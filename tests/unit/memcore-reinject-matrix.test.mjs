import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { TurnGuard } = await import("../../plugin/session-policy.ts");

/**
 * Rung 2 (R2-01..R2-05) — the positive side of the mem-core reinjection matrix.
 *
 * memcore-reinject-refusal.test.mjs covers the refusal paths (because=...).
 * This file closes what it does not:
 *   - R2-02: with enabled=true, injection occurs IFF the per-reason flag is set —
 *     an enabled reason actually injects (prompt captured), a disabled one refuses.
 *   - R2-03: changed content within the cooldown window is suppressed through the
 *     real handler (the decision-level tests cover the pure function; this proves
 *     the wiring).
 *   - R2-04: the injected payload respects memcore.maxChars (clipText truncation)
 *     and preserves the three labeled block headers.
 *   - R2-05: an injection that throws still records a refusal with because=injection-error.
 *
 * Harness notes:
 *   - Config comes from eshepherd-config.jsonc in a fresh temp project dir
 *     per test (the ESHEPHERD_MEMCORE_* env keys are not wired into loadRuntimeConfig).
 *   - The plugin dedupes instances per directory on globalThis; the reset seam
 *     (TURN_GUARD_INSTANCE_RESET_KEY) gives each test a fresh instance.
 *   - A stub scripts/run-mem-core-loader.ts emits deterministic markdown so the
 *     injection path is fully hermetic (no real mem-core loader, no MCP).
 */

const REINJECT_MARKER = "[Mem-core Reinjection]";

function makeTempProjectDir() {
  const dir = mkdtempSync(join(tmpdir(), "es-memcore-matrix-test-"));
  writeFileSync(join(dir, "package.json"), "{}\n", "utf8");
  return dir;
}

