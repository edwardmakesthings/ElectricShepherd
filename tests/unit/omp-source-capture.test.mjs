import assert from "node:assert/strict";
import test from "node:test";

import { renderSessionTranscript } from "../../src/surface/omp/source-capture.ts";

const line = (entry) => JSON.stringify(entry);

const SESSION = [
  line({ type: "session", id: "s1" }),
  line({ type: "message", message: { role: "user", content: [{ type: "text", text: "do the thing" }] } }),
  line({
    type: "message",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "done" },
        { type: "toolCall", name: "read" },
      ],
    },
  }),
  line({ type: "model_change", model: "x" }),
].join("\n");

test("renderSessionTranscript emits the compact shape the pipeline already reads", () => {
  const parsed = JSON.parse(renderSessionTranscript(SESSION, "s1", "/proj"));

  assert.deepEqual(parsed.session, { id: "s1", title: null, directory: "/proj" });
  assert.deepEqual(parsed.messages, [
    { role: "user", text: "do the thing" },
    { role: "assistant", text: "done" },
  ]);
});

// Matches transcript_capture_normalization.py: text parts only, so a capture from
// either harness feeds the consolidation mapper the same structure.
test("renderSessionTranscript keeps text parts and drops thinking and tool calls", () => {
  const parsed = JSON.parse(renderSessionTranscript(SESSION, "s1", "/proj"));
  const assistant = parsed.messages.find((m) => m.role === "assistant");
  assert.equal(assistant.text, "done");
});

test("renderSessionTranscript trims embedded content blocks", () => {
  const jsonl = line({
    type: "message",
    message: { role: "user", content: [{ type: "text", text: "before <content>\nbulk\n</content> after" }] },
  });
  const parsed = JSON.parse(renderSessionTranscript(jsonl, "s1", "/proj"));
  assert.match(parsed.messages[0].text, /trimmed by source-capture normalization/);
  assert.ok(!parsed.messages[0].text.includes("bulk"));
});

// The log is appended to while a session runs, so the last line can be half-written.
test("renderSessionTranscript survives a torn final line", () => {
  const jsonl = `${line({ type: "message", message: { role: "user", content: [{ type: "text", text: "ok" }] } })}\n{"type":"mess`;
  const parsed = JSON.parse(renderSessionTranscript(jsonl, "s1", "/proj"));
  assert.equal(parsed.messages.length, 1);
});

test("renderSessionTranscript returns empty when nothing carries text", () => {
  assert.equal(renderSessionTranscript(line({ type: "model_change" }), "s1", "/proj"), "");
  assert.equal(renderSessionTranscript("", "s1", "/proj"), "");
});
