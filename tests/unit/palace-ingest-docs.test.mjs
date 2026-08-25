import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  boundedIdSnapshot,
  invalidateAndRestamp,
  parseReminedFilesFromMineOutput,
  pickReferenceRoom,
  runDocIngest,
} from "../../tools/ingest_docs.ts";

/**
 * Phase 3 (unified memory): the `/ingest-docs` core (`runDocIngest`) against a fake
 * MCP transport — no network. Proves:
 *   1. room selection reuses an existing reference-like room, else mints `reference`;
 *   2. dry-run makes NO mine call and NO KG writes;
 *   3. apply mines first, then invalidates open outgoing facts on changed drawers
 *      only (new + remined), never on unchanged drawers;
 *   4. conservative fallback when mine output is unparseable;
 *   5. partial failures are counted, never abort the pass;
 *   6. idempotency: a second apply run over an unchanged room does nothing new;
 *   7. paging is bounded (page cap respected, uncovered counted).
 */

const WING = "proj";
let docDir;

test.before(() => {
  docDir = mkdtempSync(join(tmpdir(), "ingest-docs-"));
});

test.after(() => {
  rmSync(docDir, { recursive: true, force: true });
});

/**
 * Fake palace. `rooms` maps "wing/room" → array of drawer rows (objects with
 * drawer_id and optional metadata.source_file). `mineBehavior` controls what the
 * mine call does: it receives the current room state and may mutate it (simulating
 * purge+reinsert), then returns the tool result.
 */
function makeFakePalace({ taxonomy = {}, rooms = {}, mineBehavior = null, kgFacts = {} } = {}) {
  const state = {};
  for (const [key, rows] of Object.entries(rooms)) state[key] = rows.map((row) => ({ ...row }));

  const calls = [];
  const listDrawers = (wing, room, limit, offset) => {
    const all = state[`${wing}/${room}`] || [];
    const page = all.slice(offset, offset + limit);
    return { drawers: page.map((row) => ({ ...row })), total: all.length };
  };

  const call = async (name, payload) => {
    calls.push({ name, args: payload });
    if (name === "get_taxonomy") return { taxonomy };
    if (name === "list_drawers") return listDrawers(payload.wing, payload.room, payload.limit, payload.offset);
    if (name === "mine") {
      const result = mineBehavior ? await mineBehavior({ state, calls }) : { success: true, output: "" };
      return result;
    }
    if (name === "kg_query") {
      const handler = kgFacts[payload.entity];
      if (handler === "throw") throw new Error(`kg_query failed for ${payload.entity}`);
      if (typeof handler === "function") return handler(payload) || { facts: [] };
      if (handler) return { facts: handler };
      return { facts: [] };
    }
    if (name === "kg_add" || name === "kg_invalidate") {
      const key = `${name}:${payload.subject}`;
      if (key.startsWith("kg_add:") && kgFacts[`__fail__:${key}`]) throw new Error(`${name} failed for ${key}`);
      if (key.startsWith("kg_invalidate:") && kgFacts[`__fail__:${key}`]) throw new Error(`${name} failed for ${key}`);
      return {};
    }
    return {};
  };

  return { call, calls, state };
}

const fact = (subject, predicate, object, current = true) => ({ subject, predicate, object, current });

test("pickReferenceRoom reuses an existing reference-like room", () => {
  assert.deepEqual(pickReferenceRoom([{ room: "notes", drawers: 5 }, { room: "api-reference", drawers: 3 }]), {
    room: "api-reference",
    reused: true,
  });
  assert.deepEqual(pickReferenceRoom([{ room: "notes", drawers: 5 }]), { room: "reference", reused: false });
  // Derivation-level names are rejected even if they contain a reference stem.
  assert.deepEqual(pickReferenceRoom([{ room: "synthesis-reference", drawers: 9 }, { room: "docs", drawers: 1 }]), {
    room: "docs",
    reused: true,
  });
});

test("parseReminedFilesFromMineOutput extracts file names, ignores noise", () => {
  const out = [
    "[DRY RUN] api.md -> room:reference (3 drawers)",
    "guide.txt -> room:general (1 drawer)",
    "some progress line without an arrow",
    "bad name with spaces -> room:x (1 drawer)",
  ].join("\n");
  assert.deepEqual(parseReminedFilesFromMineOutput(out), ["api.md", "guide.txt"]);
  assert.deepEqual(parseReminedFilesFromMineOutput(""), []);
  assert.deepEqual(parseReminedFilesFromMineOutput(undefined), []);
});

