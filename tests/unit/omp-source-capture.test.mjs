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

const { spawnSync } = await import("node:child_process");
const { fileURLToPath } = await import("node:url");
const { RUNTIME_POLICY_MARKERS, runtimePolicyKind } = await import("../../src/policy/checkpoint-prompt.ts");
const constants = await import("../../src/surface/plugin/session-policy/constants.ts");
const { preprocessTranscript } = await import("../../src/scripts/memory-pipeline/chunk-extraction.ts");
test("OpenCode, OMP and derived capture classification parity; body drift, collisions and retained results", () => {
  assert.deepEqual(Object.entries(constants).filter(([name]) => name.endsWith("_MARKER")).map(([, v]) => v).sort(), [...RUNTIME_POLICY_MARKERS].sort());
  const cases = RUNTIME_POLICY_MARKERS.flatMap(marker => [
    { role: "user", text: marker }, { role: "user", text: " \n\t" + marker + " old checkpoint body" },
    { role: "user", text: marker + "ian lookalike" }, { role: "assistant", text: marker + " useful results" }]);
  cases.push(...['quoted "[Memory Checkpoint]"', 'talk about [Loop Guard]', '[Unknown] content', '[DCP] content',
    'real user work\n[Spiral Guard] appended', 'final genuine request'].map(text => ({ role: "user", text })));
  const expected = cases.filter(m => !runtimePolicyKind(m.role, m.text)).map(m => ({ ...m, text: m.text.trim() }));
  const entries = cases.map(m => ({ type: "message", message: { role: m.role, content: [{ type: "text", text: m.text }] } }));
  assert.deepEqual(JSON.parse(renderSessionTranscript(entries.map(line).join("\n"), "s", "d")).messages, expected);
  const python = fileURLToPath(new URL("../../src/scripts", import.meta.url));
  const code = 'import sys,json;sys.path.insert(0,sys.argv[1]);from transcript_capture_normalization import normalize_capture_content,RUNTIME_POLICY_MARKERS;print(json.dumps(list(RUNTIME_POLICY_MARKERS)));print(normalize_capture_content(sys.stdin.read()))';
  for (const messages of [cases.map(m => ({ info: { role: m.role }, parts: [{ type: "text", text: m.text }] })),
    cases.map(m => m.role === "user" ? { type: "user", text: m.text } : { type: m.role, content: [{ type: "text", text: m.text }] })]) {
    const r = spawnSync("python3", ["-c", code, python], { input: JSON.stringify({ info: {}, messages }), encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr); const [markers, capture] = r.stdout.trim().split("\n");
    assert.deepEqual(JSON.parse(markers), [...RUNTIME_POLICY_MARKERS]); assert.deepEqual(JSON.parse(capture).messages, expected);
  }
  const raw = JSON.stringify({ session: {}, messages: cases }), inventory = { parentDrawerId: "p", requiredChunkCount: 1, chunks: [{ drawerId: "p", chunkIndex: 0 }] };
  const result = preprocessTranscript([raw], inventory);
  assert.equal(result.audit.omittedCount, cases.length - expected.length);
  for (const m of expected) assert.ok(result.derived[0].includes(JSON.stringify(m.text)));
});
test("OpenCode normalization still excludes synthetic parts without suppressing real replies", () => {
  const r = spawnSync("python3", ["-c", 'import sys;sys.path.insert(0,sys.argv[1]);from transcript_capture_normalization import normalize_capture_content;print(normalize_capture_content(sys.stdin.read()))',
    fileURLToPath(new URL("../../src/scripts", import.meta.url))], { encoding: "utf8", input: JSON.stringify({ messages: [
      { info: { role: "user" }, parts: [{ type: "text", text: "synthetic", synthetic: true }] },
      { info: { role: "assistant" }, parts: [{ type: "text", text: "useful checkpoint outcome" }] }] }) });
  assert.equal(r.status, 0, r.stderr); assert.deepEqual(JSON.parse(r.stdout).messages, [{ role: "assistant", text: "useful checkpoint outcome" }]);
});

test("Python/TypeScript whitespace and boundary policy classification are identical", () => {
  const cases = ["\u0085", "\u001c", "\ufeff", "\u00a0", "\u2028", " ", "\n", "\t", "x"].flatMap(space => [space + "[Loop Guard] body", "[Loop Guard]" + space + "body"]);
  const result = spawnSync("python3", ["-c", 'import sys,json;sys.path.insert(0,sys.argv[1]);from transcript_capture_normalization import runtime_policy_kind;print(json.dumps([runtime_policy_kind("user",s) for s in json.loads(sys.stdin.read())]))',
    fileURLToPath(new URL("../../src/scripts", import.meta.url))], { input: JSON.stringify(cases), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), cases.map(s => runtimePolicyKind("user", s) ?? null));
});

test("OpenCode v1/v2 exported clocks are milliseconds, named and never inferred from capture", () => {
  const normalize = payload => {
    const r = spawnSync("python3", ["-c", 'import sys;sys.path.insert(0,sys.argv[1]);from transcript_capture_normalization import normalize_capture_content;print(normalize_capture_content(sys.stdin.read()))',
      fileURLToPath(new URL("../../src/scripts", import.meta.url))], { encoding: "utf8", input: JSON.stringify(payload) });
    assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout);
  };
  const created = 1704067200123, completed = created + 1000;
  for (const messages of [
    [{ info: { role: "assistant", time: { created, completed } }, parts: [{ type: "text", text: "historical result" }] }],
    [{ type: "assistant", time: { created, streamed: created + 1, completed }, content: [{ type: "text", text: "historical result" }] }],
  ]) {
    const result = normalize({ info: { time: { created, updated: completed, idle: completed } }, messages });
    assert.deepEqual(result.session.time, { created: "2024-01-01T00:00:00.123Z", updated: "2024-01-01T00:00:01.123Z", idle: "2024-01-01T00:00:01.123Z" });
    assert.deepEqual(result.messages[0].time, { created: "2024-01-01T00:00:00.123Z", completed: "2024-01-01T00:00:01.123Z",
      ...(messages[0].type ? { streamed: "2024-01-01T00:00:00.124Z" } : {}) });
    assert.ok(!Object.hasOwn(result.session.time, "ended"));
  }
  const result = normalize({ info: { time: { created: "1704067200123", updated: -1 } }, messages: [
    { type: "user", time: { created: true, completed: 1e100 }, text: "unknown time" },
    { type: "user", time: { created: 0 }, text: "epoch is real" },
    { type: "user", time: { created }, text: "[Loop Guard] omitted" },
  ] });
  assert.ok(!Object.hasOwn(result.session, "time")); assert.ok(!Object.hasOwn(result.messages[0], "time"));
  assert.equal(result.messages[1].time.created, "1970-01-01T00:00:00.000Z"); assert.equal(result.messages.length, 2);
});

