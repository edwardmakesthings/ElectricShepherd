import assert from "node:assert/strict";
import test from "node:test";

import { createMemgraphClient } from "../../adapter/memgraph.ts";
import { MCPHttpClient, SubstrateError } from "../../adapter/mcp-http-client.ts";
import { runConcernProposal } from "../../tools/propose_concerns.ts";
import { runRefinementProposal } from "../../tools/propose_refinements.ts";
import { runSkillPromotion } from "../../tools/promote_skill.ts";
import { runOutcomeRecord } from "../../tools/record_outcome.ts";
import { runRemind } from "../../tools/remind.ts";

/**
 * Rung 1 bootstrap — unit slice (spec §6.1).
 *
 * The integration atoms (write drawer + read verbatim, add KG fact + query back,
 * resolve canonical id + compute height, bounded room paging) live in
 * tests/integration/rung1-bootstrap.test.mjs against a live MemPalace in an
 * isolated fixture room. This file covers the parts that must hold WITHOUT a live
 * endpoint, deterministically:
 *
 *   1. dry-run mutating tools write nothing — `runConcernProposal`,
 *      `runRefinementProposal`, `runSkillPromotion`, `runOutcomeRecord` and
 *      `runRemind` (the approval-gated writers) each make zero kg_add/add_drawer/
 *      update/delete calls on dry_run; the apply paths write exactly the approved
 *      edges;
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

// ── 4. Broader dry-run mutating coverage: every approval-gated writer writes nothing on dry_run ──
//
// Spec §6.1 requires "dry-run every mutating tool and confirm it writes nothing".
// These four are the remaining approval-gated writers not covered by section 1
// (propose_concerns). Each runs against a fake transport that records every call;
// on dry_run the report must be a read-only preview with ZERO mutating calls.
// Deterministic: fixed timestamps, no network, no timing.

/** Names of substrate tools that mutate palace state — any one of these in a
 *  dry-run call log is a rung violation. */
const WRITE_TOOL_NAMES = ["kg_add", "add_drawer", "update_drawer", "delete_drawer"];

function writeCallsOf(calls) {
  return calls.filter((c) => WRITE_TOOL_NAMES.includes(c.name));
}

/** Generic fake palace: answers the read-only lookups the dry-run paths perform
 *  (get_drawer, kg_query by predicate, get_taxonomy, list_drawers, check_duplicate)
 *  and records every call. `kgFacts` maps `${entity}|${predicate}` -> fact objects. */
function makeFakePalace({ drawers = {}, kgFacts = {}, taxonomy = {}, duplicateOf = null } = {}) {
  const calls = [];
  const call = async (name, payload) => {
    calls.push({ name, args: payload || {} });
    if (name === "get_drawer") {
      const row = drawers[payload?.drawer_id];
      return row ? { ...row } : { error: `no drawer ${payload?.drawer_id}` };
    }
    if (name === "kg_query") {
      const key = `${payload?.entity}|${payload?.predicate}`;
      const facts = kgFacts[key] || [];
      return { facts };
    }
    if (name === "get_taxonomy") return { taxonomy };
    if (name === "list_drawers") return { drawers: [], total: 0 };
    if (name === "check_duplicate") {
      return duplicateOf ? { is_duplicate: true, drawer_id: duplicateOf } : { is_duplicate: false };
    }
    // Any mutating tool reaching here means the dry-run leaked a write — record it
    // and answer benignly so the report still completes for inspection.
    return {};
  };
  return { call, calls };
}

test("rung1: dry-run propose_refinements writes nothing (valid + rejected edges)", async () => {
  const SKILL = "drawer_proj_skills_s1";
  const EVIDENCE_OK = "drawer_sess_transcript_e1";
  const EVIDENCE_MISSING = "drawer_gone_e2";

  const fake = makeFakePalace({
    drawers: {
      [SKILL]: { drawer_id: SKILL, desc: "a skill procedure" },
      [EVIDENCE_OK]: { drawer_id: EVIDENCE_OK, desc: "session transcript that changed the skill" },
    },
    kgFacts: {
      [`${SKILL}|es-source-type`]: [{ subject: SKILL, predicate: "es-source-type", object: "skill", current: true }],
    },
  });

  const report = await runRefinementProposal({
    call: fake.call,
    skillId: SKILL,
    evidenceIds: [EVIDENCE_OK, EVIDENCE_MISSING],
    dryRun: true,
  });

  assert.equal(report.ok, true);
  assert.equal(report.dry_run, true);
  const byId = Object.fromEntries(report.edges.map((e) => [e.evidence_id, e]));
  assert.equal(byId[EVIDENCE_OK].status, "proposed");
  assert.equal(byId[EVIDENCE_MISSING].status, "rejected-evidence-missing");
  assert.equal(writeCallsOf(fake.calls).length, 0, `dry-run produced write calls: ${JSON.stringify(writeCallsOf(fake.calls))}`);
});

