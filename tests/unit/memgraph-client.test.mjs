import assert from "node:assert/strict";
import test from "node:test";

import { createMemgraphClient } from "../../adapter/memgraph.ts";

test("memgraph client uses default tool prefix", async () => {
  const calls = [];
  const client = createMemgraphClient({
    callTool: async (name, args) => {
      calls.push({ name, args });
      return {};
    },
  });

  await client.search("hello", 3, "wing-a", "room-a");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "mempalace_search");
  assert.deepEqual(calls[0].args, {
    query: "hello",
    limit: 3,
    wing: "wing-a",
    room: "room-a",
  });
});

test("memgraph client uses namespaced prefix override", async () => {
  const calls = [];
  const client = createMemgraphClient({
    toolPrefix: "gateway_mempalace_",
    callTool: async (name, args) => {
      calls.push({ name, args });
      return {};
    },
  });

  await client.getHeight("node-123");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "gateway_mempalace_get_height");
  assert.deepEqual(calls[0].args, { node_id: "node-123" });
});

test("memgraph client per-tool override wins over prefix", async () => {
  const calls = [];
  const client = createMemgraphClient({
    toolPrefix: "gateway_mempalace_",
    toolMap: {
      resolveCanonical: "custom_resolve_canonical",
    },
    callTool: async (name, args) => {
      calls.push({ name, args });
      return {};
    },
  });

  await client.resolveCanonical("node-abc", 12);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "custom_resolve_canonical");
  assert.deepEqual(calls[0].args, { node_id: "node-abc", max_hops: 12 });
});

test("listSourceDrawersByScope collapses chunk families and preserves family ids", async () => {
  const calls = [];
  const client = createMemgraphClient({
    callTool: async (name, args) => {
      calls.push({ name, args });
      if (name.endsWith("list_drawers")) {
        return {
          drawers: [
            {
              drawer_id: "drawer-root",
              room: "source-transcripts",
              source_file: "session.json",
            },
            {
              drawer_id: "drawer-chunk-1",
              room: "source-transcripts",
              source_file: "session2.json#chunk-001-of-003",
            },
            {
              drawer_id: "drawer-chunk-2",
              room: "source-transcripts",
              source_file: "session2.json#chunk-002-of-003",
            },
          ],
        };
      }
      if (name.endsWith("kg_query")) {
        return { facts: [] };
      }
      return {};
    },
  });

  const worklist = await client.listSourceDrawersByScope({ wing: "opencode", room: "source-transcripts", limit: 10 });
  const byId = new Map(worklist.map((item) => [item.drawer_id, item]));

  assert.equal(worklist.length, 2);
  assert.deepEqual(byId.get("drawer-root")?.family_drawer_ids, ["drawer-root"]);

  const family = byId.get("drawer-chunk-1")?.family_drawer_ids || byId.get("drawer-chunk-2")?.family_drawer_ids || [];
  assert.equal(family.length, 2);
  assert.ok(family.includes("drawer-chunk-1"));
  assert.ok(family.includes("drawer-chunk-2"));
});

test("kg_query uses server-side predicate filtering and traversal when supported", async () => {
  const seen = [];
  const client = createMemgraphClient({
    callTool: async (name, args) => {
      if (name.endsWith("kg_query")) seen.push(args || {});
      return { facts: [] };
    },
  });

  await client.getLineageSources("closet-1", 7);

  assert.equal(seen.length, 1);
  assert.equal(seen[0].predicate, "synthesized-from");
  assert.equal(seen[0].recurse, true);
  assert.equal(seen[0].max_depth, 7);
});

