/**
 * Standalone, exhaustive backfill of the `es-source-type` KG axis.
 *
 * `palace_stamp_source_type` (src/tools/palace_stamp_source_type.ts) is the
 * MODEL-facing tool: bounded by construction (at most `max_pages` per room) so
 * an agent's call is cheap and predictable, and a room can never be paged to
 * exhaustion by an LLM. That bound is correct for a tool a model invokes, but
 * it means repeated invocations never make progress on a room bigger than
 * `max_pages * page_size` — there is no cursor, so every call re-reads the same
 * first window from offset 0.
 *
 * This script is the other side of that same tradeoff: an operator explicitly
 * asked for a one-off migration, not a per-turn tool call, so it walks every
 * room to real exhaustion. It reuses the tool's exact classification rule
 * (`inferSourceType`) and idempotency check (`readCurrentSourceType`) so the
 * two paths can never disagree on what a drawer's source type should be.
 *
 * Classification (unchanged from the tool):
 *   - transcript-like room name (isTranscriptLikeRoom) -> `transcript`, no KG call
 *   - outgoing `synthesized-from` edge -> `synthesis`
 *   - neither -> left UNSTAMPED, never guessed
 *
 * Dry-run by default, like every mutating tool in this project.
 */

import { runKgAddWrites, runKgSupersedeWrites } from "../core/operation.ts";
import {
  asText,
  isTranscriptLikeRoom,
  parseRows,
  parseTaxonomy,
} from "../core/palace-tools.ts";
import { createSubstrateClient } from "../core/substrate-client.ts";
import { DEFAULT_MCP_TOOL_PREFIX, DEFAULT_MCP_URL, loadRuntimeConfig } from "../core/runtime-config.ts";
import { inferSourceType, readCurrentSourceType, type CallTool } from "../tools/palace_stamp_source_type.ts";
import { loadRuntimeEnv } from "./runtime-env.ts";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const runtimeProcess = (globalThis as unknown as {
  process: {
    argv: string[];
    env: Record<string, string | undefined>;
    cwd: () => string;
    stdout: { write: (text: string) => void };
    stderr: { write: (text: string) => void };
    exit: (code: number) => never;
  };
}).process;

function getArg(argv: string[], flag: string): string {
  const at = argv.indexOf(flag);
  return at >= 0 && at + 1 < argv.length ? String(argv[at + 1] || "").trim() : "";
}

function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

function parseCSV(value: string): string[] {
  return value.trim() ? [...new Set(value.split(",").map((v) => v.trim()).filter(Boolean))] : [];
}

type Concurrency<T, R> = (items: T[], limit: number, fn: (item: T) => Promise<R>) => Promise<R[]>;

/** Bounded parallelism without a queue library: each worker pulls the next index. */
const mapLimit: Concurrency<unknown, unknown> = async (items, limit, fn) => {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) || 1 }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
};

type RoomTotals = {
  room: string;
  total: number;
  inferred_transcript: number;
  inferred_synthesis: number;
  unknown: number;
  check_failed: number;
  already_stamped: number;
  stamped: number;
  stamp_failed: number;
};

export function emptyRoomTotals(room: string): RoomTotals {
  return {
    room,
    total: 0,
    inferred_transcript: 0,
    inferred_synthesis: 0,
    unknown: 0,
    check_failed: 0,
    already_stamped: 0,
    stamped: 0,
    stamp_failed: 0,
  };
}

/** Walk one room to exhaustion, classifying and (optionally) stamping every drawer. */
export async function backfillRoom(args: {
  call: CallTool;
  wing: string;
  room: string;
  pageSize: number;
  concurrency: number;
  apply: boolean;
}): Promise<RoomTotals> {
  const totals = emptyRoomTotals(args.room);
  let offset = 0;

  for (;;) {
    const response = await args.call("list_drawers", { wing: args.wing, room: args.room, limit: args.pageSize, offset });
    const rows = parseRows(response);
    const ids = rows.map((row) => asText(row.drawer_id || row.id).trim()).filter(Boolean);
    if (ids.length === 0) break;

    await mapLimit(ids, args.concurrency, async (drawerId) => {
      const { inference, checkFailed } = await inferSourceType(args.call, args.room, drawerId as string);
      if (checkFailed) totals.check_failed += 1;
      if (inference === "transcript") totals.inferred_transcript += 1;
      else if (inference === "synthesis") totals.inferred_synthesis += 1;
      else {
        totals.unknown += 1;
        return; // never guessed, never written
      }

      const current = await readCurrentSourceType(args.call, drawerId as string);
      if (current === inference) {
        totals.already_stamped += 1;
        return;
      }
      if (!args.apply) return; // dry-run: classification above already reports what WOULD happen

      try {
        const payload = { subject: drawerId as string, predicate: "es-source-type", source_closet: drawerId as string };
        const [result] = current
          ? await runKgSupersedeWrites(args.call, [{ payload: { ...payload, old_object: current, new_object: inference } }])
          : await runKgAddWrites(args.call, [{ payload: { ...payload, object: inference } }]);
        if (result?.ok) totals.stamped += 1;
        else totals.stamp_failed += 1;
      } catch {
        totals.stamp_failed += 1;
      }
    });

    totals.total += ids.length;
    runtimeProcess.stderr.write(
      `[stamp-source-type-backfill] ${args.wing}/${args.room}: ${totals.total} examined, ${totals.stamped} stamped so far\n`,
    );

    if (ids.length < args.pageSize) break; // last page
    offset += args.pageSize;
  }

  return totals;
}

