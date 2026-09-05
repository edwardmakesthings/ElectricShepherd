import assert from "node:assert/strict";
import test from "node:test";

import { inferSourceType, runSourceTypeBackfill } from "../../src/tools/palace_stamp_source_type.ts";

/**
 * Phase 1 (unified memory): the bounded, dry-run-first `es-source-type` backfill.
 * These tests drive the exported core (`runSourceTypeBackfill`) against a fake
 * MCP transport — no network. They prove:
 *   1. transcript-like rooms infer `transcript` with ZERO kg_query calls;
 *   2. non-transcript drawers with outgoing synthesized-from edges infer `synthesis`;
 *   3. unknown drawers are NEVER stamped (no kg_add) and stay unstamped;
 *   4. dry-run issues no kg_add/kg_invalidate at all;
 *   5. apply stamps inferred drawers, skips already-correct ones, invalidates a
 *      conflicting previous value before re-stamping, and counts failed stamps;
 *   6. paging is bounded — the page cap is respected and uncovered drawers counted.
 */

function makeFakePalace({ rooms = {}, taxonomy = null } = {}) {
  const calls = [];
  const listDrawers = (wing, room, limit, offset) => {
    const all = rooms[`${wing}/${room}`] || [];
    const page = all.slice(offset, offset + limit);
    return { drawers: page.map((id) => ({ drawer_id: id })), total: all.length };
  };

  const call = async (name, payload) => {
    calls.push({ name, args: payload });
    if (name === "get_taxonomy") {
      const tax = taxonomy || {};
      return { taxonomy: tax };
    }
    if (name === "list_drawers") {
      return listDrawers(payload.wing, payload.room, payload.limit, payload.offset);
    }
    if (name === "kg_query") {
      const key = `${payload.entity}|${payload.predicate}`;
      const handler = rooms[`__kg__:${key}`];
      if (typeof handler === "function") return handler(payload) || { facts: [] };
      if (handler === "throw") throw new Error(`kg_query failed for ${key}`);
      return { facts: [] };
    }
    if (name === "kg_add" || name === "kg_invalidate" || name === "kg_supersede") {
      const key = `${name}:${payload.subject}`;
      if (rooms[`__fail__:${key}`]) throw new Error(`${name} failed for ${key}`);
      return {};
    }
    return {};
  };

  return { call, calls };
}

const WING = "proj";

test("transcript-like room infers transcript with zero kg_query calls", async () => {
  const { call, calls } = makeFakePalace({
    taxonomy: { [WING]: { "source-transcripts": 3 } },
    rooms: { [`${WING}/source-transcripts`]: ["d1", "d2", "d3"] },
  });

  const report = await runSourceTypeBackfill({ call, wing: WING, dryRun: true });

  assert.equal(report.dry_run, true);
  const roomReport = report.rooms.find((r) => r.room === "source-transcripts");
  assert.equal(roomReport.transcript_like, true);
  assert.equal(roomReport.inferred_transcript, 3);
  assert.equal(roomReport.inferred_synthesis, 0);
  assert.equal(roomReport.unknown, 0);

  // The room name is the signal — no synthesized-from edge check was made for any drawer.
  const edgeChecks = calls.filter((c) => c.name === "kg_query" && c.args.predicate === "synthesized-from");
  assert.equal(edgeChecks.length, 0);
});

test("non-transcript drawer with outgoing synthesized-from infers synthesis", async () => {
  const { call } = makeFakePalace({
    taxonomy: { [WING]: { notes: 2 } },
    rooms: {
      [`${WING}/notes`]: ["synth-drawer", "plain-drawer"],
      [`__kg__:synth-drawer|synthesized-from`]: () => ({
        facts: [{ current: true, subject: "synth-drawer", predicate: "synthesized-from", object: "src-1" }],
      }),
    },
  });

  const report = await runSourceTypeBackfill({ call, wing: WING, dryRun: true });

  const roomReport = report.rooms.find((r) => r.room === "notes");
  assert.equal(roomReport.transcript_like, false);
  assert.equal(roomReport.inferred_synthesis, 1);
  assert.equal(roomReport.unknown, 1); // plain-drawer has no edges → unknown
});

test("unknown drawers are left unstamped (no kg_add) in apply mode", async () => {
  const { call, calls } = makeFakePalace({
    taxonomy: { [WING]: { notes: 2 } },
    rooms: {
      [`${WING}/notes`]: ["synth-drawer", "plain-drawer"],
      [`__kg__:synth-drawer|synthesized-from`]: () => ({
        facts: [{ current: true, subject: "synth-drawer", predicate: "synthesized-from", object: "src-1" }],
      }),
    },
  });

  const report = await runSourceTypeBackfill({ call, wing: WING, dryRun: false });

  const kgAdds = calls.filter((c) => c.name === "kg_add");
  // Only the synthesis drawer gets stamped; the unknown one does not.
  assert.equal(kgAdds.length, 1);
  assert.equal(kgAdds[0].args.subject, "synth-drawer");
  assert.equal(kgAdds[0].args.object, "synthesis");

  const plainAdds = kgAdds.filter((c) => c.args.subject === "plain-drawer");
  assert.equal(plainAdds.length, 0);
  assert.equal(report.totals.stamped, 1);
});

