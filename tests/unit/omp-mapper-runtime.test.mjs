import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import mapperRuntime, { mapperRequest } from "../../src/scripts/memory-pipeline/omp-mapper-runtime.mjs";
import { ompCompletionText } from "../../src/scripts/memory-pipeline/omp-completion.ts";
import { buildSubagentArgs, buildIsolatedSubagentEnv } from "../../src/scripts/memory-pipeline/subagent.ts";

import { assertWorkerModel, resolveMapperBudget } from "../../src/scripts/memory-pipeline/worker-model.mjs";
const MAPPER_MODEL = "fixture-model";
const model = { provider: "custom", id: MAPPER_MODEL, api: "openai-completions", contextWindow: 126976, maxTokens: 8192 };
process.env.ESHEPHERD_WORKER_MODEL = "custom/" + MAPPER_MODEL;
delete process.env.ESHEPHERD_MAPPER_OUTPUT_TOKENS;
for (const field of ["max_tokens", "max_completion_tokens"]) {
  test(`mapper hook replaces supported wire ${field}, without changing reasoning or other payload fields`, () => {
    const original = { model: MAPPER_MODEL, [field]: 8192, reasoning_effort: "high", messages: [{ content: "private" }] };
    const result = mapperRequest(original, model);
    assert.equal(result.payload[field], 8192);
    assert.equal(original[field], 8192);
    assert.equal(result.payload.reasoning_effort, "high");
    assert.equal(result.payload.messages, original.messages);
    assert.ok(!JSON.stringify(result.telemetry).includes("private"));
    assert.equal(result.telemetry.originalBudget, 8192);
  });
}
test("mapper budget supports arbitrary identities and clamps to declared model limits", () => {
  for (const provider of ["custom", "my-server", "another-provider"]) {
    for (const id of ["small", "organization/model", "user-choice"]) {
      assert.equal(mapperRequest({ max_tokens: 8192 }, { ...model, provider, id }).payload.max_tokens, 8192);
    }
  }
  assert.equal(mapperRequest({ max_tokens: 8192 }, { ...model, maxTokens: 2048 }).payload.max_tokens, 2048);
  assert.equal(mapperRequest({ max_tokens: 8192 }, { ...model, contextWindow: 4096 }).payload.max_tokens, 2048);
  assert.throws(() => mapperRequest({}, model), /unknown-wire-field/);
  assert.throws(() => mapperRequest({ max_tokens: 8192, max_completion_tokens: 8192 }, model), /unknown-wire-field/);
  assert.throws(() => mapperRequest({ max_tokens: 8192 }, { ...model, api: "other" }), /unsupported-api/);
  assert.throws(() => mapperRequest({ max_tokens: 8192 }, { ...model, maxTokens: undefined }), /limits-required/);
  assert.equal(resolveMapperBudget(32768, 65536, "24576"), 24576);
  for (const override of ["-1", "1.5", "bad", "32769"]) assert.throws(() => resolveMapperBudget(32768, 65536, override), /outside-model-limits/);
  assert.throws(() => resolveMapperBudget(8192, 8192, "8192"), /outside-model-limits/);
  assert.throws(() => assertWorkerModel("custom", "other", "custom/fixture-model"), /selected-model-mismatch/);
  assert.throws(() => assertWorkerModel("custom", "fixture-model", undefined), /selected-model-mismatch/);
});

const message = (finish = "stop") => ({ role: "assistant", provider: "custom", model: MAPPER_MODEL, stopReason: finish,
  content: [{ type: "thinking", thinking: "private reasoning" }, { type: "text", text: '{"complete":true}' }],
  usage: { input: 100, output: 24, reasoningTokens: 20, totalTokens: 124, secret: "not logged" } });
