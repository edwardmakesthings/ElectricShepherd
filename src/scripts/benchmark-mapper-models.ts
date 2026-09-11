/**
 * Benchmark mapper-model candidates against real drawers.
 *
 * Picking a mapper model by reputation is guesswork: the trait that decides
 * whether a pass consolidates or quarantines is narrow and mechanical — can the
 * model return a parseable JSON array in the mapper contract, for every id it
 * was given, without inventing ids. A model can be excellent at code and still
 * fail that, and a small fast model can pass it every time.
 *
 * So this drives the REAL `callSubagentMapper`, not a reimplementation of its
 * prompt, and scores only what the pipeline actually gates on:
 *
 *   parsed      - parseEmbeddedJSON + toSummaryFromRaw yielded >=1 summary.
 *                 This is the quarantine gate. Everything else is secondary.
 *   covered     - returned a summary for every requested transcript id.
 *   fabricated  - returned ids that were never in the worklist.
 *   populated   - summaries carry non-empty fields. An all-empty summary parses
 *                 and is still useless, so parse rate alone would flatter it.
 *   deadEndsOk  - dead-end lines carry the required outcome/because/polarity
 *                 clauses the contract demands.
 *   ms          - wall clock per drawer.
 *
 * Repeats are the point, not a luxury: a mapper that succeeds 4 times in 5 is
 * not usable, and a single sample cannot tell you which one you have.
 *
 * Read-only. It never writes to the palace, moves a drawer, or creates a node.
 *
 * Usage:
 *   node --experimental-strip-types src/scripts/benchmark-mapper-models.ts \
 *     --models litellm/general-gemma4:26b,litellm/implementer-gemma4-31b \
 *     --wing armet --room source-transcripts-failed --drawers 5 --repeats 3
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createSubstrateClient } from "../core/substrate-client.ts";
import { DEFAULT_MCP_TOOL_PREFIX, DEFAULT_MCP_URL, applyRuntimeConfigToEnv, loadRuntimeConfig } from "../core/runtime-config.ts";
import { asObject, asText, parseRows } from "../core/palace-tools.ts";
import { callSubagentMapper, resolveSubagentRunner, type MapperEnvelope } from "./memory-pipeline/subagent.ts";
import { parseModelSelector } from "./memory-pipeline/runtime-utils.ts";
import { loadRuntimeEnv } from "./runtime-env.ts";

declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  cwd: () => string;
  stdout: { write: (s: string) => void };
  stderr: { write: (s: string) => void };
  exit: (code?: number) => never;
};

type Trial = {
  model: string;
  drawerId: string;
  repeat: number;
  parsed: boolean;
  covered: boolean;
  fabricated: string[];
  populatedFields: number;
  deadEndLines: number;
  deadEndWellFormed: number;
  confidence: string;
  ms: number;
  error?: string;
};

// The contract requires every dead-end line to carry its outcome clause; a line
// without one is a claim with no evidence attached.
const DEAD_END_SHAPE = /outcome:/i;
const DEAD_END_CLAUSES = [/outcome:/i, /because:/i, /polarity:\s*(tried-failed|considered-rejected)/i];

function getArg(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

/** Score one mapper envelope against the ids it was asked for. Exported for tests. */
export function scoreEnvelope(envelope: MapperEnvelope, requestedIds: string[]): Omit<Trial, "model" | "drawerId" | "repeat" | "ms" | "error"> {
  const summaries = envelope.summaries;
  const returned = new Set(summaries.map((s) => s.transcriptId));
  const requested = new Set(requestedIds);

  let populatedFields = 0;
  let deadEndLines = 0;
  let deadEndWellFormed = 0;
  for (const summary of summaries) {
    for (const key of ["durableFacts", "decisions", "rootCausesAndWorkedExamples", "subsystemsAndFiles", "openItems", "deadEnds"] as const) {
      if ((summary[key] ?? []).length > 0) populatedFields += 1;
    }
    for (const line of summary.deadEnds ?? []) {
      deadEndLines += 1;
      if (DEAD_END_CLAUSES.every((pattern) => pattern.test(line))) deadEndWellFormed += 1;
    }
  }

  return {
    parsed: summaries.length > 0,
    covered: requestedIds.every((id) => returned.has(id)),
    fabricated: [...returned].filter((id) => !requested.has(id)),
    populatedFields,
    deadEndLines,
    deadEndWellFormed,
    confidence: summaries[0]?.confidence ?? "-",
  };
}

