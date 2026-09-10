import assert from "node:assert/strict";
import test from "node:test";

import { registerCompaction } from "../../src/surface/omp/compaction.ts";
import { MEMCORE_HEADING } from "../../src/surface/omp/runtime.ts";

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
  registerCompaction(pi);
  return { handler, logs };
}

const event = {
  type: "session.compacting",
  sessionId: "s1",
  messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "work" }] }],
};

test("omp compaction tells the summarizer which signals must survive the fold", async () => {
  const { handler } = capture();
  const result = await handler(event, { cwd: process.cwd() });

  assert.ok(result, "expected compaction context");
  assert.equal(result.context.length, 1);
  assert.match(result.context[0], /retain across this compaction/i);
  assert.equal(result.preserveData.electricShepherd.retentionNoteApplied, true);
});

// Mem-core rides the before_agent_start system-prompt override, which omp keeps
// across compaction rebuilds. Repeating it to the summarizer would let the summary
// copy it back into the conversation, leaving it in context twice.
test("omp compaction does not feed mem-core to the summarizer", async () => {
  const { handler } = capture();
  const result = await handler(event, { cwd: process.cwd() });

  assert.ok(
    !result.context.some((entry) => entry.includes(MEMCORE_HEADING)),
    "mem-core must not appear in the summarizer context",
  );
});

test("omp compaction stays out of the fold when the archive flag is off", async () => {
  const previous = process.env.ESHEPHERD_COMPACT_ARCHIVE;
  process.env.ESHEPHERD_COMPACT_ARCHIVE = "false";
  try {
    const { handler } = capture();
    // cwd without a config file, so the env flag is the only input.
    assert.equal(await handler(event, { cwd: process.env.TMPDIR || "/tmp" }), undefined);
  } finally {
    if (previous === undefined) delete process.env.ESHEPHERD_COMPACT_ARCHIVE;
    else process.env.ESHEPHERD_COMPACT_ARCHIVE = previous;
  }
});
