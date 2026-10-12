import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { withMemcoreProvenance } from "../../src/capability/memcore/mem-core-provenance.ts";
import { loadMemcoreForDirectory } from "../../src/capability/memcore/mem-core-loader.ts";

/**
 * Unit coverage for the mem_synth -> mem_core render/compose contract.
 *
 * `loadMemcoreForDirectory` is a pure file-I/O function: given a start
 * directory and a workspace root, it composes the always-loaded mem-core view
 * by walking from broad scope to narrow scope and merging memory.md files in
 * that order. These tests pin that ordering, the two source types (direct vs
 * store-root), and the scope-limiting behavior — the things that determine
 * whether the right resident memory is assembled for a given directory.
 */

function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "eshepherd-memcore-"));
  // Mark it as a workspace root so the loader's auto-detect would also stop
  // here, though these tests pass workspaceRoot explicitly for determinism.
  writeFileSync(join(root, "package.json"), "{}\n", "utf8");
  return root;
}

function writeFileEnsuring(path, content) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf8");
}

test("composes direct + store-root memory broad-to-narrow in scope order", () => {
  const root = makeWorkspace();
  const sub = join(root, "pkg", "sub");
  mkdirSync(sub, { recursive: true });

  // Broad scope: a direct memory.md at the root plus a store-root render.
  writeFileSync(join(root, "memory.md"), "ROOT DIRECT", "utf8");
  writeFileEnsuring(join(root, ".electric-shepherd", "memory", "memory.md"), withMemcoreProvenance("ROOT STORE", { workspaceRoot: root, scopeDirectory: root, wing: "test" }));
  // Narrow scope: a direct memory.md in the start directory.
  writeFileSync(join(sub, "memory.md"), "SUB DIRECT", "utf8");

  const result = loadMemcoreForDirectory({
    startDir: sub,
    workspaceRoot: root, expectedWing: "test",
  });

  // Three files: root direct, root store, sub direct.
  assert.equal(result.loadedFiles.length, 3);

  const order = result.loadedFiles.map((f) => f.content);
  assert.equal(order[0], "ROOT DIRECT");
  assert.ok(order[1].endsWith("ROOT STORE"));
  assert.equal(order[2], "SUB DIRECT");

  // Source types + scope depth reflect broad(0) -> narrow.
  assert.equal(result.loadedFiles[0].sourceType, "direct");
  assert.equal(result.loadedFiles[0].scopeDepth, 0);
  assert.equal(result.loadedFiles[1].sourceType, "store");
  assert.equal(result.loadedFiles[1].scopeDepth, 0);
  assert.equal(result.loadedFiles[2].sourceType, "direct");
  assert.equal(result.loadedFiles[2].scopeDepth, 2);

  // Merged markdown preserves broad-to-narrow order.
  const idxRootDirect = result.mergedMarkdown.indexOf("ROOT DIRECT");
  const idxRootStore = result.mergedMarkdown.indexOf("ROOT STORE");
  const idxSubDirect = result.mergedMarkdown.indexOf("SUB DIRECT");
  assert.ok(idxRootDirect >= 0 && idxRootStore > idxRootDirect && idxSubDirect > idxRootStore);

  rmSync(root, { recursive: true, force: true });
});

test("maxScopes limits composition to the narrowest scopes", () => {
  const root = makeWorkspace();
  const sub = join(root, "pkg", "sub");
  mkdirSync(sub, { recursive: true });

  writeFileSync(join(root, "memory.md"), "ROOT DIRECT", "utf8");
  writeFileSync(join(sub, "memory.md"), "SUB DIRECT", "utf8");

  const result = loadMemcoreForDirectory({
    startDir: sub,
    workspaceRoot: root,
    maxScopes: 1,
  });

  // Only the narrowest scope (sub) is considered, so the root file is excluded.
  assert.equal(result.loadedFiles.length, 1);
  assert.equal(result.loadedFiles[0].content, "SUB DIRECT");
  assert.ok(!result.mergedMarkdown.includes("ROOT DIRECT"));

  rmSync(root, { recursive: true, force: true });
});