test("rung1: dry-run promote_skill writes nothing (valid + already-promoted paths)", async () => {
  const ORIGIN = "drawer_proj_skills_aaaaaaaa";
  const SHARED_WING = "shared-skills";
  const CONTENT = "Goal: deterministic dry-run probe.\n1. Step one.";

  // Path A — a fresh, fully stamped origin (skill + domain) previews the copy plan.
  const fakeA = makeFakePalace({
    drawers: { [ORIGIN]: { drawer_id: ORIGIN, wing: "proj", room: "skills", content: CONTENT, desc: "procedure" } },
    kgFacts: {
      [`${ORIGIN}|es-source-type`]: [{ subject: ORIGIN, predicate: "es-source-type", object: "skill", current: true }],
      [`${ORIGIN}|es-domain`]: [{ subject: ORIGIN, predicate: "es-domain", object: "code", current: true }],
    },
  });
  const reportA = await runSkillPromotion({ call: fakeA.call, skillId: ORIGIN, sharedWing: SHARED_WING, dryRun: true });
  assert.equal(reportA.ok, true);
  assert.equal(reportA.dry_run, true);
  assert.equal(reportA.domain, "code");
  assert.match(reportA.next_step, /dry_run:false/);
  assert.equal(writeCallsOf(fakeA.calls).length, 0, `fresh-path dry-run produced write calls: ${JSON.stringify(writeCallsOf(fakeA.calls))}`);

  // Path B — an origin with an existing promoted-from edge short-circuits (idempotent)
  // and must still write nothing.
  const fakeB = makeFakePalace({
    drawers: { [ORIGIN]: { drawer_id: ORIGIN, wing: "proj", room: "skills", content: CONTENT, desc: "procedure" } },
    kgFacts: {
      [`${ORIGIN}|es-source-type`]: [{ subject: ORIGIN, predicate: "es-source-type", object: "skill", current: true }],
      [`${ORIGIN}|es-domain`]: [{ subject: ORIGIN, predicate: "es-domain", object: "code", current: true }],
      [`${ORIGIN}|promoted-from`]: [{ subject: "drawer_shared-skills_skills_copy", predicate: "promoted-from", object: ORIGIN, current: true }],
    },
  });
  const reportB = await runSkillPromotion({ call: fakeB.call, skillId: ORIGIN, sharedWing: SHARED_WING, dryRun: true });
  assert.equal(reportB.ok, true);
  assert.equal(reportB.dry_run, true);
  assert.ok(reportB.already_promoted_to, "expected the already-promoted short-circuit");
  assert.equal(writeCallsOf(fakeB.calls).length, 0, `already-promoted dry-run produced write calls: ${JSON.stringify(writeCallsOf(fakeB.calls))}`);
});

test("rung1: dry-run record_outcome writes nothing (outcome edges + calibration tuple proposed only)", async () => {
  const NODE_A = "drawer_w_room_a";
  const NODE_B = "drawer_w_room_b";
  const FIXED_NOW = () => new Date("2026-08-30T00:00:00.000Z");

  const fake = makeFakePalace();
  const report = await runOutcomeRecord({
    call: fake.call,
    nodeIds: [NODE_A, NODE_B],
    outcome: "accept",
    cycleRef: `rung1-cycle-${FIXED_NOW().toISOString()}`,
    dryRun: true,
    now: FIXED_NOW,
    calibration: { model_id: "model-x", task_shape: "shape-y", confidence: "high" },
  });

  assert.equal(report.ok, true);
  assert.equal(report.dry_run, true);
  assert.equal(report.outcome, "accept");
  assert.equal(report.counts.proposed, 2);
  assert.equal(report.counts.added, 0);
  for (const edge of report.edges) {
    assert.equal(edge.status, "proposed");
    assert.equal(edge.proposed_edge.predicate, "es-outcome");
    assert.equal(edge.proposed_edge.object, "accept");
  }
  // The Phase 16 calibration tuple is previewed on the same dry-run — proposed, not written.
  assert.ok(report.calibration, "expected a calibration preview in the dry-run report");
  assert.equal(report.calibration.status, "proposed");
  assert.equal(writeCallsOf(fake.calls).length, 0, `dry-run produced write calls: ${JSON.stringify(writeCallsOf(fake.calls))}`);
});

