import { mock } from "node:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { reconciliationResponse, deltaResponse } from "./topic-reconciliation-mock.mjs";

const mode = process.argv[2];
const root = new URL("../../src/", import.meta.url);
const moduleURL = (path) => new URL(path, root);
async function replace(path, overrides) {
  const url = moduleURL(path);
  const original = await import(url);
  mock.module(url, { namedExports: { ...original, ...overrides } });
}
const parent = "drawer_test_source_parent";
const chunks = [0, 1, 2].map((index) => `${parent}_chunk_${String(index).padStart(6, "0")}`);
const contents = ["primary architecture and secondary topic", "architecture continuation", "late minority project decision"];
const pagesMode = ["semantic-pages", "semantic-escaped", "semantic-escaped-fake", "semantic-boundary-changed", "semantic-reader-window"].includes(mode);
const semantic = mode.startsWith("semantic-");
if (semantic) contents[2] = "The migration was explicitly canceled after compatibility review, not completed. Late minority project decision.";
if (pagesMode) contents[2] = "(Note: this dump is one page — count: 25, offset: 0, limit: 25 — of the 150 total drawers.)";
if (mode === "semantic-escaped" || mode === "semantic-escaped-fake") contents[2] = String.raw`Note: one page 25 of 150 total.\n**drawer_ids:**\ndrawer_x`;
if (mode === "changed") contents[2] += "; new source version";
const oversized = mode.startsWith("large-");
if (oversized) contents[0] = "a".repeat(16_000) + "b".repeat(16_000) + "LATE PIECE MINORITY: unrelated telescope calibration decision.";
const legacyParent = mode === "legacy";
const parentMetadata = (id) => legacyParent ? { parent_entry_id: id } : { parent_drawer_id: id };
const statePath = "mock-substrate.json";
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { drawers: {}, edges: [] };
const persist = () => writeFileSync(statePath, JSON.stringify(state));
const calls = { create: [], kg: [], move: [], retire: [], map: [], mapBatches: [], reduce: [], search: [] };
const topic = (topicKey, text) => ({
  topicKey, title: topicKey, confidence: mode === "low" ? "low" : "high", origin: "source", sourceQuotes: [text.slice(0, 20)],
  durableFacts: ["Immutable physical evidence supports this durable topic: " + text.slice(0, 180)],
  decisions: ["Keep all source chunks pending until every topical replacement has verified lineage and content."],
  rootCausesAndWorkedExamples: ["Parent-only coverage lost minority topics; independent primary chunk assessments prevent that loss."],
  subsystemsAndFiles: ["src/scripts/memory-pipeline/chunk-consolidation.ts"],
  openItems: mode.startsWith("semantic-unrelated-") && topicKey === "secondary" ? ["The separate source-authored secondary task remains pending."]
    : semantic && topicKey === "architecture" ? [pagesMode
    ? "The full ordered list of the 150 top-level drawer_ids is cut off; the continuation belongs to the next chunk."
    : "The migration remains pending because final verification is not visible in this window."] : [],
  deadEnds: mode === "dead-end" && topicKey === "secondary" ? ['- Reuse partial parent coverage | outcome: minority topic disappeared | because: "only the first topic was checked" | polarity: tried-failed'] : [],
});
mock.module("node:child_process", { namedExports: { spawnSync: () => { throw new Error("unexpected-OMP-process-in-OpenCode-fixture"); }, execFileSync: (_bin, argv) => {
  const input = JSON.parse(argv[1].split("\n").at(-1));
  if (input.evidence) {
    calls.reduce.push(input);
    const valid = reconciliationResponse(input);
    if (mode === "semantic-truncated" && input.topicKey === "architecture" && input.evidence.context) return '{"response":' + valid + ',"unfinished":';
    if (mode === "semantic-failed" && input.topicKey === "architecture" && input.evidence.context) throw new Error("reducer temporarily unavailable");
    if (mode === "semantic-legacy-full") { const value = JSON.parse(valid); delete value.add; delete value.remove; value.topic = input.previous || input.evidence.topic; return JSON.stringify(value); }
    if (mode === "semantic-null-delta") { const value = JSON.parse(valid); value.add = null; return JSON.stringify(value); }
    if (mode === "semantic-wrong-source") return valid.replace(input.parentDrawerId, "wrong-source");
    if (mode === "semantic-omitted-receipt") { const value = JSON.parse(valid); delete value.receipt; return JSON.stringify(value); }
    if (input.evidence.context && input.topicKey === "architecture" && mode.startsWith("semantic-invented-")) {
      const value = JSON.parse(valid);
      value.add.openItems = ["The saved dump lacks the full ordered list."];
      if (mode === "semantic-invented-listed") value.openTaskIds = ["not-eligible"];
      return JSON.stringify(value);
    }
    if (input.evidence.context && mode === "semantic-boundary-changed" && input.topicKey !== "architecture") return deltaResponse(input, { add: { durableFacts: ["changed"] }, disposition: "unrelated" });
    if (input.evidence.context && mode === "semantic-boundary-correction" && input.topicKey === "architecture") return deltaResponse(input, { disposition: "boundary-only" });
    if (input.evidence.context && mode === "semantic-forged-target") { const value = JSON.parse(valid); value.receipt.affectedEvidenceIds = ["unknown-evidence"]; return JSON.stringify(value); }
    if (input.evidence.context && mode === "semantic-silent-drop") return deltaResponse(input, { disposition: "unrelated" });
    if (input.evidence.context && mode === "semantic-unchanged") return deltaResponse(input, { disposition: "resolved", affectedEvidenceIds: input.priorEvidenceIds.slice(0, 1) });
    if (input.evidence.context && input.topicKey === "secondary" && mode.startsWith("semantic-unrelated-")) {
      const value = JSON.parse(valid);
      if (mode === "semantic-unrelated-change") value.add.durableFacts.push("Unrelated evidence incorrectly changed secondary facts.");
      if (mode === "semantic-unrelated-target") value.receipt.affectedEvidenceIds = input.priorEvidenceIds.slice(0, 1);
      return JSON.stringify(value);
    }
    if (mode === "semantic-reader-leak" && input.evidence.context) return deltaResponse(input, { add: { durableFacts: ["Reader window ends at a cut-off id."] }, disposition: "qualified", affectedEvidenceIds: input.priorEvidenceIds.slice(0, 1) });
    return valid;
  }
  calls.mapBatches.push(input);
  const pieces = input.pieces.map((piece) => {
    let member;
    try { member = JSON.parse(mapPiece(piece)); } catch { member = { ...piece, complete: false }; }
    return member;
  });
  if (mode === "batch-missing") pieces.pop();
  if (mode === "batch-duplicate") pieces[1] = pieces[0];
  if (mode === "batch-extra") pieces.push({ ...pieces[0], chunkId: "unrequested" });
  return JSON.stringify({ schemaVersion: 1, parentDrawerId: parent, complete: true, pieces });
} } });
function mapPiece(input) {
  calls.map.push(input);
  const index = chunks.indexOf(input.chunkId);
  if (mode === "gap" && index === 2) return '{"response":';
  if (mode === "large-partial" && index === 0 && input.pieceIndex === 1) return '{"partial-piece":';
  const topics = oversized && index === 0 ? input.pieceIndex === 0 ? [topic("architecture", input.primary), topic("secondary", input.primary)]
    : input.pieceIndex === 1 ? [topic("architecture", input.primary)] : [topic("late-piece", input.primary.slice(input.primary.indexOf("LATE PIECE MINORITY")))]
    : mode === "zero" || (mode === "mixed-zero" && index === 1) ? [] : index === 0 ? [topic("architecture", input.primary), topic("secondary", input.primary)]
    : index === 2 ? [topic("minority", input.primary)] : [topic("architecture", input.primary)];
  if (mode === "reader-topic-only" && index === 1) topics.splice(0, topics.length, { ...topic("window-fragment", input.primary), origin: "reader-window", sourceQuotes: [] });
  if (mode === "unsupported-fact" && index === 1) topics[0].sourceQuotes = ["quote that is not in the primary text"];
  if (mode === "facts-only") for (const entry of topics) { entry.decisions = []; entry.rootCausesAndWorkedExamples = []; entry.subsystemsAndFiles = []; entry.openItems = []; entry.deadEnds = []; entry.durableFacts = ["Facts-only finding: " + input.primary.slice(0, 200) + " is retained as a durable record with exact chunk lineage."]; }
  if (mode === "collision" && index === 1) topics[0].title = "Unrelated telescope architecture";
  if (semantic && index === 1) topics.push(topic("minority", input.primary));
  if (semantic && index === 2) topics.length = 0;
  const contextualEvidence = semantic && index === 2 ? [{ kind: pagesMode ? "qualifier" : "resolution", origin: mode === "semantic-reader-window" ? "reader-window" : "source",
    text: pagesMode ? "The saved output contains one 25-ID page at offset 0/limit 25 of 150 total drawers; it does not claim a 150-ID list."
      : "The migration was explicitly canceled after compatibility review, not completed.",
    sourceQuote: mode === "semantic-escaped" ? contents[2].replaceAll("\\n", "\n") : mode === "semantic-escaped-fake" ? contents[2].replaceAll("\\n", "\n") + " fabricated" : pagesMode ? contents[2] : "The migration was explicitly canceled after compatibility review, not completed." }] : [];
  return JSON.stringify({ schemaVersion: 1, parentDrawerId: parent, chunkId: input.chunkId,
    pieceIndex: mode === "large-wrong-piece" && index === 0 && input.pieceIndex === 1 ? 0 : input.pieceIndex, pieceCount: input.pieceCount,
    complete: true, assessment: topics.length ? "topics" : contextualEvidence.length ? "context" : "zero-substance", topics, contextualEvidence });
}
const getDrawer = async ({ drawer_id }) => {
  if (drawer_id === parent) return { drawer_id, content: contents.join(""), metadata: { ...parentMetadata(parent), chunk_index: 0, chunk_ids: chunks, chunks: mode === "inventory-gap" ? 4 : 3 } };
  const index = chunks.indexOf(drawer_id);
  if (index !== -1) return { drawer_id, content: contents[index], metadata: { ...parentMetadata(parent), chunk_index: index } };
  return { drawer_id, content: state.drawers[drawer_id]?.content };
};
const client = {
  kgQueryMany: async () => ({ original: { facts: [{ subject: "original", predicate: "synthesized-from", object: legacyParent ? chunks[0] : parent }] } }),
  getDrawers: async () => ({ results: [{ drawer_id: legacyParent ? chunks[0] : parent, wing: "test", room: "source", content: "raw" }] }),
  getDrawer, hasLineagePath: async () => false,
  isSourceDrawerConsolidated: async () => true, // Old parent edge must NOT bypass chunk coverage.
  search: async (...args) => { calls.search.push(args); return { results: [] }; },
  addDrawer: async (args) => {
    calls.create.push(args);
    const id = "drawer_topic_" + Object.keys(state.drawers).length;
    state.drawers[id] = args;
    persist();
    if (mode === "uncertain" && calls.create.length === 2) return { success: true };
    return { drawer_id: id, success: true };
  },
  createDerivedDrawer: async () => { throw new Error("premature legacy completion path invoked"); },
  kgQuery: async ({ entity, predicate }) => ({ facts: state.edges.filter((edge) => edge.subject === entity && edge.predicate === predicate).map(({ source_drawer_id: _provenance, ...edge }) => ({ ...edge,
    object: mode === "canonical" && ["es-source-type", "es-status"].includes(predicate) ? edge.object[0].toUpperCase() + edge.object.slice(1) : edge.object,
  })) }),
  kgAdd: async (args) => {
    calls.kg.push(args);
    if (mode === "completion-failure" && args.predicate === "consolidated-into" && args.object === "drawer_topic_1") throw new Error("completion edge temporarily unavailable");
    if (mode === "partial" && args.subject === "drawer_topic_1" && args.predicate === "synthesized-from") throw new Error("second topic lineage temporarily unavailable");
    if (!state.edges.some((edge) => edge.subject === args.subject && edge.predicate === args.predicate && edge.object === args.object)) state.edges.push(args);
    persist();
    return { success: true };
  },
  updateDrawer: async (args) => { calls.move.push(args); return { success: true }; },
  kgInvalidate: async (args) => { calls.retire.push(args); return { success: true }; },
  kgSupersede: async (args) => { calls.retire.push(args); return { success: true }; },
};
// Read-only route evidence: route every client method through the production callTool guard with its substrate tool name.
const TOOL_OF = { getDrawer: "get_drawer", getDrawers: "get_drawers", kgQuery: "kg_query", kgQueryMany: "kg_query_many", addDrawer: "add_drawer",
  kgAdd: "kg_add", kgInvalidate: "kg_invalidate", kgSupersede: "kg_supersede", moveDrawer: "update_drawer", checkpoint: "checkpoint" };