test("dry-run makes no mine call and no KG writes", async () => {
  const { call, calls } = makeFakePalace({
    taxonomy: { [WING]: { reference: 2 } },
    rooms: { [`${WING}/reference`]: [{ drawer_id: "d1" }, { drawer_id: "d2" }] },
    mineBehavior: () => ({ success: true, output: "mined" }),
  });

  const report = await runDocIngest({ call, path: docDir, wing: WING, dryRun: true });

  assert.equal(report.ok, true);
  assert.equal(report.dry_run, true);
  assert.equal(report.room, "reference");
  assert.equal(report.pre_snapshot.total, 2);
  assert.match(report.next_step, /dry_run:false/);

  const mutating = calls.filter((c) => c.name === "mine" || c.name === "kg_add" || c.name === "kg_invalidate");
  assert.equal(mutating.length, 0);
});

test("apply: mines first, invalidates only changed drawers, re-stamps doc", async () => {
  // Room starts with d1 (unchanged) and d2 (will be re-mined under the same id).
  const mineBehavior = ({ state }) => {
    // Simulate purge+reinsert of d2 under the SAME id (content changed), plus a new drawer d3.
    state[`${WING}/reference`] = [
      { drawer_id: "d1", metadata: { source_file: "a.md" } },
      { drawer_id: "d2", metadata: { source_file: "b.md" } },
      { drawer_id: "d3", metadata: { source_file: "c.md" } },
    ];
    // Miner per-file lines carry a "[DRY RUN]"-style prefix even in apply mode.
    return { success: true, output: "[DRY RUN] b.md -> room:reference (2 drawers)\n[DRY RUN] c.md -> room:reference (1 drawer)" };
  };

  const { call, calls, state } = makeFakePalace({
    taxonomy: { [WING]: { reference: 2 } },
    rooms: {
      [`${WING}/reference`]: [
        { drawer_id: "d1", metadata: { source_file: "a.md" } },
        { drawer_id: "d2", metadata: { source_file: "b.md" } },
      ],
    },
    mineBehavior,
    kgFacts: {
      d2: [fact("d2", "es-source-type", "doc"), fact("d2", "concerns", "other-drawer")],
      d3: [fact("d3", "in-hall", "api")],
      d1: [fact("d1", "es-source-type", "doc")], // unchanged drawer has open facts too — must survive
    },
  });

  const report = await runDocIngest({ call, path: docDir, wing: WING, dryRun: false });

  assert.equal(report.ok, true);
  assert.equal(report.dry_run, false);
  // Ordering: mine happened before the first kg_invalidate.
  const mineIdx = calls.findIndex((c) => c.name === "mine");
  const firstInvalidationIdx = calls.findIndex((c) => c.name === "kg_invalidate");
  assert.ok(mineIdx >= 0 && firstInvalidationIdx > mineIdx, "mine must precede invalidation");

  // d2 (re-mined by output parsing) and d3 (new) are invalidated; d1 is untouched.
  const invalidatedSubjects = new Set(
    calls.filter((c) => c.name === "kg_invalidate").map((c) => c.args.subject),
  );
  assert.deepEqual([...invalidatedSubjects].sort(), ["d2", "d3"]);

  // Broad predicate scope: both of d2's open facts were invalidated.
  const d2Invalidations = calls.filter((c) => c.name === "kg_invalidate" && c.args.subject === "d2");
  assert.equal(d2Invalidations.length, 2);

  // Re-stamped doc on exactly the changed drawers.
  const stampedSubjects = new Set(
    calls.filter((c) => c.name === "kg_add" && c.args.predicate === "es-source-type").map((c) => c.args.subject),
  );
  assert.deepEqual([...stampedSubjects].sort(), ["d2", "d3"]);

  // es-status is never touched.
  const statusWrites = calls.filter((c) => (c.name === "kg_add" || c.name === "kg_invalidate") && c.args.predicate === "es-status");
  assert.equal(statusWrites.length, 0);

  assert.equal(report.changed.new, 1); // d3
  assert.equal(report.changed.remined_by_output, 2); // d2 (re-mined) + d3 (new id listed in output)
  assert.equal(report.changed.remined_by_fallback, 0);
  assert.equal(report.facts_invalidated, 3); // d2:2 + d3:1
  assert.equal(report.restamped_doc, 2);
  assert.equal(state[`${WING}/reference`].length, 3);
});

