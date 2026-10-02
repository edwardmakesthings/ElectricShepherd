import assert from "node:assert/strict";
import test from "node:test";

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  expandTemplate,
  parseArguments,
  readInstructionText,
  registerInstructions,
  registerPackagedAssets,
  registerPackagedSkills,
  registerPermissionDefaults,
  translateAgent,
} from "../../src/surface/opencode-v2/assets.ts";
import { loadPackagedSkills } from "../../src/surface/asset-loader.ts";

test("translateAgent maps v1 frontmatter onto v2 agent fields", () => {
  const out = translateAgent({
    prompt: "You are a guide.",
    description: "Guide",
    mode: "primary",
    model: "litellm/implementer-swift-qwen3.8-27b",
    temperature: 0.2,
    top_p: 0.9,
    steps: 60,
    permission: { read: "allow", bash: "deny", task: "allow", write: { "*": "deny" } },
    tools: { "palace_report": true, es_delete_drawers: false },
  });

  assert.equal(out.system, "You are a guide.");
  assert.deepEqual(out.model, { providerID: "litellm", id: "implementer-swift-qwen3.8-27b" });
  assert.deepEqual(out.body, { temperature: 0.2, top_p: 0.9 });
  assert.equal(out.steps, 60);
  assert.deepEqual(out.permissions, [
    { action: "read", resource: "*", effect: "allow" },
    { action: "shell", resource: "*", effect: "deny" },
    { action: "subagent", resource: "*", effect: "allow" },
    { action: "edit", resource: "*", effect: "deny" },
    { action: "palace_report", resource: "*", effect: "allow" },
    { action: "es_delete_drawers", resource: "*", effect: "deny" },
  ]);
});

test("translateAgent ignores invalid modes, models and effects", () => {
  const out = translateAgent({ mode: "weird", model: "no-slash", permission: { read: "maybe" } });
  assert.equal(out.mode, undefined);
  assert.equal(out.model, undefined);
  assert.deepEqual(out.permissions, []);
});

test("parseArguments honors quotes", () => {
  assert.deepEqual(parseArguments(`src/a.ts "error handling" 'x y'`), ["src/a.ts", "error handling", "x y"]);
});

test("expandTemplate handles $ARGUMENTS, positions and the append fallback", () => {
  assert.equal(expandTemplate("Review $ARGUMENTS now", "src/a.ts"), "Review src/a.ts now");
  assert.equal(expandTemplate("Check $1. Focus on $2.", `src/a.ts "error handling"`), "Check src/a.ts. Focus on error handling.");
  assert.equal(expandTemplate("Compare $1 with $2.", "api stable branch"), "Compare api with stable branch.");
  assert.equal(expandTemplate("Explain this.", "src/cache.ts"), "Explain this.\n\nsrc/cache.ts");
  assert.equal(expandTemplate("Explain this.", "  "), "Explain this.");
});

test("registerPackagedAssets registers bundled commands/agents and respects existing names", async () => {
  const commands = [];
  const agents = new Map([["dreamer", { id: "dreamer" }]]);
  const created = [];
  const calls = [];
  const ctx = {
    command: {
      list: async () => ({ data: [{ name: "consolidate" }] }),
      transform: async (cb) => cb({ add: (def) => commands.push(def) }),
    },
    agent: {
      transform: async (cb) =>
        cb({
          get: (id) => agents.get(id),
          update: (id, fn) => {
            const draft = { request: { body: {} }, permissions: [] };
            fn(draft);
            created.push([id, draft]);
          },
        }),
    },
    session: {
      prompt: async (input) => calls.push(["prompt", input]),
      switchAgent: async (input) => calls.push(["switchAgent", input]),
    },
  };

  const summary = await registerPackagedAssets(ctx);
  const names = commands.map((c) => c.name);

  assert.ok(names.includes("memory-status"));
  assert.ok(!names.includes("consolidate"), "existing user command must win");
  assert.ok(created.some(([id]) => id === "palace-guide"));
  assert.ok(!created.some(([id]) => id === "dreamer"), "existing user agent must win");
  assert.equal(summary.commands, names.length);

  const palaceTour = commands.find((c) => c.name === "palace-tour");
  await palaceTour.execute({ sessionID: "s1", prompt: { text: "" }, delivery: "queue" });
  assert.deepEqual(calls[0], ["switchAgent", { sessionID: "s1", agent: "palace-guide" }]);
  assert.equal(calls[1][0], "prompt");
  assert.equal(calls[1][1].sessionID, "s1");
  assert.equal(calls[1][1].delivery, "queue");
});

