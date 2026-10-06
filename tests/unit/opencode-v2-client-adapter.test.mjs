import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../../src/surface/plugin/session-policy-v2.ts";
import { createLegacyClientAdapter, toLegacyEvent } from "../../src/surface/opencode-v1/client-adapter.ts";
import { onMessageUpdatedWithGating } from "../../src/surface/plugin/session-policy/event-handlers.ts";
import { getActiveModel } from "../../src/surface/plugin/session-policy/routing.ts";

const user = { id: "msg_user", type: "user", text: "Fix the test", time: { created: 1 } };
const assistant = { id: "msg_assistant", type: "assistant", agent: "build", finish: "stop",
  model: { providerID: "custom", id: "pinned-model", variant: "careful" }, time: { created: 2 },
  content: [{ type: "text", text: "I will inspect the failure next." }] };
const request = { path: { id: "ses_fixture", messageID: assistant.id } };

for (const wrapped of [false, true]) {
  test(`adapter preserves native messages and turn context (${wrapped ? "HTTP envelope" : "SDK direct response"})`, async () => {
    const later = { ...user, id: "msg_later", text: "A later request", time: { created: 3 } };
    const messages = [user, assistant, later];
    const before = structuredClone(messages);
    const wrap = data => wrapped ? { data } : data;
    const client = createLegacyClientAdapter({ context: async () => wrap(messages),
      message: { get: async () => wrap(assistant) }, prompt: async () => assert.fail("unexpected prompt") });
    const mapped = (await client.session.message(request)).data;
    assert.equal(mapped.info.id, assistant.id);
    assert.equal(mapped.info.finish, "stop");
    assert.equal(mapped.info.parentID, user.id, "must not use a newer queued prompt");
    assert.equal(mapped.parts[0].text, assistant.content[0].text);
    assert.deepEqual(getActiveModel(mapped), { providerID: "custom", modelID: "pinned-model" });
    assert.equal(mapped.info.model.variant, "careful");
    assert.deepEqual(messages, before, "translation must not mutate native context");
    const list = (await client.session.messages(request)).data;
    assert.equal(list.length, 3);
    assert.equal(list[1].info.parentID, user.id);
  });
}

test("context fallback retains synthetic recovery ancestry and native tool states", async () => {
  const synthetic = { id: "msg_retry", type: "synthetic", text: "[Auto-Retry Guard] Recover", time: { created: 3 } };
  const after = { ...assistant, id: "msg_after", time: { created: 4 }, content: [
    { type: "reasoning", text: "reasoning" },
    { type: "tool", id: "call_1", name: "read", time: { created: 4 }, state: { status: "completed", input: { path: "test.ts" }, content: [{ type: "text", text: "test contents" }] } },
    { type: "tool", id: "call_2", name: "test", time: { created: 4 }, state: { status: "error", input: {}, error: { type: "fixture-error", message: "failed" } } },
  ] };
  const client = createLegacyClientAdapter({ context: async () => ({ data: [user, assistant, synthetic, after] }), prompt: async () => {} });
  const messages = (await client.session.messages(request)).data;
  assert.equal(messages[2].info.role, "user");
  assert.equal(messages[2].info.synthetic, true);
  assert.equal(messages[2].info.parentID, user.id);
  assert.equal(messages[2].parts[0].text, synthetic.text);
  const mapped = (await client.session.message({ path: { id: "ses_fixture", messageID: after.id } })).data;
  assert.equal(mapped.info.parentID, synthetic.id);
  assert.deepEqual(mapped.parts[1].input, { path: "test.ts" });
  assert.equal(mapped.parts[1].state.status, "completed");
  assert.deepEqual(mapped.parts[1].content, after.content[1].state.content);
  assert.deepEqual(mapped.parts[2].error, after.content[2].state.error);
  assert.equal((await client.session.message({ path: { id: "ses_fixture", messageID: "missing" } })).data, null);
});

test("synthetic nudges stay non-generating and normal prompts preserve delivery", async () => {
  const sent = [];
  const client = createLegacyClientAdapter({ context: async () => [],
    synthetic: async input => sent.push(["synthetic", input]), prompt: async input => sent.push(["prompt", input]) });
  await client.session.prompt({ path: { id: "ses_fixture" }, body: { noReply: true, parts: [{ type: "text", text: "Stop this repeated call" }], resume: false } });
  await client.session.prompt({ path: { id: "ses_fixture" }, body: { text: "Continue with the evidence", agent: "build", delivery: "queue" } });
  assert.equal(sent[0][0], "synthetic");
  assert.equal(sent[0][1].metadata.noReply, true);
  assert.equal(sent[0][1].resume, false);
  assert.equal(sent[1][0], "prompt");
  assert.deepEqual(sent[1][1].agents, [{ name: "build" }]);
  assert.equal(sent[1][1].delivery, "queue");
});

