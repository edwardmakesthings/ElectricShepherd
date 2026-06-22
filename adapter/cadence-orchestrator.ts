import type { MemgraphClient } from "./memgraph.ts";
import {
  runSynthesisConsolidation,
  type SynthesisConsolidationOptions,
  type SynthesisConsolidationResult,
} from "./synthesis-consolidation.ts";
import {
  runValidationMergeReview,
  type ValidationMergeReviewOptions,
  type ValidationMergeReviewResult,
} from "./validation-merge-review.ts";

/**
 * One policy area monitored by cadence orchestration.
 */
export type CadenceArea = {
  areaId: string;
  query: string;
  targetWing: string;
  targetRoom: string;
  scopeRoom: string;
  scopeWing?: string;
  volumeThreshold?: number;
  searchLimit?: number;
};

/**
 * Execution mode for cadence orchestration.
 * - plan: report what would run
 * - execute: run consolidation + validation for triggered areas
 */
export type CadenceExecutionMode = "plan" | "execute";

/**
 * Options for cadence orchestration.
 */
export type CadenceOrchestratorOptions = {
  areas: CadenceArea[];
  executionMode?: CadenceExecutionMode;
  defaultVolumeThreshold?: number;
  defaultSearchLimit?: number;
  idleWindowMinutes?: number;
  currentIdleMinutes?: number;
  runNightlyBackstop?: boolean;
  applyWrites?: boolean;
  applyMerges?: boolean;
  consolidationDefaults?: Partial<Omit<SynthesisConsolidationOptions, "query" | "targetWing" | "targetRoom">>;
  validationDefaults?: Partial<Omit<ValidationMergeReviewOptions, "scopeRoom">>;
};

export type CadenceTrigger = "volume-threshold" | "idle-window" | "nightly-backstop";

export type AreaCadencePlan = {
  areaId: string;
  query: string;
  targetWing: string;
  targetRoom: string;
  scopeRoom: string;
  candidateCount: number;
  threshold: number;
  triggered: boolean;
  triggerReasons: CadenceTrigger[];
};

export type CadenceExecutionResult = {
  areaId: string;
  consolidation: SynthesisConsolidationResult;
  validation: ValidationMergeReviewResult;
};

export type CadenceOrchestratorResult = {
  phase: "cadence-orchestrator";
  executionMode: CadenceExecutionMode;
  plan: AreaCadencePlan[];
  executed: CadenceExecutionResult[];
};

type GenericObject = Record<string, unknown>;

function asObject(value: unknown): GenericObject {
  return value && typeof value === "object" ? (value as GenericObject) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function countUniqueCandidateIds(searchResult: unknown): number {
  const result = asObject(searchResult);
  const pools = [
    ...asArray(result.results),
    ...asArray(result.drawers),
    ...asArray(result.matches),
    ...asArray(result.items),
    ...asArray(result.nodes),
  ];

  const ids = new Set<string>();
  for (const raw of pools) {
    const obj = asObject(raw);
    const id = asString(obj.drawer_id || obj.node_id || obj.id || obj.canonical_node_id).trim();
    if (id) ids.add(id);
  }
  return ids.size;
}

/**
 * Cadence orchestration: queue by observed volume, trigger by idle/nightly conditions,
 * and optionally execute consolidation/validation for triggered areas.
 */
export async function runCadenceOrchestrator(
  client: MemgraphClient,
  options: CadenceOrchestratorOptions,
): Promise<CadenceOrchestratorResult> {
  const executionMode: CadenceExecutionMode = options.executionMode || "plan";
  const defaultVolumeThreshold = Math.max(1, Number(options.defaultVolumeThreshold ?? 8));
  const defaultSearchLimit = Math.max(1, Number(options.defaultSearchLimit ?? 20));
  const idleWindowMinutes = Math.max(0, Number(options.idleWindowMinutes ?? 20));
  const currentIdleMinutes = Math.max(0, Number(options.currentIdleMinutes ?? 0));
  const runNightlyBackstop = Boolean(options.runNightlyBackstop);
  const applyWrites = Boolean(options.applyWrites);
  const applyMerges = Boolean(options.applyMerges);

  const plan: AreaCadencePlan[] = [];
  const executed: CadenceExecutionResult[] = [];

  for (const area of options.areas) {
    const searchLimit = Math.max(1, Number(area.searchLimit ?? defaultSearchLimit));
    const threshold = Math.max(1, Number(area.volumeThreshold ?? defaultVolumeThreshold));

    const rawSearch = await client.search(area.query, searchLimit, area.targetWing, area.targetRoom).catch(() => ({}));
    const candidateCount = countUniqueCandidateIds(rawSearch);

    const triggerReasons: CadenceTrigger[] = [];
    if (candidateCount >= threshold) {
      triggerReasons.push("volume-threshold");
    }
    if (currentIdleMinutes >= idleWindowMinutes && candidateCount > 0) {
      triggerReasons.push("idle-window");
    }
    if (runNightlyBackstop && candidateCount > 0) {
      triggerReasons.push("nightly-backstop");
    }

    const triggered = triggerReasons.length > 0;

    const item: AreaCadencePlan = {
      areaId: area.areaId,
      query: area.query,
      targetWing: area.targetWing,
      targetRoom: area.targetRoom,
      scopeRoom: area.scopeRoom,
      candidateCount,
      threshold,
      triggered,
      triggerReasons,
    };
    plan.push(item);

    if (!triggered || executionMode !== "execute") {
      continue;
    }

    const consolidation = await runSynthesisConsolidation(client, {
      query: area.query,
      targetWing: area.targetWing,
      targetRoom: area.targetRoom,
      applyWrites,
      ...(options.consolidationDefaults || {}),
    });

    const validation = await runValidationMergeReview(client, {
      scopeRoom: area.scopeRoom,
      scopeWing: area.scopeWing,
      filterWing: area.targetWing,
      filterRoom: area.targetRoom,
      applyMerges,
      ...(options.validationDefaults || {}),
    });

    executed.push({
      areaId: area.areaId,
      consolidation,
      validation,
    });
  }

  return {
    phase: "cadence-orchestrator",
    executionMode,
    plan,
    executed,
  };
}
