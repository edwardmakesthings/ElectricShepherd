import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  registerCompactionArchive,
  renderCompactionArchive,
  writeCompactionArchive,
} from "../../src/surface/opencode-v2/compaction-archive.ts";
import { abortable } from "../../src/surface/opencode-v2/tool-adapter.ts";

const MESSAGES = [
  { role: "system", content: [{ type: "text", text: "system prompt" }] },
  { role: "user", content: [{ type: "text", text: "Fix the bug" }] },
  { role: "assistant", content: [{ type: "compaction", provider: "x", text: "earlier summary" }] },
  { role: "assistant", content: [{ type: "text", text: "Looking" }, { type: "tool-call", id: "1", name: "read", input: {} }] },
  { role: "tool", content: [{ type: "tool-result", id: "1", name: "read" }] },
  { role: "assistant", content: [{ type: "reasoning", text: "hidden" }] },
];

test("renderCompactionArchive keeps user/assistant turns, tool names and prior summaries", () => {
  const at = new Date("2026-10-01T12:00:00Z");
  const markdown = renderCompactionArchive("ses_1", MESSAGES, at);
  assert.match(markdown, /# Compaction archive — session ses_1/);
  assert.match(markdown, /3 messages folded by compaction/);
  assert.match(markdown, /## \[user\]\nFix the bug/);
  assert.match(markdown, /\(previous compaction summary\)/);
  assert.match(markdown, /Looking\n\(tools: read\)/);
  assert.doesNotMatch(markdown, /system prompt|hidden/);
  assert.equal(renderCompactionArchive("ses_1", [MESSAGES[0], MESSAGES[4]], at), null);
});

test("registerCompactionArchive writes one file per compaction and never throws into compaction", async () => {
  const dir = mkdtempSync(join(tmpdir(), "es-archive-"));
  try {
    let hook;
    await registerCompactionArchive({ session: { hook: async (name, cb) => { assert.equal(name, "compaction"); hook = cb; } } }, dir);
    hook({ sessionID: "ses_2", messages: MESSAGES });
    const files = readdirSync(dir);
    assert.equal(files.length, 1);
    assert.match(files[0], /^ses_2-/);
    assert.match(readFileSync(join(dir, files[0]), "utf8"), /Fix the bug/);

    assert.doesNotThrow(() => hook({ sessionID: "ses_3", messages: null }));
    assert.equal(writeCompactionArchive(dir, "ses_4", []), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("abortable resolves normally, and rejects promptly once the session stops the call", async () => {
  assert.equal(await abortable(Promise.resolve("ok"), undefined, "t"), "ok");
  assert.equal(await abortable(Promise.resolve("ok"), new AbortController().signal, "t"), "ok");

  const controller = new AbortController();
  const pending = abortable(new Promise(() => {}), controller.signal, "palace_report");
  controller.abort();
  await assert.rejects(pending, /palace_report was cancelled/);

  await assert.rejects(abortable(Promise.resolve("late"), AbortSignal.abort(), "t"), /cancelled/);
  await assert.rejects(abortable(Promise.reject(new Error("boom")), new AbortController().signal, "t"), /boom/);
});