async function main(): Promise<void> {
  const argv = runtimeProcess.argv.slice(2);
  if (hasFlag(argv, "--help")) {
    runtimeProcess.stdout.write(
      "Usage: run-source-type-backfill.ts --wing <wing> [--rooms a,b] [--exclude-rooms a,b]\n" +
        "  [--page-size 100] [--concurrency 8] [--apply]\n" +
        "Dry-run by default. Walks every targeted room to exhaustion (no page cap) --\n" +
        "an operator migration, unlike the bounded palace_stamp_source_type tool.\n",
    );
    return;
  }

  const cwd = runtimeProcess.cwd();
  loadRuntimeEnv({ scriptUrl: import.meta.url, env: runtimeProcess.env, cwd });
  const runtimeConfig = loadRuntimeConfig({ cwd, env: runtimeProcess.env });

  const wing = getArg(argv, "--wing") || String(runtimeConfig.valuesByPath.memory?.projectWing || "").trim();
  if (!wing) throw new Error("run-source-type-backfill: --wing is required (or set memory.projectWing in config)");

  const explicitRooms = parseCSV(getArg(argv, "--rooms"));
  const excludeRooms = new Set(parseCSV(getArg(argv, "--exclude-rooms")));
  const pageSize = Math.max(1, Math.min(100, Number(getArg(argv, "--page-size") || "100")));
  const concurrency = Math.max(1, Math.min(16, Number(getArg(argv, "--concurrency") || "8")));
  const apply = hasFlag(argv, "--apply");

  const mcpURL = String(runtimeConfig.valuesByPath.mcp?.url || "").trim() || DEFAULT_MCP_URL;
  const toolPrefix = String(runtimeConfig.valuesByPath.mcp?.toolPrefix || "").trim() || DEFAULT_MCP_TOOL_PREFIX;
  // Construct through the core/ seam (Check A2): owns transport + initialize.
  const { client } = await createSubstrateClient({
    env: runtimeProcess.env,
    clientName: "electric-shepherd-source-type-backfill",
    urlOverride: mcpURL,
  });
  const call: CallTool = (name, payload) => client.callTool(`${toolPrefix}${name}`, payload);

  const taxonomy = parseTaxonomy(await call("get_taxonomy", {}));
  const wingEntry = taxonomy.find((entry) => entry.wing === wing);
  if (!wingEntry) throw new Error(`run-source-type-backfill: wing "${wing}" not found in taxonomy`);

  let rooms = wingEntry.rooms.map((entry) => entry.room).filter((room) => !excludeRooms.has(room));
  if (explicitRooms.length > 0) {
    const explicit = new Set(explicitRooms);
    rooms = rooms.filter((room) => explicit.has(room));
  }
  // Transcript-like rooms first: they classify from the room name alone (no KG
  // call per drawer), so the cheapest, usually-largest rooms finish first and a
  // run that is interrupted has already covered the highest-value ground.
  rooms.sort((a, b) => Number(isTranscriptLikeRoom(b)) - Number(isTranscriptLikeRoom(a)));

  runtimeProcess.stderr.write(
    `[stamp-source-type-backfill] wing=${wing} rooms=${rooms.length} apply=${apply} page_size=${pageSize} concurrency=${concurrency}\n`,
  );

  const perRoom: RoomTotals[] = [];
  for (const room of rooms) {
    perRoom.push(await backfillRoom({ call, wing, room, pageSize, concurrency, apply }));
  }

  const totals = perRoom.reduce(
    (acc, r) => ({
      total: acc.total + r.total,
      inferred_transcript: acc.inferred_transcript + r.inferred_transcript,
      inferred_synthesis: acc.inferred_synthesis + r.inferred_synthesis,
      unknown: acc.unknown + r.unknown,
      check_failed: acc.check_failed + r.check_failed,
      already_stamped: acc.already_stamped + r.already_stamped,
      stamped: acc.stamped + r.stamped,
      stamp_failed: acc.stamp_failed + r.stamp_failed,
    }),
    { total: 0, inferred_transcript: 0, inferred_synthesis: 0, unknown: 0, check_failed: 0, already_stamped: 0, stamped: 0, stamp_failed: 0 },
  );

  runtimeProcess.stdout.write(
    `${JSON.stringify(
      {
        wing,
        dry_run: !apply,
        rooms: perRoom,
        totals,
        next_step: apply ? undefined : "Re-run with --apply to write the stamps.",
      },
      null,
      2,
    )}\n`,
  );
}

if (runtimeProcess.argv[1] && resolve(runtimeProcess.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    runtimeProcess.stderr.write(`[stamp-source-type-backfill] fatal: ${String(err instanceof Error ? err.stack || err.message : err)}\n`);
    runtimeProcess.exit(1);
  });
}
