import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { extractSourceChunks, digest } from "../../src/scripts/memory-pipeline/chunk-extraction.ts";
import { admitDrawerText } from "../../src/scripts/memory-pipeline/raw-text-worker.ts";
const valid = "The source confirms immutable evidence and a later cancellation of the proposed migration.";
function harness(t, contents = ["a", "b", "c"]) {
  const directory = mkdtempSync(join(tmpdir(), "es-content-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const ids = contents.map((_, i) => "chunk_" + i), calls = [];
  const args = { inventory: { parentDrawerId: "parent", requiredChunkCount: ids.length, chunks: ids.map((drawerId, chunkIndex) => ({ drawerId, chunkIndex })) },
    checkpointDirectory: directory, toolPrefix: "", extractorVersion: "test-v1",
    readTool: async (_, { drawer_id }) => ({ drawer_id, content: contents[ids.indexOf(drawer_id)], metadata: { parent_drawer_id: "parent", chunk_index: ids.indexOf(drawer_id) } }),
    mapChunk: async (prompt) => { calls.push(prompt); return valid; } };
  return { args, directory, calls, contents, ids };
}
for (const text of [valid, "# Strange heading\n" + valid, "~~~notes\n" + valid + "\n~~~", "\u0060\u0060\u0060markdown\n" + valid + "\n\u0060\u0060\u0060"]) {
  test("natural text preserved verbatim: " + text.slice(0, 15), async (t) => {
    assert.equal(admitDrawerText(text), text);
    const h = harness(t); h.args.mapChunk = async () => text;
    const result = await extractSourceChunks(h.args); assert.equal(result.extractionComplete, true);
    assert.equal(result.assessments[0].content, text);
  });
}
for (const text of ["", " ", "Done", "# Done", "Acknowledged."]) {
  test("missing/acknowledgement cannot complete: " + text, async (t) => {
    const h = harness(t); let calls = 0; h.args.mapChunk = async () => { calls++; return text; };
    const result = await extractSourceChunks(h.args); assert.equal(result.extractionComplete, false);
    assert.equal(calls, text.trim() ? 1 : 2); assert.equal(result.failures.length, 3);
  });
}
test("bounded sequential batch owns conservative primary membership, not per-piece findings", async (t) => {
  const h = harness(t); const result = await extractSourceChunks(h.args);
  assert.equal(result.extractionComplete, true); assert.equal(h.calls.length, 1);
  assert.equal(result.assessments.length, 1); assert.equal(result.assessments[0].members.length, 3);
  assert.deepEqual(result.assessments[0].members.map(m => m.chunkId), h.ids);
  for (const text of h.contents) assert.ok(h.calls[0].includes("PRIMARY\n" + text));
  assert.ok(!h.calls[0].includes('"chunkId"')); assert.ok(!h.calls[0].includes('"parentDrawerId"'));
  assert.equal(result.assessments[0].content, valid);
});
test("there is no implicit no-findings or missing-response success", async (t) => {
  const h = harness(t); h.args.mapChunk = async () => "";
  const failed = await extractSourceChunks(h.args); assert.equal(failed.extractionComplete, false); assert.equal(failed.failures.length, 3);
});
test("cache is atomic per whole batch; retry only failed batches without reshaping successful memberships", async (t) => {
  const h = harness(t, Array.from({ length: 9 }, (_, i) => String(i))); let calls = 0;
  h.args.mapChunk = async () => ++calls === 2 ? 'Done' : valid;
  const first = await extractSourceChunks(h.args); assert.equal(first.extractionComplete, false);
  assert.equal(first.assessments.length, 2); assert.equal(first.failures.length, 4);
  const stored = JSON.parse(readFileSync(join(h.directory, readdirSync(h.directory).find(f => f.endsWith('.json'))), "utf8"));
  assert.equal(Object.keys(stored.responses).length, 2);
  let retries = 0; h.args.mapChunk = async (prompt) => { retries++; for (const value of [4,5,6,7]) assert.ok(prompt.includes('PRIMARY\n' + value)); return valid; };
  const second = await extractSourceChunks(h.args); assert.equal(second.extractionComplete, true); assert.equal(retries, 1);
  assert.deepEqual(second.assessments.filter((b) => first.assessments.some((a) => a.batchId === b.batchId)), first.assessments);
});
test("source/version changes invalidate cache without deleting prior evidence, including old contract", async (t) => {
  const h = harness(t); const old = join(h.directory, digest("parent") + ".json"); writeFileSync(old, '{"schemaVersion":2,"oldEvidence":true}');
  const first = await extractSourceChunks(h.args); h.contents[1] = "changed";
  const second = await extractSourceChunks(h.args); assert.notEqual(first.sourceVersion, second.sourceVersion);
  h.args.extractorVersion = "changed-prompt-or-model"; await extractSourceChunks(h.args);
  assert.equal(h.calls.length, 3); assert.equal(readdirSync(h.directory).filter(f => f.endsWith('.json')).length, 4);
  assert.equal(readFileSync(old, "utf8"), '{"schemaVersion":2,"oldEvidence":true}');
});
test("cache membership tampering cannot certify coverage", async (t) => {
  const h = harness(t); await extractSourceChunks(h.args);
  const path = join(h.directory, readdirSync(h.directory).find(f => f.endsWith('.json'))), stored = JSON.parse(readFileSync(path, "utf8"));
  Object.values(stored.responses)[0].membershipHash = "wrong"; writeFileSync(path, JSON.stringify(stored));
  const result = await extractSourceChunks(h.args); assert.equal(result.extractionComplete, false); assert.equal(result.assessments.length, 0);
});
test("physical metadata, missing inventory and source mutation remain fail closed", async (t) => {
  const h = harness(t); await assert.rejects(extractSourceChunks({ ...h.args, inventory: { ...h.args.inventory, requiredChunkCount: 4 } }), /coverage/);
  await assert.rejects(extractSourceChunks({ ...h.args, readTool: async () => ({ drawer_id: "wrong", content: "a", metadata: {} }) }), /metadata/);
  h.args.mapChunk = async () => { h.contents[0] = "mutated"; return valid; };
  await assert.rejects(extractSourceChunks(h.args), /source-changed/);
});

test("large UTF-8 summaries are preserved without an artificial admission cap", () => {
  for (const text of [valid + " ".repeat(16000), "界".repeat(6000)]) assert.equal(admitDrawerText(text), text);
});
test("entirely empty source cannot produce replacement coverage even with an invented mapper narrative", async t => {
  const h = harness(t, ["", "  "]);
  await assert.rejects(extractSourceChunks(h.args), /empty-source-not-substantive/);
  assert.equal(h.calls.length, 0);
});

const { preprocessTranscript, MAX_PREPROCESSING_BYTES, extractionPromptHash } = await import("../../src/scripts/memory-pipeline/chunk-extraction.ts");
const { RUNTIME_POLICY_MARKERS } = await import("../../src/policy/checkpoint-prompt.ts");
const sessionText = messages => JSON.stringify({ session: { id: "test", title: null, directory: "test" }, messages });
const inventoryFor = parts => ({ parentDrawerId: "parent", requiredChunkCount: parts.length,
  chunks: parts.map((_, i) => ({ drawerId: "chunk_" + i, chunkIndex: i })) });
test("structural policy filter supports every split, escaped marker/body and exact span mapping", () => {
  const messages = [{ role: "user", text: "build viewer" },
    ...RUNTIME_POLICY_MARKERS.map(marker => ({ role: "user", text: " \n" + marker + ' historical "quoted" body secret-policy-body' })),
    { role: "assistant", text: valid }, { role: "tool", text: "substantive result" }, { role: "user", text: "final real request" }];
  const text = sessionText(messages).replace("[Memory", "\\u005bMemory");
  for (let cut = 1; cut < text.length; cut++) {
    const parts = [text.slice(0, cut), text.slice(cut)], inv = inventoryFor(parts), r = preprocessTranscript(parts, inv);
    assert.equal(r.audit.status, "filtered", r.audit.fallbackReason);
    assert.equal(r.audit.omittedCount, 5); assert.equal(r.audit.retainedCount, 4);
    assert.deepEqual(r.audit.rawHashes, parts.map(digest)); assert.ok(!r.derived.join("").includes("secret-policy-body"));
    for (const omitted of r.audit.omitted) assert.deepEqual(JSON.parse(omitted.spans.map(s =>
      parts[inv.chunks.findIndex(c => c.drawerId === s.chunkId)].slice(s.start, s.end)).join("")), messages[omitted.messageIndex]);
  }
});
test("unknown, DCP, lookalikes, quoted/mid-message and appended guards stay untouched", () => {
  const messages = ["[Loop Guard]ian", '[Unknown Guard] body', '[DCP] trim', 'the [Loop Guard] body',
    '"[Memory Checkpoint]" discussion', 'real request\n[Auto-Retry Guard] appended'].map(text => ({ role: "user", text }));
  messages.push({ role: "assistant", text: "[Memory Checkpoint] useful reply" });
  const raw = [sessionText(messages)], r = preprocessTranscript(raw, inventoryFor(raw));
  assert.deepEqual(r.derived, raw); assert.equal(r.audit.omittedCount, 0); assert.equal(r.audit.fallbackReason, "no-reserved-policy-turns");
});
test("capture suffix at chunk-zero reconstructs only when exact inventory matches", () => {
  const text = sessionText([{ role: "user", text: "[Memory Checkpoint] secret-policy-body" }, { role: "assistant", text: valid }]);
  const parts = [text.slice(0, 71), text.slice(71)], inv = inventoryFor(parts);
  parts[0] += "\n\n" + JSON.stringify({ chunked_capture: true, chunks: 2, chunk_ids: inv.chunks.map(c => c.drawerId), source_file: "stamp" });
  const r = preprocessTranscript(parts, inv); assert.equal(r.audit.status, "filtered"); assert.ok(!r.derived.join("").includes("secret-policy-body"));
  const bad = [...parts]; bad[0] = bad[0].replace('"chunks":2', '"chunks":3'); assert.deepEqual(preprocessTranscript(bad, inv).derived, bad);
});
test("malformed, unsupported and oversized fallback loses no raw text", () => {
  for (const raw of ["plain [Memory Checkpoint] body", '{"session":{},"messages":[', '{"messages":[]}',
    sessionText([{ role: "user", text: "[Loop Guard] body", extra: true }]), "x".repeat(MAX_PREPROCESSING_BYTES + 1)]) {
    const parts = [raw], r = preprocessTranscript(parts, inventoryFor(parts));
    assert.deepEqual(r.derived, parts); assert.equal(r.audit.status, "no-filter"); assert.ok(r.audit.fallbackReason); assert.deepEqual(r.audit.omitted, []);
  }
});
test("policy-only inspected source cannot invoke model or fabricate findings", async t => {
  const text = sessionText(RUNTIME_POLICY_MARKERS.map(marker => ({ role: "user", text: marker + " drifting body" })));
  const h = harness(t, [text.slice(0, 80), text.slice(80)]), r = await extractSourceChunks(h.args);
  assert.equal(r.extractionComplete, false); assert.equal(r.preprocessing.status, "policy-only");
  assert.equal(h.calls.length, 0); assert.deepEqual(r.assessments, []); assert.deepEqual(r.attempts, []);
  assert.equal(r.preprocessing.inspectedChunkIds.length, 2); assert.deepEqual(r.preprocessing.contributingChunkIds, []);
});
test("retained contribution excludes policy-only chunks and all boundary boilerplate", async t => {
  const text = sessionText([{ role: "user", text: "[Loop Guard] secret-policy-body ".repeat(20) }, { role: "assistant", text: valid }]);
  const start = text.indexOf("secret-policy-body"), end = text.indexOf('},{"role":"assistant"') + 1;
  const h = harness(t, [text.slice(0, start), text.slice(start, end), text.slice(end)]), first = await extractSourceChunks(h.args);
  assert.equal(first.extractionComplete, true); assert.deepEqual(first.preprocessing.contributingChunkIds, ["chunk_2"]);
  assert.deepEqual(first.assessments.flatMap(a => a.members.map(m => m.chunkId)), ["chunk_2"]);
  assert.ok(h.calls.every(p => !p.includes("secret-policy-body") && !p.includes("[Loop Guard]")));
  const oldVersion = digest(JSON.stringify({ contract: "drawer-text-batches-v10", promptHash: extractionPromptHash(), extractor: h.args.extractorVersion,
    inventory: h.args.inventory, hashes: h.contents.map(digest), inputLimit: 16000, batchLimit: 4 })); assert.notEqual(first.sourceVersion, oldVersion);
  h.contents[1] = h.contents[1].replace("secret-policy-body", "changed-policy-body");
  const changed = await extractSourceChunks(h.args); assert.notEqual(changed.sourceVersion, first.sourceVersion);
  assert.deepEqual(changed.preprocessing.derivedHashes, first.preprocessing.derivedHashes);
  assert.equal(h.calls.length, 2); assert.equal(readdirSync(h.directory).filter(f => f.endsWith(".json")).length, 2);
  h.args.mapChunk = async () => { h.contents[1] += "mutation"; return valid; };
  h.args.extractorVersion = "fresh"; await assert.rejects(extractSourceChunks(h.args), /source-changed/);
});

test("empty normalized policy capture has no substantive source and cannot infer from session metadata", async t => {
  const h = harness(t, [sessionText([])]), r = await extractSourceChunks(h.args);
  assert.equal(r.extractionComplete, false); assert.equal(h.calls.length, 0);
  assert.equal(r.preprocessing.fallbackReason, "no-substantive-session-messages");
  assert.equal(r.preprocessing.omittedCount, 0); assert.deepEqual(r.preprocessing.contributingChunkIds, []);
});

test("metadata-only and guard-only chunks are inspected but never PRIMARY; buggy metadata caches remain unused", async t => {
  const message = { role: "assistant", text: valid }, guard = { role: "user", text: "[Loop Guard] secret-policy-body" };
  const text = sessionText([message, guard]), messageStart = text.indexOf(JSON.stringify(message)), guardStart = text.indexOf(JSON.stringify(guard));
  const h = harness(t, [text.slice(0, messageStart), text.slice(messageStart, guardStart), text.slice(guardStart)]);
  const prepared = preprocessTranscript(h.contents, h.args.inventory), session = JSON.stringify(JSON.parse(text).session);
  const start = h.contents[0].indexOf(session);
  assert.deepEqual(prepared.audit.sessionSpans, [{ chunkId: "chunk_0", start, end: start + session.length }]);
  const buggyDerived = [session, JSON.stringify(message), ""];
  const buggyAudit = { ...prepared.audit, derivedHashes: buggyDerived.map(digest), contributingChunkIds: ["chunk_0", "chunk_1"] };
  const buggyVersion = digest(JSON.stringify({ contract: "drawer-text-batches-v10", promptHash: extractionPromptHash(), extractor: h.args.extractorVersion,
    inventory: h.args.inventory, hashes: h.contents.map(digest), preprocessing: buggyAudit, inputLimit: 16000, batchLimit: 4 }));
  const oldPath = join(h.directory, digest("parent") + "." + buggyVersion + ".json");
  const oldEvidence = JSON.stringify({ schemaVersion: 4, parentDrawerId: "parent", sourceVersion: buggyVersion, preprocessing: buggyAudit,
    responses: { [digest("old-buggy-batch")]: { membershipHash: digest("old-members"), promptHash: digest("old-prompt"), response: valid } } });
  writeFileSync(oldPath, oldEvidence);
  const reads = new Map(), read = h.args.readTool;
  h.args.readTool = async (name, args) => { reads.set(args.drawer_id, (reads.get(args.drawer_id) ?? 0) + 1); return read(name, args); };
  const r = await extractSourceChunks(h.args);
  assert.equal(r.extractionComplete, true); assert.deepEqual(r.preprocessing.inspectedChunkIds, h.ids);
  assert.deepEqual(r.preprocessing.rawHashes, h.contents.map(digest));
  assert.ok(h.ids.every(id => reads.get(id) >= 3), "every raw chunk is read initially and hash-verified before/after inference");
  assert.deepEqual(r.preprocessing.contributingChunkIds, ["chunk_1"]);
  assert.deepEqual(r.assessments.flatMap(a => a.members.map(m => m.chunkId)), ["chunk_1"]);
  assert.deepEqual(r.preprocessing.sessionSpans, prepared.audit.sessionSpans);
  assert.equal(h.calls.length, 1); assert.ok(h.calls[0].includes(JSON.stringify(message)));
  assert.ok(!h.calls[0].includes(session)); assert.ok(!h.calls[0].includes("secret-policy-body"));
  assert.notDeepEqual(r.preprocessing.derivedHashes, buggyAudit.derivedHashes); assert.notEqual(r.sourceVersion, buggyVersion);
  assert.equal(readFileSync(oldPath, "utf8"), oldEvidence); assert.equal(readdirSync(h.directory).filter(f => f.endsWith(".json")).length, 2);
});
test("metadata sharing a chunk with a useful retained message remains on that chunk", async t => {
  const message = { role: "assistant", text: valid }, guard = { role: "user", text: "[Memory Checkpoint] secret-policy-body" };
  const text = sessionText([message, guard]), cut = text.indexOf(JSON.stringify(guard));
  const h = harness(t, [text.slice(0, cut), text.slice(cut)]), r = await extractSourceChunks(h.args);
  assert.equal(r.extractionComplete, true); assert.deepEqual(r.preprocessing.contributingChunkIds, ["chunk_0"]);
  assert.deepEqual(r.assessments.flatMap(a => a.members.map(m => m.chunkId)), ["chunk_0"]);
  assert.ok(h.calls[0].includes(JSON.stringify(JSON.parse(text).session))); assert.ok(h.calls[0].includes(JSON.stringify(message)));
  assert.ok(!h.calls[0].includes("secret-policy-body")); assert.ok(r.preprocessing.sessionSpans.every(span => span.chunkId === "chunk_0"));
});

test("timestamp-bearing spans retain original PRIMARY bytes and hashes across every chunk split", () => {
  const messages = [
    { role: "user", text: "[Loop Guard] secret-policy-body", time: { created: "2099-01-01T00:00:00.000Z" } },
    { role: "assistant", text: valid, time: { created: "2024-01-01T00:00:02.000Z", completed: "2024-01-01T00:00:03.000Z" } },
    { role: "user", text: "later physical turn, earlier clock", time: { created: "2024-01-01T00:00:01.000Z" } },
    { role: "user", text: "unknown clock", time: { created: "2024-02-30T00:00:00Z" } },
  ];
  const raw = JSON.stringify({ session: { id: "s", time: { created: "2024-01-01T00:00:00.000Z" } }, messages });
  for (let cut = 1; cut < raw.length; cut++) {
    const parts = [raw.slice(0, cut), raw.slice(cut)], inv = inventoryFor(parts), result = preprocessTranscript(parts, inv);
    assert.equal(result.audit.status, "filtered", result.audit.fallbackReason);
    assert.deepEqual(result.audit.rawHashes, parts.map(digest)); assert.ok(!result.derived.join("").includes("secret-policy-body"));
    for (const retained of result.audit.retained) assert.deepEqual(JSON.parse(retained.spans.map(s =>
      parts[inv.chunks.findIndex(c => c.drawerId === s.chunkId)].slice(s.start, s.end)).join("")), messages[retained.messageIndex]);
    assert.deepEqual(result.audit.sourceChronology, [{ sourceDrawerId: "parent", sessionId: "s",
      sessionTime: { created: "2024-01-01T00:00:00.000Z" }, retainedMessageTimeRange: { earliest: "2024-01-01T00:00:01.000Z", latest: "2024-01-01T00:00:03.000Z" } }]);
  }
});

test("historical time survives PRIMARY, cache reuse and fresh-version caches without replacing old evidence", async t => {
  const text = sessionText([{ role: "user", text: "[Memory Checkpoint] secret-policy-body", time: { recorded: "2099-01-01T00:00:00.000Z" } },
    { role: "assistant", text: valid, time: { created: "2024-01-01T00:00:00.000Z" } }]);
  const cut = text.indexOf('"2024-'), h = harness(t, [text.slice(0, cut), text.slice(cut)]);
  const first = await extractSourceChunks(h.args), oldPath = join(h.directory, readdirSync(h.directory).find(f => f.endsWith(".json"))), old = readFileSync(oldPath, "utf8");
  assert.ok(h.calls.join("").includes("2024-01-01T00:00:00.000Z")); assert.ok(!h.calls.join("").includes("2099-"));
  await extractSourceChunks(h.args); assert.equal(h.calls.length, 1);
  h.args.extractorVersion = "fresh-time-version";
  const fresh = await extractSourceChunks(h.args); assert.notEqual(first.sourceVersion, fresh.sourceVersion);
  assert.deepEqual(first.preprocessing.sourceChronology, fresh.preprocessing.sourceChronology);
  assert.equal(readFileSync(oldPath, "utf8"), old); assert.equal(h.calls.length, 2);
});
