import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import { applyRuntimeConfigToEnv, loadRuntimeConfig } from "../../adapter/runtime-config.ts";

function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("runtime config reads .electric-shepherd/config.jsonc and maps to env keys", () => {
  const root = makeTempDir("eshepherd-config-");
  mkdirSync(join(root, ".electric-shepherd"), { recursive: true });

  writeFileSync(
    join(root, ".electric-shepherd", "config.jsonc"),
    `{
      // JSONC comment support
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
      }
    }`,
    "utf8",
  );

  const env = {
    ESHEPHERD_SOURCE_CAPTURE_MODE: "append",
  };

  const loaded = loadRuntimeConfig({ cwd: root, env });
  applyRuntimeConfigToEnv(env, loaded);

  assert.equal(env.MEMPALACE_MCP_URL, "http://example.local/mcp");
  assert.equal(env.MEMPALACE_MCP_AUTH_HEADER, "x-litellm-api-key");
  assert.equal(env.MEMPALACE_MCP_AUTH_SCHEME, "Bearer");
  // Precedence is env > config > default. An explicit env value wins over
  // config.jsonc so a spawned child can be isolated from the repo's own config
  // purely through its environment -- config.jsonc is read from the same repo
  // root by parent and child alike, so config-first would make isolation
  // impossible.
  assert.equal(env.ESHEPHERD_SOURCE_CAPTURE_MODE, "append");
  assert.equal(env.ESHEPHERD_SOURCE_CAPTURE_DEDUP_ENABLED, "false");
  assert.equal(env.ESHEPHERD_SOURCE_CAPTURE_TIMEOUT_MS, "25000");
  assert.equal(env.ESHEPHERD_LOOPGUARD_EXEMPT_TOOLS, "compress,my-tool");

  rmSync(root, { recursive: true, force: true });
});

test("runtime config falls back to config/default when no env override is set", () => {
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
  const env = {};
  applyRuntimeConfigToEnv(env, loaded);

  assert.equal(env.ESHEPHERD_PROJECT_WING, expectedWing);
  assert.equal(env.ESHEPHERD_SOURCE_CAPTURE_WING, expectedWing);

  rmSync(root, { recursive: true, force: true });
});

test("wing defaults strip sortable numeric prefixes from project directory names", () => {
  const parent = makeTempDir("eshepherd-config-wing-numeric-");
  const root = join(parent, "001-SampleProject");
  mkdirSync(root, { recursive: true });

  const loaded = loadRuntimeConfig({ cwd: root, env: {} });
  const env = {};
  applyRuntimeConfigToEnv(env, loaded);

  assert.equal(env.ESHEPHERD_PROJECT_WING, "sampleproject");
  assert.equal(env.ESHEPHERD_SOURCE_CAPTURE_WING, "sampleproject");

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
  const env = {};
  applyRuntimeConfigToEnv(env, loaded);

  assert.equal(env.ESHEPHERD_SOURCE_CAPTURE_WING, "shared-wing");

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
  const env = {};
  applyRuntimeConfigToEnv(env, loaded);

  assert.equal(env.ESHEPHERD_SOURCE_CAPTURE_WING, expectedWing);

  rmSync(root, { recursive: true, force: true });
});
