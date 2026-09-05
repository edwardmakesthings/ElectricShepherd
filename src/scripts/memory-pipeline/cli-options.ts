/**
 * CLI option parsing for the memory consolidation + validation pipeline.
 * Extracted from run-memory-consolidation-and-validation.ts (criterion 2).
 */
import type { SynthesisConsolidationOptions, TranscriptInsightSummary } from "../../capability/episodic/synthesis-consolidation.ts";
import type { ValidationMergeReviewOptions } from "../../policy/validation-merge-review.ts";
import type { CadenceArea, CadenceOrchestratorOptions } from "../../policy/cadence-orchestrator.ts";
import { loadRuntimeConfig } from "../../core/runtime-config.ts";

export type WorklistMode = "unconsolidated" | "all";

export type WorklistOptions = {
  mode: WorklistMode;
  limit: number;
  batchSize: number;
  sourceRoom: string;
  processedRoom: string;
  failedRoom: string;
  retryFailedOnly: boolean;
  moveAlreadyConsolidated: boolean;
};

export type MemcoreApplyOptions = {
  enabled: boolean;
  filePath?: string;
  baseDir?: string;
  scopeDir?: string;
};

export type CadenceState = {
  lastRunISO: string;
  areas: Record<string, { lastCandidateCount: number; lastTriggeredISO?: string }>;
};

export function getArg(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index >= 0 && index + 1 < argv.length) return argv[index + 1];
  return undefined;
}

export function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

export function parseCSV(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

export function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function parsePositiveInt(value: unknown, fallback: number, min = 1): number {
  const raw = String(value ?? "").trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.floor(parsed));
}

export function tryReadFile(path: string): string | undefined {
  // Lazy import to avoid circular deps at module load
  const { existsSync, readFileSync } = require("node:fs") as typeof import("node:fs");
  if (!existsSync(path)) return undefined;
  return readFileSync(path, "utf8");
}

export function parseMapperSummariesFromFile(path: string | undefined): TranscriptInsightSummary[] | undefined {
  if (!path) return undefined;
  const raw = tryReadFile(path);
  if (!raw) return undefined;
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? (parsed as TranscriptInsightSummary[]) : undefined;
}

export function parseCadenceAreas(path: string | undefined): CadenceArea[] {
  if (!path) return [];
  const raw = tryReadFile(path);
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? (parsed as CadenceArea[]) : [];
}

export function parseCadenceState(path: string): CadenceState {
  const raw = tryReadFile(path);
  if (!raw) {
    return { lastRunISO: "", areas: {} };
  }
  const parsed = JSON.parse(raw);
  const obj = asObject(parsed);
  return {
    lastRunISO: asString(obj.lastRunISO),
    areas: asObject(obj.areas) as Record<string, { lastCandidateCount: number; lastTriggeredISO?: string }>,
  };
}

export function parseConsolidationOptions(argv: string[], runtimeConfig: ReturnType<typeof loadRuntimeConfig>): SynthesisConsolidationOptions {
  const runCadence = hasFlag(argv, "--run-cadence");

  const defaultSourceWing =
    String(runtimeConfig.valuesByPath.sourceCapture?.wing || runtimeConfig.valuesByPath.memory?.projectWing || "opencode").trim() ||
    "opencode";
  const defaultSourceRoom =
    String(runtimeConfig.valuesByPath.sourceCapture?.room || "source-transcripts").trim() ||
    "source-transcripts";

  let query = getArg(argv, "--query") || "memory consolidation candidates";
  let targetWing = getArg(argv, "--wing") || getArg(argv, "--target-wing") || getArg(argv, "--scope-wing") || defaultSourceWing;
  let targetRoom = getArg(argv, "--room") || getArg(argv, "--target-room") || getArg(argv, "--scope-room") || defaultSourceRoom;

  if ((!query || !targetWing || !targetRoom) && runCadence) {
    query = query || "memory consolidation candidates";
    targetWing = targetWing || defaultSourceWing;
    targetRoom = targetRoom || defaultSourceRoom;
  }

  const mapperSummaries = parseMapperSummariesFromFile(getArg(argv, "--mapper-summaries-file"));

  return {
    query,
    targetWing,
    targetRoom,
    targetHall: getArg(argv, "--target-hall") || getArg(argv, "--hall") || undefined,
    searchLimit: Number(getArg(argv, "--search-limit") || runtimeConfig.valuesByPath.consolidation?.searchLimit || "12"),
    minimumDistinctSources: Number(getArg(argv, "--min-sources") || "2"),
    minimumContentCharacters: Number(getArg(argv, "--min-content-chars") || "220"),
    minimumPopulatedSections: Number(getArg(argv, "--min-section-count") || "3"),
    minimumMapperConfidence: (getArg(argv, "--mapper-confidence-floor") as "high" | "medium" | "low" | undefined) || "medium",
    labels: parseCSV(getArg(argv, "--labels")),
    writeDurableFactsToKg: !hasFlag(argv, "--no-kg-durable-facts"),
    applyWrites: hasFlag(argv, "--apply"),
    mapperSummaries,
  };
}

