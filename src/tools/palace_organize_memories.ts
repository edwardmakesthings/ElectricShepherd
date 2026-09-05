import { tool } from "@opencode-ai/plugin";
import { asObject, createPalaceClient, parseRows, parseTaxonomy } from "../core/palace-tools.ts";
import { applyRuntimeConfigToEnv, loadRuntimeConfig } from "../core/runtime-config.ts";
import { loadRuntimeEnv } from "../scripts/runtime-env.ts";

declare const process: {
  env: Record<string, string | undefined>;
};

type RoomCount = { room: string; drawers: number };

export default tool({
  description:
    "Analyze memory organization and propose room/wing cleanup moves. Read-only: returns recommendations only, never mutates drawers.",
  args: {
    wing: tool.schema.string().describe("Wing to analyze."),
    rooms: tool.schema.array(tool.schema.string()).optional().describe("Optional subset of rooms to analyze."),
    drawer_ids: tool.schema.array(tool.schema.string()).optional().describe("Optional explicit drawer set to inspect for room mismatches."),
    tiny_room_threshold: tool.schema
      .number()
      .optional()
      .describe("Rooms at or below this count are considered tiny (default 2, chunk-count based from taxonomy)."),
    include_samples: tool.schema.boolean().optional().describe("Include sample drawer previews for candidates."),
    tool_prefix: tool.schema.string().optional().describe("MCP tool prefix override."),
  },
  async execute(args, context) {
    const cwd = context.worktree || context.directory;
    loadRuntimeEnv({ scriptUrl: import.meta.url, env: process.env, cwd });
    const runtimeConfig = loadRuntimeConfig({ cwd, env: process.env });
    applyRuntimeConfigToEnv(process.env, runtimeConfig);

    const wing = String(args.wing || "").trim();
    if (!wing) throw new Error("palace_organize_memories: wing is required");

    const selectedRooms = uniqueText(args.rooms);
    const drawerIDs = uniqueText(args.drawer_ids);
    const tinyThreshold = clampNumber(args.tiny_room_threshold, 2, 1, 20);
    const includeSamples = args.include_samples === true;

    const { client, prefix, url } = await createPalaceClient({
      env: process.env,
      clientName: "electric-shepherd-palace-organize-memories",
      toolPrefix: args.tool_prefix,
    });
    const call = async (name: string, payload: Record<string, unknown>) =>
      client.callTool(`${prefix}${name}`, payload);

    const taxonomy = parseTaxonomy(await call("get_taxonomy", {}));
    const wingEntry = taxonomy.find((entry) => entry.wing === wing);
    if (!wingEntry) {
      return json({ ok: false, wing, endpoint: url, error: "wing-not-found" });
    }

    const roomCounts = (selectedRooms.length > 0
      ? wingEntry.rooms.filter((entry) => selectedRooms.includes(entry.room))
      : wingEntry.rooms) as RoomCount[];

    const tinyRooms = roomCounts.filter((entry) => entry.drawers <= tinyThreshold);
    const namingIssues = roomCounts
      .map((entry) => ({ room: entry.room, issue: roomNameIssue(entry.room) }))
      .filter((entry) => entry.issue);
    const nearDuplicates = findNearDuplicateRoomNames(roomCounts.map((entry) => entry.room));

    const recommendations: Record<string, unknown>[] = [];

    for (const room of tinyRooms) {
      const target = bestTargetForTinyRoom(room.room, roomCounts);
      recommendations.push({
        kind: "tiny-room",
        room: room.room,
        drawers: room.drawers,
        suggestion: target
          ? `Consider moving ${room.room} into ${target} (higher-volume nearby topic).`
          : `Consider folding ${room.room} into a parent topic room after content review.`,
        proposed_target_room: target || undefined,
      });
    }

    for (const item of namingIssues) {
      recommendations.push({
        kind: "naming",
        room: item.room,
        suggestion: item.issue,
      });
    }

    for (const pair of nearDuplicates) {
      recommendations.push({
        kind: "near-duplicate-name",
        room_a: pair[0],
        room_b: pair[1],
        suggestion: "Potential topic split due to naming drift; review for merge or clearer distinction.",
      });
    }

    const drawerMismatches: Record<string, unknown>[] = [];
    if (drawerIDs.length > 0) {
      for (const drawerID of drawerIDs) {
        try {
          const drawer = asObject(await call("get_drawer", { drawer_id: drawerID }));
          const room = String(drawer.room || asObject(drawer.metadata).room || "").trim();
          const sourceFile = String(asObject(drawer.metadata).source_file || "").trim();
          const inferred = inferRoomFromSource(sourceFile);
          if (room && inferred && inferred !== room) {
            drawerMismatches.push({
              drawer_id: drawerID,
              room,
              inferred_room: inferred,
              source_file: sourceFile,
              suggestion: "Possible room mismatch from source_file hint; consider relocate_memory preview.",
            });
          }
        } catch (err) {
          drawerMismatches.push({ drawer_id: drawerID, error: String(err) });
        }
      }
    }

    const samplesByRoom: Record<string, unknown[]> = {};
    if (includeSamples) {
      for (const room of tinyRooms.slice(0, 10)) {
        try {
          const listed = await call("list_drawers", { wing, room: room.room, limit: 3, offset: 0 });
          const rows = parseRows(listed);
          samplesByRoom[room.room] = rows.map((row) => ({
            drawer_id: String((row as Record<string, unknown>).drawer_id || ""),
            preview: String((row as Record<string, unknown>).content_preview || "").slice(0, 220),
          }));
        } catch {
          samplesByRoom[room.room] = [];
        }
      }
    }

    return json({
      ok: true,
      endpoint: url,
      wing,
      analyzed_rooms: roomCounts.length,
      tiny_room_threshold: tinyThreshold,
      tiny_rooms: tinyRooms,
      naming_issues: namingIssues,
      near_duplicate_room_names: nearDuplicates,
      drawer_mismatch_checks: drawerMismatches,
      recommendations,
      samples_by_room: includeSamples ? samplesByRoom : undefined,
      next_step:
        "Apply approved moves with move_drawers/relocate_memory using dry_run first; keep naming conventions in dreamer room-selection contract.",
    });
  },
});

