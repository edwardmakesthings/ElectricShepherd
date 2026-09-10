import assert from "node:assert/strict";
import test from "node:test";

import { registerCheckpoint } from "../../src/surface/omp/session-stop.ts";
import { CHECKPOINT_PROMPT } from "../../src/policy/checkpoint-prompt.ts";

function capture() {
  let handler;
  const logs = [];
  const pi = {
    zod: {},
    logger: { warn: (message) => logs.push(message) },
    registerTool() {},
    on(_event, fn) {
      handler = fn;
    },
  };
  registerCheckpoint(pi);
  return { handler, logs };
}

const assistant = (text, stopReason = "stop") => ({
  role: "assistant",
  stopReason,
  content: [{ type: "text", text }],
});

const DONE = assistant("Done. I refactored the substrate seam and all tests pass.");
const FOUR_TURNS = [assistant("a"), assistant("b"), assistant("c"), DONE];
const ctx = { cwd: process.cwd() };

function stopEvent(overrides = {}) {
  return {
    type: "session_stop",
    messages: FOUR_TURNS,
    turn_id: 1,
    session_id: "s",
    stop_hook_active: false,
    last_assistant_message: DONE,
    ...overrides,
  };
}

test("omp checkpoint requests a continuation after a clean, substantive session", async () => {
  const { handler, logs } = capture();
  const result = await handler(stopEvent(), ctx);
  assert.equal(result.continue, true);
  assert.equal(result.additionalContext, CHECKPOINT_PROMPT);
  assert.match(logs.join("\n"), /memory checkpoint requested/);
});

test("omp checkpoint fires at most once per session", async () => {
  const { handler } = capture();
  assert.ok(await handler(stopEvent(), ctx));
  assert.equal(await handler(stopEvent(), ctx), undefined);
});

test("omp checkpoint does not re-enter its own continuation", async () => {
  const { handler } = capture();
  assert.equal(await handler(stopEvent({ stop_hook_active: true }), ctx), undefined);
});

test("omp checkpoint skips sessions that did too little work", async () => {
  const { handler } = capture();
  assert.equal(await handler(stopEvent({ messages: [DONE] }), ctx), undefined);
});

test("omp checkpoint never lands on a stall", async () => {
  const midIntent = assistant("Now let me verify the delete button:");
  const aborted = assistant("Done and dusted, all good here.", "aborted");
  const empty = assistant("ok");

  for (const last of [midIntent, aborted, empty]) {
    const { handler } = capture();
    assert.equal(await handler(stopEvent({ last_assistant_message: last }), ctx), undefined);
  }
});
