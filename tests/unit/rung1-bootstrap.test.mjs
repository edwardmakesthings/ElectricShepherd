import assert from "node:assert/strict";
import test from "node:test";

import { createMemgraphClient } from "../../adapter/memgraph.ts";
import { MCPHttpClient, SubstrateError } from "../../adapter/mcp-http-client.ts";
import { runConcernProposal } from "../../tools/propose_concerns.ts";

/**
 * Rung 1 bootstrap — unit slice (spec §6.1).
 *
 * The integration atoms (write drawer + read verbatim, add KG fact + query back)
 * live in tests/integration/rung1-bootstrap.test.mjs against a live MemPalace in an
 * isolated fixture room. This file covers the parts that must hold WITHOUT a live
 * endpoint, deterministically:
 *
 *   1. dry-run mutating tools write nothing — `runConcernProposal` (the
 *      approval-gated KG writer) makes zero kg_add/add_drawer/update calls on
 *      dry_run, and its apply path writes exactly the approved edges;
 *   2. `-32005` surfaces as a named `stale-library` failure — both at the raw
 *      transport (`callToolResult`) and through the memgraph client boundary
 *      (named error, never an empty result);
 *   3. transport failure surfaces as a named `transport` failure — same two layers.
 *
 * Failure taxonomy per spec §4.1: failures are distinguishable from empty results;
 * nothing here may collapse an error into `{}`.
 */

// ── 1. Dry-run mutating tool writes nothing ───────────────────────────────────

function makeConcernFake({ failKgAdd = false } = {}) {
  const calls = [];
  const call = async (name, payload) => {
    calls.push({ name, args: payload || {} });
    if (name === "kg_query") {
      // Subject has synthesized-from lineage; target is stamped es-source-type: doc.
      if (payload?.predicate === "synthesized-from" && payload?.entity === "closet-synth") {
        return { facts: [{ current: true, subject: "closet-synth", predicate: "synthesized-from", object: "drawer-src-1" }] };
      }
      if (payload?.predicate === "es-source-type" && payload?.entity === "doc-a") {
        return { facts: [{ current: true, subject: "doc-a", predicate: "es-source-type", object: "doc" }] };
      }
      return { facts: [] };
    }
    if (name === "get_drawer") {
      return { drawer_id: payload?.drawer_id, desc: "a doc drawer" };
    }
    if (name === "kg_add") {
      if (failKgAdd) throw new Error("kg_add exploded");
      return {};
    }
    return {};
  };
  return { call, calls };
}

test("rung1: dry-run propose_concerns writes nothing (no kg_add / no drawer writes)", async () => {
  const { call, calls } = makeConcernFake();

  const report = await runConcernProposal({
    call,
    synthesisId: "closet-synth",
    docIds: ["doc-a"],
    dryRun: true,
  });

  assert.equal(report.ok, true);
  assert.equal(report.dry_run, true);
  assert.equal(report.edges[0].status, "proposed");
  assert.equal(report.counts.proposed, 1);
  // The preview payload was assembled from reads only.
  const writes = calls.filter((c) => ["kg_add", "add_drawer", "update_drawer", "delete_drawer"].includes(c.name));
  assert.equal(writes.length, 0, `dry-run produced write calls: ${JSON.stringify(writes)}`);
});

test("rung1: apply propose_concerns writes exactly the approved concerns edge", async () => {
  const { call, calls } = makeConcernFake();

  const report = await runConcernProposal({
    call,
    synthesisId: "closet-synth",
    docIds: ["doc-a"],
    dryRun: false,
  });

  assert.equal(report.ok, true);
  assert.equal(report.dry_run, false);
  assert.equal(report.edges[0].status, "added");
  const kgAdds = calls.filter((c) => c.name === "kg_add");
  assert.equal(kgAdds.length, 1);
  assert.deepEqual(kgAdds[0].args, {
    subject: "closet-synth",
    predicate: "concerns",
    object: "doc-a",
    source_closet: "closet-synth",
  });
});

// ── 2. -32005 surfaces as a named stale-library failure ───────────────────────

