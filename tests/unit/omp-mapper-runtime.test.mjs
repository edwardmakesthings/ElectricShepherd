import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { mapperRequest, MAPPER_MODEL, MAPPER_OUTPUT_TOKENS } from "../../src/scripts/memory-pipeline/omp-mapper-runtime.mjs";
import { ompCompletionText } from "../../src/scripts/memory-pipeline/omp-completion.ts";
import { buildSubagentArgs, buildIsolatedSubagentEnv } from "../../src/scripts/memory-pipeline/subagent.ts";

const model = { provider: "litellm", id: MAPPER_MODEL, api: "openai-completions", contextWindow: 126976 };
for (const field of ["max_tokens", "max_completion_tokens"]) {
  test(`mapper hook replaces supported wire ${field}, without changing reasoning or other payload fields`, () => {
    const original = { model: MAPPER_MODEL, [field]: 8192, reasoning_effort: "high", messages: [{ content: "private" }] };
    const result = mapperRequest(original, model);
    assert.equal(result.payload[field], 24576);
    assert.equal(original[field], 8192);
    assert.equal(result.payload.reasoning_effort, "high");
    assert.equal(result.payload.messages, original.messages);
    assert.ok(!JSON.stringify(result.telemetry).includes("private"));
    assert.equal(result.telemetry.originalBudget, 8192);
  });
}
test("mapper budget never affects other providers/models and refuses unsupported shapes/headroom", () => {
  assert.equal(mapperRequest({}, { ...model, id: "other" }), undefined);
  assert.equal(mapperRequest({}, { ...model, provider: "other" }), undefined);
  assert.throws(() => mapperRequest({}, model), /unknown-wire-field/);
  assert.throws(() => mapperRequest({ max_tokens: 8192, max_completion_tokens: 8192 }, model), /unknown-wire-field/);
  assert.throws(() => mapperRequest({ max_tokens: 8192 }, { ...model, api: "other" }), /unsupported-api/);
  assert.throws(() => mapperRequest({ max_tokens: 8192 }, { ...model, contextWindow: 16000 }), /headroom/);
});

const message = (finish = "stop") => ({ role: "assistant", provider: "litellm", model: MAPPER_MODEL, stopReason: finish,
  content: [{ type: "thinking", thinking: "private reasoning" }, { type: "text", text: '{"complete":true}' }],
  usage: { input: 100, output: 24, reasoningTokens: 20, totalTokens: 124, secret: "not logged" } });
const stream = (msg) => [JSON.stringify({ type: "message_end", message: msg }), JSON.stringify({ type: "agent_end", messages: [] })].join("\n");
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
    assert.throws(() => ompCompletionText(stream(message(finish)), (record) => logs.push(record)), /mapper-terminal/);
    assert.equal(logs[0].finish, finish);
    assert.equal(logs[0].textPresent, true);
  });
}
test("thinking-only responses are never converted into text and unfinished JSON streams fail", () => {
  const msg = message();
  msg.content = [{ type: "thinking", thinking: '{"complete":true}' }];
  assert.equal(ompCompletionText(stream(msg), () => {}), "");
  assert.throws(() => ompCompletionText(JSON.stringify({ type: "message_end", message: message() }), () => {}), /incomplete-event-stream/);
  assert.throws(() => ompCompletionText(stream(message()) + '\n{"type":', () => {}), SyntaxError);
});
test("only explicitly enabled mapper invocations load the isolated hook/JSON transport", () => {
  const args = { runner: { kind: "omp", bin: "omp" }, prompt: "test" };
  assert.ok(!buildSubagentArgs(args).includes("--extension"));
  const argv = buildSubagentArgs({ ...args, mapperRuntime: true });
  assert.ok(argv.includes("--no-extensions") && argv.includes("--no-session"));
  assert.equal(argv[argv.indexOf("--mode") + 1], "json");
  assert.ok(argv[argv.indexOf("--extension") + 1].endsWith("omp-mapper-runtime.mjs"));
  assert.ok(!buildSubagentArgs({ ...args, mapperRuntime: true, runner: { kind: "opencode" } }).includes("--extension"));
  assert.equal(buildIsolatedSubagentEnv({}).ESHEPHERD_SOURCE_CAPTURE_ENABLED, "false");
});

// No inference: the installed CLI sends requests only to this loopback SSE fixture.
test("installed OMP propagates 8192 baseline and 24576 scoped budget through its real provider transport", { timeout: 60000 }, async (t) => {
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
    data({ id: "offline", choices: [{ index: 0, delta: { content: '{"complete":true}' }, finish_reason: "stop" }] });
    data({ id: "offline", choices: [], usage: { prompt_tokens: 100, completion_tokens: 24, total_tokens: 124, completion_tokens_details: { reasoning_tokens: 20 } } });
    res.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  writeFileSync(join(agentDir, "models.yml"), JSON.stringify({ providers: { litellm: {
    api: "openai-completions", apiKey: "offline-test-only", baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    models: [{ id: MAPPER_MODEL, name: "Offline mapper", reasoning: true, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 126976, maxTokens: 8192 }],
  } } }));
  const results = [];
  for (const enabled of [false, true]) {
    const argv = buildSubagentArgs({ runner: { kind: "omp", bin }, modelArg: "litellm," + MAPPER_MODEL,
      prompt: "Return JSON.", mapperRuntime: enabled });
    if (!enabled) argv.push("--mode", "json");
    argv.push("--no-tools", "--no-skills", "--no-rules", "--no-lsp", "--no-pty");
    const result = await new Promise((resolve, reject) => {
      const child = spawn(bin, argv, { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: buildIsolatedSubagentEnv({
        PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: agentDir,
      }) });
      let stdout = "", stderr = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), 20000);
      child.stdout.on("data", (chunk) => stdout += chunk);
      child.stderr.on("data", (chunk) => stderr += chunk);
      child.on("error", reject);
      child.on("close", (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    });
    assert.equal(result.status, 0, result.stderr);
    const telemetry = [];
    assert.equal(ompCompletionText(result.stdout, (record) => telemetry.push(record)), '{"complete":true}');
    assert.equal(telemetry.at(-1).usage.reasoningTokens, 20);
    results.push(result);
  }
  assert.equal(requests.length, 2, "exactly one provider request per offline invocation");
  assert.equal(requests[0].max_tokens ?? requests[0].max_completion_tokens, 8192);
  assert.equal(requests[1].max_tokens ?? requests[1].max_completion_tokens, MAPPER_OUTPUT_TOKENS);
  assert.match(results[1].stderr, /"originalBudget":8192,"budget":24576/);
  assert.equal(requests[0].reasoning_effort, requests[1].reasoning_effort);
  t.diagnostic("Real installed OMP wire: baseline 8192, scoped mapper 24576; reasoning unchanged; fixture usage output=24/reasoning=20.");
});
