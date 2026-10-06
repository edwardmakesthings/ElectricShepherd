import { join } from "node:path";
import { admitDrawerText, type WorkerPolicy } from "./raw-text-worker.ts";
import { extractSourceChunks } from "./chunk-extraction.ts";
import { reconcileSourceTopics, type ReconcileTopicFn } from "./topic-reconciliation.ts";
import type { LoadedSource } from "./source-loading.ts";
import type { ChunkConsolidationOutcome } from "./chunk-consolidation.ts";

export type SourceDraftArgs = {
  source: LoadedSource; query: string; runId?: string; checkpointDirectory: string; extractorVersion: string;
  mapChunk: Parameters<typeof extractSourceChunks>[0]["mapChunk"];
  reducerVersion: string; reconcileTopic: ReconcileTopicFn;
} & WorkerPolicy;

/** Shared draft pipeline has no substrate, write, retirement, or mem-core capability. */
export async function runSourceDraft(args: SourceDraftArgs): Promise<ChunkConsolidationOutcome> {
  const inventory = args.source.inventory, deadlineMs = args.deadlineMs ?? Date.now() + 30 * 60_000;
  const outcome: ChunkConsolidationOutcome = { parentDrawerId: inventory.parentDrawerId,
    familyIds: [...new Set([inventory.parentDrawerId, ...inventory.chunks.map(chunk => chunk.drawerId)])],
    completed: false, replacementCoverage: false, drafts: [] };
  try {
    const extraction = await extractSourceChunks({ inventory, readChunk: args.source.readChunk,
      checkpointDirectory: join(args.checkpointDirectory, "extraction"), extractorVersion: args.extractorVersion,
      mapChunk: args.mapChunk, deadlineMs, timeoutMs: args.timeoutMs });
    outcome.extraction = extraction;
    if (!extraction.extractionComplete) throw new Error(extraction.preprocessing?.status === "policy-only"
      ? "policy-only/no-substantive-source" : "chunk-extraction-incomplete");
    const reconciliation = await reconcileSourceTopics({ extraction, reducerVersion: args.reducerVersion,
      checkpointDirectory: join(args.checkpointDirectory, "reconciliation"), reconcileTopic: args.reconcileTopic,
      deadlineMs, timeoutMs: args.timeoutMs });
    outcome.reconciliation = reconciliation;
    for (const grouped of reconciliation.topics) {
      const provenance = { parentDrawerId: inventory.parentDrawerId, sourceVersion: extraction.sourceVersion,
        reconciliationVersion: reconciliation.reconciliationVersion, topicKey: grouped.key,
        contributingChunkIds: grouped.contributingChunkIds, inputBatchIds: grouped.inputBatchIds,
        sourceChronology: [...(extraction.preprocessing?.sourceChronology ?? [{ sourceDrawerId: inventory.parentDrawerId }]),
          ...(inventory.sourceChronology ?? [])],
        ...(inventory.localSource ? { localSource: inventory.localSource } : {}),
        attribution: "conservative-primary-batches; not per-claim grounding or semantic verification" };
      outcome.drafts.push({ route: "raw-text", content: admitDrawerText(grouped.content), query: args.query,
        runId: args.runId, sourceDrawerIds: [inventory.parentDrawerId], provenance, substanceGuard: { passed: true } });
    }
    // Local identity must still match after reduction, including cache-only runs.
    if (inventory.localSource) for (const chunk of inventory.chunks) await args.source.readChunk(chunk.chunkIndex);
  } catch (error) { outcome.drafts = []; outcome.error = String(error); }
  return outcome;
}
