/**
 * Transport boundary for the MemPalace substrate (Criterion 2, Slice A).
 *
 * This module owns the plumbing between the raw `ToolCaller` and the typed
 * substrate contract: tool-name resolution, result normalization to
 * `SubstrateResult`, and the two failure-handling disciplines — `call`
 * (propagate) and `callIgnoringFailure` (explicit, logged degrade). It also
 * holds the payload-shaping helpers that operate on raw substrate responses.
 *
 * Moved verbatim from adapter/memgraph.ts; no behavior changes. The class in
 * memgraph.ts now delegates to this module, keeping its public API identical.
 */

import type { SubstrateResult } from "./mcp-http-client.ts";
import type { JsonMap, MemgraphToolMap, SourceDrawerWorkItem, ToolCaller } from "./memgraph-structure.ts";

/**
 * Normalize a ToolCaller result to a `SubstrateResult`. Real callers (turn-guard,
 * the consolidation/policy scripts) return a proper `SubstrateResult` via
 * `mcp.callToolResult`. Test fakes and any legacy caller may still return a raw
 * JsonMap — that is treated as an implicit success so existing fixtures keep
 * working without a mass rewrite. The boundary normalization lives here, in one
 * place, so the typed-failure contract holds for every real substrate call.
 */
export async function invokeSubstrate(
  tools: MemgraphToolMap,
  callTool: ToolCaller,
  name: keyof MemgraphToolMap | string,
  args: JsonMap | undefined,
): Promise<SubstrateResult<JsonMap>> {
  const toolName = typeof name === "string" && !(name in tools) ? name : tools[name as keyof MemgraphToolMap];
  let raw: unknown;
  try {
    raw = await callTool(toolName, args || {});
  } catch (err) {
    // A throwing caller (e.g. mcp.callTool, which throws SubstrateError on failure)
    // is converted to an explicit failed result here so the degrade/propagate logic
    // in callIgnoringFailure / call can branch on it instead of receiving a throw.
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, kind: "protocol", detail };
  }
  if (raw && typeof raw === "object" && "ok" in raw) return raw as SubstrateResult<JsonMap>;
  // Legacy / test fake: a plain JsonMap with no `ok` discriminator is an implicit success.
  return { ok: true, value: (raw || {}) as JsonMap };
}

/**
 * Explicitly ignore a substrate failure and degrade to an empty result. This is the
 * ONLY sanctioned place in this class where a failed call becomes `{}`: every caller
 * must route through it, so each degradation is a named decision with a reason that
 * is logged operator-visible (spec §4.1). The returned object carries `__esError` so
 * callers that need to distinguish "empty" from "failed" can still see the failure.
 */
export async function callIgnoringFailure(
  tools: MemgraphToolMap,
  callTool: ToolCaller,
  name: keyof MemgraphToolMap,
  args: JsonMap | undefined,
  reason: string,
): Promise<JsonMap> {
  const result = await invokeSubstrate(tools, callTool, name, args);
  if (result.ok === false) {
    console.warn(`[memgraph] ${tools[name]} failed (${result.kind}), ignoring by design — ${reason}: ${result.detail}`);
    return { __esError: `${result.kind}: ${result.detail}` };
  }
  return result.value;
}

/** Run a substrate call and throw on failure (the propagate path). */
export async function callSubstrate(
  tools: MemgraphToolMap,
  callTool: ToolCaller,
  name: keyof MemgraphToolMap,
  args?: JsonMap,
): Promise<JsonMap> {
  const result = await invokeSubstrate(tools, callTool, name, args);
  if (result.ok === false) {
    throw new Error(`substrate call failed (${tools[name]}, kind=${result.kind}): ${result.detail}`);
  }
  return result.value;
}

// ── Payload-shaping helpers (moved verbatim from MemgraphClient) ──────────────

export function asObject(value: unknown): JsonMap {
  return value && typeof value === "object" ? (value as JsonMap) : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function asNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function asBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "true" || v === "1" || v === "yes" || v === "on") return true;
    if (v === "false" || v === "0" || v === "no" || v === "off") return false;
  }
  if (typeof value === "number") return value !== 0;
  return fallback;
}