test("rung1: dry-run remind writes nothing (create / update / close)", async () => {
  const WING = "proj";
  const REMINDER_ID = "drawer_proj_reminders_r1";
  const FIXED_NOW = () => new Date("2026-08-30T00:00:00.000Z");

  // create — the full 4-step plan (drawer + 3 edges) must be preview-only.
  const fakeCreate = makeFakePalace();
  const created = await runRemind({
    call: fakeCreate.call,
    action: "create",
    wing: WING,
    what: "verify the integration gate after the rebuild",
    condition: "web/src/**",
    expiresAt: "2026-09-30T00:00:00.000Z",
    dryRun: true,
    now: FIXED_NOW,
  });
  assert.equal(created.ok, true);
  assert.equal(created.dry_run, true);
  assert.equal(created.steps.length, 4);
  for (const step of created.steps) assert.equal(step.status, "proposed");
  assert.equal(writeCallsOf(fakeCreate.calls).length, 0, `create dry-run produced write calls: ${JSON.stringify(writeCallsOf(fakeCreate.calls))}`);

  // update — content + expiry preview-only.
  const fakeUpdate = makeFakePalace();
  const updated = await runRemind({
    call: fakeUpdate.call,
    action: "update",
    wing: WING,
    drawerId: REMINDER_ID,
    what: "reworded reminder text",
    expiresAt: "2026-10-30T00:00:00.000Z",
    dryRun: true,
    now: FIXED_NOW,
  });
  assert.equal(updated.ok, true);
  assert.equal(updated.dry_run, true);
  for (const step of updated.steps) assert.equal(step.status, "proposed");
  assert.equal(writeCallsOf(fakeUpdate.calls).length, 0, `update dry-run produced write calls: ${JSON.stringify(writeCallsOf(fakeUpdate.calls))}`);

  // close — status edge (+ satisfied-at when satisfied) preview-only.
  const fakeClose = makeFakePalace();
  const closed = await runRemind({
    call: fakeClose.call,
    action: "close",
    wing: WING,
    drawerId: REMINDER_ID,
    status: "satisfied",
    dryRun: true,
    now: FIXED_NOW,
  });
  assert.equal(closed.ok, true);
  assert.equal(closed.dry_run, true);
  for (const step of closed.steps) assert.equal(step.status, "proposed");
  assert.equal(writeCallsOf(fakeClose.calls).length, 0, `close dry-run produced write calls: ${JSON.stringify(writeCallsOf(fakeClose.calls))}`);
});

// ── 5. Dry-run zero-write for the bulk drawer ops (move / delete / relocate) ──
//
// Spec §6.1 requires "dry-run every mutating tool and confirm it writes nothing".
// Sections 1 and 4 cover the approval-gated proposal writers; these three are the
// remaining dry-run-capable mutators. They build their own MCPHttpClient from the
// runtime environment, so the fake-palace seam here is the transport itself: a
// mocked globalThis.fetch that serves the JSON-RPC handshake and records every
// tools/call. On dry_run:true the report must be a read-only preview with ZERO
// calls to update_drawer / delete_drawer / add_drawer / kg_add. No live endpoint,
// no network, fixed data — deterministic.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import moveDrawersTool from "../../tools/move_drawers.ts";
import deleteDrawersTool from "../../tools/delete_drawers.ts";
import relocateMemoryTool from "../../tools/relocate_memory.ts";

const BULK_WRITE_TOOLS = ["update_drawer", "delete_drawer", "add_drawer", "kg_add"];

function bulkWriteCallsOf(toolCalls) {
  return toolCalls.filter((c) => BULK_WRITE_TOOLS.includes(c.name));
}

/** Hermetic fake palace at the transport layer. Serves the MCP handshake and a
 *  fixed drawer inventory; records every tools/call as {name, args}. */