test("kg_query degrades to a single-hop client-side filter on -32602, and stops retrying", async () => {
  const seen = [];
  const client = createMemgraphClient({
    callTool: async (name, args) => {
      if (!name.endsWith("kg_query")) return { facts: [] };
      seen.push(args || {});
      // Pre-179c613 servers reject the traversal parameters outright.
      if ("predicate" in args || "recurse" in args || "max_depth" in args) {
        throw new Error("MCP error -32602: Unknown parameters: predicate, recurse, max_depth");
      }
      return {
        facts: [
          { current: true, subject: "closet-1", predicate: "in-hall", object: "hall-x" },
          { current: true, subject: "closet-1", predicate: "synthesized-from", object: "drawer-1" },
        ],
      };
    },
  });

  const first = await client.getLineageSources("closet-1", 7);
  // Rejected traversal call, then the legacy retry.
  assert.equal(seen.length, 2);
  // The unrelated in-hall fact is dropped by the client-side filter.
  assert.deepEqual(first.ancestors, [{ node_id: "drawer-1" }]);

  // The unsupported-server verdict is cached: no second wasted round trip.
  await client.getLineageSources("closet-2", 7);
  assert.equal(seen.length, 3);
  for (const args of seen.slice(1)) {
    assert.equal("predicate" in args, false);
    assert.equal("recurse" in args, false);
    assert.equal("max_depth" in args, false);
  }
});

test("isSourceDrawerConsolidated returns true when outgoing consolidated-into exists", async () => {
  const client = createMemgraphClient({
    callTool: async (name, args) => {
      if (name.endsWith("kg_query") && args?.direction === "outgoing") {
        return {
          facts: [
            { current: true, subject: "drawer-1", predicate: "in-hall", object: "hall-x" },
            { current: true, subject: "drawer-1", predicate: "consolidated-into", object: "closet-1" },
          ],
        };
      }
      return { facts: [] };
    },
  });

  const consolidated = await client.isSourceDrawerConsolidated("drawer-1");
  assert.equal(consolidated, true);
});

test("isSourceDrawerConsolidated ignores outgoing facts with other predicates", async () => {
  const client = createMemgraphClient({
    callTool: async () => ({
      facts: [{ current: true, subject: "drawer-3", predicate: "in-hall", object: "hall-x" }],
    }),
  });

  assert.equal(await client.isSourceDrawerConsolidated("drawer-3"), false);
});

test("isSourceDrawerConsolidated falls back to incoming synthesized-from", async () => {
  const client = createMemgraphClient({
    callTool: async (name, args) => {
      if (name.endsWith("kg_query") && args?.direction === "incoming") {
        return { facts: [{ current: true, subject: "closet-legacy", predicate: "synthesized-from", object: "drawer-2" }] };
      }
      return { facts: [] };
    },
  });

  const consolidated = await client.isSourceDrawerConsolidated("drawer-2");
  assert.equal(consolidated, true);
});


test("listSourceDrawersByScope paginates list_drawers calls", async () => {
  const calls = [];
  const client = createMemgraphClient({
    callTool: async (name, args) => {
      calls.push({ name, args });
      if (name.endsWith("list_drawers")) {
        const offset = Number(args?.offset || 0);
        if (offset === 0) {
          return {
            drawers: [
              { drawer_id: "drawer-1", room: "source-transcripts", source_file: "a.json" },
              { drawer_id: "drawer-2", room: "source-transcripts", source_file: "b.json" },
            ],
          };
        }
        if (offset === 2) {
          return {
            drawers: [
              { drawer_id: "drawer-3", room: "source-transcripts", source_file: "c.json" },
            ],
          };
        }
        return { drawers: [] };
      }
      if (name.endsWith("kg_query")) {
        return { facts: [] };
      }
      return {};
    },
  });

  const worklist = await client.listSourceDrawersByScope({
    wing: "opencode",
    room: "source-transcripts",
    limit: 3,
    pageSize: 2,
  });

  assert.equal(worklist.length, 3);

  const listCalls = calls.filter((call) => call.name.endsWith("list_drawers"));
  assert.equal(listCalls.length, 2);
  assert.deepEqual(listCalls.map((call) => call.args.offset), [0, 2]);
  assert.deepEqual(listCalls.map((call) => call.args.limit), [2, 1]);
});

// ── Phase 1: es-source-type axis (orthogonal to es-status) ───────────────────

function makeRecordingClient(handlers = {}) {
  const calls = [];
  const client = createMemgraphClient({
    callTool: async (name, args) => {
      calls.push({ name, args });
      for (const [suffix, handler] of Object.entries(handlers)) {
        if (name.endsWith(suffix)) return handler(args || {}, calls);
      }
      return {};
    },
  });
  return { client, calls };
}

