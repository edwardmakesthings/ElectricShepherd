import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTurnGuardShadowJudge } from "../../src/surface/plugin/session-policy/shadow-judge.ts";

const choices = ["none", "retry", "break_loop", "checkpoint", "escalate", "uncertain"];
const answer = (choice = "retry") => ({ model: "fixture-model", answers: { intervention: { type: "choice", choice,
  confidence: 0.8, probabilities: Object.fromEntries(choices.map(key => [key, key === choice ? 1 : 0])) } } });
const message = (id, role, body, extra = {}) => ({ info: { id, role, parentID: "", time: { created: 1 }, ...extra }, parts: [{ type: "text", text: body }] });
const history = () => [message("msg_user", "user", "Fix the failing test"),
  message("msg_previous", "assistant", "The test failed" , { finish: "tool-calls" }),
  message("msg_current", "assistant", "I will look at the failure next", { finish: "stop" })];

async function fixture(t, handler) {
  const received = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    received.push({ input, url: req.url, headers: req.headers });
    await handler(input, res);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { endpoint: `http://127.0.0.1:${server.address().port}/v1/systemone`, received };
}
function judge(endpoint, overrides = {}) {
  const records = [];
  const instance = createTurnGuardShadowJudge({ mode: "shadow", endpoint, model: "fixture-model", timeoutMs: 1000,
    maxStateChars: 2000, projectRoot: "/unused", getMessages: async () => history(), record: entry => records.push(entry), ...overrides });
  return { instance, records };
}

test("heuristic mode makes no context or inference calls", async () => {
  const { instance, records } = judge("invalid", { mode: "heuristic", getMessages: async () => assert.fail("context read") });
  await instance.observe("ses_fixture", "msg_current");
  assert.deepEqual(records, []);
});

test("shadow sends bounded visible evidence, records recommendations, and deduplicates", async t => {
  const wire = await fixture(t, (_input, res) => res.end(JSON.stringify(answer("break_loop"))));
  const messages = history();
  messages[0].parts[0].text = "task ".repeat(1000);
  messages[1].parts.push({ type: "reasoning", text: "private reasoning must not be sent" });
  messages[2].parts.push({ type: "tool", tool: "test", callID: "call_1", input: {}, state: { status: "completed", input: {}, content: [{ type: "text", text: "exact failure evidence" }] } });
  messages.push(message("msg_later", "user", "future queued prompt must not be sent"));
  const before = structuredClone(messages);
  const { instance, records } = judge(wire.endpoint, { getMessages: async () => messages });
  await instance.observe("ses_fixture", "msg_current");
  await instance.observe("ses_fixture", "msg_current");
  assert.equal(wire.received.length, 1);
  const request = wire.received[0];
  assert.equal(request.input.model, "fixture-model");
  assert.equal(request.input.questions.intervention.type, "choice");
  assert.deepEqual(Object.keys(request.input.questions.intervention.criteria), choices);
  assert.ok(request.input.state.length <= 2000);
  assert.match(request.input.state, /exact failure evidence/);
  assert.doesNotMatch(request.input.state, /private reasoning|future queued prompt/);
  assert.equal(request.headers.authorization, undefined);
  assert.equal(request.input.tools, undefined);
  assert.equal(records.length, 1);
  assert.equal(records[0].recommendation, "break_loop");
  assert.equal(records[0].truncated, true);
  assert.deepEqual(messages, before, "judgement must not modify session state");
});

test("synthetic interventions and unfinished messages never trigger inference", async t => {
  const wire = await fixture(t, (_input, res) => res.end(JSON.stringify(answer())));
  for (const synthetic of [true, false]) {
    const messages = history();
    messages[0].info.synthetic = synthetic;
    messages[0].parts[0].text = synthetic ? "Guard response" : "[Auto-Retry Guard] Recover";
    const { instance, records } = judge(wire.endpoint, { getMessages: async () => messages });
    await instance.observe("ses_fixture", "msg_current");
    assert.equal(records[0].reason, "guard-message");
  }
  const { instance, records } = judge(wire.endpoint, { getMessages: async () => [message("msg_current", "assistant", "Still streaming")] });
  await instance.observe("ses_fixture", "msg_current");
  assert.equal(records[0].reason, "message-unavailable");
  assert.equal(wire.received.length, 0);
});