function makeBulkFakeTransport({ drawers = {}, listings = {} } = {}) {
  const toolCalls = [];
  const fetchFn = async (_input, init) => {
    const payload = JSON.parse(String(init?.body || "{}"));
    if (payload.method === "initialize" || payload.method === "notifications/initialized") {
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: {} }),
        { status: 200, headers: { "Content-Type": "application/json", "Mcp-Session-Id": "rung1-bulk-test" } }
      );
    }
    if (payload.method === "tools/call") {
      const name = payload?.params?.name;
      const args = payload?.params?.arguments || {};
      toolCalls.push({ name, args });

      if (name === "mempalace_list_drawers") {
        const key = `${args.wing}/${args.room || ""}`;
        const rows = listings[key] || [];
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: { content: [{ type: "text", text: JSON.stringify({ drawers: rows, total: rows.length }) }] } }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      if (name === "mempalace_get_drawer") {
        const row = drawers[args.drawer_id];
        const body = row ? { ...row } : { error: `no drawer ${args.drawer_id}` };
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: { content: [{ type: "text", text: JSON.stringify(body) }] } }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      // Any write tool reaching here means the dry-run leaked a write — record it
      // and answer benignly so the report still completes for inspection.
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: { content: [{ type: "text", text: "{}" }] } }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetchFn, toolCalls };
}

/** Run one bulk-op tool hermetically: temp cwd with an isolated config (no auth
 *  headers, no retries), mocked fetch, env snapshot/restore. Returns the parsed
 * JSON report plus the recorded transport-level tool calls. */