test("registerInstructions appends instruction text to the system prompt on every context event", async () => {
  const dir = mkdtempSync(join(tmpdir(), "es-instr-"));
  try {
    const a = join(dir, "a.md");
    writeFileSync(a, "  Rule A  \n");
    let hook;
    const count = await registerInstructions(
      { session: { hook: async (name, cb) => { assert.equal(name, "context"); hook = cb; } } },
      [a, join(dir, "missing.md")],
    );
    assert.equal(count, 2);
    const event = { system: [{ type: "text", text: "base" }] };
    hook(event);
    hook({ system: [] });
    assert.deepEqual(event.system, [{ type: "text", text: "base" }, { type: "text", text: "Rule A" }]);
    assert.equal(readInstructionText([join(dir, "missing.md")]), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("registerInstructions registers nothing when no instruction text exists", async () => {
  let registered = false;
  const count = await registerInstructions({ session: { hook: async () => { registered = true; } } }, []);
  assert.equal(count, 0);
  assert.equal(registered, false);
});

test("registerPermissionDefaults tightens unruled allows and never overrides explicit rules", async () => {
  const agents = {
    build: { permissions: [{ action: "*", resource: "*", effect: "allow" }] },
    trusted: { data: { permissions: [{ action: "es_delete_drawers", resource: "*", effect: "allow" }] } },
  };
  let hook;
  await registerPermissionDefaults(
    {
      agent: { get: async ({ agentID }) => agents[agentID] },
      permission: { hook: async (name, cb) => { assert.equal(name, "evaluate"); hook = cb; } },
    },
    { es_delete_drawers: "ask", bogus: "maybe" },
  );

  const evaluate = async (event) => { await hook(event); return event.effect; };
  assert.equal(await evaluate({ agent: "build", action: "es_delete_drawers", effect: "allow" }), "ask");
  assert.equal(await evaluate({ agent: "trusted", action: "es_delete_drawers", effect: "allow" }), "allow");
  assert.equal(await evaluate({ agent: "build", action: "es_delete_drawers", effect: "deny" }), "deny");
  assert.equal(await evaluate({ agent: "build", action: "read", effect: "allow" }), "allow");
  assert.equal(await evaluate({ action: "es_delete_drawers", effect: "allow" }), "ask");
});

test("loadPackagedSkills reads each skills/<id>/SKILL.md with its frontmatter", () => {
  const skills = loadPackagedSkills();
  const eshepherd = skills.find((skill) => skill.id === "eshepherd");
  assert.ok(eshepherd, "the bundled eshepherd skill is found");
  assert.equal(eshepherd.name, "eshepherd");
  assert.match(eshepherd.description, /MemPalace/);
  assert.ok(eshepherd.path.endsWith("skills/eshepherd/SKILL.md"));
  assert.ok(!eshepherd.content.startsWith("---"), "frontmatter is stripped from the content");
});

test("registerPackagedSkills adds bundled skills unless an earlier registration owns the id", async () => {
  const registry = new Map([["mine", { id: "mine", path: "/user/mine/SKILL.md" }]]);
  const offered = await registerPackagedSkills(
    { skill: { transform: async (cb) => cb({ get: (id) => registry.get(id), add: (skill) => registry.set(skill.id, skill) }) } },
    [
      { id: "mine", name: "mine", path: "/bundled/mine/SKILL.md", content: "x" },
      { id: "bundled", name: "bundled", path: "/bundled/bundled/SKILL.md", content: "y" },
    ],
  );
  assert.equal(registry.get("mine").path, "/user/mine/SKILL.md");
  assert.equal(registry.get("bundled").path, "/bundled/bundled/SKILL.md");
  assert.deepEqual(offered, ["mine", "bundled"]);
});
