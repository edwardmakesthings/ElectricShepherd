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
