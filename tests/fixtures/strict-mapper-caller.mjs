import { mock } from "node:test";
import { reconciliationResponse } from "./topic-reconciliation-mock.mjs";

// Actual CLI -> actual mapper parser -> actual synthesis. Only external seams mocked.
const root = new URL("../../src/", import.meta.url);
const moduleURL = (path) => new URL(path, root);
async function replace(path, overrides) {
  const url = moduleURL(path);
  const original = await import(url);
  mock.module(url, { namedExports: { ...original, ...overrides } });
}
const mode = process.argv[2];
const ids = ["parent_a", "parent_b"];
const calls = { search: [], create: [], move: [], kg: [], retire: [] };
const stored = new Map();
const summary = {
  transcriptId: "parent_a", confidence: "high",
  durableFacts: ["The policy layer owns consolidation and the substrate owns immutable evidence."],
  decisions: ["Preserve original source drawers until every replacement parent is covered."],
  rootCausesAndWorkedExamples: ["Truncated outer JSON must never be salvaged as successful extraction."],
  subsystemsAndFiles: ["src/scripts/memory-pipeline/subagent.ts"], openItems: [], deadEnds: [],
};
mock.module("node:child_process", { namedExports: { spawnSync: () => { throw new Error("unexpected-OMP-process-in-OpenCode-fixture"); }, execFileSync: (_bin, argv) => {
  const input = JSON.parse(argv[1].split("\n").at(-1));
  if (input.evidence) return reconciliationResponse(input);
  const { parentDrawerId } = input;
  if (parentDrawerId !== "parent_a") return "";
  const valid = JSON.stringify({ schemaVersion: 1, parentDrawerId, complete: true, pieces: input.pieces.map((piece) => ({
    schemaVersion: 1, parentDrawerId, chunkId: piece.chunkId, pieceIndex: piece.pieceIndex, pieceCount: piece.pieceCount,
    complete: true, assessment: "topics", topics: [{ ...summary, topicKey: "safety", title: "Strict extraction", origin: "source",
      sourceQuotes: [piece.primary.slice(0, 12)] }], contextualEvidence: [],
  })) });
  return mode === "truncated" ? '{"response":' + valid + ',"unfinished":'
    : mode === "trailing" ? valid + '\n{"unfinished":'
    : mode === "sections" ? "TRANSCRIPT_ID: parent_a\nDECISIONS\n- Chose a different parser\n"
    : mode === "legacy" ? JSON.stringify([summary]) : valid;
} } });
const client = {
  kgQueryMany: async () => ({ original: { facts: ids.map((id) => ({
    subject: "original", predicate: "synthesized-from", object: id,
  })) } }),
  getDrawers: async () => ({ results: ids.map((drawer_id) => ({
    drawer_id, wing: "test", room: "source", content: "raw source",
  })) }),
  getDrawer: async (args) => ({ drawer_id: args.drawer_id, content: stored.get(args.drawer_id) || "Raw source.", metadata: {} }),
  hasLineagePath: async () => false,
  isSourceDrawerConsolidated: async () => calls.create.length > 0,
  search: async (...args) => { calls.search.push(args); return { results: [] }; },
  createDerivedDrawer: async (args) => { calls.create.push(args); return { node_id: "replacement" }; },
  addDrawer: async (args) => { calls.create.push(args); stored.set("replacement", args.content); return { drawer_id: "replacement", success: true }; },
  kgQuery: async (args) => ({ facts: calls.kg.filter((edge) => edge.subject === args.entity && edge.predicate === args.predicate) }),
  updateDrawer: async (args) => { calls.move.push(args); return { success: true }; },
  kgAdd: async (args) => { calls.kg.push(args); return { success: true }; },
  kgInvalidate: async (args) => { calls.retire.push(args); },
  kgSupersede: async (args) => { calls.retire.push(args); },
};
await replace("core/memgraph.ts", { createMemgraphClient: () => client });
await replace("core/substrate-client.ts", { createSubstrateClient: async () => ({ client: {
  callTool: async (_name, args) => ({ drawer_id: args.drawer_id, content: "Raw non-session fragment." }),
} }) });
await replace("core/runtime-config.ts", { loadRuntimeConfig: () => ({ valuesByPath: { mcp: { autoDiscover: false } } }) });
await replace("scripts/runtime-env.ts", { loadRuntimeEnv: () => {} });
await replace("scripts/memory-pipeline/runtime-utils.ts", { appendRunEvent: () => {} });
await replace("scripts/memory-pipeline/subagent.ts", {
  resolveSubagentRunner: () => ({ kind: "opencode", bin: "unused", standalone: true }),
});
await replace("policy/validation-merge-review.ts", { runValidationMergeReview: async () => ({}) });
await replace("scripts/memory-pipeline/memcore-render.ts", { renderAndApplyMemcore: async () => undefined });
await replace("scripts/memory-pipeline/run-report.ts", {
  emitRunCompletion: async ({ allSkipped, worklistOutput, consolidationBatches }) => {
    console.log(JSON.stringify({ calls, allSkipped, worklistOutput, consolidationBatches }));
  },
});
process.argv = [process.execPath, "caller", "--no-lock", "--apply", "--wing", "test",
  "--room", "source", "--batch-size", "2", "--reconsolidate", "original"];
await import(moduleURL("scripts/run-memory-consolidation-and-validation.ts"));