export function uniq(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

export function parseDrawerRows(payload: unknown): JsonMap[] {
  const root = asObject(payload);
  const pools = [
    ...asArray(root.drawers),
    ...asArray(root.results),
    ...asArray(root.items),
    ...asArray(root.nodes),
    ...asArray(root.data),
  ];
  return pools.map((row) => asObject(row)).filter((row) => Object.keys(row).length > 0);
}

export function parseKgFacts(payload: unknown): JsonMap[] {
  const root = asObject(payload);
  const facts = asArray(root.facts);
  return facts.map((fact) => asObject(fact)).filter((fact) => Object.keys(fact).length > 0);
}

export function uniqueFromFactsByDirection(facts: JsonMap[], direction: "incoming" | "outgoing"): string[] {
  const values: string[] = [];
  for (const fact of facts) {
    const current = asBoolean(fact.current, true);
    if (!current) continue;
    const next =
      direction === "incoming"
        ? asString(fact.subject || fact.node_id || fact.drawer_id || fact.id)
        : asString(fact.object || fact.node_id || fact.drawer_id || fact.id);
    const id = next.trim();
    if (id) values.push(id);
  }
  return uniq(values);
}

export function parseRawMemoryItems(payload: unknown): SourceDrawerWorkItem[] {
  const pools = parseDrawerRows(payload);

  const out: SourceDrawerWorkItem[] = [];
  const seen = new Set<string>();

  for (const raw of pools) {
    const row = asObject(raw);
    const drawer_id = asString(row.drawer_id || row.node_id || row.id).trim();
    if (!drawer_id || seen.has(drawer_id)) continue;

    seen.add(drawer_id);
    out.push({
      drawer_id,
      wing: asString(row.wing || row.closet || row.namespace).trim() || undefined,
      room: asString(row.room).trim() || undefined,
      desc: asString(row.desc || row.title || row.summary).trim() || undefined,
      filed_at: asString(row.filed_at || row.created_at).trim() || undefined,
      content: asString(row.content || row.text).trim() || undefined,
      source_file: asString(row.source_file || asObject(row.metadata).source_file).trim() || undefined,
      added_by: asString(row.added_by || asObject(row.metadata).added_by).trim() || undefined,
    });
  }

  return out;
}

export function normalizeSourceFileKey(sourceFile?: string): string {
  const value = asString(sourceFile).trim();
  if (!value) return "";
  return value.replace(/#chunk-\d+-of-\d+$/, "");
}

export function collapseChunkedSourceItems(items: SourceDrawerWorkItem[]): SourceDrawerWorkItem[] {
  const out: SourceDrawerWorkItem[] = [];
  const byBase = new Map<string, SourceDrawerWorkItem>();
  const familyByBase = new Map<string, Set<string>>();

  for (const item of items) {
    const rawSource = asString(item.source_file).trim();
    const baseSource = normalizeSourceFileKey(rawSource);
    if (!baseSource) {
      out.push({
        ...item,
        family_drawer_ids: [item.drawer_id],
      });
      continue;
    }

    if (!familyByBase.has(baseSource)) familyByBase.set(baseSource, new Set<string>());
    familyByBase.get(baseSource)?.add(item.drawer_id);

    const existing = byBase.get(baseSource);
    if (!existing) {
      byBase.set(baseSource, item);
      continue;
    }

    const existingRaw = asString(existing.source_file).trim();
    const existingIsRoot = existingRaw === baseSource;
    const itemIsRoot = rawSource === baseSource;
    if (!existingIsRoot && itemIsRoot) {
      byBase.set(baseSource, item);
      continue;
    }

    const existingFiledAt = asString(existing.filed_at).trim();
    const itemFiledAt = asString(item.filed_at).trim();
    if (itemFiledAt && (!existingFiledAt || itemFiledAt < existingFiledAt)) {
      byBase.set(baseSource, item);
    }
  }

  const grouped = [...byBase.entries()].map(([baseSource, representative]) => ({
    ...representative,
    family_drawer_ids: [...(familyByBase.get(baseSource) || new Set<string>([representative.drawer_id]))],
  }));

  return [...out, ...grouped];
}
