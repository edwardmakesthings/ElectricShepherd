import { mock } from "node:test";

// Run the actual CLI loop and synthesis implementation; only external seams
// and unrelated final reporting/rendering are mocked. No live palace access.
const root = new URL("../../src/", import.meta.url);
const moduleURL = (path) => new URL(path, root);
async function replace(path, overrides) {
  const url = moduleURL(path);
  const original = await import(url);
  mock.module(url, { namedExports: { ...original, ...overrides } });
}

const mode = process.argv[2];
const ids = ["parent_a", "parent_b"];
const calls = { search: [], create: [], move: [], kg: [], retire: [], fetch: [] };
const stored = new Map();
const summary = (transcriptId) => ({
  transcriptId, confidence: "high",
  durableFacts: ["The policy layer owns consolidation and the substrate owns immutable evidence."],
  decisions: ["Preserve original source drawers until every replacement parent is covered."],
  rootCausesAndWorkedExamples: ["Empty mapper output previously triggered destination search and unrelated synthesis."],
  subsystemsAndFiles: ["src/capability/episodic/synthesis-consolidation.ts"],
  openItems: [],
});
const client = {
  kgQueryMany: async () => ({ original: { facts: ids.map((id) => ({
    subject: "original", predicate: "synthesized-from", object: id,
  })) } }),
  getDrawers: async () => ({ results: ids.map((drawer_id) => ({
    drawer_id, wing: "test", room: "source", content: "Decision: raw heuristic evidence must not be used in live mapper mode.",
  })) }),
  getDrawer: async (args) => { calls.fetch.push(args); return { drawer_id: args.drawer_id,
    content: stored.get(args.drawer_id)?.content || "Raw non-session text.", metadata: stored.get(args.drawer_id)?.metadata || {} }; },
  hasLineagePath: async () => false,
  isSourceDrawerConsolidated: async () => calls.create.length > 0,
  search: async (...args) => { calls.search.push(args); return { results: [] }; },
  createDerivedDrawer: async (args) => { calls.create.push(args); return { node_id: "replacement" }; },
  addDrawers: async ({ items }) => { calls.create.push(items[0]); stored.set("replacement", items[0]); return { results: [{ drawer_id: "replacement", success: true }], errors: 0 }; },
  kgQuery: async (args) => ({ facts: calls.kg.filter((edge) => edge.subject === args.entity && edge.predicate === args.predicate) }),
  updateDrawer: async (args) => { calls.move.push(args); return { success: true }; },
  kgAdd: async (args) => { calls.kg.push(args); return { success: true }; },
  kgInvalidate: async (args) => { calls.retire.push(args); },
  kgSupersede: async (args) => { calls.retire.push(args); },
};
await replace("core/memgraph.ts", { createMemgraphClient: () => client });
await replace("core/substrate-client.ts", { createSubstrateClient: async () => ({ client: {} }) });
await replace("core/runtime-config.ts", { loadRuntimeConfig: () => ({ valuesByPath: { mcp: { autoDiscover: false } } }) });
await replace("scripts/runtime-env.ts", { loadRuntimeEnv: () => {} });
await replace("scripts/memory-pipeline/runtime-utils.ts", { appendRunEvent: () => {} });
let extractionCalls = 0;
await replace("scripts/memory-pipeline/subagent.ts", {
  resolveSubagentRunner: () => mode === "unavailable" ? undefined : ({ kind: "opencode", bin: "unused" }),
  runSubagent: ({ prompt }) => {
    if (prompt.includes("NEXT CHRONOLOGICAL FINDINGS")) return summary("parent_a").durableFacts[0];
    if (mode !== "partial" || extractionCalls++ !== 0) return "";
    return summary("parent_a").durableFacts[0];
  },
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
