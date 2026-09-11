import assert from "node:assert/strict";
import test from "node:test";

import { translateAgent, translateCommand, translateInstruction } from "../../src/scripts/sync-omp-assets.ts";

const ES_AGENT = `---
description: Memory consolidation orchestrator (map-reduce policy layer)
mode: primary
model: "litellm/implementer-qwen3.8-27b"
temperature: 0.2
permission:
  read: allow
  write:
    "*": deny
tools:
  brain_mempalace-mempalace_*: true
  write: true
---
# Dreamer

You are the Dreamer.
`;

const ES_COMMAND = `---
description: Consolidate deep — full pass
agent: dreamer
subtask: false
---
Take deliberate control of the dream.
`;

// omp requires \`name\`, which OpenCode agents never carry.
test("agent translation supplies the name omp requires", () => {
  const out = translateAgent("dreamer", ES_AGENT);
  assert.match(out, /^---\nname: dreamer\n/);
  assert.match(out, /description: "Memory consolidation orchestrator \(map-reduce policy layer\)"/);
});

// omp's `tools` is an array of exact names; an OpenCode glob map handed to omp
// restricts nothing, so carrying it over would imply a limit that does not exist.
test("agent translation drops OpenCode-only frontmatter", () => {
  const out = translateAgent("dreamer", ES_AGENT);
  for (const dropped of ["mode:", "temperature:", "permission:", "tools:", "brain_mempalace"]) {
    assert.ok(!out.includes(dropped), `expected ${dropped} to be dropped`);
  }
  assert.match(out, /# Dreamer/);
  assert.match(out, /You are the Dreamer\./);
});

test("agent translation falls back to a description when none is declared", () => {
  assert.match(translateAgent("scout", "# Scout\n\nbody"), /description: "Electric Shepherd scout agent"/);
});

// omp reads only `description` from a command, so `agent:` routing would vanish
// silently. omp has no in-session agent switch, so it becomes a task delegation.
test("command translation turns agent routing into a task delegation", () => {
  const out = translateCommand(ES_COMMAND);
  assert.match(out, /Delegate this entire request to the `dreamer` agent using the `task` tool/);
  assert.match(out, /Take deliberate control of the dream\./);
  assert.ok(!out.includes("subtask:"));
});

test("command translation leaves unrouted commands alone", () => {
  const out = translateCommand("---\ndescription: Plain\n---\nJust do the thing.\n");
  assert.ok(!out.includes("Delegate this entire request"));
  assert.match(out, /Just do the thing\./);
});

test("command translation preserves $ARGUMENTS for omp substitution", () => {
  const out = translateCommand("---\ndescription: X\nagent: dreamer\n---\nScope: $ARGUMENTS\n");
  assert.match(out, /Scope: \$ARGUMENTS/);
});

// OpenCode puts instructions/ on config.instructions, which applies to every
// agent. omp's equivalent is a rule with alwaysApply and no agents filter.
test("instruction translation becomes an always-on omp rule", () => {
  const out = translateInstruction("agent-discipline", "# Agent discipline\n\nDo the thing.\n");
  assert.match(out, /alwaysApply: true/);
  assert.match(out, /description: "Electric Shepherd agent-discipline"/);
  assert.match(out, /# Agent discipline/);
  assert.ok(!out.includes("agents:"), "no agents filter means every agent, matching OpenCode");
});

test("instruction translation keeps an authored description", () => {
  const out = translateInstruction("x", "---\ndescription: Custom\n---\nBody\n");
  assert.match(out, /description: "Custom"/);
});
