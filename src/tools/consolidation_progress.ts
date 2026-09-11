/**
 * Read the current/last consolidation run's progress from the run-event log.
 *
 * The run writes progress to `.electric-shepherd/consolidation-runs.ndjson` as it
 * goes, but nothing surfaced it to the agent, so a multi-minute pass looked
 * identical to a hung one from inside a session. This reads the tail of that log
 * and returns the latest counters — it never blocks and never tails forever.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { defineTool } from "./contract.ts";
import { applyRuntimeConfigToEnv, loadRuntimeConfig } from "../core/runtime-config.ts";
import { loadRuntimeEnv } from "../scripts/runtime-env.ts";

declare const process: { env: Record<string, string | undefined> };

// Progress lines are small; this is enough for many runs without reading a
// multi-megabyte log into memory.
const TAIL_BYTES = 256 * 1024;

export type RunProgress = {
  run_id: string;
  status: string;
  phase: string;
  updated_at: string;
  stale_seconds: number;
  counters: Record<string, number>;
  recent_phases: { at: string; phase: string; chunk?: string }[];
};

/** Parse the run-event log tail into the latest state per run. Exported for tests. */
export function parseRunEvents(text: string, nowMs: number): RunProgress[] {
  const byRun = new Map<string, RunProgress>();
  const phasesByRun = new Map<string, { at: string; phase: string; chunk?: string }[]>();

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue; // a partial first line from the byte-offset read
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const runId = String(event.runId || "").trim();
    if (!runId) continue;

    const counters = (event.counters || {}) as Record<string, number>;
    const at = String(event.ts || "");
    const phase = String(event.phase || "");
    const chunkIndex = Number(counters.chunkIndex);
    const chunkTotal = Number(counters.chunkTotal);

    const phases = phasesByRun.get(runId) ?? [];
    if (phase) {
      phases.push({
        at,
        phase,
        chunk: Number.isFinite(chunkIndex) && chunkTotal ? `${chunkIndex}/${chunkTotal}` : undefined,
      });
      phasesByRun.set(runId, phases);
    }

    const updatedMs = Date.parse(at);
    byRun.set(runId, {
      run_id: runId,
      status: String(event.status || ""),
      phase,
      updated_at: at,
      stale_seconds: Number.isFinite(updatedMs) ? Math.max(0, Math.round((nowMs - updatedMs) / 1000)) : -1,
      counters,
      recent_phases: [],
    });
  }

  for (const [runId, progress] of byRun) {
    progress.recent_phases = (phasesByRun.get(runId) ?? []).slice(-8);
  }

  return [...byRun.values()].sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
}

export default defineTool({
  name: "consolidation_progress",
  description:
    "Report progress of the running (or most recent) consolidation pass: run id, phase, chunk index vs total, and examined/processed/failed/created counters, plus how many seconds since the last update. Read-only and instant — it reads the run-event log, it does not wait for the run. Call it to check whether a long pass is advancing instead of assuming it hung.",
  args: (s) => ({
    runs: s.number().optional().describe("How many recent runs to report (default 1, max 10)."),
    project_root: s.string().optional().describe("Project root holding .electric-shepherd/ (defaults to cwd)."),
  }),
  async execute(args, { cwd }) {
    loadRuntimeEnv({ scriptUrl: import.meta.url, env: process.env, cwd });
    const runtimeConfig = loadRuntimeConfig({ cwd, env: process.env });
    applyRuntimeConfigToEnv(process.env, runtimeConfig);

    const root = String(args.project_root || process.env.ESHEPHERD_PROJECT_ROOT || cwd);
    const logPath = join(root, ".electric-shepherd", "consolidation-runs.ndjson");
    if (!existsSync(logPath)) {
      return json({ found: false, log_path: logPath, next_step: "No consolidation has run in this project yet." });
    }

    const size = statSync(logPath).size;
    const handle = readFileSync(logPath);
    const text = handle.subarray(Math.max(0, size - TAIL_BYTES)).toString("utf8");

    const limit = Math.max(1, Math.min(10, Math.floor(Number(args.runs) || 1)));
    const runs = parseRunEvents(text, Date.now()).slice(0, limit);
    if (runs.length === 0) {
      return json({ found: false, log_path: logPath, next_step: "Run-event log exists but holds no parseable progress yet." });
    }

    const latest = runs[0];
    const done = latest.status !== "running";
    return json({
      found: true,
      log_path: logPath,
      runs,
      next_step: done
        ? `Most recent run ended with status="${latest.status}".`
        : `Run ${latest.run_id} is at ${latest.phase} (chunk ${latest.counters.chunkIndex ?? "?"}/${latest.counters.chunkTotal ?? "?"}), last update ${latest.stale_seconds}s ago. Re-call to refresh; do not assume a stall under ~120s.`,
    });
  },
});

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
