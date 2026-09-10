/**
 * Source-transcript capture for oh-my-pi.
 *
 * The OpenCode path shells out to `capture-source-transcripts.sh`, which runs
 * `opencode --pure export <sid>` — a hard dependency on that binary. omp needs
 * none of it: the session is already an append-only JSONL entry log on disk, and
 * `session_stop` hands over its path directly, so capture is a file read.
 *
 * Every captured drawer is stamped `es-source-type: transcript` at write time.
 * That stamp is what makes the retrieval authority table work — an unstamped
 * drawer reads as `unknown`, whose intent boosts are all zero, so it competes
 * with docs and syntheses on raw similarity instead of being demoted on factual
 * queries. Capturing without stamping is what turns a transcript into noise.
 *
 * Append-only for now: one drawer per settle, keyed by a unique `source_file`.
 * The replace/hybrid dedup modes the shell script implements are not ported.
 */

import { readFileSync } from "node:fs";

import { createMemgraphClient } from "../../core/memgraph.ts";
import { resolveMCPHeadersFromEnv } from "../../core/mcp-transport.ts";
import { DEFAULT_MCP_TOOL_PREFIX, DEFAULT_MCP_URL } from "../../core/runtime-config.ts";
import { createSubstrateClient } from "../../core/substrate-client.ts";
import type { OmpExtensionApi, OmpExtensionContext, OmpSessionStopEvent } from "./api.ts";
import { isTrue, log, resolveEnv, toNumber, type EsEnv } from "./runtime.ts";

/** Entry types in omp's session log that carry conversation content. */
const CONTENT_ENTRY_TYPES = new Set(["message", "custom_message"]);

const TRIMMED_CONTENT_MARKER = "<content>\n[trimmed by source-capture normalization]\n</content>";

type SessionEntry = { type?: string; message?: { role?: string; content?: unknown } };

/** Mirrors trim_embedded_content in transcript_capture_normalization.py. */
function trimEmbeddedContent(text: string): string {
  if (!text.includes("<content>") || !text.includes("</content>")) return text;
  return text.replace(/<content>[\s\S]*?<\/content>/g, TRIMMED_CONTENT_MARKER);
}

/**
 * Render an omp session JSONL into the compact JSON the consolidation pipeline
 * already reads. Deliberately byte-compatible with the shape
 * `transcript_capture_normalization.py` produces for OpenCode exports —
 * `{session,messages:[{role,text}]}`, text parts only — so one mapper serves
 * both harnesses. A markdown rendering would also collide with the `##`
 * headings that appear inside message bodies.
 */
export function renderSessionTranscript(jsonl: string, sessionID: string, directory: string): string {
  const messages: Array<{ role: string; text: string }> = [];

  for (const raw of jsonl.split("\n")) {
    const line = raw.trim();
    if (!line) continue;

    let entry: SessionEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a torn final line during an in-flight append is not an error
    }
    if (!CONTENT_ENTRY_TYPES.has(String(entry.type ?? ""))) continue;

    const message = entry.message;
    if (!message || typeof message !== "object") continue;
    const content = Array.isArray(message.content) ? message.content : [];

    const textParts: string[] = [];
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      if ((part as { type?: string }).type !== "text") continue;
      const value = (part as { text?: string }).text;
      if (typeof value !== "string") continue;
      const cleaned = trimEmbeddedContent(value.trim());
      if (cleaned) textParts.push(cleaned);
    }
    if (textParts.length === 0) continue;

    messages.push({ role: String(message.role ?? ""), text: textParts.join("\n\n") });
  }

  if (messages.length === 0) return "";
  return JSON.stringify({ session: { id: sessionID, title: null, directory }, messages });
}

async function capture(env: EsEnv, sessionFile: string, sessionID: string, cwd: string): Promise<string> {
  const transcript = renderSessionTranscript(readFileSync(sessionFile, "utf8"), sessionID, cwd);
  if (!transcript) return "empty";

  const { client } = await createSubstrateClient({
    env,
    clientName: "electric-shepherd-omp-capture",
    urlOverride: String(env.MEMPALACE_MCP_URL || "").trim() || DEFAULT_MCP_URL,
    headersOverride: resolveMCPHeadersFromEnv(env),
    requestTimeoutMs: toNumber(env.ESHEPHERD_SOURCE_CAPTURE_TIMEOUT_MS, 20000),
    maxRetries: 0,
  });
  const memgraph = createMemgraphClient({
    callTool: async (name: string, args?: Record<string, unknown>) => client.callToolResult(name, args),
    toolPrefix:
      String(env.ESHEPHERD_SOURCE_CAPTURE_TOOL_PREFIX || env.MEMGRAPH_TOOL_PREFIX || "").trim() ||
      DEFAULT_MCP_TOOL_PREFIX,
  });

  const result: any = await memgraph.addDrawer({
    wing: String(env.ESHEPHERD_SOURCE_CAPTURE_WING || "").trim() || "opencode",
    room: String(env.ESHEPHERD_SOURCE_CAPTURE_ROOM || "").trim() || "source-transcripts",
    content: transcript,
    source_file: `omp://session/${sessionID}/${new Date().toISOString()}`,
    added_by: String(env.ESHEPHERD_SOURCE_CAPTURE_ADDED_BY || "").trim() || "electric-shepherd-capture",
  });

  const drawerID = String(result?.drawer_id || result?.id || "").trim();
  if (!drawerID) return `stored ${transcript.length} chars (no drawer id returned; source type NOT stamped)`;

  const stamped = await memgraph.setClosetSourceType(drawerID, "transcript");
  return `stored ${transcript.length} chars as ${drawerID}${stamped ? " (stamped transcript)" : " (STAMP FAILED)"}`;
}

export function registerSourceCapture(pi: OmpExtensionApi): void {
  const capturedSessions = new Set<string>();

  pi.on("session_stop", async (event: OmpSessionStopEvent, ctx: OmpExtensionContext) => {
    const sessionID = String(event.session_id || "").trim();
    const sessionFile = String(event.session_file || "").trim();
    if (!sessionID || !sessionFile || capturedSessions.has(sessionID)) return;

    const env = resolveEnv(ctx.cwd || process.cwd(), import.meta.url);
    if (!isTrue(env.ESHEPHERD_SOURCE_CAPTURE_ENABLED)) return;

    capturedSessions.add(sessionID);
    const cwd = ctx.cwd || process.cwd();
    try {
      log(pi, `source capture: ${await capture(env, sessionFile, sessionID, cwd)}`);
    } catch (err) {
      // Named degradation: a failed capture must not block the settle. The
      // session file is still on disk, so a later run can pick it up.
      log(pi, `source capture failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}
