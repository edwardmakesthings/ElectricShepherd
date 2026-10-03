import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MemgraphClient } from "../../core/memgraph.ts";
import { parseFacts } from "../../core/palace-tools.ts";
import { logicalParentDrawerId } from "../../core/drawer-metadata.ts";
import { runSynthesisConsolidation, type SynthesisConsolidationOptions, type SynthesisConsolidationResult } from "../../capability/episodic/synthesis-consolidation.ts";
import { parseDeadEndLine } from "../../capability/negative/dead-ends.ts";
import { asObject, asString } from "./cli-options.ts";
import { extractSourceChunks, type SourceChunkInventory, type ChunkExtractionResult } from "./chunk-extraction.ts";
import { parseCompleteJSON } from "./complete-json.ts";
import { reconcileSourceTopics, type ReconcileTopicFn, type TopicReconciliationResult } from "./topic-reconciliation.ts";

type WriteState = { contentHash: string; status: "writing" | "returned" | "verified"; drawerId?: string };
type Coverage = {
  schemaVersion: 1; parentDrawerId: string; sourceVersion: string;
  writes: Record<string, WriteState>; extraction: ChunkExtractionResult;
  reconciliation: TopicReconciliationResult;
  completed: boolean;
};
type TopicPlan = { key: string; content: string; chunkIds: string[]; rulesOut?: string[] };
export type ChunkConsolidationOutcome = {
  parentDrawerId: string; familyIds: string[]; completed: boolean; replacementCoverage: boolean;
  drafts: SynthesisConsolidationResult[]; extraction?: ChunkExtractionResult; reconciliation?: TopicReconciliationResult; error?: string;
};
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function requireValue(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

/** Discover the complete physical inventory from the logical drawer's supported metadata. */
export async function discoverSourceChunks(client: MemgraphClient, sourceId: string): Promise<SourceChunkInventory> {
  let row = asObject(await client.getDrawer({ drawer_id: sourceId }));
  requireValue(row.drawer_id === sourceId, "source-discovery-missing-drawer");
  const physicalParent = logicalParentDrawerId(row.metadata);
  const isPhysical = Boolean(physicalParent && physicalParent !== sourceId);
  const parentDrawerId = physicalParent || sourceId;
  if (isPhysical) row = asObject(await client.getDrawer({ drawer_id: parentDrawerId }));
  requireValue(row.drawer_id === parentDrawerId, "source-discovery-missing-parent");
  const metadata = asObject(row.metadata);
  const declared = metadata.chunk_ids ?? row.chunk_ids;
  if (declared === undefined) {
    requireValue(!physicalParent && !logicalParentDrawerId(metadata) && !row.chunks && !metadata.chunks, "source-discovery-missing-chunk-inventory");
    return { parentDrawerId, requiredChunkCount: 1, chunks: [{ drawerId: parentDrawerId, chunkIndex: 0 }] };
  }
  requireValue(Array.isArray(declared) && declared.length > 0 && declared.every((id) => typeof id === "string" && id.trim()), "invalid-physical-chunk-inventory");
  const count = metadata.chunks ?? row.chunks;
  requireValue(Number.isSafeInteger(count) && count === declared.length && (!isPhysical || declared.includes(sourceId)), "physical-chunk-count-mismatch");
  return { parentDrawerId, requiredChunkCount: count as number, chunks: declared.map((drawerId, chunkIndex) => ({ drawerId, chunkIndex })) };
}

/** Reject unavailable/truncated graph reads instead of treating them as absent edges. */
async function currentFacts(client: MemgraphClient, subject: string, predicate: string): Promise<Record<string, unknown>[]> {
  const result = await client.kgQuery({ entity: subject, predicate, direction: "outgoing", recurse: false, max_depth: 1 });
  requireValue(Array.isArray(result.facts) && !result.error && !result.truncated, "topic-lineage-read-unavailable");
  return parseFacts({ facts: Array.isArray(result.active_facts) ? result.active_facts : result.facts });
}

async function ensureEdge(client: MemgraphClient, subject: string, predicate: string, object: string, closet: string, sourceDrawerId?: string): Promise<void> {
  requireValue(subject !== object, "chunk-lineage-self-loop");
  const closedVocabulary = predicate === "es-source-type" || predicate === "es-status" ||
    (predicate === "rules-out" && ["tried-failed", "considered-rejected"].includes(object));
  const hasEdge = async (): Promise<boolean> => (await currentFacts(client, subject, predicate)).some((fact) => fact.current !== false && fact.subject === subject && fact.predicate === predicate &&
    (closedVocabulary ? asString(fact.object).toLowerCase() === object.toLowerCase() : fact.object === object));
  if (await hasEdge()) return;
  await client.kgAdd({ subject, predicate, object, source_closet: closet, source_drawer_id: sourceDrawerId });
  requireValue(await hasEdge(), "chunk-edge-unverified:" + predicate);
}

/** Each source completes only after all assessed chunks and topic writes are verified. */
export async function runChunkConsolidation(args: {
  client: MemgraphClient; sourceId: string; options: SynthesisConsolidationOptions;
  checkpointDirectory: string; extractorVersion: string;
  mapChunk: Parameters<typeof extractSourceChunks>[0]["mapChunk"];
  reducerVersion: string; reconcileTopic: ReconcileTopicFn;
}): Promise<ChunkConsolidationOutcome> {
  const { client, options } = args;
  const outcome: ChunkConsolidationOutcome = {
    parentDrawerId: args.sourceId, familyIds: [args.sourceId], completed: false, replacementCoverage: false, drafts: [],
  };
  try {
    const inventory = await discoverSourceChunks(client, args.sourceId);
    outcome.parentDrawerId = inventory.parentDrawerId;
    outcome.familyIds = [...new Set([inventory.parentDrawerId, ...inventory.chunks.map((chunk) => chunk.drawerId)])];
    const extraction = await extractSourceChunks({
      inventory, readTool: (_name, toolArgs) => client.getDrawer({ drawer_id: String(toolArgs.drawer_id) }),
      toolPrefix: "", checkpointDirectory: join(args.checkpointDirectory, "extraction"),
      extractorVersion: args.extractorVersion, mapChunk: args.mapChunk,
    });
    outcome.extraction = extraction;
    requireValue(extraction.extractionComplete, "chunk-extraction-incomplete");
    const reconciliation = await reconcileSourceTopics({ extraction, reducerVersion: args.reducerVersion,
      checkpointDirectory: join(args.checkpointDirectory, "reconciliation"), reconcileTopic: args.reconcileTopic });
    outcome.reconciliation = reconciliation;
    const plans: TopicPlan[] = [];
    for (const grouped of reconciliation.topics) {
      const summaries = [{ ...grouped.topic, transcriptId: inventory.parentDrawerId }];
      const draft = await runSynthesisConsolidation(client, {
        ...options, query: grouped.topic.title, mapperSummaries: summaries, rawEntries: undefined, applyWrites: false,
      });
      outcome.drafts.push(draft);
      requireValue(draft.droppedSummaryIds.length === 0 && draft.inflationGuard.passed, "topic-not-eligible:" + grouped.topic.topicKey);
      const content = draft.consolidationDraft.content + "\n\n## Chunk Evidence\n" + JSON.stringify({
        parentDrawerId: inventory.parentDrawerId, sourceVersion: extraction.sourceVersion,
        reconciliationVersion: reconciliation.reconciliationVersion,
        topicKey: grouped.topic.topicKey, contributingChunkIds: grouped.contributingChunkIds,
        evidence: grouped.evidence, receipts: grouped.receipts,
      });
      plans.push({ key: grouped.topic.topicKey, content, chunkIds: grouped.contributingChunkIds });
      const deadEnds = new Set(grouped.topic.deadEnds);
      for (const line of deadEnds) {
        const parsed = parseDeadEndLine(line).parsed;
        requireValue(parsed, "incomplete-topic-dead-end");
        plans.push({ key: grouped.topic.topicKey + ":dead-end:" + hash(line), content: line,
          chunkIds: [...new Set(grouped.evidence.filter((record) => record.topic?.deadEnds.includes(line)).map((record) => record.chunkId))],
          rulesOut: [parsed.tried, parsed.polarity] });
      }
    }
    if (!options.applyWrites) return outcome;
    const checkpointPath = join(args.checkpointDirectory, hash(inventory.parentDrawerId) + ".json");
    const sourceVersion = hash(JSON.stringify({ extraction: extraction.sourceVersion, reconciliation: reconciliation.reconciliationVersion,
      wing: options.targetWing, room: options.targetRoom, plans }));
    const coverage: Coverage = { schemaVersion: 1, parentDrawerId: inventory.parentDrawerId, sourceVersion, writes: {}, extraction, reconciliation, completed: false };
    if (existsSync(checkpointPath)) {
      const stored = asObject(parseCompleteJSON(readFileSync(checkpointPath, "utf8"), 128 * 1024 * 1024));
      requireValue(stored.schemaVersion === 1 && stored.parentDrawerId === inventory.parentDrawerId && typeof stored.sourceVersion === "string", "invalid-source-coverage-checkpoint");
      requireValue(stored.writes && typeof stored.writes === "object" && !Array.isArray(stored.writes) && typeof stored.completed === "boolean", "invalid-source-write-checkpoint");
      const writes = asObject(stored.writes);
      for (const value of Object.values(writes)) {
        const write = asObject(value);
        requireValue(typeof write.contentHash === "string" && ["writing", "returned", "verified"].includes(String(write.status)), "invalid-topic-write-checkpoint");
        requireValue(write.status === "writing" || typeof write.drawerId === "string", "missing-persisted-drawer-id");
        requireValue(write.status !== "writing" || write.drawerId, "uncertain-topic-write:manual-reconciliation-required:" + checkpointPath);
      }
      if (stored.sourceVersion === sourceVersion) coverage.writes = writes as Record<string, WriteState>;
    }
    const persist = (): void => {
      mkdirSync(args.checkpointDirectory, { recursive: true });
      const temporary = checkpointPath + "." + randomUUID() + ".tmp";
      writeFileSync(temporary, JSON.stringify(coverage), { encoding: "utf8", flag: "wx" });
      renameSync(temporary, checkpointPath);
    };
    persist();
    for (const plan of plans) {
      let state = coverage.writes[plan.key];
      const contentHash = hash(plan.content);
      requireValue(!state || state.contentHash === contentHash, "topic-plan-changed-within-source-version");
      if (!state) {
        state = { contentHash, status: "writing" };
        coverage.writes[plan.key] = state;
        // An interrupted add without a persisted returned ID requires manual reconciliation.
        persist();
        const added = asObject(await client.addDrawer({
          wing: options.targetWing, room: options.targetRoom, content: plan.content,
          source_file: "es://consolidation/" + inventory.parentDrawerId + "/" + sourceVersion + "/" + plan.key,
          added_by: "electric-shepherd-consolidation",
        }));
        const drawerId = asString(added.drawer_id || added.node_id || added.id).trim();
        requireValue(drawerId && added.success !== false, "uncertain-topic-write:manual-reconciliation-required:" + checkpointPath);
        state.drawerId = drawerId;
        state.status = "returned";
        persist();
      }
      const drawerId = state.drawerId;
      requireValue(drawerId, "uncertain-topic-write:manual-reconciliation-required:" + checkpointPath);
      requireValue(!outcome.familyIds.includes(drawerId), "topic-source-id-collision");
      const actual = asObject(await client.getDrawer({ drawer_id: drawerId }));
      requireValue(actual.drawer_id === drawerId && actual.content === plan.content, "topic-content-unverified:" + drawerId);
      const types = await currentFacts(client, drawerId, "es-source-type");
      requireValue(types.every((fact) => fact.current === false || asString(fact.object).toLowerCase() === "synthesis"), "topic-existing-source-type-conflict");
      await ensureEdge(client, drawerId, "es-source-type", "synthesis", drawerId);
      const statuses = await currentFacts(client, drawerId, "es-status");
      if (!statuses.some((fact) => fact.current !== false && ["provisional", "active"].includes(asString(fact.object).toLowerCase()))) {
        requireValue(!statuses.some((fact) => fact.current !== false), "topic-status-conflict");
        await ensureEdge(client, drawerId, "es-status", "provisional", drawerId);
      }
      for (const source of new Set([inventory.parentDrawerId, ...plan.chunkIds])) {
        await ensureEdge(client, drawerId, "synthesized-from", source, drawerId, inventory.parentDrawerId);
      }
      for (const object of plan.rulesOut || []) await ensureEdge(client, drawerId, "rules-out", object, drawerId);
      state.status = "verified";
      persist();
    }
    for (const [index, grouped] of reconciliation.topics.entries()) {
      outcome.drafts[index].createdNodeId = coverage.writes[grouped.topic.topicKey].drawerId;
    }
    // Recheck inventory/content after writes; cache reads cannot silently certify a changed source.
    const currentInventory = await discoverSourceChunks(client, inventory.parentDrawerId);
    requireValue(JSON.stringify(currentInventory) === JSON.stringify(inventory), "source-inventory-changed-during-write");
    const current = await extractSourceChunks({
      inventory, readTool: (_name, toolArgs) => client.getDrawer({ drawer_id: String(toolArgs.drawer_id) }),
      toolPrefix: "", checkpointDirectory: join(args.checkpointDirectory, "extraction"), extractorVersion: args.extractorVersion,
      mapChunk: async () => { throw new Error("source-changed-during-write"); },
    });
    requireValue(current.extractionComplete && current.sourceVersion === extraction.sourceVersion, "source-changed-during-write");
    // No completion edge is emitted until EVERY topic/evidence write is verified.
    for (const source of outcome.familyIds) {
      const relevant = source === inventory.parentDrawerId ? plans : plans.filter((plan) => plan.chunkIds.includes(source));
      const completionPlans = relevant.length ? relevant : plans.slice(0, 1); // Explicit zero-substance chunk.
      for (const plan of completionPlans) {
        const drawerId = coverage.writes[plan.key].drawerId!;
        await ensureEdge(client, source, "consolidated-into", drawerId, drawerId);
      }
    }
    coverage.completed = true;
    persist();
    outcome.completed = true;
    outcome.replacementCoverage = plans.length > 0;
  } catch (error) {
    outcome.error = String(error);
  }
  return outcome;
}
