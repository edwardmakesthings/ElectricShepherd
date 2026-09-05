import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { TurnGuard } = await import("../../src/surface/plugin/session-policy.ts");

/**
 * Rung 2 (R2-05) — Refusal Transparency.
 *
 * Every mem-core reinjection refusal must be observable in the status/context
 * logs with an explicit `because` reason. These tests drive the real plugin
 * event hooks (session.started / session.idle / session.compacted) with the
 * reinject gates disabled and assert that a refusal entry with the correct
 * `because` value lands in `.electric-shepherd/memcore-context.ndjson`.
 */

function makeTempProjectDir() {
  const dir = mkdtempSync(join(tmpdir(), "es-memcore-refusal-test-"));
  writeFileSync(join(dir, "package.json"), "{}\n", "utf8");
  // A local config file is the only supported way to set these gates (the
  // ESHEPHERD_MEMCORE_* env keys are not wired into loadRuntimeConfig's
  // valuesByPath), so each test writes its own flags here.
  writeFileSync(
    join(dir, "eshepherd-config.jsonc"),
    `${JSON.stringify({ memcore: { reinject: {} } }, null, 2)}\n`,
    "utf8",
  );
  return dir;
}

function setReinjectFlags(projectDir, flags) {
  const configPath = join(projectDir, "eshepherd-config.jsonc");
  writeFileSync(
    configPath,
    `${JSON.stringify({ memcore: { reinject: flags } }, null, 2)}\n`,
    "utf8",
  );
}

function restoreEnv(snapshot) {
  for (const [k, v] of Object.entries(snapshot)) {
    if (typeof v === "undefined") delete process.env[k];
    else process.env[k] = v;
  }
}

function readRefusals(projectDir) {
  const logPath = join(projectDir, ".electric-shepherd", "memcore-context.ndjson");
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// The durable per-event status log: every writeStatusFile call appends the
// event-specific fields here (the overwrite-only turn-guard-status.json snapshot
// retains only the LAST event, so it is not a reliable place to assert a refusal
// that other same-handler events follow).
function readStatusEvents(projectDir) {
  const logPath = join(projectDir, ".electric-shepherd", "turn-guard-events.ndjson");
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function makeClient() {
  const prompts = [];
  // onSessionIdle requires >= 2 messages before it reaches the mem-core gate;
  // two minimal user/assistant messages satisfy that without triggering any
  // retry/checkpoint/worked-example side effects.
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
          return {};
        },
      },
    },
  };
}

// The plugin dedupes instances per directory on globalThis; each test uses a
// fresh temp dir so every TurnGuard call registers its own instance.
const ENV_KEYS = [
  "ESHEPHERD_AUTO_CONSOLIDATION_ENABLED",
  "ESHEPHERD_MEMCORE_REINJECT_ENABLED",
  "ESHEPHERD_MEMCORE_REINJECT_ON_IDLE",
  "ESHEPHERD_MEMCORE_REINJECT_ON_COMPACT",
  "ESHEPHERD_MEMCORE_REINJECT_ON_START",
];

async function withPlugin(reinjectFlags, fn) {
  const projectDir = makeTempProjectDir();
  setReinjectFlags(projectDir, reinjectFlags);
  const envSnapshot = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.ESHEPHERD_AUTO_CONSOLIDATION_ENABLED = "false";
  try {
    const { client, prompts } = makeClient();
    const plugin = await TurnGuard({ client, directory: projectDir });
    return await fn(plugin, projectDir, prompts);
  } finally {
    restoreEnv(envSnapshot);
    rmSync(projectDir, { recursive: true, force: true });
  }
}

test("global disable records an observable refusal (because=reinject-disabled) for every reason", async () => {
  await withPlugin(
    { enabled: false },
    async (plugin, projectDir, prompts) => {
      for (const [type, sid] of [
        ["session.started", "sid-g-started"],
        ["session.idle", "sid-g-idle"],
        ["session.compacted", "sid-g-compact"],
        ["experimental.session.compacting", "sid-g-compacting"],
      ]) {
        await plugin.event({ event: { type, properties: { sessionID: sid } } });
      }

      assert.equal(prompts.length, 0, "reinject disabled must never inject a mem-core prompt");

      const refusals = readRefusals(projectDir).filter(
        (row) => row.type === "memcore-reinject" && row.injected === false,
      );
      assert.equal(refusals.length, 3, "one refusal entry per lifecycle event");
      for (const [reason, sid] of [
        ["started", "sid-g-started"],
        ["idle", "sid-g-idle"],
        ["compacted", "sid-g-compact"],
      ]) {
        const row = refusals.find((r) => r.reason === reason);
        assert.ok(row, `refusal entry for reason=${reason} exists`);
        assert.equal(row.sid, sid);
        assert.equal(row.because, "reinject-disabled", `because value for reason=${reason}`);
      }
      assert.equal(
        refusals.some((r) => r.reason === "compacting"),
        false,
        "pre-compaction event is intentionally not used for mem-core reinjection",
      );
    },
  );
});

