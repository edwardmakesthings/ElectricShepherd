import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { loadRuntimeEnv } from "../../scripts/runtime-env.ts";

function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function scriptUrlFor(repoRoot) {
  const scriptPath = join(repoRoot, "scripts", "fake-script.ts");
  mkdirSync(dirname(scriptPath), { recursive: true });
  return pathToFileURL(scriptPath).href;
}

test("runtime env loads .env then .env.local and preserves existing env keys", () => {
  const repoRoot = makeTempDir("eshepherd-env-");
  const env = {
    MEMPALACE_MCP_URL: "http://already-set",
  };

  writeFileSync(join(repoRoot, ".env"), "MEMPALACE_MCP_URL=http://from-env\nMEMGRAPH_TOOL_PREFIX=prefix_from_env\n", "utf8");
  writeFileSync(join(repoRoot, ".env.local"), "MEMGRAPH_TOOL_PREFIX=prefix_from_local\n", "utf8");

  const result = loadRuntimeEnv({
    scriptUrl: scriptUrlFor(repoRoot),
    env,
    cwd: repoRoot,
  });

  assert.equal(env.MEMPALACE_MCP_URL, "http://already-set");
  assert.equal(env.MEMGRAPH_TOOL_PREFIX, "prefix_from_local");
  assert.equal(result.loadedFiles.length, 2);

  rmSync(repoRoot, { recursive: true, force: true });
});

test("runtime env falls back to sibling docker/.env when repo env files are absent", () => {
  const workspaceRoot = makeTempDir("eshepherd-workspace-");
  const repoRoot = join(workspaceRoot, "ElectricShepherd");
  const dockerRoot = join(workspaceRoot, "docker");
  mkdirSync(repoRoot, { recursive: true });
  mkdirSync(dockerRoot, { recursive: true });

  writeFileSync(join(dockerRoot, ".env"), "MEMPALACE_MCP_URL=http://docker-fallback\n", "utf8");

  const env = {};
  const result = loadRuntimeEnv({
    scriptUrl: scriptUrlFor(repoRoot),
    env,
    cwd: repoRoot,
  });

  assert.equal(env.MEMPALACE_MCP_URL, "http://docker-fallback");
  assert.equal(result.loadedFiles.length, 1);
  assert.match(result.loadedFiles[0], /docker[\\/]\.env$/);

  rmSync(workspaceRoot, { recursive: true, force: true });
});

test("runtime env honors ESHEPHERD_ENV_FILE explicit path", () => {
  const repoRoot = makeTempDir("eshepherd-explicit-env-");
  const env = {
    ESHEPHERD_ENV_FILE: "./custom.env",
  };

  writeFileSync(join(repoRoot, "custom.env"), "MEMPALACE_MCP_URL=http://explicit-file\n", "utf8");
  writeFileSync(join(repoRoot, ".env"), "MEMPALACE_MCP_URL=http://repo-default\n", "utf8");

  const result = loadRuntimeEnv({
    scriptUrl: scriptUrlFor(repoRoot),
    env,
    cwd: repoRoot,
  });

  assert.equal(env.MEMPALACE_MCP_URL, "http://explicit-file");
  assert.equal(result.loadedFiles.length, 1);
  assert.ok(result.loadedFiles[0].endsWith("custom.env"));

  rmSync(repoRoot, { recursive: true, force: true });
});
