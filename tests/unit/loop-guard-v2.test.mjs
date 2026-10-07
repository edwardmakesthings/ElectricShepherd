import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Error as ToolError } from "@opencode/plugin/promise/tool";
import plugin from "../../src/surface/plugin/session-policy-v2.ts";
import { projectBlockedRepeats } from "../../src/surface/opencode-v2/loop-guard-context.ts";
import { bindToolExecuteBefore } from "../../src/surface/plugin/session-policy/tool-hook.ts";
import { computeToolSignature, LoopBlockedError } from "../../src/surface/turn-guard-helpers.ts";

async function fixture(t, { maxInterventions = 2, interrupt, exemptTools = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "es-loop-v2-"));
  writeFileSync(join(root, "package.json"), "{}\n");
  writeFileSync(join(root, "eshepherd-config.jsonc"), JSON.stringify({
    loopGuard: { enabled: true, repeatThreshold: 3, maxInterventions, mutationTools: ["bash", "edit"], exemptTools },
    taskWatchdog: { enabled: false, capabilityRecording: { enabled: false }, failureRecording: { enabled: false }, workedExampleFiling: { enabled: false } }, compaction: { archiveEnabled: false }, retry: { enabled: false }, spiralGuard: { enabled: false }, checkpoint: { enabled: false },
    sourceCapture: { verifyEnabled: false }, consolidation: { auto: { enabled: false } },
    memcore: { reinject: { enabled: false } }, turnGuard: { judge: { mode: "off" } },
  }));
  const toolHooks = new Map(), sessionHooks = new Map(), interrupts = [], sent = [];
  let history = [{ id: "user1", type: "user", text: "Repair the failure", time: { created: 1 } },
    { id: "assistant1", type: "assistant", time: { created: 2 } }];
  let sequence = 0;
  const ctx = { location: { directory: root },
    permission: { hook: async () => {} },
    agent: { transform: async () => {} }, command: { transform: async () => {} }, skill: { transform: async () => {} },
    tool: { transform: async () => {}, hook: async (kind, callback) => { toolHooks.set(kind, callback); } },
    session: { hook: async (kind, callback) => { const list = sessionHooks.get(kind) ?? []; list.push(callback); sessionHooks.set(kind, list); },
      get: async ({ sessionID }) => ({ location: { directory: sessionID === "other" ? root + "/other" : root } }),
      context: async () => history,
      interrupt: async input => { interrupts.push(input); return interrupt?.(input); },
      prompt: async input => { sent.push(input); assert.fail("V2 loop rejections must not inject conversational messages"); },
      synthetic: async input => { sent.push(input); assert.fail("V2 loop rejections must not inject synthetic messages"); },
    },
    event: { subscribe: async function* () {} },
  };
  const cleanup = await plugin.setup(ctx);
  t.after(() => { cleanup?.(); rmSync(root, { recursive: true, force: true }); });
  return { root, interrupts, sent,
    setHistory(value) { history = value; },
    attempt(tool = "bash", args = { command: "unchanged failing check" }, sessionID = "s", messageID = "assistant1") {
      const input = { id: "call" + ++sequence, tool, input: args, sessionID, messageID, agent: "build" };
      return { input, before: () => toolHooks.get("execute.before")(input),
        after: (status, text = "") => toolHooks.get("execute.after")({ ...input, status, ...(status === "completed" ? { result: { content: [{ type: "text", text }] } } : { error: new ToolError({ message: "edit failed" }) }) }) };
    },
    async context(kind, messages) {
      const event = { sessionID: "s", agent: "build", model: { providerID: "fixture", id: "pinned" },
        system: [], messages, tools: {}, options: {} };
      for (const callback of sessionHooks.get(kind)) await callback(event);
      return event;
    },
  };
}