for (const history of [[user, assistant], []]) {
  test(`native step-end dispatch reaches policy with ${history.length ? "inferred parent" : "compacted context"}`, async () => {
    const client = createLegacyClientAdapter({ context: async () => history, message: { get: async ({ messageID }) => messageID === user.id ? user : assistant }, prompt: async () => {} });
    const called = [];
    const args = { client, directory: "/fixture", projectRoot: "/fixture", retryEnabled: true, spiralGuardEnabled: true,
      event: toLegacyEvent({ type: "session.step.ended", data: { sessionID: "ses_fixture", assistantMessageID: assistant.id, finish: "stop" } }),
      unwrapMessageResult: value => value?.data ?? null, noteAutoConsolidationActivity: () => {},
      verifySourceCapture: async () => {}, issueRetry: async (_sid, current, parent) => { called.push([current, parent]); return false; },
      maybeSpiralNudge: async () => { called.push("spiral"); return false; }, pruneToMax: () => {}, autoConsolidationMaxTrackedSessions: 10 };
    for (const key of ["retryChainBySession", "terminalCountBySession", "activeRoutingBySession", "messageCountBySession", "lastCountedMessageIdBySession"]) args[key] = new Map();
    args.startupConfirmedBySession = new Set();
    args.memoryReadSessions = new Set();
    await onMessageUpdatedWithGating(args);
    assert.equal(called[0][0].info.id, assistant.id);
    assert.equal(called[0][1]?.info.id ?? null, history.length ? user.id : null);
    assert.equal(called[1], "spiral");
  });
}

test("native control records do not hide the last conversational message", async () => {
  const client = createLegacyClientAdapter({ context: async () => [user, assistant,
    { id: "msg_control", type: "model-switched", time: { created: 3 }, model: { providerID: "custom", id: "other" } }], prompt: async () => {} });
  assert.equal((await client.session.messages(request)).data.at(-1).info.id, assistant.id);
});

test("native V2 event bridge scopes sessions and observes each completed step once", async t => {
  const root = mkdtempSync(join(tmpdir(), "es-v2-native-"));
  let requests = 0;
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    requests++;
    const input = JSON.parse(body);
    const criteria = Object.keys(input.questions.intervention.criteria);
    res.end(JSON.stringify({ model: input.model, answers: { intervention: { type: "choice", choice: "none", confidence: 0.8,
      probabilities: Object.fromEntries(criteria.map(key => [key, key === "none" ? 1 : 0])) } } }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  writeFileSync(join(root, "package.json"), "{}\n");
  writeFileSync(join(root, "eshepherd-config.jsonc"), JSON.stringify({
    turnGuard: { judge: { mode: "shadow", endpoint: `http://127.0.0.1:${server.address().port}/v1/systemone`, model: "fixture-model" } },
    retry: { enabled: false }, spiralGuard: { enabled: false }, checkpoint: { enabled: false }, sourceCapture: { verifyEnabled: false },
    consolidation: { auto: { enabled: false } }, memcore: { reinject: { enabled: false } },
  }));
  const step = sessionID => ({ type: "session.step.ended", data: { sessionID, assistantMessageID: assistant.id, finish: "stop" } });
  let events = [step("ses_missing"), step("ses_other"), step("ses_fixture"), step("ses_fixture"), { type: "session.idle", data: { sessionID: "ses_fixture" } }];
  let drain; const drained = new Promise(resolve => { drain = resolve; });
  let subscriptions = 0, subscriptionSignal;
  const ctx = { location: { directory: root },
    agent: { transform: async () => {} }, command: { transform: async () => {} }, skill: { transform: async () => {} },
    tool: { transform: async () => {}, hook: async () => {} },
    session: { hook: async () => {},
      get: async ({ sessionID }) => { if (sessionID === "ses_missing") throw new Error("fixture lookup failed"); return { location: { directory: sessionID === "ses_other" ? root + "/other" : root } }; },
      context: async () => [user, assistant], message: { get: async ({ messageID }) => messageID === user.id ? user : assistant },
      prompt: async () => assert.fail("shadow must not send messages"), synthetic: async () => assert.fail("shadow must not send messages"),
    },
    event: { subscribe: async function* (options) { subscriptions++; subscriptionSignal = options.signal; try { for (const event of events) yield event; } finally { drain(); } } },
  };
  const cleanup = await plugin.setup(ctx);
  t.after(async () => { cleanup?.(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true }); });
  await drained;
  const log = join(root, ".electric-shepherd", "turn-guard-judge.ndjson");
  const deadline = Date.now() + 2000;
  while (!existsSync(log) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(existsSync(log), "native step dispatch must reach the shadow observer");
  const records = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(requests, 1, "foreign sessions, duplicate step and idle must not cause extra checks");
  assert.equal(records.length, 1);
  assert.equal(records[0].status, "judged");
  assert.equal(subscriptions, 1);
  cleanup();
  assert.equal(subscriptionSignal.aborted, true);
  events = [];
  const reloaded = await plugin.setup(ctx);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(subscriptions, 2, "cleanup must release the per-directory guard owner");
  reloaded?.();
});
