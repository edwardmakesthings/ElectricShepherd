import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveSubagentRunner, stripFrontmatter } from "../../src/scripts/memory-pipeline/subagent.ts";

function makeBin(dir, name) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, "#!/bin/sh\n", "utf8");
  return path;
}

test("subagent runner honours an explicit binary and infers its kind", () => {
  assert.deepEqual(resolveSubagentRunner({ explicitBin: "/opt/bin/omp", env: {} }), {
    kind: "omp",
    bin: "/opt/bin/omp",
  });
  assert.deepEqual(resolveSubagentRunner({ explicitBin: "/opt/bin/opencode", env: {} }), {
    kind: "opencode",
    bin: "/opt/bin/opencode",
  });
});

test("subagent runner reads ESHEPHERD_SUBAGENT_BIN", () => {
  const runner = resolveSubagentRunner({ env: { ESHEPHERD_SUBAGENT_BIN: "/custom/omp" } });
  assert.deepEqual(runner, { kind: "omp", bin: "/custom/omp" });
});

test("subagent runner finds a binary on PATH and returns it absolute", () => {
  const dir = mkdtempSync(join(tmpdir(), "es-bin-path-"));
  const bin = makeBin(dir, "opencode");
  try {
    assert.deepEqual(resolveSubagentRunner({ env: { PATH: dir } }), { kind: "opencode", bin });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The bug this guards: a non-login shell drops ~/.opencode/bin from PATH, so a
// bare `opencode` ENOENTs and the mapper silently quarantines its whole worklist.
test("subagent runner falls back to well-known installs when PATH omits them", () => {
  const home = mkdtempSync(join(tmpdir(), "es-bin-home-"));
  const bin = makeBin(join(home, ".opencode", "bin"), "opencode");
  try {
    assert.deepEqual(resolveSubagentRunner({ env: { PATH: "" }, home }), { kind: "opencode", bin });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("subagent runner falls back to an omp install when opencode is absent", () => {
  const home = mkdtempSync(join(tmpdir(), "es-bin-omp-"));
  const bin = makeBin(join(home, ".local", "bin"), "omp");
  try {
    assert.deepEqual(resolveSubagentRunner({ env: { PATH: "" }, home }), { kind: "omp", bin });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("subagent runner reports nothing rather than guessing a bare name", () => {
  const home = mkdtempSync(join(tmpdir(), "es-bin-none-"));
  try {
    assert.equal(resolveSubagentRunner({ env: { PATH: "" }, home }), undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("stripFrontmatter removes a leading yaml block only", () => {
  assert.equal(stripFrontmatter("---\nname: x\n---\nBody here"), "Body here");
  assert.equal(stripFrontmatter("No frontmatter"), "No frontmatter");
  assert.equal(stripFrontmatter("Body\n\n---\n\nnot frontmatter"), "Body\n\n---\n\nnot frontmatter");
});