test("OMP keeps original message creation and ISO entry recording clocks distinct and ordered", () => {
  const payload = [
    { type: "session", timestamp: "2024-01-01T01:00:00+01:00" },
    { type: "message", timestamp: "2024-01-01T00:00:02.000Z", message: { role: "assistant", timestamp: 1704067200123, content: [{ type: "text", text: "first" }] } },
    { type: "message", timestamp: "bad", message: { role: "user", timestamp: "1704067200123", content: [{ type: "text", text: "unknown" }] } },
    { type: "message", timestamp: "2024-01-01T00:00:00.000Z", message: { role: "user", timestamp: 0, content: [{ type: "text", text: "last but earlier clock" }] } },
    { type: "message", timestamp: "2025-01-01T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "[Loop Guard] omitted" }] } },
  ];
  const result = JSON.parse(renderSessionTranscript(payload.map(line).join("\n"), "s", "d"));
  assert.deepEqual(result.session.time, { created: "2024-01-01T00:00:00.000Z" });
  assert.deepEqual(result.messages[0].time, { created: "2024-01-01T00:00:00.123Z", recorded: "2024-01-01T00:00:02.000Z" });
  assert.ok(!Object.hasOwn(result.messages[1], "time")); assert.equal(result.messages[2].time.created, "1970-01-01T00:00:00.000Z");
  assert.deepEqual(result.messages.map(m => m.text), ["first", "unknown", "last but earlier clock"]);
});