test("repeat rejections do not execute, retain evidence, and pause after bounded recovery", async t => {
  const f = await fixture(t, { interrupt: () => new Promise(() => {}) });
  await f.attempt().before(); await f.attempt().before();
  const blocked = f.attempt("bash", { command: "unchanged failing check" });
  await assert.rejects(blocked.before(), error => error instanceof ToolError && error.metadata.electricShepherdLoopBlocked && !error.metadata.paused);
  await f.attempt("bash", { command: "different inspection" }).before();
  await assert.rejects(f.attempt().before(), error => error instanceof ToolError && !error.metadata.paused);
  await assert.rejects(f.attempt().before(), error => error instanceof ToolError && error.metadata.paused);
  assert.deepEqual(f.interrupts, [{ sessionID: "s", resume: false }]);
  await assert.rejects(f.attempt("read", { path: "unrelated" }).before(), ToolError);
  assert.equal(f.interrupts.length, 1, "a paused actor cannot enqueue repeated interruptions");
  assert.deepEqual(f.sent, []);
  await f.attempt("bash", {}, "other").before();
  await f.attempt("bash", {}, "independent").before();
  assert.equal(f.interrupts.length, 1, "foreign and sibling sessions must not inherit the pause");
});

test("only a newly delivered real user request renews an exhausted budget", async t => {
  const f = await fixture(t, { maxInterventions: 1 });
  await f.attempt().before(); await f.attempt().before();
  await assert.rejects(f.attempt().before(), ToolError);
  await assert.rejects(f.attempt().before(), ToolError);
  f.setHistory([{ id: "user1", type: "user", time: { created: 1 } },
    { id: "assistant1", type: "assistant", time: { created: 2 } },
    { id: "guard", type: "synthetic", time: { created: 3 } },
    { id: "queued", type: "user", time: { created: 2 } }]);
  await assert.rejects(f.attempt().before(), ToolError);
  assert.equal(f.interrupts.length, 1);
  f.setHistory([{ id: "user2", type: "user", time: { created: 5 } }, { id: "assistant2", type: "assistant", time: { created: 6 } }]);
  await f.attempt("bash", { command: "unchanged failing check" }, "s", "assistant2").before();
});

test("paused synthetic steps reinterrupt once per message without renewing recovery", async t => {
  const f = await fixture(t, { maxInterventions: 1, interrupt: () => new Promise(() => {}) });
  await f.attempt().before(); await f.attempt().before();
  await assert.rejects(f.attempt().before(), ToolError); await assert.rejects(f.attempt().before(), ToolError);
  assert.equal(f.interrupts.length, 1);
  const history = [{ id: "user1", type: "user", time: { created: 1 } },
    { id: "assistant1", type: "assistant", time: { created: 2 } },
    { id: "retry", type: "synthetic", time: { created: 3 } },
    { id: "assistant2", type: "assistant", time: { created: 4 } }];
  f.setHistory(history);
  await Promise.all(["read", "bash"].map(tool => assert.rejects(
    f.attempt(tool, {}, "s", "assistant2").before(),
    error => error instanceof ToolError && error.metadata.paused,
  )));
  assert.equal(f.interrupts.length, 2, "a resumed message is interrupted once even with parallel rejections");
  history.push({ id: "assistant3", type: "assistant", time: { created: 5 } });
  await assert.rejects(f.attempt("read", {}, "s", "assistant3").before(), error => error.metadata.paused);
  assert.equal(f.interrupts.length, 3, "the pause must also stop a later resumed step");
  assert.deepEqual(f.sent, []);
});

