import { MemgraphClient } from "./memgraph.ts";
import { asObject, asText, parseRows, parseTaxonomy } from "./palace-tools.ts";
import { createSubstrateClient } from "./substrate-client.ts";

export type MemcoreSource = {
  drawerId: string;
  description: string;
  content: string;
  room: string;
  filedAt: string;
  facts: Record<string, string[]>;
};

export type MemcoreReadClient = Pick<MemgraphClient, "listDrawers" | "getDrawers" | "kgQueryMany"> & {
  getTaxonomy(): Promise<unknown>;
};

export async function connectMemcoreReader(env: Record<string, string | undefined>): Promise<MemcoreReadClient> {
  const substrate = await createSubstrateClient({ env, clientName: "mem-core-refresh", toolPrefix: env.MEMGRAPH_TOOL_PREFIX });
  const graph = new MemgraphClient({ callTool: (name, args) => substrate.client.callToolResult(name, args), toolPrefix: substrate.prefix });
  return {
    getTaxonomy: () => substrate.client.callTool(`${substrate.prefix}get_taxonomy`, {}),
    listDrawers: (args) => graph.listDrawers(args),
    getDrawers: (args) => graph.getDrawers(args),
    kgQueryMany: (args) => graph.kgQueryMany(args),
  };
}

function currentFacts(payload: unknown, entity: string, now: number): Record<string, string[]> {
  const root = asObject(payload);
  const rows = Array.isArray(root.active_facts) ? root.active_facts : root.facts;
  if (!Array.isArray(rows)) throw new Error(`Missing graph result for ${entity}`);
  const facts: Record<string, string[]> = Object.create(null);
  for (const value of rows) {
    const fact = asObject(value);
    if (typeof fact.subject !== "string" || typeof fact.predicate !== "string" || typeof fact.object !== "string") {
      throw new Error(`Malformed graph fact for ${entity}`);
    }
    if (fact.current !== undefined && typeof fact.current !== "boolean") throw new Error(`Invalid current flag for ${entity}`);
    if (fact.current === false || (fact.direction && fact.direction !== "outgoing") || fact.subject !== entity) continue;
    const from = fact.valid_from ? Date.parse(asText(fact.valid_from)) : -Infinity;
    const to = fact.valid_to ? Date.parse(asText(fact.valid_to)) : Infinity;
    if (Number.isNaN(from) || Number.isNaN(to)) throw new Error(`Invalid fact interval for ${entity}`);
    if (from > now || to <= now) continue;
    const predicate = asText(fact.predicate).trim();
    const object = asText(fact.object).trim();
    if (!predicate || !object) throw new Error(`Malformed graph fact for ${entity}`);
    const values = facts[predicate] || (facts[predicate] = []);
    if (!values.includes(object)) values.push(object);
  }
  return facts;
}

