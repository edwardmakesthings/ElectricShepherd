import { mock } from "node:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { WorkerFailure } from "../../src/scripts/memory-pipeline/omp-completion.ts";

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
if (mode === "changed") contents[2] += "; new source version";
if (mode.startsWith("large-")) contents[0] = "a".repeat(32_000) + "late minority finding";
if (mode === "policy-only" || mode === "policy-mixed") {
  const source = JSON.stringify({ session: { id: "offline", time: { created: "2024-01-01T00:00:00.000Z", updated: "2024-01-01T00:00:03.000Z" } }, messages: [
    { role: "user", text: "[Memory Checkpoint] secret-policy-body".repeat(30), time: { created: "2099-01-01T00:00:00.000Z" } },
    ...(mode === "policy-mixed" ? [{ role: "assistant", text: "A substantive viewer fix was implemented and validated.", time: { created: "2024-01-01T00:00:02.000Z" } }] : [])] });
  const cut = source.indexOf("secret-policy-body"), end = source.indexOf('},{"role":"assistant"');
  contents.splice(0, 3, source.slice(0, cut), source.slice(cut, end < 0 ? source.length - 2 : end + 1), source.slice(end < 0 ? source.length - 2 : end + 1));
}
if (mode === "metadata-split") {
  const message = { role: "assistant", text: "A substantive viewer fix was implemented and validated." };
  const guard = { role: "user", text: "[Loop Guard] secret-policy-body" };
  const source = JSON.stringify({ session: { id: "metadata-only" }, messages: [message, guard] });
  const cut = source.indexOf(JSON.stringify(message)), guardCut = source.indexOf(JSON.stringify(guard));
  contents.splice(0, 3, source.slice(0, cut), source.slice(cut, guardCut), source.slice(guardCut));
}
const legacyParent = mode === "legacy";
const parentMetadata = (id) => legacyParent ? { parent_entry_id: id } : { parent_drawer_id: id };
const statePath = "mock-substrate.json";
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { drawers: {}, edges: [] };
const persist = () => writeFileSync(statePath, JSON.stringify(state));
const calls = { create: [], kg: [], move: [], retire: [], map: [], mapBatches: [], reduce: [], search: [] };
const drawerText = "Architecture remains immutable; the later minority project decision cancels migration and preserves verified lineage.";
const workerConfig = resolve("mock-worker-config"); mkdirSync(workerConfig, { recursive: true });
writeFileSync(resolve(workerConfig, "models.yml"), JSON.stringify({ providers: { custom: { api: "openai-completions", apiKey: "offline",
  baseUrl: "http://127.0.0.1:1/v1", models: [{ id: "fixture-model", name: "Mock mapper", reasoning: false,
    input: ["text"], contextWindow: 8192, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
process.env.PI_CODING_AGENT_DIR = workerConfig;
mock.module("node:child_process", { namedExports: { execFileSync: () => { throw new Error("unexpected-legacy-runner"); }, spawnSync: (_bin, argv) => {
  const prompt = argv[argv.indexOf("-p") + 1];
  if (!argv.includes("--no-tools")) throw new Error("tool-isolation-flag-missing");
  let text = drawerText, finish = "stop";
  if (prompt.includes("NEXT CHRONOLOGICAL FINDINGS")) {
    calls.reduce.push(prompt);
    if (mode === "reducer-empty") text = "";
    if (mode === "reducer-done") text = "Done";
    if (mode === "reducer-error") finish = "error";
    if (mode === "reducer-retry-length" && calls.reduce.length === 1) finish = "length";
  } else {
    const sources = [...prompt.matchAll(/\nPRIMARY\n([\s\S]*?)\nNEXT BOUNDARY CONTEXT/g)].map(m => ({ primary: m[1] }));
    calls.mapBatches.push({ sources }); calls.map.push(...sources);
    if (mode === "missing" || (mode === "large-fail" && sources.some(s => s.primary.includes("late minority")))) text = "";
    if (mode === "done") text = "Done";
    if (mode === "length" || (mode === "retry-length" && calls.mapBatches.length === 1)) finish = "length";
    if (mode === "error" || (mode === "retry-error" && calls.mapBatches.length === 1)) finish = "error";
    if (mode === "tool") finish = "toolUse";
    if (mode === "retry-empty" && calls.mapBatches.length === 1) text = "";
    if (mode === "timeout" || (mode === "retry-timeout" && calls.mapBatches.length === 1)) return { error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }), status: null, signal: "SIGTERM", stdout: "", stderr: "" };
  }
  if (mode === "markdown") text = "# Unknown heading\n" + drawerText;
  if (mode === "fences") text = "\u0060\u0060\u0060notes\n" + drawerText + "\n\u0060\u0060\u0060";
  if (mode === "storage-limit" || mode === "storage-excess") text = "x".repeat(mode === "storage-limit" ? 100000 : 100001);
  const message = { role: "assistant", stopReason: finish, content: [{ type: "text", text }, ...(finish === "toolUse" ? [{ type: "toolCall", name: "add_drawer", arguments: { secret: "not-logged" } }] : [])] };
  const request = { event: "request", provider: "custom", model: mode === "model-drift" ? "unexpected-model" : "fixture-model",
    budget: mode === "budget-drift" ? 24576 : 2048, outputLimit: 2048, contextWindow: 8192 };
  if (mode === "missing-request-limits") delete request.outputLimit;
  return { status: 0, signal: null, stderr: mode === "unisolated" ? "" : '[eshepherd-mapper-runtime] {"event":"tool-isolation","activeTools":0,"requestTools":0}\n[eshepherd-mapper-runtime] ' + JSON.stringify(request) + "\n", stdout: [JSON.stringify({ type: "message_end", message }), JSON.stringify({ type: "agent_end" })].join("\n") };
} } });
const getDrawer = async ({ drawer_id }) => {
  if (drawer_id === parent) return { drawer_id, content: contents.join(""), metadata: { ...parentMetadata(parent), chunk_index: 0, chunk_ids: chunks, chunks: mode === "inventory-gap" ? 4 : 3 } };
  const index = chunks.indexOf(drawer_id);
  if (index !== -1) return { drawer_id, content: contents[index], metadata: { ...parentMetadata(parent), chunk_index: index } };
  return { drawer_id, content: state.drawers[drawer_id]?.content, metadata: mode === "lost-provenance" ? {} : state.drawers[drawer_id]?.metadata };
};
const client = {
  kgQueryMany: async () => ({ original: { facts: [{ subject: "original", predicate: "synthesized-from", object: legacyParent ? chunks[0] : parent }] } }),
  getDrawers: async () => ({ results: [{ drawer_id: legacyParent ? chunks[0] : parent, wing: "test", room: "source", content: "raw" }] }),
  getDrawer, hasLineagePath: async () => false,
  isSourceDrawerConsolidated: async () => true, // Old parent edge must NOT bypass chunk coverage.
  search: async (...args) => { calls.search.push(args); return { results: [] }; },
  addDrawer: async () => { throw new Error("unsupported-desc-single-write"); },
  addDrawers: async ({ items, added_by }) => {
    if (items.length !== 1) throw new Error("unexpected-bulk-size");
    const args = { ...items[0], added_by };
    calls.create.push(args);
    const id = "drawer_topic_" + Object.keys(state.drawers).length;
    state.drawers[id] = args;
    persist();
    if (mode === "uncertain") return { results: [{ success: true }] };
    if (mode === "uncertain-throw") throw new WorkerFailure("timeout", true);
    return { results: [{ drawer_id: id, success: true }], errors: 0 };
  },
  createDerivedDrawer: async () => { throw new Error("premature legacy completion path invoked"); },
  kgQuery: async ({ entity, predicate }) => ({ facts: state.edges.filter((edge) => edge.subject === entity && edge.predicate === predicate).map(({ source_drawer_id: _provenance, ...edge }) => ({ ...edge,
    object: mode === "canonical" && ["es-source-type", "es-status"].includes(predicate) ? edge.object[0].toUpperCase() + edge.object.slice(1) : edge.object,
  })) }),
  kgAdd: async (args) => {
    calls.kg.push(args);
    if (mode === "completion-failure" && args.predicate === "consolidated-into") throw new Error("completion edge temporarily unavailable");
    if (mode === "partial" && args.predicate === "synthesized-from") throw new Error("lineage temporarily unavailable");
    if (!state.edges.some((edge) => edge.subject === args.subject && edge.predicate === args.predicate && edge.object === args.object)) state.edges.push(args);
    persist();
    return { success: true };
  },
  updateDrawer: async (args) => { calls.move.push(args); return { success: true }; },
  kgInvalidate: async (args) => { calls.retire.push(args); return { success: true }; },
  kgSupersede: async (args) => { calls.retire.push(args); return { success: true }; },
};
// Read-only route evidence: route every client method through the production callTool guard with its substrate tool name.
const TOOL_OF = { getDrawer: "get_drawer", getDrawers: "get_drawers", kgQuery: "kg_query", kgQueryMany: "kg_query_many", addDrawer: "add_drawer", addDrawers: "add_drawers",
  kgAdd: "kg_add", kgInvalidate: "kg_invalidate", kgSupersede: "kg_supersede", moveDrawer: "update_drawer", checkpoint: "checkpoint" };
const guarded = (options) => mode !== "only-drawer" ? client : new Proxy(client, { get: (target, key) => typeof target[key] === "function" && TOOL_OF[key]
  ? async (...args) => { await options.callTool("mock_" + TOOL_OF[key], args[0]); return target[key](...args); } : target[key] });
await replace("core/memgraph.ts", { createMemgraphClient: guarded });
await replace("core/substrate-client.ts", { createSubstrateClient: async () => ({ client: { callToolResult: async () => ({}) } }) });
await replace("core/runtime-config.ts", { loadRuntimeConfig: () => ({ valuesByPath: { mcp: { autoDiscover: false }, consolidation: { mapperModel: "custom/fixture-model" } } }) });
await replace("scripts/runtime-env.ts", { loadRuntimeEnv: () => {} });
await replace("scripts/memory-pipeline/runtime-utils.ts", { appendRunEvent: () => {} });
await replace("scripts/memory-pipeline/subagent.ts", { resolveSubagentRunner: () => ({ kind: "omp", bin: "unused" }) });
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
if (mode === "deadline") process.argv.push("--run-timeout-ms", "1");
await import(moduleURL("scripts/run-memory-consolidation-and-validation.ts"));