test("createDerivedDrawer stamps both es-status=provisional and es-source-type=synthesis", async () => {
  const { client, calls } = makeRecordingClient({
    add_drawer: () => ({ drawer_id: "drawer-new" }),
  });

  const result = await client.createDerivedDrawer({
    wing: "w",
    room: "synthesis",
    content: "c",
    source_drawer_ids: ["drawer-a"],
    desc: "d",
  });

  assert.equal(result.success, true);
  assert.equal(result.drawer_id, "drawer-new");

  const kgAdds = calls.filter((call) => call.name.endsWith("kg_add"));
  const statusStamps = kgAdds.filter((call) => call.args.predicate === "es-status");
  const typeStamps = kgAdds.filter((call) => call.args.predicate === "es-source-type");

  assert.equal(statusStamps.length, 1);
  assert.equal(statusStamps[0].args.subject, "drawer-new");
  assert.equal(statusStamps[0].args.object, "provisional");
  assert.equal(statusStamps[0].args.source_closet, "drawer-new");
  assert.equal(typeStamps.length, 1);
  assert.equal(typeStamps[0].args.subject, "drawer-new");
  assert.equal(typeStamps[0].args.object, "synthesis");
  assert.equal(typeStamps[0].args.source_closet, "drawer-new");
});

test("createDerivedDrawer: a failed es-status stamp does not block the es-source-type stamp", async () => {
  const { client, calls } = makeRecordingClient({
    add_drawer: () => ({ drawer_id: "drawer-new" }),
    kg_add: (args) => {
      if (args.predicate === "es-status") throw new Error("kg_add es-status exploded");
      return {};
    },
  });

  const result = await client.createDerivedDrawer({
    wing: "w",
    room: "synthesis",
    content: "c",
    source_drawer_ids: [],
    desc: "d",
  });

  assert.equal(result.success, true);
  const kgAdds = calls.filter((call) => call.name.endsWith("kg_add"));
  // The es-source-type stamp still went out even though es-status failed.
  assert.ok(kgAdds.some((call) => call.args.predicate === "es-source-type" && call.args.object === "synthesis"));
});

test("createDerivedDrawer: a failed es-source-type stamp does not block the es-status stamp", async () => {
  const { client, calls } = makeRecordingClient({
    add_drawer: () => ({ drawer_id: "drawer-new" }),
    kg_add: (args) => {
      if (args.predicate === "es-source-type") throw new Error("kg_add es-source-type exploded");
      return {};
    },
  });

  const result = await client.createDerivedDrawer({
    wing: "w",
    room: "synthesis",
    content: "c",
    source_drawer_ids: [],
    desc: "d",
  });

  assert.equal(result.success, true);
  const kgAdds = calls.filter((call) => call.name.endsWith("kg_add"));
  // The es-status stamp still went out even though es-source-type failed.
  assert.ok(kgAdds.some((call) => call.args.predicate === "es-status" && call.args.object === "provisional"));
});

test("getClosetSourceType reads the stamped value and returns null when unstamped", async () => {
  const { client } = makeRecordingClient({
    kg_query: (args) => {
      if (args.predicate !== "es-source-type") return { facts: [] };
      if (args.entity === "stamped") {
        return { facts: [{ current: true, subject: "stamped", predicate: "es-source-type", object: "transcript" }] };
      }
      return { facts: [] };
    },
  });

  assert.equal(await client.getClosetSourceType("stamped"), "transcript");
  assert.equal(await client.getClosetSourceType("unstamped"), null);
});

test("getClosetSourceType returns null on read failure (never throws)", async () => {
  const { client } = makeRecordingClient({
    kg_query: () => {
      throw new Error("kg_query exploded");
    },
  });

  assert.equal(await client.getClosetSourceType("broken"), null);
});