const stream = (msg) => [JSON.stringify({ type: "message_end", message: msg }), JSON.stringify({ type: "agent_end", messages: [] })].join("\n");
test("any earlier tool turn rejects even if final assistant stops with useful text", () => {
  const logs = [], tool = message("toolUse"); tool.content = [{ type: "toolCall", name: "add_drawer", arguments: { token: "private-secret" } }];
  assert.throws(() => ompCompletionText(JSON.stringify({ type: "message_end", message: tool }) + "\n" + stream(message()), r => logs.push(r)), /tool-use/);
  assert.equal(logs[0].name, "add_drawer"); assert.ok(!JSON.stringify(logs).includes("private-secret"));
  assert.throws(() => ompCompletionText(JSON.stringify({ type: "message_end", message: tool }) + '\n{"unfinished":', () => {}), /tool-use/);
  assert.throws(() => ompCompletionText(JSON.stringify({ type: "tool_execution_start", toolName: "bash", args: { private: "secret" } }) + "\n" + stream(message()), () => {}), /tool-use/);
});
test("runtime disables active tools, blocks calls before execution, aborts and rejects tool-bearing requests", async () => {
  const handlers = new Map(); let active = ["read", "mcp_write"], aborted = 0;
  mapperRuntime({ on: (name, fn) => handlers.set(name, fn), setActiveTools: async names => { active = names; }, getActiveTools: () => active }, () => { throw new Error("isolation"); });
  await handlers.get("session_start")(); assert.deepEqual(active, []);
  active = ["extension-tool"]; await handlers.get("before_agent_start")(); assert.deepEqual(active, []);
  assert.throws(() => handlers.get("before_provider_request")({ payload: { max_tokens: 8192, tools: [{}] } }, { model }), /isolation/);
  const result = handlers.get("tool_call")({ toolName: "add_drawer", input: { private: "secret" } }, { abort: () => aborted++ });
  assert.equal(result.block, true); assert.equal(aborted, 1);
  assert.throws(() => handlers.get("before_provider_request")({ payload: { max_tokens: 8192 } }, { model }), /isolation/);
});
test("terminal message_end text survives an empty/cleaned agent_end context; telemetry contains no content", () => {
  const logs = [];
  assert.equal(ompCompletionText(stream(message()), (record) => logs.push(record)), '{"complete":true}');
  assert.equal(logs[0].usage.reasoningTokens, 20);
  assert.equal(logs[0].usage.output, 24);
  assert.ok(!JSON.stringify(logs).includes("private"));
  assert.ok(!JSON.stringify(logs).includes("not logged"));
});
for (const finish of ["length", "error", "aborted", "toolUse"]) {
  test(`${finish} stays fail-closed even when terminal text is valid JSON`, () => {
    const logs = [];
    assert.throws(() => ompCompletionText(stream(message(finish)), (record) => logs.push(record)), /worker-/);
    assert.equal(logs.find(r => r.event === "completion").finish, finish);
    assert.equal(logs.find(r => r.event === "completion").textPresent, true);
  });
}
test("thinking-only responses are never converted into text and unfinished JSON streams fail", () => {
  const msg = message();
  msg.content = [{ type: "thinking", thinking: '{"complete":true}' }];
  assert.equal(ompCompletionText(stream(msg), () => {}), "");
  assert.throws(() => ompCompletionText(JSON.stringify({ type: "message_end", message: message() }), () => {}), /invalid-stream/);
  assert.throws(() => ompCompletionText(stream(message()) + '\n{"type":', () => {}), /invalid-stream/);
});
test("only explicitly enabled mapper invocations load the isolated hook/JSON transport", () => {
  const args = { runner: { kind: "omp", bin: "omp" }, prompt: "test" };
  assert.ok(!buildSubagentArgs(args).includes("--extension"));
  const argv = buildSubagentArgs({ ...args, mapperRuntime: true });
  assert.ok(argv.includes("--no-extensions") && argv.includes("--no-session"));
  assert.ok(argv.includes("--no-tools"));
  assert.equal(argv[argv.indexOf("--mode") + 1], "json");
  assert.ok(argv[argv.indexOf("--extension") + 1].endsWith("omp-mapper-runtime.mjs"));
  assert.ok(!buildSubagentArgs({ ...args, mapperRuntime: true, runner: { kind: "opencode" } }).includes("--extension"));
  assert.equal(buildIsolatedSubagentEnv({}).ESHEPHERD_SOURCE_CAPTURE_ENABLED, "false");
});

