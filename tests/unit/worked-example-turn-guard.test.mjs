import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { TurnGuard } = await import("../../plugin/turn-guard.ts");

// Import smoke: plugin module must load (P0-6 acceptance).
test("plugin/turn-guard.ts imports successfully", async () => {
  const mod = await import("../../plugin/turn-guard.ts");
  assert.ok(mod && typeof mod.TurnGuard === "function");
});

function makeTempProjectDir() {
  const dir = mkdtempSync(join(tmpdir(), "es-turn-guard-test-"));
  writeFileSync(join(dir, "package.json"), "{}\n", "utf8");
  return dir;
}

function restoreEnv(snapshot) {
  for (const [k, v] of Object.entries(snapshot)) {
    if (typeof v === "undefined") {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
}

function getHeader(headers, name) {
  if (!headers) return "";
  if (typeof headers.get === "function") return String(headers.get(name) || "");
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (String(k).toLowerCase() === target) return String(v);
  }
  return "";
}

// The real Phase 13 functions (single source of truth for cap + floor).
const {
  retrieveSimilarWorkedExamples,
  formatWorkedExampleDemonstration,
  WORKED_EXAMPLE_MAX_INJECT,
  WORKED_EXAMPLE_RELEVANCE_FLOOR,
} = await import("../../adapter/retrieval-expansion.ts");

const { shouldInjectWorkedExamples } = await import("../../adapter/turn-guard-helpers.ts");

const QUERY =
  "fix the retry loop in the gateway adapter where the websocket reconnect handler keeps spawning duplicate connections";
const EXAMPLE_A_TEXT =
  "Solved the retry loop in the gateway adapter: the websocket reconnect handler was spawning duplicate connections because the backoff timer was never cleared.";
const EXAMPLE_B_TEXT =
  "Gateway adapter websocket fix: clear the reconnect timer before spawning a new connection to avoid duplicates in the retry loop.";

function makeSearchClient(rows) {
  return {
    search: async (_q, _limit, _wing, room) => {
      assert.equal(room, "apprenticeship");
      return { results: rows };
    },
    getDrawer: async () => ({}),
  };
}

test("shouldInjectWorkedExamples gates on implement-local, non-empty prompt, and idempotent heading check", () => {
  const heading = "## Demonstrations: how this class of problem was solved in this codebase before";
  assert.equal(
    shouldInjectWorkedExamples({ enabled: true, subagentType: "implement-local", prompt: QUERY, heading }).shouldInject,
    true,
  );
  for (const subagentType of ["explore", "review-diff", "run-tests", "solve-deep-cloud", ""]) {
    const decision = shouldInjectWorkedExamples({ enabled: true, subagentType, prompt: QUERY, heading });
    assert.equal(decision.shouldInject, false, `${subagentType || "(empty)"} must not trigger injection`);
  }
  assert.equal(
    shouldInjectWorkedExamples({ enabled: true, subagentType: "implement-local", prompt: `${QUERY}\n${heading}`, heading })
      .shouldInject,
    false,
    "already-augmented prompt must not be re-injected",
  );
});

test("implement-local call with matching examples over floor gets a delimited demonstration section", async () => {
  const client = makeSearchClient([
    { drawer_id: "ex-a", content: EXAMPLE_A_TEXT },
    { drawer_id: "ex-b", content: EXAMPLE_B_TEXT },
  ]);
  const examples = await retrieveSimilarWorkedExamples(client, {
    query: QUERY,
    limit: WORKED_EXAMPLE_MAX_INJECT,
    relevanceFloor: WORKED_EXAMPLE_RELEVANCE_FLOOR,
  });
  const demonstration = formatWorkedExampleDemonstration(examples);

  assert.ok(demonstration.length > 0, "demonstration must be non-empty when examples qualify");
  const augmented = `${QUERY}${demonstration}`;
  assert.ok(augmented.startsWith(QUERY), "original prompt must be preserved verbatim at the front");
  assert.ok(augmented.includes("## Demonstrations:"), "delimited demonstration section present");
  assert.ok(augmented.includes("### Example 1"), "example headers present");
});

test("implement-local call with no examples over floor injects nothing (prompt unchanged)", async () => {
  const client = makeSearchClient([
    { drawer_id: "ex-weak", content: "Unrelated database migration note about schema versioning and index rebuilds." },
  ]);
  const examples = await retrieveSimilarWorkedExamples(client, {
    query: QUERY,
    limit: WORKED_EXAMPLE_MAX_INJECT,
    relevanceFloor: WORKED_EXAMPLE_RELEVANCE_FLOOR,
  });
  const demonstration = formatWorkedExampleDemonstration(examples);

  assert.deepEqual(examples, [], "no examples above floor");
  assert.equal(demonstration, "", "format returns '' for empty input -> prompt unchanged");
});

test("at most WORKED_EXAMPLE_MAX_INJECT (=2) examples are injected", async () => {
  const manyRows = Array.from({ length: 5 }, (_, i) => ({
    drawer_id: `ex-${String.fromCharCode(97 + i)}`,
    content: EXAMPLE_A_TEXT,
  }));
  const client = makeSearchClient(manyRows);
  const examples = await retrieveSimilarWorkedExamples(client, {
    query: QUERY,
    limit: WORKED_EXAMPLE_MAX_INJECT,
    relevanceFloor: WORKED_EXAMPLE_RELEVANCE_FLOOR,
  });

  assert.equal(WORKED_EXAMPLE_MAX_INJECT, 2);
  assert.equal(examples.length, 2, "hard cap of 2 enforced");
});

test("TurnGuard CREATE wiring: onSessionIdle records capability tuple for successful routing-tier task output", async () => {
  const projectDir = makeTempProjectDir();
  const envKeys = [
    "ESHEPHERD_AUTO_CONSOLIDATION_ENABLED",
    "ESHEPHERD_MEMCORE_REINJECT_ENABLED",
    "MEMPALACE_MCP_BEARER_TOKEN",
  ];
  const envSnapshot = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
  const originalFetch = globalThis.fetch;
  const kgAdds = [];

  globalThis.fetch = async (_input, init) => {
    const payload = JSON.parse(String(init?.body || "{}"));
    if (payload.method === "initialize" || payload.method === "notifications/initialized") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Mcp-Session-Id": "test-session" },
      });
    }
    if (payload.method === "tools/call") {
      if (payload?.params?.name === "mempalace_kg_add") {
        kgAdds.push(payload?.params?.arguments || {});
      }
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id,
          result: { content: [{ type: "text", text: "{}" }] },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  process.env.ESHEPHERD_AUTO_CONSOLIDATION_ENABLED = "false";
  process.env.ESHEPHERD_MEMCORE_REINJECT_ENABLED = "false";

  const client = {
    session: {
      messages: async () => ({
        data: [
          {
            info: { role: "user", time: { created: 1 } },
            parts: [{ type: "text", text: "run this" }],
          },
          {
            info: { role: "assistant", time: { created: 2 } },
            parts: [
              {
                type: "tool",
                tool: "task",
                state: {
                  status: "success",
                  input: {
                    subagent_type: "implement-local",
                    description: "Fix retry bug",
                    prompt: "Fix the retry loop in gateway.ts",
                  },
                  output: "Completed fix with coverage and verified behavior in tests.",
                },
              },
            ],
          },
        ],
      }),
      prompt: async () => ({}),
    },
  };

  try {
    const plugin = await TurnGuard({ client, directory: projectDir });
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: "sid-cap" } } });

    const outcomeEdge = kgAdds.find((row) => row.predicate === "es-capability-outcome");
    assert.ok(outcomeEdge, "must write es-capability-outcome on successful implement-local completion");
    assert.equal(outcomeEdge.object, "accept");
    assert.ok(String(outcomeEdge.subject || "").startsWith("capability::"));
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv(envSnapshot);
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("TurnGuard CREATE wiring: loop-block failure records event and persists intervention after confirmation", async () => {
  const projectDir = makeTempProjectDir();
  const envKeys = [
    "ESHEPHERD_AUTO_CONSOLIDATION_ENABLED",
    "ESHEPHERD_MEMCORE_REINJECT_ENABLED",
    "ESHEPHERD_LOOPGUARD_THRESHOLD",
  ];
  const envSnapshot = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
  const originalFetch = globalThis.fetch;
  const kgAdds = [];

  globalThis.fetch = async (_input, init) => {
    const payload = JSON.parse(String(init?.body || "{}"));
    if (payload.method === "initialize" || payload.method === "notifications/initialized") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Mcp-Session-Id": "test-session" },
      });
    }
    if (payload.method === "tools/call") {
      if (payload?.params?.name === "mempalace_kg_add") {
        kgAdds.push(payload?.params?.arguments || {});
      }
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id,
          result: { content: [{ type: "text", text: "{}" }] },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  process.env.ESHEPHERD_AUTO_CONSOLIDATION_ENABLED = "false";
  process.env.ESHEPHERD_MEMCORE_REINJECT_ENABLED = "false";
  process.env.ESHEPHERD_LOOPGUARD_THRESHOLD = "3";

  const prompts = [];
  const client = {
    session: {
      messages: async () => ({ data: [] }),
      prompt: async (req) => {
        prompts.push(req);
        return {};
      },
    },
  };

  try {
    const plugin = await TurnGuard({ client, directory: projectDir });
    const hook = plugin["tool.execute.before"];
    const input = {
      tool: "bash",
      sessionID: "sid-loop",
      model: { providerID: "litellm", modelID: "model-a" },
      args: { command: "npm test" },
    };

    await hook({ ...input }, { args: { ...input.args } });
    await hook({ ...input }, { args: { ...input.args } });

    await assert.rejects(
      () => hook({ ...input }, { args: { ...input.args } }),
      /STOP\. You have called `bash` 3 times with identical arguments/,
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    await hook({ ...input }, { args: { ...input.args } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const failureEvent = kgAdds.find((row) => row.predicate === "es-failure-event" && row.object === "loop");
    assert.ok(failureEvent, "blocked loop must record es-failure-event=loop");

    const interventionText = kgAdds.find((row) => row.predicate === "es-intervention-text");
    assert.ok(interventionText, "confirmed loop-block must persist es-intervention-text");
    assert.ok(String(interventionText.object || "").includes("You are looping"));
    assert.ok(prompts.length >= 1, "loop-block must inject a noReply prompt nudge");
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv(envSnapshot);
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("TurnGuard worked-example injection uses MCP auth header and appends demonstration block", async () => {
  const projectDir = makeTempProjectDir();
  const envKeys = [
    "ESHEPHERD_AUTO_CONSOLIDATION_ENABLED",
    "ESHEPHERD_MEMCORE_REINJECT_ENABLED",
    "MEMPALACE_MCP_BEARER_TOKEN",
  ];
  const envSnapshot = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
  const originalFetch = globalThis.fetch;
  const fetchCalls = [];

  globalThis.fetch = async (_input, init) => {
    const payload = JSON.parse(String(init?.body || "{}"));
    fetchCalls.push({
      method: payload.method,
      tool: payload?.params?.name,
      headers: init?.headers,
    });

    if (payload.method === "initialize" || payload.method === "notifications/initialized") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Mcp-Session-Id": "test-session" },
      });
    }

    if (payload.method === "tools/call") {
      if (payload?.params?.name === "mempalace_search") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: payload.id,
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    results: [
                      {
                        drawer_id: "drawer_worked_example_1",
                        content: "Resolved retry-loop in gateway by resetting stale backoff timers before reconnect.",
                      },
                    ],
                  }),
                },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id,
          result: { content: [{ type: "text", text: "{}" }] },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  process.env.ESHEPHERD_AUTO_CONSOLIDATION_ENABLED = "false";
  process.env.ESHEPHERD_MEMCORE_REINJECT_ENABLED = "false";
  process.env.MEMPALACE_MCP_BEARER_TOKEN = "secret-token";

  const client = {
    session: {
      messages: async () => ({ data: [] }),
      prompt: async () => ({}),
    },
  };

  try {
    const plugin = await TurnGuard({ client, directory: projectDir });
    const hook = plugin["tool.execute.before"];
    const input = {
      tool: "task",
      sessionID: "sid-inject",
      model: { providerID: "litellm", modelID: "model-a" },
      args: {
        subagent_type: "implement-local",
        description: "Fix retry loop",
        prompt: QUERY,
      },
    };
    const output = { args: { ...input.args } };

    await hook(input, output);

    assert.ok(String(output.args.prompt).includes("## Demonstrations:"), "implement-local prompt must receive demonstration block");

    const initCall = fetchCalls.find((call) => call.method === "initialize");
    assert.ok(initCall, "expected MCP initialize call");
    assert.equal(getHeader(initCall.headers, "Authorization"), "Bearer secret-token");
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv(envSnapshot);
    rmSync(projectDir, { recursive: true, force: true });
  }
});