async function runBulkToolHermetically(tool, args) {
  const dir = mkdtempSync(join(tmpdir(), "rung1-bulk-"));
  writeFileSync(
    join(dir, "eshepherd-config.jsonc"),
    `{
      "mcp": {
        "url": "http://localhost:8093/mcp",
        "toolPrefix": "mempalace_",
        "requestTimeoutMs": 1500,
        "maxRetries": 0
      }
    }`,
    "utf8"
  );

  const envKeys = [
    "MEMPALACE_MCP_URL",
    "ESHEPHERD_MOVE_MCP_URL",
    "ESHEPHERD_DELETE_MCP_URL",
    "MEMGRAPH_TOOL_PREFIX",
    "MEMPALACE_MCP_API_KEY",
    "MEMPALACE_MCP_BEARER_TOKEN",
    "MEMPALACE_MCP_AUTH_HEADER",
    "MEMPALACE_MCP_AUTH_SCHEME",
    "MEMPALACE_MCP_HEADERS_JSON",
  ];
  const envSnapshot = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
  for (const k of envKeys) delete process.env[k];

  const { fetchFn, toolCalls } = makeBulkFakeTransport({
    drawers: BULK_DRAWERS,
    listings: BULK_LISTINGS,
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;

  try {
    const raw = await tool.execute(args, { worktree: dir, directory: dir });
    return { report: JSON.parse(raw), toolCalls };
  } finally {
    globalThis.fetch = originalFetch;
    for (const [k, v] of Object.entries(envSnapshot)) {
      if (typeof v === "undefined") delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

const BULK_DRAWERS = {
  drawer_wingA_roomX_a1: { drawer_id: "drawer_wingA_roomX_a1", wing: "wingA", room: "roomX" },
  drawer_wingA_roomX_b2: { drawer_id: "drawer_wingA_roomX_b2", wing: "wingA", room: "roomX" },
  drawer_wingB_roomY_c3: {
    drawer_id: "drawer_wingB_roomY_c3",
    wing: "wingB",
    room: "roomY",
    content: "Opening line of the note.\nMiddle sentence about another project.\nClosing line of the note.",
  },
};

const BULK_LISTINGS = {
  "wingA/roomX": [
    { drawer_id: "drawer_wingA_roomX_a1" },
    { drawer_id: "drawer_wingA_roomX_b2" },
  ],
};

test("rung1: dry-run move_drawers writes nothing (explicit IDs + wing scope)", async () => {
  // Explicit IDs: read-only preview of each planned move.
  const byIds = await runBulkToolHermetically(moveDrawersTool, {
    drawer_ids: ["drawer_wingA_roomX_a1"],
    target_wing: "wingB",
    dry_run: true,
  });
  assert.equal(byIds.report.ok, true);
  assert.equal(byIds.report.dry_run, true);
  // The dry-run row is an ok preview of the planned move (from→to), not a write:
  // moved counts only applied moves.
  assert.equal(byIds.report.moved, 1);
  assert.equal(byIds.report.requested, 1);
  const movedRow = byIds.report.results[0];
  assert.equal(movedRow.from_wing, "wingA");
  assert.equal(movedRow.to_wing, "wingB");
  assert.equal(bulkWriteCallsOf(byIds.toolCalls).length, 0, `move_drawers dry-run produced write calls: ${JSON.stringify(bulkWriteCallsOf(byIds.toolCalls))}`);

  // Wing scope: list_drawers pages the room read-only; no update_drawer.
  const byScope = await runBulkToolHermetically(moveDrawersTool, {
    source_wing: "wingA",
    source_room: "roomX",
    target_wing: "wingB",
    dry_run: true,
  });
  assert.equal(byScope.report.ok, true);
  assert.equal(byScope.report.dry_run, true);
  assert.equal(byScope.report.requested, 2);
  assert.equal(byScope.report.moved, 2);
  assert.ok(
    byScope.toolCalls.some((c) => c.name === "mempalace_list_drawers"),
    "scoped dry-run must page the room via list_drawers"
  );
  assert.equal(bulkWriteCallsOf(byScope.toolCalls).length, 0, `move_drawers scoped dry-run produced write calls: ${JSON.stringify(bulkWriteCallsOf(byScope.toolCalls))}`);
});

test("rung1: dry-run delete_drawers writes nothing (explicit IDs + wing scope)", async () => {
  const byIds = await runBulkToolHermetically(deleteDrawersTool, {
    drawer_ids: ["drawer_wingA_roomX_a1", "drawer_wingA_roomX_b2"],
    dry_run: true,
  });
  assert.equal(byIds.report.ok, true);
  assert.equal(byIds.report.dry_run, true);
  assert.equal(byIds.report.requested, 2);
  assert.deepEqual(byIds.report.drawer_ids, ["drawer_wingA_roomX_a1", "drawer_wingA_roomX_b2"]);
  assert.equal(bulkWriteCallsOf(byIds.toolCalls).length, 0, `delete_drawers dry-run produced write calls: ${JSON.stringify(bulkWriteCallsOf(byIds.toolCalls))}`);

  const byScope = await runBulkToolHermetically(deleteDrawersTool, {
    source_wing: "wingA",
    source_room: "roomX",
    dry_run: true,
  });
  assert.equal(byScope.report.ok, true);
  assert.equal(byScope.report.dry_run, true);
  assert.equal(byScope.report.requested, 2);
  assert.ok(
    byScope.toolCalls.some((c) => c.name === "mempalace_list_drawers"),
    "scoped dry-run must page the room via list_drawers"
  );
  assert.equal(bulkWriteCallsOf(byScope.toolCalls).length, 0, `delete_drawers scoped dry-run produced write calls: ${JSON.stringify(bulkWriteCallsOf(byScope.toolCalls))}`);
});

test("rung1: dry-run relocate_memory writes nothing (move + excerpt modes)", async () => {
  const moved = await runBulkToolHermetically(relocateMemoryTool, {
    drawer_id: "drawer_wingA_roomX_a1",
    target_wing: "wingB",
    target_room: "roomY",
    mode: "move",
    dry_run: true,
  });
  assert.equal(moved.report.ok, true);
  assert.equal(moved.report.dry_run, true);
  assert.equal(moved.report.mode, "move");
  assert.deepEqual(moved.report.to, { wing: "wingB", room: "roomY" });
  assert.match(moved.report.next_step, /dry_run:false/);
  assert.equal(bulkWriteCallsOf(moved.toolCalls).length, 0, `relocate move dry-run produced write calls: ${JSON.stringify(bulkWriteCallsOf(moved.toolCalls))}`);

  const excerpted = await runBulkToolHermetically(relocateMemoryTool, {
    drawer_id: "drawer_wingB_roomY_c3",
    target_wing: "wingA",
    target_room: "roomX",
    mode: "excerpt",
    excerpt: "Middle sentence about another project.",
    dry_run: true,
  });
  assert.equal(excerpted.report.ok, true);
  assert.equal(excerpted.report.dry_run, true);
  assert.equal(excerpted.report.mode, "excerpt");
  assert.equal(excerpted.report.verbatim_verified, true);
  assert.match(excerpted.report.next_step, /dry_run:false/);
  assert.equal(bulkWriteCallsOf(excerpted.toolCalls).length, 0, `relocate excerpt dry-run produced write calls: ${JSON.stringify(bulkWriteCallsOf(excerpted.toolCalls))}`);
});