// No inference: the installed CLI sends requests only to this loopback SSE fixture.
test("installed OMP propagates 8192 baseline and a user-selected 6144 scoped budget through its real provider transport", { timeout: 60000 }, async (t) => {
  const bin = process.env.ESHEPHERD_TEST_OMP_BIN || join(homedir(), ".local/bin/omp");
  if (!existsSync(bin)) return t.skip("OMP binary unavailable; pure contract tests still execute");
  const root = mkdtempSync(join(tmpdir(), "es-omp-wire-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  const requests = [];
  const server = createServer(async (req, res) => {
    if (!req.url.endsWith("/chat/completions")) { res.writeHead(404).end(); return; }
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.writeHead(200, { "content-type": "text/event-stream" });
    const data = (value) => res.write("data: " + JSON.stringify(value) + "\n\n");
    data({ id: "offline", choices: [{ index: 0, delta: { reasoning_content: "fixture reasoning" }, finish_reason: null }] });
    if (requests.length === 3) {
      data({ id: "offline", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "unexpected", type: "function", function: { name: "read", arguments: '{"path":"private-fixture-path"}' } }] }, finish_reason: "tool_calls" }] });
    } else data({ id: "offline", choices: [{ index: 0, delta: { content: '{"complete":true}' }, finish_reason: "stop" }] });
    data({ id: "offline", choices: [], usage: { prompt_tokens: 100, completion_tokens: 24, total_tokens: 124, completion_tokens_details: { reasoning_tokens: 20 } } });
    res.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  writeFileSync(join(agentDir, "models.yml"), JSON.stringify({ providers: { custom: {
    api: "openai-completions", apiKey: "offline-test-only", baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    models: [{ id: MAPPER_MODEL, name: "Offline mapper", reasoning: true, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 126976, maxTokens: 8192 }],
  } } }));
  const results = [];
  for (const enabled of [false, true, true]) {
    const argv = buildSubagentArgs({ runner: { kind: "omp", bin }, modelArg: "custom," + MAPPER_MODEL,
      prompt: "Return JSON.", mapperRuntime: enabled });
    if (!enabled) argv.push("--mode", "json");
    argv.push("--no-tools", "--no-skills", "--no-rules", "--no-lsp", "--no-pty");
    const result = await new Promise((resolve, reject) => {
      const child = spawn(bin, argv, { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: buildIsolatedSubagentEnv({
        PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: agentDir,
        ESHEPHERD_WORKER_MODEL: "custom/" + MAPPER_MODEL, ESHEPHERD_MAPPER_OUTPUT_TOKENS: "6144",
      }) });
      let stdout = "", stderr = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), 20000);
      child.stdout.on("data", (chunk) => stdout += chunk);
      child.stderr.on("data", (chunk) => stderr += chunk);
      child.on("error", reject);
      child.on("close", (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    });
    assert.equal(result.status, results.length === 2 ? 70 : 0, result.stderr);
    const telemetry = [];
    if (results.length === 2) {
      assert.throws(() => ompCompletionText(result.stdout, r => telemetry.push(r)), /tool-use|invalid-stream/);
      assert.match(result.stderr, /unexpected-tool/);
      assert.ok(!result.stderr.includes("private-fixture-path"), "safe telemetry never includes tool arguments");
    } else {
      assert.equal(ompCompletionText(result.stdout, (record) => telemetry.push(record)), '{"complete":true}');
      assert.equal(telemetry.at(-1).usage.reasoningTokens, 20);
    }
    results.push(result);
  }
  assert.equal(requests.length, 3, "one provider request per offline invocation; no continuation after tool-use");
  assert.equal(requests[0].max_tokens ?? requests[0].max_completion_tokens, 8192);
  assert.equal(requests[1].max_tokens ?? requests[1].max_completion_tokens, 6144);
  assert.ok(!requests[1].tools?.length && !requests[1].functions?.length, "installed OMP wire has zero tool definitions");
  assert.match(results[1].stderr, /"activeTools":0,"requestTools":0/);
  assert.match(results[1].stderr, /"originalBudget":8192,"budget":6144/);
  assert.equal(requests[0].reasoning_effort, requests[1].reasoning_effort);
  t.diagnostic("Real installed OMP wire: baseline 8192, scoped mapper 6144; reasoning unchanged; fixture usage output=24/reasoning=20.");
});