function uniqueText(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out = new Set<string>();
  for (const raw of value) {
    const text = String(raw || "").trim();
    if (text) out.add(text);
  }
  return [...out];
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

export function roomNameIssue(room: string): string {
  if (!room) return "";
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(room)) {
    return "Room name is not kebab-case; prefer lowercase-hyphen words.";
  }
  if (/(^|-)synthesis($|-)|(^|-)mem-synth($|-)|(^|-)level-\d+($|-)|(^|-)arc(s)?($|-)/.test(room)) {
    return "Room name looks derivation-level based; prefer purpose/subsystem naming.";
  }
  return "";
}

function normalizeStem(text: string): string {
  return text
    .toLowerCase()
    .replace(/[-_]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function sharedPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i += 1;
  return i;
}

function findNearDuplicateRoomNames(rooms: string[]): [string, string][] {
  const out: [string, string][] = [];
  for (let i = 0; i < rooms.length; i += 1) {
    for (let j = i + 1; j < rooms.length; j += 1) {
      const a = rooms[i];
      const b = rooms[j];
      if (a === b) continue;
      const na = normalizeStem(a);
      const nb = normalizeStem(b);
      if (!na || !nb) continue;
      if (na === nb) {
        out.push([a, b]);
        continue;
      }
      const shorter = Math.min(na.length, nb.length);
      const prefix = sharedPrefixLength(na, nb);
      if (shorter >= 6 && prefix >= shorter - 2) out.push([a, b]);
    }
  }
  return out.slice(0, 25);
}

function bestTargetForTinyRoom(room: string, roomCounts: RoomCount[]): string {
  const stem = normalizeStem(room);
  if (!stem) return "";
  const candidates = roomCounts
    .filter((entry) => entry.room !== room)
    .map((entry) => ({ room: entry.room, drawers: entry.drawers, prefix: sharedPrefixLength(stem, normalizeStem(entry.room)) }))
    .filter((entry) => entry.prefix >= 4)
    .sort((a, b) => b.prefix - a.prefix || b.drawers - a.drawers);
  return candidates[0]?.room || "";
}

function inferRoomFromSource(sourceFile: string): string {
  const text = sourceFile.toLowerCase();
  if (!text) return "";
  if (text.includes("viewer")) return "viewer";
  if (text.includes("configurator") || text.includes("cfg-")) return "configurator";
  if (text.includes("layout") || text.includes("solver") || text.includes("houdini")) return "backend";
  if (text.includes("web") || text.includes("frontend")) return "frontend";
  if (text.includes("decision") || text.includes("adr")) return "decisions";
  return "";
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
