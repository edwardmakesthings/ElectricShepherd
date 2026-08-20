/**
 * Shared helpers for the MemPalace inspection / relocation tools.
 *
 * These exist because MemPalace is a black box from inside a session: the only
 * read primitives are "dump everything about one drawer" or "page a room", and
 * neither answers the questions a user actually asks ("what is in this wing?",
 * "how much of it is already consolidated?"). The tools built on these helpers
 * do the paging/aggregation OUTSIDE the model's context and return a small
 * digest instead of raw content.
 */

import { MCPHttpClient, resolveMCPHeadersFromEnv } from "./mcp-http-client.ts";

export type PalaceEnv = Record<string, string | undefined>;

export type PalaceEndpoint = {
  url: string;
  headers: Record<string, string>;
};

// Loopback endpoints are the unauthenticated direct MemPalace server; sending
// gateway credentials there would leak them to a process that never needs them.
const LOOPBACK_URL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i;

export function resolvePalaceEndpoint(env: PalaceEnv): PalaceEndpoint {
  const url = String(env.MEMPALACE_MCP_URL || "").trim() || "http://localhost:8093/mcp";
  return { url, headers: LOOPBACK_URL.test(url) ? {} : resolveMCPHeadersFromEnv(env) };
}

export function palaceToolPrefix(env: PalaceEnv, override?: string): string {
  return String(override || env.MEMGRAPH_TOOL_PREFIX || "mempalace_").trim() || "mempalace_";
}

export async function createPalaceClient(args: {
  env: PalaceEnv;
  clientName: string;
  toolPrefix?: string;
  requestTimeoutMs?: number;
}): Promise<{ client: MCPHttpClient; prefix: string; url: string }> {
  const endpoint = resolvePalaceEndpoint(args.env);
  const client = new MCPHttpClient(endpoint.url, endpoint.headers, {
    clientName: args.clientName,
    requestTimeoutMs: args.requestTimeoutMs,
  });
  await client.initialize();
  return { client, prefix: palaceToolPrefix(args.env, args.toolPrefix), url: endpoint.url };
}

export function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || typeof value === "undefined") return "";
  return String(value);
}

/** MemPalace returns list-shaped payloads under several keys depending on tool. */
export function parseRows(payload: unknown): Record<string, unknown>[] {
  const root = asObject(payload);
  const pools = [
    ...asArray(root.drawers),
    ...asArray(root.results),
    ...asArray(root.items),
    ...asArray(root.nodes),
    ...asArray(root.data),
  ];
  return pools.map(asObject).filter((row) => Object.keys(row).length > 0);
}

export function parseFacts(payload: unknown): Record<string, unknown>[] {
  const root = asObject(payload);
  const pools = [
    ...asArray(root.facts),
    ...asArray(root.triples),
    ...asArray(root.edges),
    ...asArray(root.results),
    ...asArray(root.relationships),
  ];
  return pools.map(asObject).filter((row) => Object.keys(row).length > 0);
}

