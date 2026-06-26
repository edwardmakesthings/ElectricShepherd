import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  loadAgentDefinitions,
  loadCommandDefinitions,
  loadInstructionPaths,
  dedupeAppendInstructions,
  loadPackagedAssets,
  mergeWithoutOverride,
  parseFrontmatter,
  splitFrontmatter,
} from "../../adapter/asset-loader.ts";

/**
 * Unit coverage for the packaged-asset loader that powers the plugin's `config`
 * hook. The hook reads the bundled agents/commands markdown and injects them
 * into the resolved OpenCode config so they load in any consumer project. These
 * tests pin the frontmatter parsing contract (scalars, nested maps, body field),
 * the no-clobber merge, and the real bundled files parsing into valid shapes.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("splitFrontmatter separates header and body, tolerating BOM and CRLF", () => {
  const raw = "\uFEFF---\r\ndescription: hi\r\n---\r\nbody line one\r\nbody line two\r\n";
  const { frontmatter, body } = splitFrontmatter(raw);
  assert.equal(frontmatter, "description: hi");
  assert.equal(body, "body line one\r\nbody line two");
});

test("splitFrontmatter returns empty frontmatter when no header present", () => {
  const { frontmatter, body } = splitFrontmatter("just a body\n");
  assert.equal(frontmatter, "");
  assert.equal(body, "just a body");
});

test("parseFrontmatter coerces scalars and one level of nested maps", () => {
  const meta = parseFrontmatter(
    [
      "description: An agent",
      'model: "litellm/foo:7b"',
      "mode: subagent",
      "temperature: 0.2",
      "steps: 120",
      "subtask: true",
      "permission:",
      "  read: allow",
      "  edit: deny",
    ].join("\n"),
  );
  assert.equal(meta.description, "An agent");
  assert.equal(meta.model, "litellm/foo:7b");
  assert.equal(meta.mode, "subagent");
  assert.equal(meta.temperature, 0.2);
  assert.equal(meta.steps, 120);
  assert.equal(meta.subtask, true);
  assert.deepEqual(meta.permission, { read: "allow", edit: "deny" });
});

test("loadAgentDefinitions keys by filename and puts body in prompt", () => {
  const dir = mkdtempSync(join(tmpdir(), "eshepherd-agents-"));
  try {
    writeFileSync(
      join(dir, "sample.md"),
      "---\ndescription: Sample\nmode: primary\n---\nYou are sample.\n",
      "utf8",
    );
    const agents = loadAgentDefinitions(dir);
    assert.deepEqual(Object.keys(agents), ["sample"]);
    assert.equal(agents.sample.description, "Sample");
    assert.equal(agents.sample.mode, "primary");
    assert.equal(agents.sample.prompt, "You are sample.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadCommandDefinitions puts body in template", () => {
  const dir = mkdtempSync(join(tmpdir(), "eshepherd-cmd-"));
  try {
    writeFileSync(
      join(dir, "do-thing.md"),
      "---\ndescription: Do\nagent: dreamer\nsubtask: true\n---\nRun $ARGUMENTS now.\n",
      "utf8",
    );
    const commands = loadCommandDefinitions(dir);
    assert.equal(commands["do-thing"].agent, "dreamer");
    assert.equal(commands["do-thing"].subtask, true);
    assert.equal(commands["do-thing"].template, "Run $ARGUMENTS now.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadAgentDefinitions returns empty for a missing directory", () => {
  assert.deepEqual(loadAgentDefinitions(join(tmpdir(), "eshepherd-does-not-exist-xyz")), {});
});

test("mergeWithoutOverride keeps user-defined entries", () => {
  const merged = mergeWithoutOverride(
    { dreamer: { mode: "primary", prompt: "bundled" }, mapper: { mode: "subagent" } },
    { dreamer: { mode: "primary", prompt: "user override" } },
  );
  assert.equal(merged.dreamer.prompt, "user override");
  assert.equal(merged.mapper.mode, "subagent");
});

test("real bundled assets parse into the expected dreamer agents and commands", () => {
  const { agents, commands } = loadPackagedAssets(repoRoot);
  for (const name of ["dreamer", "dream-mapper", "dream-auditor", "dream-consolidator"]) {
    assert.ok(agents[name], `expected bundled agent ${name}`);
    assert.ok(typeof agents[name].prompt === "string" && agents[name].prompt.length > 0);
    assert.ok(agents[name].mode === "primary" || agents[name].mode === "subagent");
  }
  for (const name of ["count-sheep", "herd", "lucid-dream", "wake-up", "headcount"]) {
    assert.ok(commands[name], `expected bundled command ${name}`);
    const expectedAgent = name === "count-sheep" ? "build" : "dreamer";
    assert.equal(commands[name].agent, expectedAgent);
    assert.ok(typeof commands[name].template === "string" && commands[name].template.length > 0);
  }
  // Converted keys must be current, not deprecated.
  assert.equal(agents.dreamer.steps, 120);
  assert.deepEqual(agents.dreamer.permission, {
    read: "allow",
    edit: "deny",
    bash: "allow",
    task: "allow",
  });
});

test("loadInstructionPaths returns absolute paths to existing bundled rule files", () => {
  const paths = loadInstructionPaths(repoRoot);
  assert.equal(paths.length, 1);
  for (const p of paths) {
    assert.ok(p.endsWith("agent-discipline.md"));
    assert.ok(p.includes("instructions"));
  }
});

test("loadInstructionPaths skips names that do not exist", () => {
  const paths = loadInstructionPaths(repoRoot, ["agent-discipline.md", "does-not-exist.md"]);
  assert.equal(paths.length, 1);
  assert.ok(paths[0].endsWith("agent-discipline.md"));
});

test("dedupeAppendInstructions appends without duplicating existing entries", () => {
  const result = dedupeAppendInstructions(["CONTRIBUTING.md", "/abs/agent-discipline.md"], [
    "/abs/agent-discipline.md",
    "/abs/eshepherd/memory/memory.md",
  ]);
  assert.deepEqual(result, ["CONTRIBUTING.md", "/abs/agent-discipline.md", "/abs/eshepherd/memory/memory.md"]);
});

test("dedupeAppendInstructions tolerates an undefined existing array", () => {
  assert.deepEqual(dedupeAppendInstructions(undefined, ["/a.md"]), ["/a.md"]);
});

