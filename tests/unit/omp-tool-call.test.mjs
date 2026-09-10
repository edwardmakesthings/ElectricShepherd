import assert from "node:assert/strict";
import test from "node:test";

import { registerToolCallGuard } from "../../src/surface/omp/tool-call.ts";
import { isConsolidationWriteTool } from "../../src/policy/synthesis-boundary.ts";

function capture() {
  let handler;
  const logs = [];
  const pi = {
    zod: {},
    logger: { warn: (message) => logs.push(message) },
    registerTool() {},
    on(_event, fn) {
      handler = fn;
    },
  };
  registerToolCallGuard(pi);
  return { handler, logs };
}

const call = (toolName) => ({ type: "tool_call", toolCallId: "t1", toolName, input: {} });
const ctx = { cwd: process.cwd() };

// The gateway prefixes tool names (mempalace-mempalace_add_drawer), so the guard
// matches on suffix or it would silently pass every gatewayed call through.
test("synthesis boundary recognises derived writes behind any gateway prefix", () => {
  for (const name of [
    "add_drawer",
    "mempalace_add_drawer",
    "mempalace-mempalace_add_drawer",
    "mempalace-mempalace_kg_add",
    "mempalace-mempalace_apply_merge",
    "mempalace-mempalace_update_drawer",
    "mempalace-mempalace_kg_invalidate",
  ]) {
    assert.equal(isConsolidationWriteTool(name), true, name);
  }
});

test("synthesis boundary leaves reads and diary writes alone", () => {
  for (const name of [
    "mempalace-mempalace_search",
    "mempalace-mempalace_get_drawer",
    "mempalace-mempalace_diary_write",
    "read",
    "bash",
  ]) {
    assert.equal(isConsolidationWriteTool(name), false, name);
  }
});

test("omp tool_call blocks a derived write and names the way through", () => {
  const { handler, logs } = capture();
  const result = handler(call("mempalace-mempalace_add_drawer"), ctx);

  assert.equal(result.block, true);
  assert.match(result.reason, /synthesis boundary/i);
  assert.match(result.reason, /diary_write/);
  assert.match(logs.join("\n"), /blocked mempalace-mempalace_add_drawer/);
});

test("omp tool_call passes through unrelated tools", () => {
  const { handler, logs } = capture();
  assert.equal(handler(call("read"), ctx), undefined);
  assert.equal(handler(call("mempalace-mempalace_search"), ctx), undefined);
  assert.equal(logs.length, 0);
});

// The boundary is an invariant with no off switch, so in particular an inherited
// environment cannot clear it.
test("omp tool_call write guard is not disableable through the environment", () => {
  const previous = process.env.ESHEPHERD_CONSOLIDATION_WRITE_GUARD_ENABLED;
  process.env.ESHEPHERD_CONSOLIDATION_WRITE_GUARD_ENABLED = "false";
  try {
    const { handler } = capture();
    const result = handler(call("add_drawer"), { cwd: process.env.TMPDIR || "/tmp" });
    assert.equal(result.block, true, "an env var must not switch the boundary off");
  } finally {
    if (previous === undefined) delete process.env.ESHEPHERD_CONSOLIDATION_WRITE_GUARD_ENABLED;
    else process.env.ESHEPHERD_CONSOLIDATION_WRITE_GUARD_ENABLED = previous;
  }
});
