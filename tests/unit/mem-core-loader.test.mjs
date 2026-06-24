import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadMemcoreForDirectory } from "../../adapter/mem-core-loader.ts";

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
  writeFileEnsuring(join(root, "eshepherd", "memory", "memory.md"), "ROOT STORE");
  // Narrow scope: a direct memory.md in the start directory.
  writeFileSync(join(sub, "memory.md"), "SUB DIRECT", "utf8");

  const result = loadMemcoreForDirectory({
    startDir: sub,
    workspaceRoot: root,
  });

  // Three files: root direct, root store, sub direct.
  assert.equal(result.loadedFiles.length, 3);

  const order = result.loadedFiles.map((f) => f.content);
  assert.deepEqual(order, ["ROOT DIRECT", "ROOT STORE", "SUB DIRECT"]);

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

  // Custom store root instead of the default eshepherd/memory or memory.
  writeFileEnsuring(join(root, "custom-store", "memory.md"), "CUSTOM STORE ROOT");

  const result = loadMemcoreForDirectory({
    startDir: root,
    workspaceRoot: root,
    storeRoots: ["custom-store"],
  });

  assert.equal(result.loadedFiles.length, 1);
  assert.equal(result.loadedFiles[0].sourceType, "store");
  assert.equal(result.loadedFiles[0].content, "CUSTOM STORE ROOT");

  rmSync(root, { recursive: true, force: true });
});