test("apply: conservative fallback when mine output is unparseable invalidates all surviving ids", async () => {
  const mineBehavior = ({ state }) => {
    // d1 survives with the same id; content changed but output gives no file names.
    state[`${WING}/reference`] = [{ drawer_id: "d1", metadata: { source_file: "a.md" } }];
    return { success: true, output: "mined 1 file (no per-file detail)" };
  };

  const { call, calls } = makeFakePalace({
    taxonomy: { [WING]: { reference: 1 } },
    rooms: { [`${WING}/reference`]: [{ drawer_id: "d1", metadata: { source_file: "a.md" } }] },
    mineBehavior,
    kgFacts: { d1: [fact("d1", "es-source-type", "doc")] },
  });

  const report = await runDocIngest({ call, path: docDir, wing: WING, dryRun: false });

  assert.equal(report.changed.new, 0);
  assert.equal(report.changed.remined_by_fallback, 1); // d1 survived → conservative invalidation
  const invalidatedSubjects = new Set(
    calls.filter((c) => c.name === "kg_invalidate").map((c) => c.args.subject),
  );
  assert.deepEqual([...invalidatedSubjects], ["d1"]);
});

test("apply: unchanged room (no new, no parseable output change) still converges and re-stamps", async () => {
  // Miner skipped everything (mtime gate): same ids, empty output → fallback invalidates
  // surviving ids. This is the over-broad-but-safe direction; report shows it.
  const mineBehavior = () => ({ success: true, output: "0 files changed" });

  const { call, calls } = makeFakePalace({
    taxonomy: { [WING]: { reference: 1 } },
    rooms: { [`${WING}/reference`]: [{ drawer_id: "d1", metadata: { source_file: "a.md" } }] },
    mineBehavior,
    kgFacts: { d1: [fact("d1", "es-source-type", "doc")] },
  });

  const report = await runDocIngest({ call, path: docDir, wing: WING, dryRun: false });

  assert.equal(report.ok, true);
  assert.equal(report.changed.remined_by_fallback, 1);
  // Idempotent re-stamp: kg_add of the identical triple is a no-op server-side.
  const stamped = calls.filter((c) => c.name === "kg_add" && c.args.subject === "d1");
  assert.equal(stamped.length, 1);
  assert.equal(stamped[0].args.object, "doc");
});

test("apply: mine failure stops immediately — no KG writes", async () => {
  const mineBehavior = () => ({ success: false, error: "MineAlreadyRunning" });

  const { call, calls } = makeFakePalace({
    taxonomy: { [WING]: { reference: 1 } },
    rooms: { [`${WING}/reference`]: [{ drawer_id: "d1" }] },
    mineBehavior,
    kgFacts: { d1: [fact("d1", "es-source-type", "doc")] },
  });

  const report = await runDocIngest({ call, path: docDir, wing: WING, dryRun: false });

  assert.equal(report.ok, false);
  assert.match(report.error, /MineAlreadyRunning/);
  const kgWrites = calls.filter((c) => c.name === "kg_add" || c.name === "kg_invalidate");
  assert.equal(kgWrites.length, 0);
});

test("apply: partial invalidation failures are counted, pass continues", async () => {
  const mineBehavior = ({ state }) => {
    state[`${WING}/reference`] = [
      { drawer_id: "d1", metadata: { source_file: "a.md" } },
      { drawer_id: "d2", metadata: { source_file: "b.md" } },
    ];
    return { success: true, output: "" }; // fallback → both invalidated
  };

  const { call, calls } = makeFakePalace({
    taxonomy: { [WING]: { reference: 1 } },
    rooms: { [`${WING}/reference`]: [{ drawer_id: "d1", metadata: { source_file: "a.md" } }] },
    mineBehavior,
    kgFacts: {
      d1: [fact("d1", "es-source-type", "doc")],
      d2: [fact("d2", "concerns", "x"), fact("d2", "in-hall", "api")],
      "__fail__:kg_invalidate:d2": true, // every invalidation on d2 fails
    },
  });

  const report = await runDocIngest({ call, path: docDir, wing: WING, dryRun: false });

  assert.equal(report.ok, true);
  assert.equal(report.invalidate_failed, 2); // both of d2's facts failed
  assert.equal(report.facts_invalidated, 1); // d1's fact succeeded
  assert.equal(report.restamped_doc, 2); // re-stamp still attempted on both
  assert.match(report.next_step, /retry/);

  // d1 was fully handled despite d2 failing — the pass did not abort.
  const d1Invalidations = calls.filter((c) => c.name === "kg_invalidate" && c.args.subject === "d1");
  assert.equal(d1Invalidations.length, 1);
});