test("per-reason disable records an observable refusal (because=reinject-<reason>-disabled)", async () => {
  await withPlugin(
    { enabled: true, onIdle: false, onCompact: false, onStart: false },
    async (plugin, projectDir) => {
      for (const [type, sid] of [
        ["session.started", "sid-p-started"],
        ["session.idle", "sid-p-idle"],
        ["session.compacted", "sid-p-compact"],
      ]) {
        await plugin.event({ event: { type, properties: { sessionID: sid } } });
      }

      const refusals = readRefusals(projectDir).filter(
        (row) => row.type === "memcore-reinject" && row.injected === false,
      );
      assert.equal(refusals.length, 3, "one refusal entry per lifecycle event");
      for (const reason of ["started", "idle", "compacted"]) {
        const row = refusals.find((r) => r.reason === reason);
        assert.ok(row, `refusal entry for reason=${reason} exists`);
        assert.equal(
          row.because,
          `reinject-${reason}-disabled`,
          `because value for reason=${reason}`,
        );
      }
    },
  );
});

test("enabled gates with no mem-core markdown refuse with because=no-memcore-markdown in context log AND status file", async () => {
  await withPlugin(
    { enabled: true, onIdle: true, onCompact: true, onStart: true },
    async (plugin, projectDir) => {
      // Temp dir has no scripts/run-mem-core-loader.ts -> loader not found ->
      // the no-memcore-markdown refusal path must fire.
      await plugin.event({ event: { type: "session.idle", properties: { sessionID: "sid-nomd" } } });

      const refusals = readRefusals(projectDir).filter(
        (row) => row.type === "memcore-reinject" && row.injected === false,
      );
      assert.equal(refusals.length, 1);
      assert.equal(refusals[0].because, "no-memcore-markdown");
      assert.equal(refusals[0].note, undefined, "refusal must use because, not note");

      // The status file event log (turn-guard-events.ndjson) must carry the same
      // because. The overwrite-only turn-guard-status.json snapshot is clobbered by
      // later events in the same handler (e.g. auto-consolidation-armed), so the
      // durable per-event log is the correct place to assert the refusal entry.
      const statusEvents = readStatusEvents(projectDir).filter(
        (row) => row.type === "memcore-reinject" && row.injected === false,
      );
      assert.ok(statusEvents.length >= 1, "status event log has a memcore-reinject refusal");
      for (const ev of statusEvents) {
        assert.equal(ev.because, "no-memcore-markdown", "status file entry carries same because");
      }
    },
  );
});

test("dedup-or-cooldown skip refuses with because=dedup-or-cooldown-skip in context log AND status file", async () => {
  await withPlugin(
    { enabled: true, onIdle: true, onCompact: true, onStart: true },
    async (plugin, projectDir) => {
      // Give the temp project a loader script and a memory.md so the no-memcore-markdown
      // path is bypassed and injection actually proceeds; then a second idle event with
      // unchanged content hits the dedup-or-cooldown skip gate.
      const scriptsDir = join(projectDir, "src", "scripts");
      mkdirSync(scriptsDir, { recursive: true });
      writeFileSync(
        join(scriptsDir, "run-mem-core-loader.ts"),
        `process.stdout.write("<!-- test mem-core -->\\n# Test Memory\\ncontent for dedup check\\n");\n`,
        "utf8",
      );
      writeFileSync(join(projectDir, "memory.md"), "# Test Memory\ncontent for dedup check\n", "utf8");

      // First idle: injection succeeds (no previous record -> shouldInject).
      await plugin.event({ event: { type: "session.idle", properties: { sessionID: "sid-dedup" } } });

      // Second idle: same scopeDir + same content signature, within cooldown window.
      await plugin.event({ event: { type: "session.idle", properties: { sessionID: "sid-dedup" } } });

      const refusals = readRefusals(projectDir).filter(
        (row) => row.type === "memcore-reinject" && row.injected === false,
      );
      assert.equal(refusals.length, 1, "exactly one refusal (the dedup-or-cooldown skip)");
      assert.equal(refusals[0].because, "dedup-or-cooldown-skip");
      assert.equal(refusals[0].note, undefined, "refusal must use because, not note");

      // The status file event log (turn-guard-events.ndjson) must carry the same
      // because. The overwrite-only turn-guard-status.json snapshot is clobbered by
      // later events in the same handler (e.g. auto-consolidation-armed), so the
      // durable per-event log is the correct place to assert the refusal entry.
      const statusEvents = readStatusEvents(projectDir).filter(
        (row) => row.type === "memcore-reinject" && row.injected === false,
      );
      assert.ok(statusEvents.length >= 1, "status event log has a memcore-reinject refusal");
      for (const ev of statusEvents) {
        assert.equal(ev.because, "dedup-or-cooldown-skip", "status file entry carries same because");
      }
    },
  );
});
