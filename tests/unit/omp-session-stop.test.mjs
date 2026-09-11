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

// session_stop only fires on the top-level session (task subagents get none of
// their own), so a one-shot `omp -p` command that delegates to a subagent and
// reports its answer settles as an ordinary top-level turn — indistinguishable
// by content from real interactive work. `omp -p` is documented as "process
// prompt and exit"; a continuation there is a turn the invocation can't read.
test("omp checkpoint does not fire for a one-shot print-mode invocation", async () => {
  const { handler, logs } = capture();
  const result = await handler(stopEvent(), { ...ctx, mode: "print" });
  assert.equal(result, undefined);
  assert.match(logs.join("\n"), /mode=print is not interactive/);
});

test("omp checkpoint still fires for interactive and rpc sessions", async () => {
  for (const mode of ["tui", "rpc"]) {
    const { handler } = capture();
    const result = await handler(stopEvent(), { ...ctx, mode });
    assert.ok(result, mode);
  }
});

test("omp checkpoint interactive-only gate can be turned off", async () => {
  const previous = process.env.ESHEPHERD_CHECKPOINT_INTERACTIVE_ONLY;
  process.env.ESHEPHERD_CHECKPOINT_INTERACTIVE_ONLY = "false";
  try {
    const { handler } = capture();
    const result = await handler(stopEvent(), { ...ctx, mode: "print" });
    assert.ok(result);
  } finally {
    if (previous === undefined) delete process.env.ESHEPHERD_CHECKPOINT_INTERACTIVE_ONLY;
    else process.env.ESHEPHERD_CHECKPOINT_INTERACTIVE_ONLY = previous;
  }
});

// checkpoint.disabledAgents is an existing OpenCode config key this surface
// never read. Recognised the same way the synthesis boundary recognises the
// dreamer: from the system prompt's identity sentence.
test("omp checkpoint skips a session whose active agent is disabled", async () => {
  const previous = process.env.ESHEPHERD_CHECKPOINT_DISABLED_AGENTS;
  process.env.ESHEPHERD_CHECKPOINT_DISABLED_AGENTS = "dreamer";
  try {
    const { handler, logs } = capture();
    const result = await handler(stopEvent(), {
      ...ctx,
      mode: "tui",
      getSystemPrompt: () => ["You are the Dreamer."],
    });
    assert.equal(result, undefined);
    assert.match(logs.join("\n"), /disabledAgents/);
  } finally {
    if (previous === undefined) delete process.env.ESHEPHERD_CHECKPOINT_DISABLED_AGENTS;
    else process.env.ESHEPHERD_CHECKPOINT_DISABLED_AGENTS = previous;
  }
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
