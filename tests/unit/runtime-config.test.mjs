import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import { applyRuntimeConfigToEnv, getRuntimeConfigEnvMap, getRuntimeConfigValueByPath, loadRuntimeConfig } from "../../adapter/runtime-config.ts";

function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("runtime config reads .electric-shepherd/config.jsonc and exposes values by path/env map", () => {
  const root = makeTempDir("eshepherd-config-");
  mkdirSync(join(root, ".electric-shepherd"), { recursive: true });

  writeFileSync(
    join(root, ".electric-shepherd", "config.jsonc"),
    `{
      // JSONC comment support
      "env": {
        "envFile": "../docker/.env"
      },
      "mcp": {
        "url": "http://example.local/mcp",
        "authHeader": "x-litellm-api-key",
        "authScheme": "Bearer",
      },
      "sourceCapture": {
        "mode": "replace",
        "dedupEnabled": false
      },
      "commands": {
        "sourceCapture": {
          "timeoutMs": 25000
        }
      },
      "loopGuard": {
        "exemptTools": ["compress", "my-tool"]
      },
      "taskWatchdog": {
        "workedExampleInjection": {
          "enabled": false,
          "searchTimeoutMs": 1234
        },
        "workedExampleFiling": {
          "enabled": false
        }
      }

    }`,
    "utf8",
  );

  const env = {
    ESHEPHERD_SOURCE_CAPTURE_MODE: "append",
  };

  const loaded = loadRuntimeConfig({ cwd: root, env });
  const envMap = getRuntimeConfigEnvMap(loaded);

  assert.equal(getRuntimeConfigValueByPath(loaded, "mcp.url"), "http://example.local/mcp");
  assert.equal(getRuntimeConfigValueByPath(loaded, "env.envFile"), "../docker/.env");
  assert.equal(getRuntimeConfigValueByPath(loaded, "mcp.authHeader"), "x-litellm-api-key");
  assert.equal(getRuntimeConfigValueByPath(loaded, "mcp.authScheme"), "Bearer");
  // Non-secret runtime config is config-first (with defaults), not env-driven.
  assert.equal(getRuntimeConfigValueByPath(loaded, "sourceCapture.mode"), "replace");
  assert.equal(getRuntimeConfigValueByPath(loaded, "sourceCapture.dedupEnabled"), "false");
  assert.equal(getRuntimeConfigValueByPath(loaded, "commands.sourceCapture.timeoutMs"), "25000");
  assert.equal(getRuntimeConfigValueByPath(loaded, "loopGuard.exemptTools"), "compress,my-tool");
  assert.equal(getRuntimeConfigValueByPath(loaded, "taskWatchdog.workedExampleInjection.enabled"), "false");
  assert.equal(getRuntimeConfigValueByPath(loaded, "taskWatchdog.workedExampleInjection.searchTimeoutMs"), "1234");
  assert.equal(getRuntimeConfigValueByPath(loaded, "taskWatchdog.workedExampleFiling.enabled"), "false");

  assert.equal(envMap.MEMPALACE_MCP_URL, "http://example.local/mcp");
  assert.equal(envMap.ESHEPHERD_ENV_FILE, "../docker/.env");
  assert.equal(envMap.MEMPALACE_MCP_AUTH_HEADER, "x-litellm-api-key");
  assert.equal(envMap.MEMPALACE_MCP_AUTH_SCHEME, "Bearer");

  rmSync(root, { recursive: true, force: true });
});

test("runtime config preserves env input when applyRuntimeConfigToEnv is called", () => {
  const root = makeTempDir("eshepherd-config-default-");
  const env = {
    ESHEPHERD_SOURCE_CAPTURE_MODE: "append",
  };

  const loaded = loadRuntimeConfig({ cwd: root, env });
  applyRuntimeConfigToEnv(env, loaded);

  assert.equal(env.ESHEPHERD_SOURCE_CAPTURE_MODE, "append");

  rmSync(root, { recursive: true, force: true });
});

test("wing defaults are computed from the project directory name, not a shared literal", () => {
  const root = makeTempDir("eshepherd-config-wing-");
  const expectedWing = basename(root).toLowerCase().replace(/[ -]/g, "_").replace(/^_+|_+$/g, "");

  const loaded = loadRuntimeConfig({ cwd: root, env: {} });
  assert.equal(getRuntimeConfigValueByPath(loaded, "memory.projectWing"), expectedWing);
  assert.equal(getRuntimeConfigValueByPath(loaded, "sourceCapture.wing"), expectedWing);

  rmSync(root, { recursive: true, force: true });
});

test("wing defaults strip sortable numeric prefixes from project directory names", () => {
  const parent = makeTempDir("eshepherd-config-wing-numeric-");
  const root = join(parent, "001-SampleProject");
  mkdirSync(root, { recursive: true });

  const loaded = loadRuntimeConfig({ cwd: root, env: {} });
  assert.equal(getRuntimeConfigValueByPath(loaded, "memory.projectWing"), "sampleproject");
  assert.equal(getRuntimeConfigValueByPath(loaded, "sourceCapture.wing"), "sampleproject");

  rmSync(parent, { recursive: true, force: true });
});

test("an explicit config wing wins over the computed project-name default", () => {
  const root = makeTempDir("eshepherd-config-wing-explicit-");
  mkdirSync(join(root, ".electric-shepherd"), { recursive: true });
  writeFileSync(
    join(root, ".electric-shepherd", "config.jsonc"),
    `{ "sourceCapture": { "wing": "shared-wing" } }`,
    "utf8",
  );

  const loaded = loadRuntimeConfig({ cwd: root, env: {} });
  assert.equal(getRuntimeConfigValueByPath(loaded, "sourceCapture.wing"), "shared-wing");

  rmSync(root, { recursive: true, force: true });
});

test("an explicit empty-string config wing still falls back to the computed default", () => {
  const root = makeTempDir("eshepherd-config-wing-blank-");
  const expectedWing = basename(root).toLowerCase().replace(/[ -]/g, "_").replace(/^_+|_+$/g, "");
  mkdirSync(join(root, ".electric-shepherd"), { recursive: true });
  writeFileSync(
    join(root, ".electric-shepherd", "config.jsonc"),
    `{ "sourceCapture": { "wing": "" } }`,
    "utf8",
  );

  const loaded = loadRuntimeConfig({ cwd: root, env: {} });
  assert.equal(getRuntimeConfigValueByPath(loaded, "sourceCapture.wing"), expectedWing);

  rmSync(root, { recursive: true, force: true });
});