test("setClosetSourceType invalidates the previous value then adds the new one", async () => {
  const { client, calls } = makeRecordingClient({
    kg_query: (args) => {
      if (args.predicate === "es-source-type") {
        return { facts: [{ current: true, subject: "drawer-1", predicate: "es-source-type", object: "doc" }] };
      }
      return { facts: [] };
    },
  });

  const ok = await client.setClosetSourceType("drawer-1", "synthesis", "run-9");
  assert.equal(ok, true);

  const invalidates = calls.filter((call) => call.name.endsWith("kg_invalidate"));
  assert.equal(invalidates.length, 1);
  assert.deepEqual(invalidates[0].args, { subject: "drawer-1", predicate: "es-source-type", object: "doc" });

  const adds = calls.filter((call) => call.name.endsWith("kg_add"));
  assert.equal(adds.length, 1);
  assert.deepEqual(adds[0].args, {
    subject: "drawer-1",
    predicate: "es-source-type",
    object: "synthesis",
    source_closet: "drawer-1",
    source_run_id: "run-9",
  });
});

test("setClosetSourceType skips invalidation when the value is already current", async () => {
  const { client, calls } = makeRecordingClient({
    kg_query: (args) => {
      if (args.predicate === "es-source-type") {
        return { facts: [{ current: true, subject: "drawer-1", predicate: "es-source-type", object: "transcript" }] };
      }
      return { facts: [] };
    },
  });

  const ok = await client.setClosetSourceType("drawer-1", "transcript");
  assert.equal(ok, true);
  assert.equal(calls.filter((call) => call.name.endsWith("kg_invalidate")).length, 0);
});

test("setClosetSourceType returns false on failure without throwing", async () => {
  const { client } = makeRecordingClient({
    kg_add: () => {
      throw new Error("kg_add exploded");
    },
  });

  assert.equal(await client.setClosetSourceType("drawer-1", "skill"), false);
});

test("es-status and es-source-type are independently settable (no cross-predicate invalidation)", async () => {
  const { client, calls } = makeRecordingClient({
    kg_query: (args) => {
      if (args.predicate === "es-status") {
        return { facts: [{ current: true, subject: "drawer-1", predicate: "es-status", object: "provisional" }] };
      }
      if (args.predicate === "es-source-type") {
        return { facts: [{ current: true, subject: "drawer-1", predicate: "es-source-type", object: "transcript" }] };
      }
      return { facts: [] };
    },
  });

  await client.setClosetStatus("drawer-1", "active");
  await client.setClosetSourceType("drawer-1", "synthesis");

  const invalidates = calls.filter((call) => call.name.endsWith("kg_invalidate"));
  // Each setter only ever invalidates facts on ITS OWN predicate.
  for (const call of invalidates) {
    assert.ok(
      ["es-status", "es-source-type"].includes(call.args.predicate),
      `unexpected invalidate predicate: ${call.args.predicate}`,
    );
  }
  const statusInvalidates = invalidates.filter((call) => call.args.predicate === "es-status");
  const typeInvalidates = invalidates.filter((call) => call.args.predicate === "es-source-type");
  // setClosetStatus("active") invalidated the opposite es-status value.
  assert.equal(statusInvalidates.length, 1);
  assert.equal(statusInvalidates[0].args.object, "provisional");
  // setClosetSourceType invalidated the previous source-type value.
  assert.equal(typeInvalidates.length, 1);
  assert.equal(typeInvalidates[0].args.object, "transcript");

  // The es-status setter never touched an es-source-type fact and vice versa.
  assert.ok(!invalidates.some((call) => call.args.predicate === "es-status" && call.args.object !== "provisional"));
  assert.ok(!invalidates.some((call) => call.args.predicate === "es-source-type" && call.args.object !== "transcript"));
});

test("setClosetStatus never invalidates an es-source-type fact", async () => {
  const { client, calls } = makeRecordingClient({});

  await client.setClosetStatus("drawer-1", "active");

  const invalidates = calls.filter((call) => call.name.endsWith("kg_invalidate"));
  for (const call of invalidates) {
    assert.equal(call.args.predicate, "es-status");
  }
});