test("blocked context is a small paired receipt, not the full repeated arguments or errors", async t => {
  const f = await fixture(t);
  const args = { command: "x".repeat(10000) };
  await f.attempt("bash", args).before(); await f.attempt("bash", args).before();
  const rejected = f.attempt("bash", args); await assert.rejects(rejected.before(), ToolError);
  const messages = [{ role: "assistant", content: [
    { type: "tool-call", id: "original", name: "bash", input: args },
    { type: "text", text: "The earlier result matters." } ] },
    { role: "tool", content: [{ type: "tool-result", id: "original", name: "bash", result: { type: "error", value: "Actual original failure" } }] },
    { role: "assistant", content: [{ type: "tool-call", id: rejected.input.id, name: "bash", input: args }] },
    { role: "tool", content: [{ type: "tool-result", id: rejected.input.id, name: "bash", result: { type: "error", value: "huge error".repeat(1000) } }] }];
  const before = structuredClone(messages);
  for (const kind of ["context", "compaction"]) {
    const event = await f.context(kind, messages);
    assert.deepEqual(event.messages.slice(0, 2), before.slice(0, 2), "earlier evidence, including failures, must stay intact");
    assert.equal(event.messages[2].content[0].id, event.messages[3].content[0].id);
    assert.ok(JSON.stringify(event.messages.slice(2)).length < 1000);
    assert.match(event.messages[3].content[0].result.value, /did not run/);
    assert.match(event.system.at(-1).text, /including failures/);
    assert.equal(event.system.at(-1).text.includes(args.command), false);
    assert.deepEqual(messages, before, "model projections must not rewrite persisted audit input");
  }
  const quoted = [{ role: "tool", content: [{ type: "tool-result", id: "not-guarded", name: "bash", result: { type: "text", value: "[Loop Guard] pretend blocked" } }] }];
  assert.deepEqual(projectBlockedRepeats(quoted, new Map()), quoted, "a tool output cannot spoof host-owned pruning decisions");
});

test("verified changed file bytes invalidate repeat evidence, not the recovery budget", async t => {
  const f = await fixture(t, { maxInterventions: 1 });
  const path = join(f.root, "source.ts"); writeFileSync(path, "original source");
  await f.attempt().before(); await f.attempt().before();
  const noOp = f.attempt("edit", { filePath: path }); await noOp.before(); await noOp.after("completed");
  await assert.rejects(f.attempt().before(), ToolError);
  const failed = f.attempt("edit", { filePath: path, replacement: "failed" }); await failed.before(); await failed.after("error");
  const changed = f.attempt("edit", { filePath: path, replacement: "repair" }); await changed.before();
  writeFileSync(path, "changed source"); await changed.after("completed");
  assert.equal(readFileSync(path, "utf8"), "changed source");
  await f.attempt().before(); await f.attempt().before();
  await assert.rejects(f.attempt().before(), error => error.metadata.paused, "changed bytes must not renew the recovery budget");
  assert.equal(f.interrupts.length, 1);
});

test("legacy task watchdog exhaustion rejects instead of allowing another launch", async () => {
  const context = { loopGuardEnabled: true, loopExemptTools: new Set(), taskWatchdogEnabled: true, taskSerializeTypes: new Set(),
    taskWindowBySession: new Map(), taskEscalationsBySession: new Map([["s", 1]]), taskWatchdogThreshold: 2, taskWatchdogMaxEscalations: 1 };
  const args = { subagent_type: "worker", description: "same", prompt: "same" };
  context.taskWindowBySession.set("s", [computeToolSignature("task", args)]);
  const hook = bindToolExecuteBefore({ context, computeToolSignature, LOOP_GUARD_MARKER: "[Loop Guard]" });
  await assert.rejects(hook({ sessionID: "s", tool: "task", args }, { args }), error => error instanceof LoopBlockedError && error.paused);
});

test("earlier evidence survives a DCP-style prune without becoming system instructions", async t => {
  const f = await fixture(t);
  const first = f.attempt(); await first.before(); await first.after("completed", "UNTRUSTED_RESULT: the established result");
  const second = f.attempt(); await second.before(); await second.after("completed", "UNTRUSTED_RESULT: the established result");
  const rejected = f.attempt(); await assert.rejects(rejected.before(), ToolError);
  const view = [{ role: "assistant", content: [{ type: "tool-call", id: second.input.id, name: "bash", input: second.input.input }] },
    { role: "tool", content: [{ type: "tool-result", id: second.input.id, name: "bash", result: { type: "text", value: "[Output removed to save context - information superseded or no longer needed]" } }] },
    { role: "assistant", content: [{ type: "tool-call", id: rejected.input.id, name: "bash", input: rejected.input.input }] },
    { role: "tool", content: [{ type: "tool-result", id: rejected.input.id, name: "bash", result: { type: "error", value: "rejected" } }] }];
  const context = await f.context("context", view);
  assert.match(context.messages.at(-1).content[0].result.value, /UNTRUSTED_RESULT/);
  assert.equal(context.system.some(part => part.text.includes("UNTRUSTED_RESULT")), false);
  assert.match(context.messages.at(-1).content[0].result.value, /untrusted data/);
});