export function parseWorklistOptions(argv: string[], runtimeConfig: ReturnType<typeof loadRuntimeConfig>): WorklistOptions {
  const allMode = hasFlag(argv, "--all") || hasFlag(argv, "--full-scope") || hasFlag(argv, "--reprocess-all");
  const limit = Number(getArg(argv, "--worklist-limit") || getArg(argv, "--search-limit") || "200");
  const batchSize = Math.max(1, Number(getArg(argv, "--batch-size") || "1"));
  const defaultSourceRoom =
    String(runtimeConfig.valuesByPath.sourceCapture?.room || "source-transcripts").trim() ||
    "source-transcripts";
  const scopeRoom = getArg(argv, "--room") || getArg(argv, "--target-room") || getArg(argv, "--scope-room") || defaultSourceRoom;
  const processedRoom = getArg(argv, "--processed-room") || `${scopeRoom}-processed`;
  const failedRoom = getArg(argv, "--failed-room") || `${scopeRoom}-failed`;
  const retryFailedOnly = hasFlag(argv, "--retry-failed-only");
  const moveAlreadyConsolidated = !hasFlag(argv, "--no-move-already-consolidated");
  return {
    mode: allMode ? "all" : "unconsolidated",
    limit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 200,
    batchSize,
    sourceRoom: scopeRoom,
    processedRoom,
    failedRoom,
    retryFailedOnly,
    moveAlreadyConsolidated,
  };
}

export function parseValidationOptions(
  argv: string[],
  consolidation: SynthesisConsolidationOptions,
  runtimeConfig: ReturnType<typeof loadRuntimeConfig>,
): ValidationMergeReviewOptions {
  const scopeRoom = getArg(argv, "--scope-room") || consolidation.targetRoom;
  return {
    scopeRoom,
    scopeWing: getArg(argv, "--scope-wing") || consolidation.targetWing,
    filterWing: getArg(argv, "--wing") || getArg(argv, "--target-wing") || consolidation.targetWing,
    filterRoom: getArg(argv, "--room") || getArg(argv, "--target-room") || consolidation.targetRoom,
    includeMergedNodes: hasFlag(argv, "--include-merged"),
    validationDepth: Number(getArg(argv, "--validation-depth") || "6"),
    validationLimit: Number(getArg(argv, "--validation-limit") || "50"),
    mergeSimilarityThreshold: Number(getArg(argv, "--merge-threshold") || "0.82"),
    mergeLimit: Number(getArg(argv, "--merge-limit") || "20"),
    mergeMaxNodes: Number(getArg(argv, "--merge-max-nodes") || "300"),
    mergeMaxDepth: Number(getArg(argv, "--merge-max-depth") || "20"),
    applyMerges: hasFlag(argv, "--apply-merges"),
    automaticMergeScore: Number(getArg(argv, "--allow-auto-merge-score") || "0.92"),
    notificationURL: getArg(argv, "--ntfy-url") || String(runtimeConfig.valuesByPath.notifications?.ntfyUrl || ""),
    escalationTopic: getArg(argv, "--escalation-topic") || "electric-shepherd-escalations",
  };
}

export function parseCadenceOptions(argv: string[], consolidation: SynthesisConsolidationOptions): CadenceOrchestratorOptions {
  const fromFile = parseCadenceAreas(getArg(argv, "--areas-file"));
  const fallbackArea: CadenceArea = {
    areaId: getArg(argv, "--area-id") || "default-area",
    query: consolidation.query,
    targetWing: consolidation.targetWing,
    targetRoom: consolidation.targetRoom,
    scopeRoom: getArg(argv, "--scope-room") || consolidation.targetRoom,
    scopeWing: getArg(argv, "--scope-wing") || consolidation.targetWing,
    volumeThreshold: Number(getArg(argv, "--volume-threshold") || "8"),
  };

  return {
    areas: fromFile.length > 0 ? fromFile : [fallbackArea],
    executionMode: (getArg(argv, "--cadence-mode") as "plan" | "execute" | undefined) || "plan",
    defaultVolumeThreshold: Number(getArg(argv, "--volume-threshold") || "8"),
    defaultSearchLimit: Number(getArg(argv, "--search-limit") || "20"),
    idleWindowMinutes: Number(getArg(argv, "--idle-window-minutes") || "20"),
    currentIdleMinutes: Number(getArg(argv, "--current-idle-minutes") || "0"),
    runNightlyBackstop: hasFlag(argv, "--nightly-backstop"),
    applyWrites: hasFlag(argv, "--apply"),
    applyMerges: hasFlag(argv, "--apply-merges"),
    ...(parseCalibrationOptions(argv) ? { calibration: parseCalibrationOptions(argv)! } : {}),
  };
}