test("setClosetSourceType never invalidates an es-status fact", async () => {
  const { client, calls } = makeRecordingClient({
    kg_query: (args) => {
      if (args.predicate === "es-source-type") {
        return { facts: [{ current: true, subject: "drawer-1", predicate: "es-source-type", object: "doc" }] };
      }
      return { facts: [] };
    },
  });

  await client.setClosetSourceType("drawer-1", "transcript");

  const invalidates = calls.filter((call) => call.name.endsWith("kg_invalidate"));
  for (const call of invalidates) {
    assert.equal(call.args.predicate, "es-source-type");
  }
});


// ── Phase 11: es-staleness axis (temporal validity flag) ─────────────────────

test("getStaleness reads the stamped value and returns null when unflagged", async () => {
  const { client } = makeRecordingClient({
    kg_query: (args) => {
      if (args.predicate !== "es-staleness") return { facts: [] };
      if (args.entity === "stamped") {
        return { facts: [{ current: true, subject: "stamped", predicate: "es-staleness", object: "source-changed" }] };
      }
      return { facts: [] };
    },
  });

  assert.equal(await client.getStaleness("stamped"), "source-changed");
  assert.equal(await client.getStaleness("unflagged"), null);
});

test("getStaleness ignores invalidated facts and returns null on read failure (never throws)", async () => {
  const { client } = makeRecordingClient({
    kg_query: (args) => {
      if (args.predicate === "es-staleness") {
        if (args.entity === "retired") {
          return { facts: [{ current: false, subject: "retired", predicate: "es-staleness", object: "source-changed" }] };
        }
        throw new Error("kg_query exploded");
      }
      return { facts: [] };
    },
  });

  assert.equal(await client.getStaleness("retired"), null);
  assert.equal(await client.getStaleness("broken"), null);
});

test("getStalenessFlags returns per-node markers and degrades to null on failure", async () => {
  const { client } = makeRecordingClient({
    kg_query: (args) => {
      if (args.predicate !== "es-staleness") return { facts: [] };
      if (args.entity === "node-a") {
        return { facts: [{ current: true, subject: "node-a", predicate: "es-staleness", object: "source-changed" }] };
      }
      if (args.entity === "node-broken") throw new Error("kg_query exploded");
      return { facts: [] };
    },
  });

  const flags = await client.getStalenessFlags(["node-a", "node-b", "node-broken"]);
  assert.equal(flags.get("node-a"), "source-changed");
  assert.equal(flags.get("node-b"), null);
  assert.equal(flags.get("node-broken"), null);
});

test("setStalenessFlag invalidates the previous es-staleness value then adds the new one", async () => {
  const { client, calls } = makeRecordingClient({
    kg_query: (args) => {
      if (args.predicate === "es-staleness") {
        return { facts: [{ current: true, subject: "drawer-1", predicate: "es-staleness", object: "source-changed" }] };
      }
      return { facts: [] };
    },
  });

  const ok = await client.setStalenessFlag("drawer-1", "basis-drifted", "run-9");
  assert.equal(ok, true);

  const invalidates = calls.filter((call) => call.name.endsWith("kg_invalidate"));
  assert.equal(invalidates.length, 1);
  assert.deepEqual(invalidates[0].args, { subject: "drawer-1", predicate: "es-staleness", object: "source-changed" });

  const adds = calls.filter((call) => call.name.endsWith("kg_add"));
  assert.equal(adds.length, 1);
  assert.deepEqual(adds[0].args, {
    subject: "drawer-1",
    predicate: "es-staleness",
    object: "basis-drifted",
    source_closet: "drawer-1",
    source_run_id: "run-9",
  });
});

test("setStalenessFlag skips invalidation and duplicate add when the value is already current", async () => {
  const { client, calls } = makeRecordingClient({
    kg_query: (args) => {
      if (args.predicate === "es-staleness") {
        return { facts: [{ current: true, subject: "drawer-1", predicate: "es-staleness", object: "source-changed" }] };
      }
      return { facts: [] };
    },
  });

  const ok = await client.setStalenessFlag("drawer-1", "source-changed");
  assert.equal(ok, true);
  // Idempotent re-set: no invalidation, no duplicate kg_add.
  assert.equal(calls.filter((call) => call.name.endsWith("kg_invalidate")).length, 0);
  assert.equal(calls.filter((call) => call.name.endsWith("kg_add")).length, 0);
});