test("dry-run issues no kg_add, kg_invalidate, or kg_supersede", async () => {
  const { call, calls } = makeFakePalace({
    taxonomy: { [WING]: { "source-transcripts": 2 } },
    rooms: { [`${WING}/source-transcripts`]: ["d1", "d2"] },
  });

  const report = await runSourceTypeBackfill({ call, wing: WING, dryRun: true });

  assert.equal(report.dry_run, true);
  assert.ok(report.next_step.includes("dry_run:false"));
  assert.equal(calls.filter((c) => c.name === "kg_add").length, 0);
  assert.equal(calls.filter((c) => c.name === "kg_invalidate").length, 0);
  assert.equal(calls.filter((c) => c.name === "kg_supersede").length, 0);
  // dry-run still reports what it would do
  const roomReport = report.rooms[0];
  assert.equal(roomReport.would_stamp, 2);
});

test("apply skips already-correctly-stamped drawers (no invalidate, no re-add)", async () => {
  const { call, calls } = makeFakePalace({
    taxonomy: { [WING]: { "source-transcripts": 1 } },
    rooms: {
      [`${WING}/source-transcripts`]: ["d1"],
      [`__kg__:d1|es-source-type`]: () => ({
        facts: [{ current: true, subject: "d1", predicate: "es-source-type", object: "transcript" }],
      }),
    },
  });

  const report = await runSourceTypeBackfill({ call, wing: WING, dryRun: false });

  assert.equal(calls.filter((c) => c.name === "kg_add").length, 0);
  assert.equal(calls.filter((c) => c.name === "kg_invalidate").length, 0);
  assert.equal(report.totals.already_stamped, 1);
  assert.equal(report.totals.stamped, 0);
});

test("apply supersedes a conflicting previous value atomically", async () => {
  const { call, calls } = makeFakePalace({
    taxonomy: { [WING]: { notes: 1 } },
    rooms: {
      [`${WING}/notes`]: ["synth-drawer"],
      [`__kg__:synth-drawer|synthesized-from`]: () => ({
        facts: [{ current: true, subject: "synth-drawer", predicate: "synthesized-from", object: "src-1" }],
      }),
      [`__kg__:synth-drawer|es-source-type`]: () => ({
        facts: [{ current: true, subject: "synth-drawer", predicate: "es-source-type", object: "doc" }],
      }),
    },
  });

  const report = await runSourceTypeBackfill({ call, wing: WING, dryRun: false });

  const supersedes = calls.filter((c) => c.name === "kg_supersede");
  assert.equal(supersedes.length, 1);
  assert.deepEqual(supersedes[0].args, {
    subject: "synth-drawer",
    predicate: "es-source-type",
    old_object: "doc",
    new_object: "synthesis",
    source_closet: "synth-drawer",
  });
  const adds = calls.filter((c) => c.name === "kg_add");
  assert.equal(adds.length, 0);
  assert.equal(report.totals.stamped, 1);
});

test("a failed kg_query reads as unknown (unstamped) and is counted as check_failed", async () => {
  const { call } = makeFakePalace({
    taxonomy: { [WING]: { notes: 1 } },
    rooms: {
      [`${WING}/notes`]: ["flaky-drawer"],
      [`__kg__:flaky-drawer|synthesized-from`]: "throw",
    },
  });

  const report = await runSourceTypeBackfill({ call, wing: WING, dryRun: true });

  const roomReport = report.rooms[0];
  assert.equal(roomReport.unknown, 1);
  assert.equal(roomReport.check_failed, 1);
  assert.equal(roomReport.inferred_synthesis, 0);
});

test("paging is bounded by max_pages and uncovered drawers are counted", async () => {
  // 5 drawers in a transcript-like room; page_size 2, max_pages 2 → covers 4, not 1.
  const { call } = makeFakePalace({
    taxonomy: { [WING]: { "source-transcripts": 5 } },
    rooms: { [`${WING}/source-transcripts`]: ["d1", "d2", "d3", "d4", "d5"] },
  });

  const report = await runSourceTypeBackfill({
    call,
    wing: WING,
    dryRun: true,
    pageSize: 2,
    maxPages: 2,
  });

  const roomReport = report.rooms[0];
  assert.equal(roomReport.total, 5);
  assert.equal(roomReport.covered, 4);
  assert.equal(roomReport.not_covered_by_page_cap, 1);
});

test("defaults are page_size 50 and max_pages 4", async () => {
  // 250 drawers; defaults cover 4*50 = 200, leaving 50 uncovered.
  const ids = Array.from({ length: 250 }, (_, i) => `d${i}`);
  const { call } = makeFakePalace({
    taxonomy: { [WING]: { "source-transcripts": 250 } },
    rooms: { [`${WING}/source-transcripts`]: ids },
  });

  const report = await runSourceTypeBackfill({ call, wing: WING, dryRun: true });

  const roomReport = report.rooms[0];
  assert.equal(roomReport.total, 250);
  assert.equal(roomReport.covered, 200);
  assert.equal(roomReport.not_covered_by_page_cap, 50);
});

test("inferSourceType classifies by room and edge presence", async () => {
  const transcriptCall = makeFakePalace({}).call;
  assert.deepEqual(await inferSourceType(transcriptCall, "source-transcripts", "any"), {
    inference: "transcript",
    checkFailed: false,
  });

  const synthCall = makeFakePalace({
    rooms: {
      [`__kg__:x|synthesized-from`]: () => ({ facts: [{ current: true, subject: "x", object: "s" }] }),
    },
  }).call;
  assert.deepEqual(await inferSourceType(synthCall, "notes", "x"), { inference: "synthesis", checkFailed: false });

  const unknownCall = makeFakePalace({}).call;
  assert.deepEqual(await inferSourceType(unknownCall, "notes", "y"), { inference: "unknown", checkFailed: false });

  const failedCall = makeFakePalace({
    rooms: { [`__kg__:z|synthesized-from`]: "throw" },
  }).call;
  assert.deepEqual(await inferSourceType(failedCall, "notes", "z"), { inference: "unknown", checkFailed: true });
});
