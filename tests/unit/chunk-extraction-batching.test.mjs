import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { extractSourceChunks, MAX_INPUT_CHARACTERS } from "../../src/scripts/memory-pipeline/chunk-extraction.ts";
async function run(t, contents, mapChunk) {
  const directory = mkdtempSync(join(tmpdir(), "es-content-large-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
  return extractSourceChunks({ inventory: { parentDrawerId: "parent", requiredChunkCount: contents.length, chunks: contents.map((_, i) => ({ drawerId: "c" + i, chunkIndex: i })) },
    toolPrefix: "", checkpointDirectory: directory, extractorVersion: "test", mapChunk,
    readTool: async (_, { drawer_id }) => ({ drawer_id, content: contents[Number(drawer_id.slice(1))], metadata: { parent_drawer_id: "parent", chunk_index: Number(drawer_id.slice(1)) } }) });
}
test("oversized escaped sources split without truncation or surrogate splitting, with bounded serial prompts", async (t) => {
  const contents = ['\\n"\t'.repeat(6000) + "😀".repeat(1000), "LATE correction: proposal canceled."];
  const seen = []; let active = 0;
  const result = await run(t, contents, async (prompt) => {
    assert.equal(active++, 0); await Promise.resolve(); active--;
    assert.ok(prompt.length <= MAX_INPUT_CHARACTERS);
    const sources = [...prompt.matchAll(/\nPRIMARY\n([\s\S]*?)\nNEXT BOUNDARY CONTEXT/g)].map(m => m[1]); assert.ok(sources.length <= 4);
    seen.push(...sources);
    return 'Immutable evidence supports the findings and later source corrections must be preserved.';
  });
  assert.equal(result.extractionComplete, true); assert.equal(seen.join(""), contents.join(""));
  for (const primary of seen) { assert.ok(!/[\uD800-\uDBFF]$/.test(primary)); assert.ok(!/^[\uDC00-\uDFFF]/.test(primary)); }
  const members = result.assessments.flatMap((batch) => batch.members);
  assert.equal(members.filter((member) => member.chunkId === "c0").length, members[0].pieceCount);
  assert.deepEqual([...new Set(members.map(m => m.chunkId))], ["c0", "c1"]);
});
test("boundary context is not attributed when its primary batch fails", async (t) => {
  const contents = ["a", "b", "c", "d", "boundary-only fifth primary"];
  const result = await run(t, contents, async (prompt) => {
    const sources = [...prompt.matchAll(/\nPRIMARY\n([\s\S]*?)\nNEXT BOUNDARY CONTEXT/g)];
    if (sources.length === 1) return "";
    assert.ok(prompt.includes('NEXT BOUNDARY CONTEXT\n' + contents[4]));
    return 'Immutable evidence supports the findings and later source corrections must be preserved.';
  });
  assert.equal(result.extractionComplete, false);
  assert.deepEqual(result.assessments.flatMap(b => b.members.map(m => m.chunkId)), ["c0", "c1", "c2", "c3"]);
});