test("setStalenessFlag never invalidates es-status or es-source-type facts", async () => {
  const { client, calls } = makeRecordingClient({
    kg_query: (args) => {
      if (args.predicate === "es-staleness") {
        return { facts: [{ current: true, subject: "drawer-1", predicate: "es-staleness", object: "source-changed" }] };
      }
      if (args.predicate === "es-status") {
        return { facts: [{ current: true, subject: "drawer-1", predicate: "es-status", object: "provisional" }] };
      }
      if (args.predicate === "es-source-type") {
        return { facts: [{ current: true, subject: "drawer-1", predicate: "es-source-type", object: "synthesis" }] };
      }
      return { facts: [] };
    },
  });

  await client.setStalenessFlag("drawer-1", "basis-drifted");

  const invalidates = calls.filter((call) => call.name.endsWith("kg_invalidate"));
  // Every invalidate is scoped to the es-staleness predicate only.
  for (const call of invalidates) {
    assert.equal(call.args.predicate, "es-staleness");
  }
  assert.ok(!invalidates.some((call) => call.args.predicate === "es-status"));
  assert.ok(!invalidates.some((call) => call.args.predicate === "es-source-type"));
});

test("es-staleness is independently settable alongside es-status and es-source-type (no cross-predicate invalidation)", async () => {
  const { client, calls } = makeRecordingClient({
    kg_query: (args) => {
      if (args.predicate === "es-status") {
        return { facts: [{ current: true, subject: "drawer-1", predicate: "es-status", object: "provisional" }] };
      }
      if (args.predicate === "es-source-type") {
        return { facts: [{ current: true, subject: "drawer-1", predicate: "es-source-type", object: "transcript" }] };
      }
      if (args.predicate === "es-staleness") {
        return { facts: [{ current: true, subject: "drawer-1", predicate: "es-staleness", object: "source-changed" }] };
      }
      return { facts: [] };
    },
  });

  await client.setClosetStatus("drawer-1", "active");
  await client.setClosetSourceType("drawer-1", "synthesis");
  await client.setStalenessFlag("drawer-1", "basis-drifted");

  const invalidates = calls.filter((call) => call.name.endsWith("kg_invalidate"));
  // Each setter only ever invalidates facts on ITS OWN predicate.
  for (const call of invalidates) {
    assert.ok(
      ["es-status", "es-source-type", "es-staleness"].includes(call.args.predicate),
      `unexpected invalidate predicate: ${call.args.predicate}`,
    );
  }
  const statusInvalidates = invalidates.filter((call) => call.args.predicate === "es-status");
  const typeInvalidates = invalidates.filter((call) => call.args.predicate === "es-source-type");
  const stalenessInvalidates = invalidates.filter((call) => call.args.predicate === "es-staleness");
  assert.equal(statusInvalidates.length, 1);
  assert.equal(statusInvalidates[0].args.object, "provisional");
  assert.equal(typeInvalidates.length, 1);
  assert.equal(typeInvalidates[0].args.object, "transcript");
  assert.equal(stalenessInvalidates.length, 1);
  assert.equal(stalenessInvalidates[0].args.object, "source-changed");

  // No setter touched another axis's facts.
  assert.ok(!invalidates.some((call) => call.args.predicate === "es-status" && call.args.object !== "provisional"));
  assert.ok(!invalidates.some((call) => call.args.predicate === "es-source-type" && call.args.object !== "transcript"));
  assert.ok(!invalidates.some((call) => call.args.predicate === "es-staleness" && call.args.object !== "source-changed"));
});

test("setStalenessFlag returns false on failure without throwing", async () => {
  const { client } = makeRecordingClient({
    kg_add: () => {
      throw new Error("kg_add exploded");
    },
  });

  assert.equal(await client.setStalenessFlag("drawer-1", "source-changed"), false);
});

test("setStalenessFlag returns false for an empty node id without any writes", async () => {
  const { client, calls } = makeRecordingClient({});

  assert.equal(await client.setStalenessFlag("   ", "source-changed"), false);
  assert.equal(calls.length, 0);
});
