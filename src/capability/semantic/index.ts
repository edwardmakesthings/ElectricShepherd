/**
 * Semantic memory capability (spec §3.2, Rung 3).
 *
 * Owns: doc ingestion, authority ranking, cross-type linking — `concerns`,
 * `es-source-type`. Docs are the authority axis of retrieval: on factual intent
 * a doc-stamped node outranks an unstamped synthesis by construction (the
 * INTENT_AUTHORITY_BOOSTS table + the factual floor), and a hit on a synthesis
 * surfaces its authority docs through the one-hop `concerns` expansion.
 *
 * Binding rule (spec §3.1): this module never calls the substrate directly. The
 * ranking engine lives in adapter/retrieval-expansion.ts (expandScopedRetrieval)
 * over an injected MemgraphClient; this capability exposes the semantic surface
 * — ingest (doc-stamped write), read (authority-ranked retrieval), fail (named
 * errors) — as explicit functions so the layer-shaped suite can drive them with
 * a fake callTool.
 */

import type { MemgraphClient } from "../../core/memgraph.ts";
import { expandScopedRetrieval } from "../../policy/retrieval.ts";
import {
  type NodeAuthority,
  type RankedScopedNode,
  type RetrievalIntent,
  type RetrievalWeights,
} from "../../policy/retrieval-scoring.ts";
import type { RetrievalExpansionOptions, RetrievalExpansionResult } from "../../policy/retrieval-expansion-types.ts";
import { getClosetSourceType, setClosetSourceType } from "./source-type.ts";
import { getConcerns } from "./concerns.ts";
import { getStaleness, getStalenessFlags, setStalenessFlag } from "./staleness.ts";

export { expandScopedRetrieval };
export {
  type NodeAuthority,
  type RankedScopedNode,
  type RetrievalExpansionOptions,
  type RetrievalExpansionResult,
  type RetrievalIntent,
  type RetrievalWeights,
};

export { getClosetSourceType, setClosetSourceType };
export { getConcerns };
export { getStaleness, getStalenessFlags, setStalenessFlag };

/**
 * WRITE contract (Rung 3 §6.3 question 1): a doc is ingested as a drawer stamped
 * `es-source-type: doc` in the scope room, optionally linked to the syntheses it
 * supports via `concerns` edges (synthesis → doc). The stamp is what makes the
 * doc visible to retrieval at all — expandScopedRetrieval's direct-doc-scan and
 * concerns blocks hard-filter on es-source-type: doc, so an unstamped drawer is
 * never admitted. Returns the writes performed so the test can assert the stamp
 * edge exists.
 */
export type DocIngestPlan = {
  drawer: { wing: string; room: string; content: string };
  edges: Array<{ subject: string; predicate: string; object: string }>;
};

export function planDocIngest(args: {
  wing: string;
  room: string;
  content: string;
  drawer_id?: string;
  concerns_synthesis_ids?: string[];
}): DocIngestPlan {
  const drawerId = args.drawer_id || "(new doc drawer)";
  return {
    drawer: { wing: args.wing, room: args.room, content: String(args.content || "") },
    edges: [
      // The authority stamp — the single edge that makes this node a doc.
      { subject: drawerId, predicate: "es-source-type", object: "doc" },
      // Cross-type links: each supporting synthesis points at this doc.
      ...(args.concerns_synthesis_ids || []).map((synthId) => ({
        subject: String(synthId),
        predicate: "concerns",
        object: drawerId,
      })),
    ],
  };
}

/**
 * READ contract (Rung 3 §6.3 question 2): a doc is consumed when authority weight
 * boosts its ranking above outcome history in expandScopedRetrieval — on factual
 * intent the INTENT_AUTHORITY_BOOSTS table gives docs a boost strictly above any
 * unstamped synthesis, and the factual floor clamps a provisional synthesis so it
 * can never outrank a doc. This helper runs the real engine over an injected
 * client and returns the ranked pool, so the test asserts "the doc-stamped node
 * ranks above the unflagged synthesis" against actual consumption, not a write.
 */
export async function readAuthorityRanked(
  client: MemgraphClient,
  options: RetrievalExpansionOptions & { intent?: RetrievalIntent },
): Promise<RetrievalExpansionResult> {
  // Factual intent is the semantic surface's default: it is the only intent that
  // admits docs directly (include_docs implied) and applies the authority floor.
  return expandScopedRetrieval(client, { ...options, intent: options.intent || "factual" });
}

/**
 * FAIL contract (Rung 3 §6.3 question 3): a substrate error during doc ingestion
 * or retrieval surfaces as a named failure, not an empty ranked pool. The
 * MemgraphClient boundary normalizes throwing callers into SubstrateResult; this
 * wrapper distinguishes "engine ran, zero docs in scope" (a legitimate empty)
 * from "the read itself failed" (a named error the caller must see).
 */
export class SemanticReadError extends Error {
  readonly kind: string;
  constructor(kind: string, detail: string) {
    super(detail);
    this.name = "SemanticReadError";
    this.kind = kind;
  }
}

export async function readAuthorityRankedStrict(
  client: MemgraphClient,
  options: RetrievalExpansionOptions & { intent?: RetrievalIntent },
): Promise<RetrievalExpansionResult> {
  try {
    return await expandScopedRetrieval(client, { ...options, intent: options.intent || "factual" });
  } catch (err) {
    // Named failure: a broken substrate must not masquerade as "no docs found".
    const detail = err instanceof Error ? err.message : String(err);
    throw new SemanticReadError("protocol", `semantic retrieval failed: ${detail}`);
  }
}