export function clipPreview(text: unknown, maxChars: number): string {
  const normalized = asText(text).replace(/\s+/g, " ").trim();
  if (maxChars <= 0 || normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(1, maxChars - 1))}...`;
}

/**
 * Head+tail preview: the middle is what blows up context, but the ends are what
 * identify a transcript (who/when at the top, where it stopped at the bottom).
 */
export function previewEnds(
  text: unknown,
  headChars: number,
  tailChars: number,
): { head: string; tail: string; truncated: boolean } {
  const raw = asText(text);
  const head = Math.max(0, headChars);
  const tail = Math.max(0, tailChars);
  if (raw.length <= head + tail) {
    return { head: raw, tail: "", truncated: false };
  }
  return { head: raw.slice(0, head), tail: raw.slice(raw.length - tail), truncated: true };
}

export function scratchFileNameFor(drawerId: unknown, stamp: unknown): string {
  const safeId = asText(drawerId).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "drawer";
  const safeStamp = asText(stamp).replace(/[^0-9A-Za-z]/g, "").slice(0, 15);
  return safeStamp ? `${safeId}.${safeStamp}.txt` : `${safeId}.txt`;
}

export function normalizeForVerbatimMatch(text: unknown): string {
  return asText(text)
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .trim();
}

/**
 * Relocation must never become paraphrase-laundering: an excerpt is only filed
 * into a new wing/room if it appears verbatim in the source drawer.
 */
export function verifyVerbatimExcerpt(
  sourceContent: unknown,
  excerpt: unknown,
): { ok: boolean; reason?: string } {
  const needle = normalizeForVerbatimMatch(excerpt);
  if (!needle) return { ok: false, reason: "empty-excerpt" };

  const haystack = normalizeForVerbatimMatch(sourceContent);
  if (!haystack) return { ok: false, reason: "source-content-unavailable" };

  if (!haystack.includes(needle)) return { ok: false, reason: "excerpt-not-verbatim-in-source" };
  return { ok: true };
}

export function drawerContentFrom(payload: unknown): string {
  const root = asObject(payload);
  const direct = asText(root.content) || asText(root.text) || asText(root.document);
  if (direct) return direct;
  const nested = asObject(root.drawer);
  return asText(nested.content) || asText(nested.text);
}

const MAX_ANCHOR_CHARS = 400;

// Whitespace-flexible so an anchor copied out of a rendered summary still matches
// the stored text; runs collapse to \s+ so the pattern cannot nest quantifiers.
function anchorPattern(anchor: string): RegExp {
  const escaped = anchor
    .slice(0, MAX_ANCHOR_CHARS)
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s+");
  return new RegExp(escaped);
}

/**
 * Lift the passage between two verbatim anchors out of a drawer.
 *
 * This is what lets an agent propose a relocation without holding the passage:
 * it names the first and last line, and the slice comes from the stored content,
 * so the result is verbatim by construction rather than by trust.
 */
export function sliceVerbatimBetween(
  content: unknown,
  startAnchor: unknown,
  endAnchor: unknown,
): { ok: boolean; text?: string; reason?: string } {
  const raw = asText(content);
  const start = asText(startAnchor).trim();
  const end = asText(endAnchor).trim();

  if (!raw) return { ok: false, reason: "source-content-unavailable" };
  if (!start || !end) return { ok: false, reason: "missing-anchor" };

  const startMatch = anchorPattern(start).exec(raw);
  if (!startMatch) return { ok: false, reason: "start-anchor-not-found" };

  const from = startMatch.index;
  const minimumEnd = from + startMatch[0].length;

  const endMatch = anchorPattern(end).exec(raw.slice(from));
  if (!endMatch) return { ok: false, reason: "end-anchor-not-found" };

  const to = Math.max(minimumEnd, from + endMatch.index + endMatch[0].length);
  const text = raw.slice(from, to);
  if (!text.trim()) return { ok: false, reason: "empty-slice" };

  return { ok: true, text };
}


export type TaxonomyEntry = { wing: string; rooms: { room: string; drawers: number }[]; drawers: number };
export function parseTaxonomy(payload: unknown): TaxonomyEntry[] {
  const taxonomy = asObject(asObject(payload).taxonomy);
  const out: TaxonomyEntry[] = [];

  for (const [wing, roomsRaw] of Object.entries(taxonomy)) {
    const rooms = Object.entries(asObject(roomsRaw))
      .map(([room, count]) => ({ room, drawers: Number(count) || 0 }))
      .sort((a, b) => b.drawers - a.drawers);
    out.push({ wing, rooms, drawers: rooms.reduce((sum, item) => sum + item.drawers, 0) });
  }

  return out.sort((a, b) => b.drawers - a.drawers);
}

/** Rooms whose names suggest raw session transcripts rather than curated notes. */
export function isTranscriptLikeRoom(room: unknown): boolean {
  const name = asText(room).toLowerCase();
  if (!name) return false;
  return /transcript|mem[-_]?raw|session|capture/.test(name);
}

export function summarizeDrawerRows(
  rows: Record<string, unknown>[],
  previewChars: number,
): {
  count: number;
  filedAtEarliest: string;
  filedAtLatest: string;
  sources: string[];
  samples: { drawer_id: string; room: string; filed_at: string; preview: string }[];
} {
  const filedAt: string[] = [];
  const sources = new Set<string>();
  const samples: { drawer_id: string; room: string; filed_at: string; preview: string }[] = [];

  for (const row of rows) {
    const meta = asObject(row.metadata);
    const stamp = asText(meta.filed_at);
    if (stamp) filedAt.push(stamp);

    const source = asText(meta.source_file);
    if (source) sources.add(source);

    samples.push({
      drawer_id: asText(row.drawer_id || row.id),
      room: asText(row.room || meta.room),
      filed_at: stamp,
      preview: clipPreview(row.content_preview ?? row.content ?? row.preview, previewChars),
    });
  }

  filedAt.sort();
  return {
    count: rows.length,
    filedAtEarliest: filedAt[0] || "",
    filedAtLatest: filedAt[filedAt.length - 1] || "",
    sources: [...sources].slice(0, 25),
    samples,
  };
}

export type DiffWindow = { since: string; before: string };

const RELATIVE_DURATION = /^(\d+)\s*(h|d|w|m)$/i;
const DURATION_MS: Record<string, number> = {
  h: 3600000,
  d: 86400000,
  w: 604800000,
  m: 2592000000,
};

/**
 * Resolve "what changed lately" into two adjacent windows of equal length, so
 * the current period is compared against the one immediately before it.
 */
export function resolveDiffWindows(args: {
  now: Date;
  since: string;
  until?: string;
}): { current: DiffWindow; previous: DiffWindow; durationMs: number } {
  const until = args.until ? new Date(args.until) : args.now;
  if (Number.isNaN(until.getTime())) throw new Error(`invalid until: ${args.until}`);

  const relative = RELATIVE_DURATION.exec(String(args.since || "").trim());
  let start: Date;
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2].toLowerCase();
    if (!amount) throw new Error(`invalid since duration: ${args.since}`);
    start = new Date(until.getTime() - amount * DURATION_MS[unit]);
  } else {
    start = new Date(args.since);
    if (Number.isNaN(start.getTime())) throw new Error(`invalid since: ${args.since}`);
  }

  const durationMs = until.getTime() - start.getTime();
  if (durationMs <= 0) throw new Error("since must be earlier than until");

  return {
    current: { since: start.toISOString(), before: until.toISOString() },
    previous: {
      since: new Date(start.getTime() - durationMs).toISOString(),
      before: start.toISOString(),
    },
    durationMs,
  };
}