/** Aggregate trials per model into the comparison row. Exported for tests. */
export function summarize(trials: Trial[]): Record<string, unknown>[] {
  const byModel = new Map<string, Trial[]>();
  for (const trial of trials) {
    byModel.set(trial.model, [...(byModel.get(trial.model) ?? []), trial]);
  }

  return [...byModel.entries()].map(([model, rows]) => {
    const n = rows.length;
    const parsed = rows.filter((r) => r.parsed).length;
    const covered = rows.filter((r) => r.covered).length;
    const fabricated = rows.filter((r) => r.fabricated.length > 0).length;
    const errored = rows.filter((r) => r.error).length;
    const times = rows.map((r) => r.ms).sort((a, b) => a - b);
    const deadEndLines = rows.reduce((sum, r) => sum + r.deadEndLines, 0);
    const deadEndWellFormed = rows.reduce((sum, r) => sum + r.deadEndWellFormed, 0);
    return {
      model,
      trials: n,
      parse_rate: `${parsed}/${n}`,
      coverage_rate: `${covered}/${n}`,
      fabricated_runs: fabricated,
      errored_runs: errored,
      avg_populated_fields: n ? Number((rows.reduce((s, r) => s + r.populatedFields, 0) / n).toFixed(1)) : 0,
      dead_end_format: deadEndLines ? `${deadEndWellFormed}/${deadEndLines}` : "n/a",
      median_ms: times.length ? times[Math.floor(times.length / 2)] : 0,
      max_ms: times.length ? times[times.length - 1] : 0,
    };
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.length === 0) {
    process.stdout.write(
      "Usage: benchmark-mapper-models.ts --models <a,b> [--wing W] [--room R] [--drawers 5] [--repeats 3] [--timeout-ms 600000]\n" +
        "  Read-only. Drives the real mapper against real drawers and scores parse/coverage/latency.\n",
    );
    return;
  }

  const models = String(getArg(argv, "--models") || "").split(",").map((m) => m.trim()).filter(Boolean);
  if (models.length === 0) throw new Error("--models is required (comma-separated <provider>/<model> selectors)");
  for (const model of models) {
    if (!parseModelSelector(model)) throw new Error(`--models entry "${model}" must be <provider>/<model>`);
  }

  const cwd = process.cwd();
  loadRuntimeEnv({ scriptUrl: import.meta.url, env: process.env, cwd });
  const runtimeConfig = loadRuntimeConfig({ cwd, env: process.env });
  applyRuntimeConfigToEnv(process.env, runtimeConfig);

  const wing = getArg(argv, "--wing") || String(runtimeConfig.valuesByPath.memory?.projectWing || "").trim();
  const room = getArg(argv, "--room") || String(runtimeConfig.valuesByPath.sourceCapture?.room || "source-transcripts").trim();
  if (!wing) throw new Error("--wing is required (or set memory.projectWing)");

  const drawerCount = Math.max(1, Number(getArg(argv, "--drawers") || "5"));
  const repeats = Math.max(1, Number(getArg(argv, "--repeats") || "3"));
  const timeoutMs = Math.max(1, Number(getArg(argv, "--timeout-ms") || "600000"));

  const runner = resolveSubagentRunner({
    env: process.env,
    preferKind: String(runtimeConfig.valuesByPath.consolidation?.subagentHarness || "").trim().toLowerCase() as "omp" | "opencode" | undefined,
  });
  if (!runner) throw new Error("no subagent CLI found (opencode/omp)");

  const toolPrefix = String(runtimeConfig.valuesByPath.mcp?.toolPrefix || "").trim() || DEFAULT_MCP_TOOL_PREFIX;
  const { client } = await createSubstrateClient({
    env: process.env,
    clientName: "electric-shepherd-mapper-benchmark",
    urlOverride: String(runtimeConfig.valuesByPath.mcp?.url || DEFAULT_MCP_URL).trim(),
  });

  const listed = await client.callTool(`${toolPrefix}list_drawers`, { wing, room, limit: drawerCount, offset: 0 });
  const drawerIds = parseRows(listed)
    .map((row) => asText(row.drawer_id || row.id).trim())
    .filter(Boolean)
    .slice(0, drawerCount);
  if (drawerIds.length === 0) throw new Error(`no drawers found in ${wing}/${room}`);

  process.stderr.write(
    `[mapper-bench] ${models.length} model(s) x ${drawerIds.length} drawer(s) x ${repeats} repeat(s) = ${models.length * drawerIds.length * repeats} runs via ${runner.kind}\n`,
  );

  const trials: Trial[] = [];
  const outDir = join(cwd, ".electric-shepherd", "scratch", "mapper-bench");
  mkdirSync(outDir, { recursive: true });

  for (const model of models) {
    for (const drawerId of drawerIds) {
      for (let repeat = 1; repeat <= repeats; repeat += 1) {
        const startedAt = Date.now();
        try {
          const envelope = await callSubagentMapper({
            toolPrefix,
            readTool: (name, toolArgs) => client.callTool(name, toolArgs),
            mapperAgentName: getArg(argv, "--mapper-agent") || "dream-mapper",
            activeModel: parseModelSelector(model),
            query: "memory consolidation candidates",
            wing,
            room,
            worklistIds: [drawerId],
            runner,
            esRoot: resolve(fileURLToPath(import.meta.url), "..", "..", ".."),
            timeoutMs,
          });
          const score = scoreEnvelope(envelope, [drawerId]);
          trials.push({ model, drawerId, repeat, ms: Date.now() - startedAt, ...score });
          writeFileSync(
            join(outDir, `${model.replace(/[^a-z0-9]+/gi, "-")}__${drawerId}__r${repeat}.json`),
            JSON.stringify(envelope.raw, null, 2),
            "utf8",
          );
          process.stderr.write(
            `[mapper-bench] ${model} ${drawerId} r${repeat}: parsed=${score.parsed} covered=${score.covered} ${Date.now() - startedAt}ms\n`,
          );
        } catch (err) {
          trials.push({
            model, drawerId, repeat, ms: Date.now() - startedAt,
            parsed: false, covered: false, fabricated: [], populatedFields: 0,
            deadEndLines: 0, deadEndWellFormed: 0, confidence: "-",
            error: String(err),
          });
          process.stderr.write(`[mapper-bench] ${model} ${drawerId} r${repeat}: ERROR ${String(err)}\n`);
        }
      }
    }
  }

  process.stdout.write(`${JSON.stringify({ wing, room, drawerIds, repeats, runner: runner.kind, summary: summarize(trials), trials, raw_output_dir: outDir }, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    process.stderr.write(`[mapper-bench] ${String(err)}\n`);
    process.exit(1);
  });
}