function withFetch(fn) {
  const original = globalThis.fetch;
  globalThis.fetch = fn;
  return () => {
    globalThis.fetch = original;
  };
}

const jsonRpcResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

test("rung1: MCPHttpClient surfaces -32005 as kind=stale-library (callToolResult)", async () => {
  const restore = withFetch(async () =>
    jsonRpcResponse({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32005, message: "Server library is stale; restart required" },
    })
  );

  try {
    const client = new MCPHttpClient("https://example.test/mcp", {}, { maxRetries: 0 });
    const result = await client.callToolResult("mempalace_get_height", { node_id: "node-1" });

    assert.equal(result.ok, false);
    assert.equal(result.kind, "stale-library");
    assert.match(result.detail, /-32005|stale/i);
  } finally {
    restore();
  }
});

test("rung1: MCPHttpClient.callTool throws SubstrateError(kind=stale-library) on -32005", async () => {
  const restore = withFetch(async () =>
    jsonRpcResponse({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32005, message: "Server library is stale; restart required" },
    })
  );

  try {
    const client = new MCPHttpClient("https://example.test/mcp", {}, { maxRetries: 0 });
    await assert.rejects(
      () => client.callTool("mempalace_get_height", { node_id: "node-1" }),
      (err) => {
        assert.ok(err instanceof SubstrateError, `expected SubstrateError, got ${err?.constructor?.name}`);
        assert.equal(err.kind, "stale-library");
        return true;
      }
    );
  } finally {
    restore();
  }
});

test("rung1: memgraph client surfaces -32005 as a named error, never an empty result", async () => {
  // The real transport (mcp.callToolResult) returns SubstrateResult{ok:false,
  // kind:"stale-library"} for -32005; the memgraph boundary must turn that into
  // a named throw — not an empty `{}`.
  const client = createMemgraphClient({
    callTool: async () => ({
      ok: false,
      kind: "stale-library",
      detail: "Tool call failed (mempalace_get_height): Server library is stale; restart required (-32005)",
    }),
  });

  await assert.rejects(
    () => client.getHeight("node-1"),
    (err) => {
      assert.equal(err instanceof Error, true);
      assert.match(err.message, /stale-library/);
      assert.match(err.message, /32005|stale/i);
      return true;
    }
  );
});

// ── 3. Transport failure surfaces as a named transport failure ────────────────

test("rung1: MCPHttpClient surfaces network failure as kind=transport (callToolResult)", async () => {
  const restore = withFetch(async () => {
    throw new TypeError("fetch failed");
  });

  try {
    // maxRetries: 0 keeps the test deterministic (no backoff sleep, single attempt).
    const client = new MCPHttpClient("https://unreachable.test/mcp", {}, { maxRetries: 0 });
    const result = await client.callToolResult("mempalace_get_height", { node_id: "node-1" });

    assert.equal(result.ok, false);
    assert.equal(result.kind, "transport");
    assert.match(result.detail, /fetch failed|network/i);
  } finally {
    restore();
  }
});

test("rung1: MCPHttpClient surfaces HTTP 500 as a named protocol failure (not transport)", async () => {
  const restore = withFetch(async () => jsonRpcResponse({ error: "boom" }, 500));

  try {
    const client = new MCPHttpClient("https://example.test/mcp", {}, { maxRetries: 0 });
    const result = await client.callToolResult("mempalace_get_height", { node_id: "node-1" });

    assert.equal(result.ok, false);
    assert.equal(result.kind, "protocol");
    assert.match(result.detail, /MCP HTTP 500/);
  } finally {
    restore();
  }
});

test("rung1: memgraph client surfaces transport failure as a named error", async () => {
  // The real transport classifies network failures (TypeError / "fetch failed")
  // as kind:"transport"; the memgraph boundary must name that kind in the throw.
  const client = createMemgraphClient({
    callTool: async () => ({
      ok: false,
      kind: "transport",
      detail: "Tool call failed (mempalace_get_height): fetch failed",
    }),
  });

  await assert.rejects(
    () => client.getHeight("node-1"),
    (err) => {
      assert.equal(err instanceof Error, true);
      assert.match(err.message, /transport/);
      return true;
    }
  );
});