test("returns an empty composition when no memory files exist", () => {
  const root = makeWorkspace();
  const sub = join(root, "pkg", "sub");
  mkdirSync(sub, { recursive: true });

  const result = loadMemcoreForDirectory({
    startDir: sub,
    workspaceRoot: root,
  });

  assert.equal(result.loadedFiles.length, 0);
  assert.equal(result.mergedMarkdown, "");

  rmSync(root, { recursive: true, force: true });
});

test("honors a custom store-root location", () => {
  const root = makeWorkspace();

  // Custom store root instead of the default .electric-shepherd/memory.
  writeFileEnsuring(join(root, "custom-store", "memory.md"), withMemcoreProvenance("CUSTOM STORE ROOT", { workspaceRoot: root, scopeDirectory: root, wing: "test" }));

  const result = loadMemcoreForDirectory({
    startDir: root,
    workspaceRoot: root,
    storeRoots: ["custom-store"], expectedWing: "test",
  });

  assert.equal(result.loadedFiles.length, 1);
  assert.equal(result.loadedFiles[0].sourceType, "store");
  assert.ok(result.loadedFiles[0].content.endsWith("CUSTOM STORE ROOT"));

  rmSync(root, { recursive: true, force: true });
});

test("generated memory requires matching project, scope, and configured wing; legacy files are omitted", (t) => {
  const root = makeWorkspace();
  const other = makeWorkspace();
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true }); });
  const target = join(root, ".electric-shepherd", "memory", "memory.md");
  const identity = { workspaceRoot: root, scopeDirectory: root, wing: "test" };
  for (const text of ["OLD ARMET STATE", "<!-- electric-shepherd-memcore broken -->\nBAD",
    withMemcoreProvenance("FOREIGN", { ...identity, workspaceRoot: other, scopeDirectory: other }),
    withMemcoreProvenance("WRONG WING", { ...identity, wing: "armet" }),
    withMemcoreProvenance("WRONG SCOPE", { ...identity, scopeDirectory: join(root, "sub") })]) {
    writeFileEnsuring(target, text);
    const loaded = loadMemcoreForDirectory({ startDir: root, expectedWing: "test" });
    assert.equal(loaded.mergedMarkdown, "");
    assert.equal(loaded.skippedFiles.length, 1);
  }
  writeFileEnsuring(target, withMemcoreProvenance("OWN MEMORY", identity));
  assert.match(loadMemcoreForDirectory({ startDir: root, expectedWing: "test" }).mergedMarkdown, /OWN MEMORY/);
  assert.equal(loadMemcoreForDirectory({ startDir: root }).mergedMarkdown, "", "the default configured wing is enforced too");
});

test("empty files inject nothing and handwritten project notes remain available", (t) => {
  const root = makeWorkspace();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileEnsuring(join(root, ".electric-shepherd", "memory", "memory.md"), "\n");
  writeFileSync(join(root, "memory.md"), "  \n");
  assert.equal(loadMemcoreForDirectory({ startDir: root }).mergedMarkdown, "");
  writeFileSync(join(root, "memory.md"), "Project-owned handwritten convention.");
  assert.match(loadMemcoreForDirectory({ startDir: root }).mergedMarkdown, /handwritten convention/);
  writeFileSync(join(root, "memory.md"), "# Labeled memory blocks (always in context)\nOLD FOREIGN RENDER");
  assert.equal(loadMemcoreForDirectory({ startDir: root }).mergedMarkdown, "");
});

test("explicit foreign roots and symlinked foreign direct files cannot cross project boundaries", (t) => {
  const root = makeWorkspace();
  const other = makeWorkspace();
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true }); });
  writeFileSync(join(other, "memory.md"), "FOREIGN DIRECT MEMORY");
  assert.throws(() => loadMemcoreForDirectory({ startDir: root, workspaceRoot: other }), /does not match/);
  symlinkSync(join(other, "memory.md"), join(root, "memory.md"));
  assert.equal(loadMemcoreForDirectory({ startDir: root }).mergedMarkdown, "");
  const child = join(root, "nested-project");
  mkdirSync(child); writeFileSync(join(child, "package.json"), "{}\n");
  assert.throws(() => loadMemcoreForDirectory({ startDir: child, workspaceRoot: root }), /does not match/);
});
