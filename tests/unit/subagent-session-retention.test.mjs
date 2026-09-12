import assert from "node:assert/strict";
import test from "node:test";

import { buildSubagentArgs } from "../../src/scripts/memory-pipeline/subagent.ts";

const omp = { kind: "omp", bin: "/home/u/.local/bin/omp" };
const opencode = { kind: "opencode", bin: "/home/u/.opencode/bin/opencode" };

// Default stays ephemeral: 26 chunks would otherwise leave 26 session files per
// run, so retention is opt-in.
test("omp discards the session by default", () => {
  const argv = buildSubagentArgs({ runner: omp, prompt: "p" });
  assert.ok(argv.includes("--no-session"));
  assert.ok(argv.includes("--no-title"));
});

test("omp keeps and titles the session when asked", () => {
  const argv = buildSubagentArgs({ runner: omp, prompt: "p", keepSession: true, sessionTitle: "es-mapper run-1 chunk 3/26" });
  assert.ok(!argv.includes("--no-session"), "--no-session must be dropped");
  assert.ok(!argv.includes("--no-title"), "a kept session needs a findable title");
  assert.deepEqual(argv.slice(argv.indexOf("--title"), argv.indexOf("--title") + 2), ["--title", "es-mapper run-1 chunk 3/26"]);
});

// Extensions stay off regardless: this is what stops a mapper pass re-entering
// Electric Shepherd and recursively triggering capture/consolidation.
test("omp keeps extensions disabled whether or not the session is kept", () => {
  for (const keepSession of [true, false]) {
    assert.ok(buildSubagentArgs({ runner: omp, prompt: "p", keepSession }).includes("--no-extensions"));
  }
});

// `opencode run` has no --no-session, so passing one would be a CLI error.
test("opencode never receives a --no-session flag it does not support", () => {
  for (const keepSession of [true, false]) {
    const argv = buildSubagentArgs({ runner: opencode, prompt: "p", keepSession, sessionTitle: "t" });
    assert.ok(!argv.includes("--no-session"));
  }
});

test("opencode titles the session only when retention is requested", () => {
  assert.ok(!buildSubagentArgs({ runner: opencode, prompt: "p", sessionTitle: "t" }).includes("--title"));
  assert.ok(buildSubagentArgs({ runner: opencode, prompt: "p", keepSession: true, sessionTitle: "t" }).includes("--title"));
});

// omp takes provider/model; the internal routing format uses a comma.
test("omp rewrites the model separator, opencode keeps it", () => {
  const ompArgs = buildSubagentArgs({ runner: omp, prompt: "p", modelArg: "litellm,implementer-qwen3.8-27b" });
  assert.ok(ompArgs.includes("litellm/implementer-qwen3.8-27b"));

  const ocArgs = buildSubagentArgs({ runner: opencode, prompt: "p", modelArg: "litellm/implementer-qwen3.8-27b" });
  assert.ok(ocArgs.includes("litellm/implementer-qwen3.8-27b"));
});

// omp has no --agent for a top-level run; the definition rides in as a prompt file.
test("agent selection differs by harness", () => {
  const ompArgs = buildSubagentArgs({ runner: omp, prompt: "p", agentName: "dream-mapper" }, "/tmp/a/dream-mapper.md");
  assert.ok(!ompArgs.includes("--agent"));
  assert.ok(ompArgs.includes("--append-system-prompt=/tmp/a/dream-mapper.md"));

  const ocArgs = buildSubagentArgs({ runner: opencode, prompt: "p", agentName: "dream-mapper" });
  assert.deepEqual(ocArgs.slice(ocArgs.indexOf("--agent"), ocArgs.indexOf("--agent") + 2), ["--agent", "dream-mapper"]);
});