function setConfig(projectDir, config) {
  const configPath = join(projectDir, "eshepherd-config.jsonc");
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

// Deterministic loader output: the three labeled blocks plus a padding line whose
// length is controlled by padChars (to exercise memcore.maxChars truncation).
function installLoader(projectDir, { padChars = 0 } = {}) {
  const scriptsDir = join(projectDir, "scripts");
  mkdirSync(scriptsDir, { recursive: true });
  const pad = padChars > 0 ? "x".repeat(padChars) : "";
  writeFileSync(
    join(scriptsDir, "run-mem-core-loader.ts"),
    `process.stdout.write(\`# Labeled memory blocks (always in context)\\n\\n## [project-state]\\n- fact one\\n\\n## [active-conventions]\\n- decision one\\n\\n## [open-items]\\n- open item one\\n\\n${pad}\\n\`);\n`,
    "utf8",
  );
}

function readLog(projectDir, fileName) {
  const logPath = join(projectDir, ".electric-shepherd", fileName);
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const memcoreRows = (projectDir) =>
  readLog(projectDir, "memcore-context.ndjson").filter(
    (row) => row.type === "memcore-reinject",
  );
const statusRows = (projectDir) =>
  readLog(projectDir, "turn-guard-events.ndjson").filter(
    (row) => row.type === "memcore-reinject",
  );

function makeClient({ promptBehavior } = {}) {
  const prompts = [];
  return {
    prompts,
    client: {
      session: {
        messages: async () => ({
          data: [
            { info: { role: "user", time: { created: 1 } }, parts: [{ type: "text", text: "hi" }] },
            { info: { role: "assistant", time: { created: 2 } }, parts: [{ type: "text", text: "ok" }] },
          ],
        }),
        prompt: async (req) => {
          prompts.push(req);
          if (promptBehavior === "throw") throw new Error("boom-injection");
          return {};
        },
      },
    },
  };
}

async function withPlugin({ config, loader = {}, promptBehavior }, fn) {
  const projectDir = makeTempProjectDir();
  setConfig(projectDir, config);
  if (loader !== null) installLoader(projectDir, loader);
  globalThis.__ESHEPHERD_TURN_GUARD_INSTANCE_RESET__ = true;
  process.env.ESHEPHERD_AUTO_CONSOLIDATION_ENABLED = "false";
  try {
    const { client, prompts } = makeClient({ promptBehavior });
    const plugin = await TurnGuard({ client, directory: projectDir });
    return await fn(plugin, projectDir, prompts);
  } finally {
    delete process.env.ESHEPHERD_AUTO_CONSOLIDATION_ENABLED;
    rmSync(projectDir, { recursive: true, force: true });
  }
}

const ALL_ON = { enabled: true, onIdle: true, onCompact: true, onStart: true };

test("R2-02 mixed per-reason flags: injection iff the reason is enabled", async () => {
  await withPlugin(
    { config: { memcore: { reinject: { enabled: true, onIdle: false, onCompact: false, onStart: true } } } },
    async (plugin, projectDir, prompts) => {
      await plugin.event({ event: { type: "session.started", properties: { sessionID: "sid-m-started" } } });
      await plugin.event({ event: { type: "session.idle", properties: { sessionID: "sid-m-idle" } } });
      await plugin.event({ event: { type: "session.compacted", properties: { sessionID: "sid-m-compact" } } });

      // Enabled reason injected exactly once.
      assert.equal(prompts.length, 1, "exactly one injection (the enabled reason)");
      const text = prompts[0].body.parts.find((p) => p.type === "text").text;
      assert.ok(text.includes(REINJECT_MARKER), "injected payload carries the reinjection marker");
      assert.ok(text.includes("reason=started"), "injection was for the enabled reason");

      // Disabled reasons refused with explicit because, in both logs.
      const refusals = memcoreRows(projectDir).filter((r) => r.injected === false);
      assert.equal(refusals.length, 2, "one refusal per disabled reason");
      for (const [reason, sid] of [["idle", "sid-m-idle"], ["compacted", "sid-m-compact"]]) {
        const row = refusals.find((r) => r.reason === reason);
        assert.ok(row, `refusal entry for reason=${reason} exists`);
        assert.equal(row.sid, sid);
        assert.equal(row.because, `reinject-${reason}-disabled`, `because value for reason=${reason}`);
      }
      const statusRefusals = statusRows(projectDir).filter((r) => r.injected === false);
      for (const reason of ["idle", "compacted"]) {
        assert.ok(
          statusRefusals.some((r) => r.reason === reason && r.because === `reinject-${reason}-disabled`),
          `status event log carries because for reason=${reason}`,
        );
      }
    },
  );
});

test("R2-03 changed content within the cooldown window is suppressed by the real handler", async () => {
  await withPlugin(
    { config: { memcore: { reinject: ALL_ON, injectionCooldownMs: 60000 } } },
    async (plugin, projectDir, prompts) => {
      // First idle: no previous record -> injects.
      await plugin.event({ event: { type: "session.idle", properties: { sessionID: "sid-cd" } } });
      assert.equal(prompts.length, 1, "first idle injects");

      // Change the rendered content (new signature) while the cooldown is active.
      installLoader(projectDir, { padChars: 5000 });
      await plugin.event({ event: { type: "session.idle", properties: { sessionID: "sid-cd" } } });
      assert.equal(prompts.length, 1, "changed content within cooldown does NOT re-inject");

      const refusals = memcoreRows(projectDir).filter((r) => r.injected === false);
      assert.equal(refusals.length, 1, "exactly one refusal (the suppressed repeat)");
      assert.equal(refusals[0].because, "dedup-or-cooldown-skip");
      assert.ok(
        statusRows(projectDir).some((r) => r.injected === false && r.because === "dedup-or-cooldown-skip"),
        "status event log carries the dedup-or-cooldown refusal",
      );
    },
  );
});

test("R2-04 injected payload respects memcore.maxChars and preserves the three labeled blocks", async () => {
  const MAX_CHARS = 500;
  await withPlugin(
    { config: { memcore: { reinject: ALL_ON, maxChars: MAX_CHARS } }, loader: { padChars: 2000 } },
    async (plugin, projectDir, prompts) => {
      await plugin.event({ event: { type: "session.idle", properties: { sessionID: "sid-max" } } });

      assert.equal(prompts.length, 1, "injection happened");
      const text = prompts[0].body.parts.find((p) => p.type === "text").text;
      const clipped = text.slice(text.indexOf(REINJECT_MARKER));
      // clipText slices the render to maxChars and then appends a truncation
      // marker ("<!-- truncated by turn-guard (N chars omitted) -->"); bound the
      // marker length generously so the assertion stays stable across scope paths.
      assert.ok(clipped.length <= MAX_CHARS + 128, `clipped render exceeds maxChars (${clipped.length} > ${MAX_CHARS + 128})`);
      assert.ok(clipped.includes("truncated by turn-guard"), "truncation marker present");

      // The three labeled blocks survive the clip (they precede the padding).
      for (const header of ["## [project-state]", "## [active-conventions]", "## [open-items]"]) {
        assert.ok(clipped.includes(header), `labeled block missing from clipped render: ${header}`);
      }

      const injected = memcoreRows(projectDir).find((r) => r.injected === true);
      assert.ok(injected, "injection recorded in context log");
      assert.ok(injected.chars <= MAX_CHARS + 128, `logged chars respect maxChars (${injected.chars})`);
    },
  );
});

test("R2-05 injection error records a refusal with because=injection-error", async () => {
  await withPlugin(
    { config: { memcore: { reinject: ALL_ON } }, promptBehavior: "throw" },
    async (plugin, projectDir) => {
      await plugin.event({ event: { type: "session.idle", properties: { sessionID: "sid-err" } } });

      const refusals = memcoreRows(projectDir).filter((r) => r.injected === false);
      assert.equal(refusals.length, 1, "exactly one refusal (the failed injection)");
      assert.equal(refusals[0].because, "injection-error");
      assert.ok(String(refusals[0].error).includes("boom-injection"), "raw error preserved alongside because");

      const statusRefusals = statusRows(projectDir).filter((r) => r.injected === false);
      assert.equal(statusRefusals.length, 1);
      assert.equal(statusRefusals[0].because, "injection-error", "status event log carries same because");
    },
  );
});