test("all guard instances share one inference slot without a backlog", async t => {
  let start;
  const started = new Promise(resolve => { start = resolve; });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const wire = await fixture(t, async (_input, res) => { start(); await gate; res.end(JSON.stringify(answer())); });
  const first = judge(wire.endpoint), second = judge(wire.endpoint);
  const running = first.instance.observe("ses_first", "msg_current");
  await started;
  await second.instance.observe("ses_second", "msg_current");
  assert.equal(second.records[0].reason, "busy");
  assert.equal(wire.received.length, 1);
  release();
  await running;
  assert.equal(first.records[0].status, "judged");
});

for (const mutate of [value => { value.model = "other-model"; }, value => { value.answers.intervention.choice = "invented"; },
  value => { value.answers.intervention.confidence = 2; }, value => { value.answers.intervention.probabilities.retry = -1; }]) {
  test("invalid verdicts are failures, not decisions", async t => {
    const value = answer(); mutate(value);
    const wire = await fixture(t, (_input, res) => res.end(JSON.stringify(value)));
    const { instance, records } = judge(wire.endpoint);
    await instance.observe("ses_fixture", "msg_current");
    assert.equal(records[0].reason, "invalid-response");
    assert.equal(records[0].recommendation, undefined);
  });
}

test("context timeouts release the slot and never stall the main policy", async () => {
  const { instance, records } = judge("http://127.0.0.1:1/v1/systemone", { timeoutMs: 20, getMessages: () => new Promise(() => {}) });
  await instance.observe("ses_fixture", "msg_current");
  assert.equal(records[0].reason, "timeout");
  const next = judge("invalid");
  await next.instance.observe("ses_next", "msg_current");
  assert.equal(next.records[0].reason, "configuration", "slot must be released, not busy");
});

test("stream timeouts abort the HTTP connection and disposal stops future checks", async t => {
  let close;
  const closed = new Promise(resolve => { close = resolve; });
  const wire = await fixture(t, (_input, res) => { res.on("close", close); res.writeHead(200); res.write("{"); });
  const { instance, records } = judge(wire.endpoint, { timeoutMs: 500 });
  await instance.observe("ses_fixture", "msg_current");
  await closed;
  assert.equal(records[0].reason, "timeout");
  instance.dispose();
  await instance.observe("ses_fixture", "msg_previous");
  assert.equal(wire.received.length, 1);
});

test("oversized responses and redirects fail without a fallback request", async t => {
  for (const redirect of [false, true]) {
    const wire = await fixture(t, (_input, res) => redirect ?
      res.writeHead(302, { Location: "/unexpected" }).end() : res.end("x".repeat(70000)));
    const { instance, records } = judge(wire.endpoint);
    await instance.observe("ses_fixture", "msg_current");
    assert.equal(records[0].status, "failed");
    assert.equal(wire.received.length, 1);
  }
});

test("durable shadow records exclude prompts, raw responses, and error text", async t => {
  const root = mkdtempSync(join(tmpdir(), "es-shadow-record-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const wire = await fixture(t, (_input, res) => res.end(JSON.stringify(answer("uncertain"))));
  const { instance } = judge(wire.endpoint, { projectRoot: root, record: undefined });
  await instance.observe("ses_fixture", "msg_current");
  const file = join(root, ".electric-shepherd", "turn-guard-judge.ndjson");
  const output = readFileSync(file, "utf8");
  assert.equal(JSON.parse(output).recommendation, "uncertain");
  assert.doesNotMatch(output, /Fix the failing test|I will look|probabilities/);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});
