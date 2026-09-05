import assert from "node:assert/strict";
import test from "node:test";

import { MemgraphClient } from "../../src/core/memgraph.ts";

/**
 * Phase 9 (unified memory): rules-out read/write contract on the memgraph client.
 *
 * Pins the negative-knowledge KG axis:
 *   - getRulesOut is one-hop outgoing, splits statements from polarity tokens,
 *     drops expired facts, and degrades to "no rules-out" (never throws) on failure;
 *   - fileDeadEnd files ONE dead end as a synthesis drawer + its rules-out edges
 *     (one per statement, plus the optional polarity token), reports edge counts
 *     honestly, and never aborts the filing when a single edge fails.
 */

function makeClient(overrides = {}) {
  const calls = [];
  return {
    client: new MemgraphClient({
      toolPrefix: "mempalace_",
      callTool: async (name, args) => {
        calls.push({ name, args });
        if (overrides[name]) return overrides[name](args);
        throw new Error(`unexpected tool call: ${name}`);
      },
    }),
    calls,
  };
}

test("getRulesOut returns one-hop outgoing rules-out facts, splitting statements from polarities", async () => {
  const { client } = makeClient({
    mempalace_kg_query: () => ({
      facts: [
        { subject: "n1", predicate: "rules-out", object: "cache_control injection on the openai/ prefix", current: true },
        { subject: "n1", predicate: "rules-out", object: "tried-failed", current: true },
        { subject: "n1", predicate: "rules-out", object: "an expired statement", current: false },
        { subject: "n1", predicate: "synthesized-from", object: "src-1", current: true },
      ],
    }),
  });

  const result = await client.getRulesOut("n1");
  assert.deepEqual(result.statements, ["cache_control injection on the openai/ prefix"]);
  assert.deepEqual(result.polarities, ["tried-failed"]);
  assert.equal(result.count, 2);
});

test("getRulesOut degrades to empty (never throws) when the kg_query call fails", async () => {
  const { client } = makeClient({
    mempalace_kg_query: () => {
      throw new Error("gateway down");
    },
  });

  const result = await client.getRulesOut("n1");
  assert.deepEqual(result, { statements: [], polarities: [], count: 0 });
});

test("getRulesOut is one-hop by design (no recursion)", async () => {
  const { client, calls } = makeClient({ mempalace_kg_query: () => ({ facts: [] }) });
  await client.getRulesOut("n1");
  const kgCall = calls.find((c) => c.name === "mempalace_kg_query");
  assert.ok(kgCall, "kg_query must be called");
  // One-hop: recurse is omitted (the client only sends it when true), and the
  // predicate filter pins the axis. Recursive rules-out would create cycles through
  // unrelated syntheses — never allowed.
  assert.equal(kgCall.args.recurse, undefined, "rules-out must never recurse");
  assert.equal(kgCall.args.predicate, "rules-out");
});

test("fileDeadEnd files one synthesis drawer + one rules-out edge per statement + optional polarity", async () => {
  const { client, calls } = makeClient({
    mempalace_add_drawer: () => ({ success: true, drawer_id: "drawer_new" }),
    mempalace_kg_add: () => ({ success: true }),
  });

  const result = await client.fileDeadEnd({
    wing: "test-wing",
    room: "decisions",
    content: "cache_control injection on the openai/ prefix | outcome: this does not work, LiteLLM strips the marker | because: \"marker removed\" | polarity: tried-failed",
    statements: ["cache_control injection on the openai/ prefix"],
    polarity: "tried-failed",
    source_drawer_ids: ["raw-1"],
  });

  assert.equal(result.success, true);
  assert.equal(result.node_id, "drawer_new");
  // One edge per statement + one polarity token.
  assert.equal(result.rules_out_edges_added, 2);

  const rulesOutAdds = calls.filter((c) => c.name === "mempalace_kg_add" && c.args.predicate === "rules-out");
  assert.equal(rulesOutAdds.length, 2);
  assert.deepEqual(
    rulesOutAdds.map((c) => c.args.object).sort(),
    ["cache_control injection on the openai/ prefix", "tried-failed"],
  );
  for (const add of rulesOutAdds) {
    assert.equal(add.args.subject, "drawer_new");
  }
});

test("fileDeadEnd reports failure when no statements are given (no drawer filed)", async () => {
  const { client, calls } = makeClient({
    mempalace_add_drawer: () => ({ success: true, drawer_id: "drawer_new" }),
  });

  const result = await client.fileDeadEnd({
    wing: "test-wing",
    room: "decisions",
    content: "anything",
    statements: [],
  });

  assert.equal(result.success, false);
  assert.equal(result.rules_out_edges_added, 0);
  // No drawer must be created for a dead end without its ruled-out statement.
  assert.ok(!calls.some((c) => c.name === "mempalace_add_drawer"), "no statements -> no drawer");
});

test("fileDeadEnd is best-effort per edge: one failed edge does not abort the filing", async () => {
  let rulesOutAddCount = 0;
  const { client } = makeClient({
    mempalace_add_drawer: () => ({ success: true, drawer_id: "drawer_new" }),
    mempalace_kg_add: (args) => {
      if (args.predicate === "rules-out") {
        rulesOutAddCount += 1;
        if (rulesOutAddCount === 1) throw new Error("first edge failed");
      }
      return { success: true };
    },
  });

  const result = await client.fileDeadEnd({
    wing: "test-wing",
    room: "decisions",
    content: "content",
    statements: ["statement A", "statement B"],
    polarity: "tried-failed",
    source_drawer_ids: ["raw-1"],
  });

  // The drawer was still filed; the failed edge is reported, not swallowed.
  assert.equal(result.node_id, "drawer_new");
  assert.equal(result.rules_out_edges_added, 2); // 3 attempted, 1 failed
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /first edge failed/);
  assert.equal(result.success, false);
});