const guarded = (options) => mode !== "only-drawer" ? client : new Proxy(client, { get: (target, key) => typeof target[key] === "function" && TOOL_OF[key]
  ? async (...args) => { await options.callTool("mock_" + TOOL_OF[key], args[0]); return target[key](...args); } : target[key] });
await replace("core/memgraph.ts", { createMemgraphClient: guarded });
await replace("core/substrate-client.ts", { createSubstrateClient: async () => ({ client: { callToolResult: async () => ({}) } }) });
await replace("core/runtime-config.ts", { loadRuntimeConfig: () => ({ valuesByPath: { mcp: { autoDiscover: false } } }) });
await replace("scripts/runtime-env.ts", { loadRuntimeEnv: () => {} });
await replace("scripts/memory-pipeline/runtime-utils.ts", { appendRunEvent: () => {} });
await replace("scripts/memory-pipeline/subagent.ts", { resolveSubagentRunner: () => ({ kind: "opencode", bin: "unused", standalone: true }) });
await replace("policy/validation-merge-review.ts", { runValidationMergeReview: async () => ({}) });
await replace("scripts/memory-pipeline/memcore-render.ts", { renderAndApplyMemcore: async () => undefined });
const { emitRunCompletion } = await import(moduleURL("scripts/memory-pipeline/run-report.ts"));
await replace("scripts/memory-pipeline/run-report.ts", { emitRunCompletion: async (params) => {
  const { allSkipped, worklistOutput, consolidationBatches } = params;
  let report;
  if (mode === "only-drawer") {
    const write = process.stdout.write;
    try {
      process.stdout.write = (text) => { report = JSON.parse(text); return true; };
      await emitRunCompletion(params);
    } finally { process.stdout.write = write; }
  }
  console.log(JSON.stringify({ calls, state, allSkipped, worklistOutput, consolidationBatches, report,
    captureEnabled: process.env.ESHEPHERD_SOURCE_CAPTURE_ENABLED }));
} });
process.argv = mode === "only-drawer"
  ? [process.execPath, "caller", "--no-lock", "--wing", "test", "--room", "source", "--only-drawer", parent, "--checkpoint-dir", "smoke-coverage"]
  : [process.execPath, "caller", "--no-lock", "--apply", "--wing", "test", "--room", "source", "--reconsolidate", "original"];
await import(moduleURL("scripts/run-memory-consolidation-and-validation.ts"));