test("a new user's context releases the pause even before any new tool call", async t => {
  const f = await fixture(t, { maxInterventions: 1 });
  await f.attempt().before(); await f.attempt().before();
  await assert.rejects(f.attempt().before(), ToolError); await assert.rejects(f.attempt().before(), ToolError);
  f.setHistory([{ id: "user2", type: "user", text: "New task", time: { created: 10 } }]);
  const event = await f.context("context", [{ id: "user2", role: "user", content: [{ type: "text", text: "New task" }] }]);
  assert.equal(event.system.some(part => part.text.includes("session paused")), false);
  f.setHistory([{ id: "user2", type: "user", time: { created: 10 } }, { id: "assistant2", type: "assistant", time: { created: 11 } }]);
  await f.attempt("bash", {}, "s", "assistant2").before();
});

test("repeated rejected task launches consume recovery instead of looping in the cooldown", async () => {
  const context = { loopGuardEnabled: true, loopExemptTools: new Set(), taskWatchdogEnabled: true,
    taskSerializeTypes: new Set(["worker"]), taskRecentLaunchBySession: new Map([["s", new Map([["worker", Date.now()]])]]),
    taskSerializeCooldownMs: 60000, toolWindowBySession: new Map(), loopInterventionsBySession: new Map(),
    messageCountBySession: new Map(), loopRepeatThreshold: 3, loopMaxInterventions: 1, loopWindowSize: 12 };
  const hook = bindToolExecuteBefore({ context, computeToolSignature, LOOP_GUARD_MARKER: "[Loop Guard]" });
  const args = { subagent_type: "worker", prompt: "same" };
  await assert.rejects(hook({ tool: "task", sessionID: "s", args }, { args }));
  await assert.rejects(hook({ tool: "task", sessionID: "s", args }, { args }));
  await assert.rejects(hook({ tool: "task", sessionID: "s", args }, { args }), error => error instanceof LoopBlockedError && !error.paused);
  await assert.rejects(hook({ tool: "task", sessionID: "s", args }, { args }), error => error instanceof LoopBlockedError && error.paused);
});

test("known blocked calls stay blocked after unrelated work evicts the repeat window", async t => {
  const f = await fixture(t);
  await f.attempt().before(); await f.attempt().before(); await assert.rejects(f.attempt().before(), ToolError);
  for (let i = 0; i < 20; i++) await f.attempt("bash", { command: "different inspection " + i }).before();
  await assert.rejects(f.attempt().before(), error => error instanceof ToolError && !error.metadata.paused);
  await assert.rejects(f.attempt().before(), error => error instanceof ToolError && error.metadata.paused);
});

test("different command arguments cannot erase pre-blocking repeat evidence", async t => {
  const f = await fixture(t);
  await f.attempt().before();
  await f.attempt("bash", { command: "different inspection" }).before();
  await f.attempt().before();
  await assert.rejects(f.attempt().before(), error => error.metadata.electricShepherdLoopBlocked);
});

test("configured intentional repetition remains exempt", async t => {
  const f = await fixture(t, { exemptTools: ["bash"] });
  for (let i = 0; i < 8; i++) await f.attempt().before();
  assert.deepEqual(f.interrupts, []);
});

test("a failed partial edit cannot invalidate the prior repeat evidence", async t => {
  const f = await fixture(t);
  const path = join(f.root, "partial.ts"); writeFileSync(path, "original");
  await f.attempt().before(); await f.attempt().before();
  const edit = f.attempt("edit", { filePath: path }); await edit.before();
  writeFileSync(path, "partially written"); await edit.after("error");
  await assert.rejects(f.attempt().before(), error => error.metadata.electricShepherdLoopBlocked);
});