test("apply: kg_query failure on a changed drawer is counted as fact_check_failed, no guessing", async () => {
  const mineBehavior = ({ state }) => {
    state[`${WING}/reference`] = [{ drawer_id: "d2", metadata: { source_file: "b.md" } }];
    return { success: true, output: "[DRY RUN] b.md -> room:reference (1 drawer)" };
  };

  const { call, calls } = makeFakePalace({
    taxonomy: { [WING]: { reference: 0 } },
    rooms: { [`${WING}/reference`]: [] }, // pre-snapshot is empty → d2 is NEW, not remined
    mineBehavior,
    kgFacts: { d2: "throw" },
  });

  const report = await runDocIngest({ call, path: docDir, wing: WING, dryRun: false });

  assert.equal(report.fact_check_failed, 1);
  // No invalidation was attempted on a drawer whose facts could not be read.
  const d2Invalidations = calls.filter((c) => c.name === "kg_invalidate" && c.args.subject === "d2");
  assert.equal(d2Invalidations.length, 0);
  // The re-stamp is skipped too (degrades to unknown authority, safe per spec),
  // and the report carries a retry next_step.
  const d2Stamps = calls.filter((c) => c.name === "kg_add" && c.args.subject === "d2");
  assert.equal(d2Stamps.length, 0);
  assert.match(report.next_step || "", /retry/);
});

test("wing not found → clean error report", async () => {
  const { call } = makeFakePalace({ taxonomy: { other: { reference: 1 } } });
  const report = await runDocIngest({ call, path: docDir, wing: WING, dryRun: true });
  assert.equal(report.ok, false);
  assert.match(report.error, /Wing not found/);
});

test("wing is required", async () => {
  const { call } = makeFakePalace({ taxonomy: {} });
  await assert.rejects(() => runDocIngest({ call, path: docDir, wing: "" }), /wing is required/);
});

test("path must be an existing directory", async () => {
  const { call } = makeFakePalace({ taxonomy: { [WING]: {} } });
  await assert.rejects(() => runDocIngest({ call, path: "/no/such/dir-xyz", wing: WING }), /existing directory/);
});

test("idempotency: second apply over unchanged state makes no new invalidations", async () => {
  // First run: d1 is new (room was empty), gets invalidated+stamped. Second run:
  // mine skips (no output names → fallback would flag d1 as surviving, but its facts
  // were closed by run 1, so kg_query returns no open facts → zero invalidations).
  const rooms = { [`${WING}/reference`]: [] };
  const mineBehavior = () => ({ success: true, output: "" });

  const first = makeFakePalace({ taxonomy: { [WING]: { reference: 0 } }, rooms, mineBehavior, kgFacts: {} });
  // Seed the room state that run 1 would produce.
  first.state[`${WING}/reference`] = [{ drawer_id: "d1", metadata: { source_file: "a.md" } }];

  const second = makeFakePalace({
    taxonomy: { [WING]: { reference: 1 } },
    rooms: { [`${WING}/reference`]: [{ drawer_id: "d1", metadata: { source_file: "a.md" } }] },
    mineBehavior,
    kgFacts: {}, // facts were closed by run 1 → nothing open to invalidate
  });

  const report2 = await runDocIngest({ call: second.call, path: docDir, wing: WING, dryRun: false });

  assert.equal(report2.ok, true);
  assert.equal(report2.facts_invalidated, 0); // already-closed facts are absent from candidates
  assert.equal(report2.restamped_doc, 1); // re-stamp is an idempotent no-op server-side
});

test("bounded paging: page cap respected, uncovered counted", async () => {
  const many = Array.from({ length: 150 }, (_, i) => ({ drawer_id: `d${i}` }));
  const { call } = makeFakePalace({
    taxonomy: { [WING]: { reference: 150 } },
    rooms: { [`${WING}/reference`]: many },
  });

  const snapshot = await boundedIdSnapshot(call, WING, "reference", 50, 2); // cap: 2 pages × 50 = 100
  assert.equal(snapshot.ids.length, 100);
  assert.equal(snapshot.total, 150);
  assert.equal(snapshot.incomplete, true);

  const report = await runDocIngest({ call, path: docDir, wing: WING, dryRun: true, pageSize: 50, maxPages: 2 });
  assert.equal(report.pre_snapshot.covered, 100);
  assert.equal(report.pre_snapshot.incomplete, true);
});

test("invalidateAndRestamp: broad invalidation + doc re-stamp in one pass", async () => {
  const { call, calls } = makeFakePalace({
    kgFacts: { d9: [fact("d9", "es-source-type", "doc"), fact("d9", "in-hall", "api"), fact("d9", "concerns", "x")] },
  });

  const result = await invalidateAndRestamp(call, "d9");

  assert.equal(result.invalidated, 3);
  assert.equal(result.restamped, true);
  const adds = calls.filter((c) => c.name === "kg_add");
  assert.equal(adds.length, 1);
  assert.deepEqual(adds[0].args, { subject: "d9", predicate: "es-source-type", object: "doc", source_closet: "d9" });
});