/** Read a complete scoped snapshot; incomplete reads must never replace resident memory. */
export async function readMemcoreSources(client: MemcoreReadClient, options: {
  wing: string;
  room?: string;
  maxDrawers?: number;
}): Promise<{ sources: MemcoreSource[]; scanned: number }> {
  const taxonomy = asObject(await client.getTaxonomy());
  if (!taxonomy.taxonomy || typeof taxonomy.taxonomy !== "object" || Array.isArray(taxonomy.taxonomy)) {
    throw new Error("Invalid palace taxonomy");
  }
  const tree = asObject(taxonomy.taxonomy);
  const maxDrawers = options.maxDrawers ?? 2000;
  if (!Number.isSafeInteger(maxDrawers) || maxDrawers < 1) throw new Error("maxDrawers must be a positive integer");
  for (const rooms of Object.values(tree)) {
    if (!rooms || typeof rooms !== "object" || Array.isArray(rooms)) throw new Error("Invalid palace taxonomy");
    for (const count of Object.values(rooms)) {
      if (!Number.isSafeInteger(Number(count)) || Number(count) < 0) throw new Error("Invalid palace room total");
    }
  }
  if (!Object.hasOwn(tree, options.wing)) {
    if (options.room) throw new Error(`Memory room not found: ${options.wing}/${options.room}`);
    return { sources: [], scanned: 0 };
  }
  const wing = parseTaxonomy(taxonomy).find((entry) => entry.wing === options.wing);
  if (!wing) throw new Error(`Memory wing not found: ${options.wing}`);
  const rooms = wing.rooms.filter((entry) => !options.room || entry.room === options.room);
  if (options.room && !rooms.length) throw new Error(`Memory room not found: ${options.wing}/${options.room}`);
  const sources: MemcoreSource[] = [];
  const seen = new Set<string>();
  const now = Date.now();
  for (const { room } of rooms.sort((a, b) => a.room.localeCompare(b.room))) {
    let offset = 0;
    let total: number | undefined;
    do {
      const listed = await client.listDrawers({ wing: options.wing, room, limit: 100, offset });
      if (!Array.isArray(listed.drawers)) throw new Error(`Invalid drawer page for ${options.wing}/${room}`);
      const rows = parseRows(listed);
      const pageTotal = Number(listed.total);
      if (!Number.isSafeInteger(pageTotal) || pageTotal < 0 || (total !== undefined && total !== pageTotal)) {
        throw new Error(`Incomplete or changing drawer listing for ${options.wing}/${room}`);
      }
      total = pageTotal;
      if (offset + rows.length > total || (!rows.length && offset < total)) throw new Error(`Premature end of drawer listing for ${room}`);
      const ids = rows.map((row) => asText(row.drawer_id || row.id).trim());
      for (const [index, id] of ids.entries()) {
        if (!id || seen.has(id)) throw new Error(`Missing or repeated drawer ID in ${room}`);
        if (rows[index].wing && rows[index].wing !== options.wing) throw new Error(`Out-of-scope drawer: ${id}`);
        if (rows[index].room && rows[index].room !== room) throw new Error(`Out-of-scope drawer: ${id}`);
        seen.add(id);
      }
      if (seen.size > maxDrawers) throw new Error(`Refresh exceeds ${maxDrawers} drawers; narrow --room or raise --max-drawers`);
      const graphs = await client.kgQueryMany({ entities: ids, direction: "outgoing", recurse: false, max_depth: 1 });
      const eligible = rows.flatMap((row, index) => {
        const drawerId = ids[index];
        const facts = currentFacts(graphs[drawerId], drawerId, now);
        const status = facts["es-status"] || [];
        const sourceTypes = (facts["es-source-type"] || []).map((value) => value.toLowerCase());
        const summary = status.length === 1 && status[0] === "active" &&
          (facts["synthesized-from"] || []).some((id) => id !== drawerId) &&
          (!sourceTypes.length || (sourceTypes.length === 1 && sourceTypes[0] === "synthesis"));
        const reminderStatus = facts["es-reminder-status"] || [];
        const reminder = room === "reminders" && reminderStatus.length === 1 && reminderStatus[0] === "active";
        if ((!summary && !reminder) || (facts["merged-into"] || []).length) return [];
        return [{ drawerId, description: asText(row.desc), room, filedAt: asText(row.filed_at), facts }];
      });
      const fetched = await client.getDrawers({ drawer_ids: eligible.map((source) => source.drawerId) });
      if (Number(fetched.errors || 0) || !Array.isArray(fetched.results)) throw new Error("Incomplete memory drawer read");
      const byId = new Map(parseRows(fetched).map((row) => [asText(row.drawer_id || row.id), row]));
      for (const source of eligible) {
        const drawer = byId.get(source.drawerId);
        const content = asText(drawer?.content || drawer?.text).trim();
        if (!drawer || drawer.error || !content) throw new Error(`Missing memory content: ${source.drawerId}`);
        const metadata = asObject(drawer.metadata);
        if (((drawer.wing || metadata.wing) && (drawer.wing || metadata.wing) !== options.wing) ||
          ((drawer.room || metadata.room) && (drawer.room || metadata.room) !== source.room)) {
          throw new Error(`Out-of-scope memory content: ${source.drawerId}`);
        }
        sources.push({ ...source, content, description: source.description || asText(drawer.desc),
          filedAt: source.filedAt || asText(metadata.filed_at) });
      }
      offset += rows.length;
    } while (offset < total);
  }
  sources.sort((a, b) => b.filedAt.localeCompare(a.filedAt) || a.drawerId.localeCompare(b.drawerId));
  return { sources, scanned: seen.size };
}
