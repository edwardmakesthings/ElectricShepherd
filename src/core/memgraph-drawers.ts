/**
 * MemgraphClient drawer CRUD + KG write + source-scope method group (Criterion 2 split).
 *
 * Moved verbatim from adapter/memgraph.ts: add/checkpoint/update drawer, the
 * namespaced update-drawer fallback, kgAdd/kgSupersede/kgInvalidate wrappers,
 * createDerivedDrawer / fileDeadEnd, search/listDrawers/getDrawer, and the
 * source-scope worklist listing. Each function takes a `MemgraphInternals`
 * context; the MemgraphClient facade delegates to them.
 */

import type { JsonMap } from "./memgraph-structure.ts";
import { asString } from "./memgraph-transport.ts";
import type { MemgraphInternals } from "./memgraph-internals.ts";
import { UPDATE_DRAWER_FALLBACK_NAMES } from "./substrate-client.ts";

export function addDrawer(core: MemgraphInternals, args: {
  wing: string;
  room: string;
  content: string;
  source_file?: string;
  added_by?: string;
  desc?: string;
}) {
  return core.call("addDrawer", args as unknown as JsonMap);
}

export function checkpoint(core: MemgraphInternals, args: {
  items: Array<{
    wing: string;
    room: string;
    content: string;
    source_file?: string;
    added_by?: string;
    desc?: string;
  }>;
  dedup_threshold?: number;
  added_by?: string;
  diary?: {
    agent_name?: string;
    entry?: string;
    topic?: string;
    wing?: string;
  };
}) {
  return core.call("checkpoint", args as unknown as JsonMap);
}

export function updateDrawer(core: MemgraphInternals, args: {
  drawer_id: string;
  content?: string;
  wing?: string;
  room?: string;
}) {
  return callWithUpdateDrawerFallback(core, args as unknown as JsonMap);
}

async function callWithUpdateDrawerFallback(core: MemgraphInternals, args: JsonMap): Promise<JsonMap> {
  const primary = await core.invoke("updateDrawer", args);
  if (primary.ok === false) {
    let lastDetail: string;
    if (!shouldRetryWithDreamNamespacedTool(new Error(primary.detail))) throw new Error(`substrate call failed (update_drawer, kind=${primary.kind}): ${primary.detail}`);
    // The server rejected the prefixed name (not-found / not-allowed): try the
    // namespaced fallback tool names. Each failure is explicit; the last one wins.
    const fallbackNames: string[] = [...UPDATE_DRAWER_FALLBACK_NAMES];
    lastDetail = primary.detail;
    for (const toolName of fallbackNames) {
      const res = await core.invoke(toolName, args);
      if (res.ok === false) {
        lastDetail = res.detail;
      } else {
        return res.value;
      }
    }
    throw new Error(`update_drawer failed via all names (${fallbackNames.join(", ")}): ${lastDetail}`);
  }
  return primary.value;
}

function shouldRetryWithDreamNamespacedTool(err: unknown): boolean {
  const message = String(err || "").toLowerCase();
  if (!message) return false;
  return (
    message.includes("not allowed") ||
    message.includes("not found") ||
    message.includes("unknown tool") ||
    message.includes("no such tool")
  );
}

export function kgAdd(core: MemgraphInternals, args: {
  subject: string;
  predicate: string;
  object: string;
  valid_from?: string;
  source_closet?: string;
  // Provenance — the run_id of the consolidation execution
  source_run_id?: string;
}) {
  return core.call("kgAdd", args as unknown as JsonMap);
}

export function kgSupersede(core: MemgraphInternals, args: {
  subject: string;
  predicate: string;
  old_object: string;
  new_object: string;
  source_closet?: string;
  source_run_id?: string;
}) {
  return core.call("kgSupersede", args as unknown as JsonMap);
}

export function kgInvalidate(core: MemgraphInternals, args: {
  subject: string;
  predicate: string;
  object: string;
  ended?: string;
}) {
  return core.call("kgInvalidate", args as unknown as JsonMap);
}


export function search(core: MemgraphInternals, query: string, limit = 5, wing?: string, room?: string) {
  return core.call("search", { query, limit, wing, room });
}

export function listDrawers(core: MemgraphInternals, args: {
  wing?: string;
  room?: string;
  limit?: number;
  offset?: number;
}) {
  return core.call("listDrawers", args as unknown as JsonMap);
}

export function getDrawer(core: MemgraphInternals, args: {
  drawer_id: string;
}) {
  return core.call("getDrawer", args as unknown as JsonMap);
}

