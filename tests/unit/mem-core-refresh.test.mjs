import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { readMemcoreSources } from "../../src/core/memcore-sources.ts";
import { buildRefreshedMemcore } from "../../src/capability/memcore/mem-core-refresh.ts";
import { loadMemcoreForDirectory } from "../../src/capability/memcore/mem-core-loader.ts";
import { renderAndApplyMemcore } from "../../src/scripts/memory-pipeline/memcore-render.ts";
import { refreshMemcore } from "../../src/scripts/run-mem-core-refresh.ts";

function fact(subject, predicate, object, extra = {}) {
  return { subject, predicate, object, direction: "outgoing", current: true, ...extra };
}
function summary(id, extra = {}) {
  return { drawer_id: id, wing: "test", room: "decisions", desc: `Decision ${id}`, content: `Exact stored decision ${id}.`,
    facts: [fact(id, "es-status", "active"), fact(id, "es-source-type", "synthesis"),
      fact(id, "synthesized-from", "raw-a"), fact(id, "synthesized-from", "raw-b")], ...extra };
}
function fixture(rows, overrides = {}) {
  const calls = [];
  const rooms = [...new Set(rows.map((row) => row.room))];
  const client = {
    getTaxonomy: async () => ({ taxonomy: { test: Object.fromEntries((rooms.length ? rooms : ["decisions"]).map((room) => [room, 1])) } }),
    listDrawers: async (args) => {
      calls.push(["listDrawers", args]);
      const scoped = rows.filter((row) => row.room === args.room);
      return { drawers: scoped.slice(args.offset, args.offset + args.limit), total: scoped.length };
    },
    kgQueryMany: async ({ entities }) => Object.fromEntries(entities.map((id) => [id, { facts: rows.find((row) => row.drawer_id === id).facts }])),
    getDrawers: async ({ drawer_ids }) => ({ results: drawer_ids.map((id) => rows.find((row) => row.drawer_id === id)), errors: 0 }),
    ...overrides,
  };
  return { client, calls };
}
function workspace(t) {
  mkdirSync("/tmp/opencode", { recursive: true });
  const root = mkdtempSync("/tmp/opencode/eshepherd-refresh-");
  copyFileSync(new URL("../../package.json", import.meta.url), join(root, "package.json"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
const renderOptions = { wing: "test", workspaceRoot: "/workspace/test", scopeDir: "/workspace/test" };

test("refresh reads current active summaries, not historical statuses, raw, retired, or merged drawers", async () => {
  const active = summary("active");
  active.facts.push(fact("active", "es-status", "provisional", { current: false, valid_to: "2020-01-01" }));
  const old = summary("expired");
  old.facts[0] = fact("expired", "es-status", "active", { valid_to: "2020-01-01" });
  const provisional = summary("provisional");
  provisional.facts[0].object = "provisional";
  const retired = summary("retired");
  retired.facts[0].object = "retired";
  const merged = summary("merged");
  merged.facts.push(fact("merged", "merged-into", "active"));
  const raw = summary("raw");
  raw.facts[1].object = "transcript";
  const { client } = fixture([active, old, provisional, retired, merged, raw]);
  const result = await readMemcoreSources(client, { wing: "test" });
  assert.equal(result.scanned, 6);
  assert.deepEqual(result.sources.map((source) => source.drawerId), ["active"]);
  assert.deepEqual(result.sources[0].facts["es-status"], ["active"]);
});

test("refresh pages every room to exhaustion, in parent-drawer units", async () => {
  const rows = Array.from({ length: 102 }, (_, index) => summary(`node-${index}`));
  rows.push(summary("other-room", { room: "conventions" }));
  const { client, calls } = fixture(rows);
  const result = await readMemcoreSources(client, { wing: "test" });
  assert.equal(result.sources.length, 103);
  assert.deepEqual(calls.map(([, args]) => [args.room, args.offset]), [["conventions", 0], ["decisions", 0], ["decisions", 100]]);
  await assert.rejects(readMemcoreSources(client, { wing: "test", maxDrawers: 100 }), /exceeds 100/);
});

test("refresh fails closed on missing graph data, failed content reads, premature pages, and wrong scope", async () => {
  const rows = [summary("active")];
  for (const overrides of [
    { kgQueryMany: async () => ({}) },
    { kgQueryMany: async () => ({ active: { facts: [null] } }) },
    { getTaxonomy: async () => ({ taxonomy: { test: "broken" } }) },
    { getDrawers: async () => ({ results: [], errors: 1 }) },
    { listDrawers: async () => ({ drawers: [], total: 1 }) },
    { listDrawers: async () => ({ drawers: [summary("wrong", { wing: "other" })], total: 1 }) },
  ]) await assert.rejects(readMemcoreSources(fixture(rows, overrides).client, { wing: "test" }));
  assert.deepEqual(await readMemcoreSources(fixture(rows).client, { wing: "missing" }), { sources: [], scanned: 0 });
});

test("preview does not write; apply replaces stale content and pointers, and is idempotent", async (t) => {
  const root = workspace(t);
  const target = join(root, ".electric-shepherd", "memory", "memory.md");
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, "OLD ARMET CONTENT\nnode_id:deleted-node\n");
  const { client } = fixture([summary("active")]);
  const args = ["--start-dir", root, "--wing", "test"];
  const preview = await refreshMemcore(args, client);
  assert.equal(preview.fileWritten, false);
  assert.equal(readFileSync(target, "utf8"), "OLD ARMET CONTENT\nnode_id:deleted-node\n");
  assert.match(preview.markdown, /Exact stored decision active/);
  assert.doesNotMatch(preview.markdown, /ARMET|deleted-node/);
  const applied = await refreshMemcore([...args, "--apply"], client);
  assert.equal(applied.fileWritten, true);
  assert.equal(readFileSync(target, "utf8"), preview.markdown);
  assert.equal((await refreshMemcore([...args, "--apply"], client)).fileWritten, false);
});

test("failed apply preserves the old file; an empty successful snapshot clears old derived content", async (t) => {
  const root = workspace(t);
  const target = join(root, ".electric-shepherd", "memory", "memory.md");
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, "KEEP UNTIL A COMPLETE READ");
  const args = ["--start-dir", root, "--wing", "test", "--apply"];
  const { client } = fixture([summary("active")], { kgQueryMany: async () => { throw new Error("palace unavailable"); } });
  await assert.rejects(refreshMemcore(args, client), /palace unavailable/);
  assert.equal(readFileSync(target, "utf8"), "KEEP UNTIL A COMPLETE READ");
  const empty = await refreshMemcore(args, fixture([]).client);
  assert.equal(empty.markdown, "");
  assert.equal(readFileSync(target, "utf8"), "");
  assert.equal(loadMemcoreForDirectory({ startDir: root }).mergedMarkdown, "");
});

test("nested refresh uses the project wing and writes the loader-compatible scope, not direct or broad memory", async (t) => {
  const root = workspace(t);
  const sub = join(root, "src", "nested");
  mkdirSync(sub, { recursive: true });
  const broad = join(root, ".electric-shepherd", "memory", "memory.md");
  mkdirSync(join(broad, ".."), { recursive: true });
  writeFileSync(broad, "BROAD");
  writeFileSync(join(sub, "memory.md"), "DIRECT");
  const { client } = fixture([summary("active")]);
  const result = await refreshMemcore(["--start-dir", sub, "--wing", "test", "--apply"], client);
  assert.equal(result.filePath, join(root, ".electric-shepherd", "memory", "src", "nested", "memory.md"));
  assert.equal(readFileSync(broad, "utf8"), "BROAD");
  assert.equal(readFileSync(join(sub, "memory.md"), "utf8"), "DIRECT");
  assert.ok(loadMemcoreForDirectory({ startDir: sub, expectedWing: "test" }).loadedFiles.some((file) => file.path === result.filePath));
  await assert.rejects(refreshMemcore(["--start-dir", root, "--apply", "typo"], client), /Unknown refresh argument/);
  assert.equal(existsSync(join(root, "typo")), false);
});

test("rebuild honors current hall labels, ruled-out markers, and the character budget", async () => {
  const { sources } = await readMemcoreSources(fixture([
    summary("convention", { facts: [...summary("convention").facts, fact("convention", "in-hall", "hall_advice")] }),
    summary("preference", { facts: [...summary("preference").facts, fact("preference", "in-hall", "hall_preferences")] }),
    summary("dead-end", { content: "Never retry the abandoned approach. ".repeat(100),
      facts: [...summary("dead-end").facts, fact("dead-end", "rules-out", "abandoned approach")] }),
  ]).client, { wing: "test" });
  const result = buildRefreshedMemcore(sources, { ...renderOptions, maxChars: 1800 });
  assert.ok(result.markdown.length <= 1800);
  assert.match(result.markdown, /\[active-conventions\][\s\S]*Decision convention/);
  assert.match(result.markdown, /\[user-preferences\][\s\S]*Decision preference/);
  assert.match(result.markdown, /\[dead-ends\]\n### \[RULED OUT\]/);
  assert.match(result.markdown, /\[RULED OUT\] node_id:dead-end/);
  assert.match(result.markdown, /Excerpt truncated/);
});

test("refresh preserves prospective matching: active reminders appear only inside the triggering path", async () => {
  const reminder = { drawer_id: "reminder", wing: "test", room: "reminders", content: "Use the integration fixture.",
    facts: [fact("reminder", "es-reminder-status", "active"), fact("reminder", "triggers-on", "tests/**"),
      fact("reminder", "es-reminder-expires-at", "2099-01-01")] };
  const { sources } = await readMemcoreSources(fixture([reminder]).client, { wing: "test" });
  const inside = buildRefreshedMemcore(sources, { ...renderOptions, scopeDir: "/workspace/test/tests/unit" });
  const outside = buildRefreshedMemcore(sources, { ...renderOptions, scopeDir: "/workspace/test/src" });
  assert.match(inside.markdown, /Use the integration fixture/);
  assert.doesNotMatch(outside.markdown, /Use the integration fixture/);
  assert.deepEqual(outside.sourceDrawerIds, []);
});

test("a confirmed absent project wing is empty, not a fallback; invalid and failed taxonomy reads are errors", async (t) => {
  const root = workspace(t);
  const target = join(root, ".electric-shepherd", "memory", "memory.md");
  mkdirSync(join(target, ".."), { recursive: true }); writeFileSync(target, "OLD FOREIGN MEMORY");
  const { client, calls } = fixture([summary("other-wing")]);
  const args = ["--start-dir", root, "--wing", "new_project"];
  const preview = await refreshMemcore(args, client);
  assert.equal(preview.markdown, ""); assert.deepEqual(preview.sourceDrawerIds, []);
  assert.equal(readFileSync(target, "utf8"), "OLD FOREIGN MEMORY");
  assert.deepEqual(calls, [], "another wing is never scanned");
  await refreshMemcore([...args, "--apply"], client);
  assert.equal(readFileSync(target, "utf8"), "");
  for (const getTaxonomy of [async () => ({}), async () => ({ taxonomy: [] }),
    async () => ({ taxonomy: { broken: "invalid" } }), async () => { throw new Error("unavailable"); }]) {
    writeFileSync(target, "PRESERVE ON FAILURE");
    await assert.rejects(refreshMemcore([...args, "--apply"], { ...client, getTaxonomy }));
    assert.equal(readFileSync(target, "utf8"), "PRESERVE ON FAILURE");
  }
});

test("consolidation renders carry the same project provenance consumed by the loader", async (t) => {
  const root = workspace(t);
  const target = join(root, ".electric-shepherd", "memory", "memory.md");
  await renderAndApplyMemcore({
    client: { listScopedDerivedDrawers: async () => ({ nodes: [] }), listReminders: async () => [] },
    consolidationOptions: { targetWing: "test", targetRoom: "decisions" },
    runtimeConfig: { valuesByPath: {} }, memcoreApply: { enabled: true, filePath: target, scopeDir: root },
    memcoreMinFactHeight: 2,
    consolidation: { runId: "fixture", createdNodeId: "known-summary", sourceDrawerIds: ["raw-a", "raw-b"], query: "fixture" },
    validationMergeReview: { downwardValidation: [], escalations: { nodeIds: [], mergePairs: [], reasons: [] } },
    worklist: [], includeBasePipeline: true, onProgress: () => {},
  });
  const loaded = loadMemcoreForDirectory({ startDir: root, expectedWing: "test" });
  assert.equal(loaded.skippedFiles.length, 0);
  assert.match(loaded.mergedMarkdown, /known-summary/);
});

test("refresh through a directory alias writes and loads the canonical project render", async (t) => {
  const root = workspace(t), alias = join(root, "alias");
  symlinkSync(root, alias);
  const result = await refreshMemcore(["--start-dir", alias, "--wing", "test", "--apply"], fixture([summary("own")]).client);
  assert.equal(result.filePath, join(root, ".electric-shepherd", "memory", "memory.md"));
  assert.match(loadMemcoreForDirectory({ startDir: alias, expectedWing: "test" }).mergedMarkdown, /Exact stored decision own/);
});
