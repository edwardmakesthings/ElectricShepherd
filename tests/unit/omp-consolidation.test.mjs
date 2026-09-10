import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { registerConsolidation } from "../../src/surface/omp/consolidation.ts";

function capture() {
  const handlers = new Map();
  const logs = [];
  const pi = {
    zod: {},
    logger: { warn: (message) => logs.push(message) },
    registerTool() {},
    on(event, fn) {
      handlers.set(event, fn);
    },
  };
  registerConsolidation(pi);
  return { handlers, logs };
}

/** A project root the driver will accept as the consolidation cwd. */
function makeProject() {
  const root = mkdtempSync(join(tmpdir(), "es-consolidation-"));
  writeFileSync(join(root, "package.json"), "{}\n", "utf8");
  return root;
}

function withConsolidation(enabled, run) {
  const previous = process.env.ESHEPHERD_AUTO_CONSOLIDATION_ENABLED;
  process.env.ESHEPHERD_AUTO_CONSOLIDATION_ENABLED = enabled;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.ESHEPHERD_AUTO_CONSOLIDATION_ENABLED;
    else process.env.ESHEPHERD_AUTO_CONSOLIDATION_ENABLED = previous;
  }
}

const compactEvent = {
  type: "session_compact",
  compactionEntry: { firstKeptEntryId: "entry-42" },
  fromExtension: false,
};

const stopEvent = (overrides = {}) => ({
  type: "session_stop",
  messages: [],
  turn_id: 1,
  session_id: "s1",
  stop_hook_active: false,
  ...overrides,
});

test("omp consolidation subscribes to both the fold and the settle", () => {
  const { handlers } = capture();
  assert.ok(handlers.has("session_compact"));
  assert.ok(handlers.has("session_stop"));
});

test("omp consolidation stays put when disabled", () => {
  const root = makeProject();
  withConsolidation("false", () => {
    const { handlers, logs } = capture();
    handlers.get("session_compact")(compactEvent, { cwd: root });
    assert.equal(logs.length, 0);
    // The script owns the lock file; a skipped launch must not create one.
    assert.ok(!existsSync(join(root, ".electric-shepherd", "auto-consolidation.lock")));
  });
  rmSync(root, { recursive: true, force: true });
});

// omp stops dispatching session_stop at the first result carrying a continuation,
// so this handler must stay silent or it would suppress the memory checkpoint.
test("omp consolidation never returns a session_stop continuation", () => {
  const root = makeProject();
  withConsolidation("false", () => {
    const { handlers } = capture();
    assert.equal(handlers.get("session_stop")(stopEvent(), { cwd: root }), undefined);
  });
  rmSync(root, { recursive: true, force: true });
});

test("omp consolidation ignores its own continuation pass", () => {
  const root = makeProject();
  withConsolidation("true", () => {
    const { handlers, logs } = capture();
    assert.equal(handlers.get("session_stop")(stopEvent({ stop_hook_active: true }), { cwd: root }), undefined);
    assert.equal(logs.length, 0, "a continuation pass must not launch a run");
  });
  rmSync(root, { recursive: true, force: true });
});
