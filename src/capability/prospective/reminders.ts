/**
 * Prospective-memory read side — the reminders room + per-drawer reminder axes.
 *
 * One bounded page of the reminders room plus per-drawer one-hop kg_query for the
 * reminder axes (triggers-on / es-reminder-status / es-reminder-expires-at /
 * es-reminder-satisfied-at). Concurrency 8 — the only validated level in this
 * repo. Read failures degrade to empty facts per drawer (the render drops the
 * pending section rather than throwing); a failed room page degrades to [].
 */

import type { JsonMap } from "../../core/memgraph-structure.ts";
import type { MemgraphInternals } from "../../core/memgraph-internals.ts";
import { asBoolean, asObject, asString, parseKgFacts } from "../../core/memgraph-transport.ts";

export async function listReminders(
  core: MemgraphInternals,
  args: { wing: string; room?: string; limit?: number },
): Promise<
  Array<{
    drawer_id: string;
    what: string;
    status: string;
    conditions: string[];
    expires_at?: string;
    satisfied_at?: string;
  }>
> {
  const wing = asString(args.wing).trim();
  if (!wing) return [];
  const room = asString(args.room).trim() || "reminders";
  const limit = Math.max(1, Math.min(50, Number(args.limit) || 20));

  const pageRes = await core.invoke("listDrawers", { wing, room, limit, offset: 0 });
  if (pageRes.ok === false) {
    // non-fatal: the render degrades to "no pending section" (logged). A failed
    // room page must not look like "there are no reminders".
    console.warn(`[memgraph] listReminders room page (${wing}/${room}) failed (kind=${pageRes.kind}), rendering no pending section: ${pageRes.detail}`);
    return [];
  }
  const root = asObject(pageRes.value);
  const pool = Array.isArray(root.drawers)
    ? (root.drawers as unknown[])
    : Array.isArray(root.results)
      ? (root.results as unknown[])
      : [];
  const rows = pool.slice(0, limit).map((row) => asObject(row));

  const ids = rows
    .map((row) => asString(row.drawer_id || row.node_id || row.id).trim())
    .filter(Boolean);
  const byId = new Map<string, JsonMap>();
  for (const row of rows) {
    const id = asString(row.drawer_id || row.node_id || row.id).trim();
    if (id) byId.set(id, row);
  }

  const out: Array<{
    drawer_id: string;
    what: string;
    status: string;
    conditions: string[];
    expires_at?: string;
    satisfied_at?: string;
  }> = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < ids.length) {
      const index = cursor;
      cursor += 1;
      const id = ids[index];
      const row = byId.get(id) || {};
      const item: {
        drawer_id: string;
        what: string;
        status: string;
        conditions: string[];
        expires_at?: string;
        satisfied_at?: string;
      } = {
        drawer_id: id,
        what: asString(row.content || row.text).trim(),
        status: "unknown",
        conditions: [],
      };
      // Degrade to "no facts" on edge-read failure (logged).
      const result = await core.kgQueryIgnoringFailure(
        { entity: id, direction: "outgoing" },
        `listReminders(${id}) edge read failure degrades to no facts`,
      );
      for (const fact of parseKgFacts(result)) {
        if (!asBoolean(fact.current, true)) continue;
        const predicate = asString(fact.predicate).trim();
        const object = asString(fact.object).trim();
        if (!object) continue;
        if (predicate === "triggers-on") item.conditions.push(object);
        else if (predicate === "es-reminder-status") item.status = object.toLowerCase();
        else if (predicate === "es-reminder-expires-at") item.expires_at = object;
        else if (predicate === "es-reminder-satisfied-at") item.satisfied_at = object;
      }
      out.push(item);
    }
  };
  const slots = Math.max(1, Math.min(8, ids.length));
  if (ids.length > 0) await Promise.all(Array.from({ length: slots }, () => worker()));
  return out;
}
