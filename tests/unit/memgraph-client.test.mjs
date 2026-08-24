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

test("isSourceDrawerConsolidated returns true when outgoing consolidated-into exists", async () => {
  const client = createMemgraphClient({
    callTool: async (name, args) => {
      if (name.endsWith("kg_query") && args?.predicate === "consolidated-into") {
        return { facts: [{ current: true, subject: "drawer-1", predicate: "consolidated-into", object: "closet-1" }] };
      }
      if (name.endsWith("kg_query") && args?.predicate === "synthesized-from") {
        return { facts: [] };
      }
      return {};
    },
  });

  const consolidated = await client.isSourceDrawerConsolidated("drawer-1");
  assert.equal(consolidated, true);
});

test("isSourceDrawerConsolidated falls back to incoming synthesized-from", async () => {
  const client = createMemgraphClient({
    callTool: async (name, args) => {
      if (name.endsWith("kg_query") && args?.predicate === "consolidated-into") {
        return { facts: [] };
      }
      if (name.endsWith("kg_query") && args?.predicate === "synthesized-from" && args?.direction === "incoming") {
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