export function parseCalibrationOptions(argv: string[]): CadenceOrchestratorOptions["calibration"] | undefined {
  const modelsRaw = getArg(argv, "--calibration-models") || "";
  const models = modelsRaw.split(",").map((m) => m.trim()).filter(Boolean);
  if (models.length === 0) return undefined;
  const shapesRaw = getArg(argv, "--calibration-shapes") || "";
  const shapeKeys = shapesRaw.split(",").map((s) => s.trim()).filter(Boolean);
  const minSampleRaw = getArg(argv, "--calibration-min-sample") || "";
  const minSample = minSampleRaw ? Number(minSampleRaw) : undefined;
  return { models, ...(shapeKeys.length > 0 ? { shapeKeys } : {}), ...(minSample && Number.isFinite(minSample) ? { minSample } : {}) };
}

export function parseMemcoreApply(argv: string[]): MemcoreApplyOptions {
  const disabled = hasFlag(argv, "--no-mem-core-auto");
  const enabled = !disabled || hasFlag(argv, "--apply-mem-core");

  return {
    enabled,
    filePath: getArg(argv, "--mem-core-file") || undefined,
    baseDir: getArg(argv, "--mem-core-dir") || undefined,
    scopeDir: getArg(argv, "--mem-core-scope-dir") || undefined,
  };
}

export function usage(): string {
  return [
    "Usage:",
    "  node scripts/run-memory-consolidation-and-validation.ts [--query <text>] [--wing <wing>] [--room <room>] [flags]",
    "",
    "Consolidation flags:",
    "  --search-limit <n>",
    "  --min-sources <n>",
    "  --min-content-chars <n>",
    "  --min-section-count <n>",
    "  --mapper-confidence-floor <high|medium|low>",
    "  --mapper-summaries-file <path-to-json-array>",
    "  --use-live-mapper                (invoke dream-mapper via opencode run)",
    "  --mapper-agent <name>            (default: dream-mapper)",
    "  --all | --full-scope             (worklist mode: reprocess all source drawers in scope)",
    "  --room <room>                    (source room; default: ESHEPHERD_SOURCE_CAPTURE_ROOM or source-transcripts)",
    "  --retry-failed-only              (source room becomes <room>-failed or --failed-room)",
    "  --batch-size <n>                 (transcript families per subagent run; default: 1)",
    "  --worklist-limit <n>             (max source drawers enumerated; default: 200)",
    "  --processed-room <room>          (default: <room>-processed)",
    "  --failed-room <room>             (default: <room>-failed)",
    "  --no-move-already-consolidated   (do not auto-move already-consolidated sources)",
    "  --labels <csv>",
    "  --apply                          (creates derived drawers if checks pass; default is dry-run)",
    "",
    "Validation + Merge Review flags:",
    "  --scope-room <room>",
    "  --scope-wing <wing>",
    "  --validation-depth <n>",
    "  --validation-limit <n>",
    "  --merge-threshold <float>",
    "  --merge-limit <n>",
    "  --allow-auto-merge-score <float>",
    "  --apply-merges                   (applies auto-merge decisions; default is read-only)",
    "  --ntfy-url <url>",
    "  --escalation-topic <topic>",
    "  --use-live-auditor               (invoke dream-auditor via opencode run)",
    "  --auditor-agent <name>           (default: dream-auditor)",
    "",
    "Mem-core apply flags:",
    "  --apply-mem-core                 (legacy explicit flag; mem-core auto write is on by default)",
    "  --no-mem-core-auto               (disable automatic mem-core file output)",
    "  --mem-core-dir <path>            (base dir; default: ./.electric-shepherd/memory)",
    "  --mem-core-scope-dir <path>      (scope directory used to place layered memory.md under the base dir)",
    "  --mem-core-file <path>           (full override path for one output file)",
    "",
    "Cadence Orchestrator flags:",
    "  --run-cadence                    (include cadence orchestration in output)",
    "  --cadence-mode <plan|execute>",
    "  --areas-file <path-to-json-array>",
    "  --area-id <id>                   (fallback area id when no areas file)",
    "  --volume-threshold <n>",
    "  --idle-window-minutes <n>",
    "  --current-idle-minutes <n>",
    "  --nightly-backstop",
    "  --cadence-state-file <path>      (persist area counters/trigger timestamps)",
    "  --include-base-pipeline          (also run top-level consolidation+validation when --run-cadence is set)",
    "  --opencode-bin <path>            (default: opencode; used for live subagent fallback)",
    "  --no-native-coord                (force standalone lockfile path; bypass MemPalace native coordinator)",
    "",
    "Output:",
    "  JSON envelope: { worklist, worklistMode, consolidation, validationMergeReview, mapper?, auditor?, memCoreApply?, cadence?, cadenceState? }",
    "",
    "Read-only defaults:",
    "  Without --apply and --apply-merges, the run proposes consolidation/merge decisions but does not write them to MemPalace.",
    "  mem-core render remains enabled by default and writes local files only.",
  ].join("\n");
}
