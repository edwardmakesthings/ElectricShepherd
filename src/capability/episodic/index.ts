/**
 * Episodic memory capability (spec §3.2, Rung 3).
 *
 * Owns: transcript capture, consolidation, the synthesis DAG
 * (`synthesized-from`, `consolidated-into`, `merged-into`).
 *
 * Binding rule (spec §3.1): this module never calls the substrate directly. It
 * operates on an injected MemgraphClient — the published interface over the
 * core/ substrate seam — and every write/read/fail path is an explicit, named
 * function so the layer-shaped test suite can drive it with a fake callTool.
 *
 * The heavy lifting (map/reduce + inflation guard + lineage writes) already
 * lives in adapter/synthesis-consolidation.ts; this module re-exports it as the
 * episodic capability surface and adds the capture-side contract that the
 * turn-guard source-capture path exercises.
 */

import type { MemgraphClient } from "../../core/memgraph.ts";
import {
  runSynthesisConsolidation,
  type ConsolidationConfidence,
  type InflationGuardResult,
  type SynthesisConsolidationOptions,
  type SynthesisConsolidationResult,
  type TranscriptInsightSummary,
} from "./synthesis-consolidation.ts";

export {
  runSynthesisConsolidation,
  type ConsolidationConfidence,
  type InflationGuardResult,
  type SynthesisConsolidationOptions,
  type SynthesisConsolidationResult,
  type TranscriptInsightSummary,
};

/**
 * WRITE contract (Rung 3 §6.3 question 1): a consolidation with applyWrites and
 * a passing inflation guard produces one synthesis drawer plus its lineage —
 * `synthesized-from` edges from the new node to every distinct source transcript
 * (≥2 by construction of the guard) and the in-hall/durable-fact KG writes.
 * The result reports exactly what was written; a failed substrate call surfaces
 * as a named error in kgWrites.errors / createResult, never as a silent empty
 * node id.
 */
export async function writeEpisodicSynthesis(
  client: MemgraphClient,
  options: SynthesisConsolidationOptions,
): Promise<SynthesisConsolidationResult> {
  return runSynthesisConsolidation(client, options);
}

/**
 * READ contract (Rung 3 §6.3 question 2): an episodic node is consumed when it
 * reaches scoped retrieval (expandScopedRetrieval admits nodes with a
 * synthesized-from lineage into the pool) or appears in the mem-core render.
 * This helper asks the substrate directly for the node's lineage so the read
 * check can assert reachability without re-implementing ranking: a node with ≥2
 * distinct sources is, by construction, reachable from any of those sources'
 * derivatives.
 */
export async function readEpisodicLineage(
  client: MemgraphClient,
  nodeId: string,
  maxDepth = 20,
): Promise<{ sources: string[]; derivatives: string[] }> {
  const [sourcesRaw, derivativesRaw] = await Promise.all([
    client.getLineageSources(nodeId, maxDepth),
    client.getLineageDerivatives(nodeId, maxDepth),
  ]);
  const extract = (raw: unknown): string[] => {
    const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const pools = [obj.node_ids, obj.nodes, obj.results, obj.items];
    const out: string[] = [];
    for (const pool of pools) {
      if (!Array.isArray(pool)) continue;
      for (const item of pool) {
        const id = typeof item === "string" ? item : (item as Record<string, unknown>)?.node_id ?? (item as Record<string, unknown>)?.id;
        if (typeof id === "string" && id.trim()) out.push(id.trim());
      }
    }
    return [...new Set(out)];
  };
  return { sources: extract(sourcesRaw), derivatives: extract(derivativesRaw) };
}

/**
 * FAIL contract (Rung 3 §6.3 question 3): a substrate error mid-consolidation
 * must surface as a named, operator-visible failure — not an empty result. The
 * MemgraphClient boundary normalizes throwing callers into SubstrateResult, so
 * this wrapper detects the failed create (no node id + a recorded failure) and
 * throws a named EpisodicWriteError carrying the kind, letting the caller branch
 * on it instead of treating "no createdNodeId" as success.
 */
export class EpisodicWriteError extends Error {
  readonly kind: string;
  constructor(kind: string, detail: string) {
    super(detail);
    this.name = "EpisodicWriteError";
    this.kind = kind;
  }
}

export async function writeEpisodicSynthesisStrict(
  client: MemgraphClient,
  options: SynthesisConsolidationOptions,
): Promise<SynthesisConsolidationResult> {
  const result = await runSynthesisConsolidation(client, { ...options, applyWrites: true });
  if (result.inflationGuard.passed && !result.createdNodeId) {
    // The guard admitted the synthesis but no node id came back: either the
    // create call failed or it returned an unrecognized shape. Surface it as a
    // named error rather than letting callers see "passed, nothing written".
    const detail = result.kgWrites?.errors?.[0] || "createDerivedDrawer returned no node id";
    throw new EpisodicWriteError("protocol", `episodic synthesis write failed: ${detail}`);
  }
  return result;
}
