import assert from "node:assert/strict";
import test from "node:test";

import { backfillRoom } from "../../src/scripts/run-source-type-backfill.ts";

/**
 * `backfillRoom` is the exhaustive counterpart to `runSourceTypeBackfill`'s
 * bounded paging (tests/unit/palace-stamp-source-type.test.mjs): same
 * classification and idempotency rules, but no page cap, no cursor loss across
 * invocations. These tests drive it against a fake substrate — no network.
 */
function makeFakePalace({ drawers = [], kgFacts = {}, failWrites = new Set() } = {}) {
  const calls = [];
  const call = async (name, payload) => {
    calls.push({ name, args: payload });
    if (name === "list_drawers") {
      const page = drawers.slice(payload.offset, payload.offset + payload.limit);
      return { drawers: page.map((id) => ({ drawer_id: id })), total: drawers.length };
    }
    if (name === "kg_query") {
      const key = `${payload.entity}|${payload.predicate}`;
      const facts = kgFacts[key];
      if (facts === "throw") throw new Error(`kg_query failed for ${key}`);
      return { facts: facts || [] };
    }
    if (name === "kg_add" || name === "kg_supersede") {
      if (failWrites.has(payload.subject)) throw new Error(`${name} failed for ${payload.subject}`);
      return {};
    }
    return {};
  };
  return { call, calls };
}

const factFor = (subject, object) => ({ subject, object });

test("backfillRoom pages a room to exhaustion beyond a single page", async () => {
  const drawers = Array.from({ length: 7 }, (_, i) => `d${i}`);
  const { call, calls } = makeFakePalace({ drawers });

  const totals = await backfillRoom({ call, wing: "w", room: "source-transcripts", pageSize: 3, concurrency: 4, apply: false });

  // 3 pages (3+3+1), not capped at the first page like the model-facing tool.
  assert.equal(totals.total, 7);
  assert.equal(calls.filter((c) => c.name === "list_drawers").length, 3);
  assert.equal(totals.inferred_transcript, 7); // room name alone infers transcript
});

test("backfillRoom never writes an unknown drawer, dry-run or apply", async () => {
  const { call } = makeFakePalace({ drawers: ["d1"], kgFacts: { "d1|synthesized-from": [] } });
  const dryRun = await backfillRoom({ call, wing: "w", room: "docs", pageSize: 10, concurrency: 2, apply: false });
  const applied = await backfillRoom({ call, wing: "w", room: "docs", pageSize: 10, concurrency: 2, apply: true });

  assert.equal(dryRun.unknown, 1);
  assert.equal(applied.unknown, 1);
  assert.equal(applied.stamped, 0);
});

test("backfillRoom infers synthesis from an outgoing synthesized-from edge", async () => {
  const { call } = makeFakePalace({
    drawers: ["d1"],
    kgFacts: { "d1|synthesized-from": [factFor("d1", "source1")] },
  });
  const totals = await backfillRoom({ call, wing: "w", room: "docs", pageSize: 10, concurrency: 2, apply: true });
  assert.equal(totals.inferred_synthesis, 1);
  assert.equal(totals.stamped, 1);
});

test("backfillRoom dry-run classifies but writes nothing", async () => {
  const { call, calls } = makeFakePalace({ drawers: ["d1", "d2"] });
  const totals = await backfillRoom({ call, wing: "w", room: "transcripts", pageSize: 10, concurrency: 2, apply: false });

  assert.equal(totals.inferred_transcript, 2);
  assert.equal(calls.some((c) => c.name === "kg_add" || c.name === "kg_supersede"), false);
});

test("backfillRoom skips an already-correctly-stamped drawer", async () => {
  const { call, calls } = makeFakePalace({
    drawers: ["d1"],
    kgFacts: { "d1|es-source-type": [factFor("d1", "transcript")] },
  });
  const totals = await backfillRoom({ call, wing: "w", room: "source-transcripts", pageSize: 10, concurrency: 2, apply: true });

  assert.equal(totals.already_stamped, 1);
  assert.equal(totals.stamped, 0);
  assert.equal(calls.some((c) => c.name === "kg_add" || c.name === "kg_supersede"), false);
});

test("backfillRoom supersedes a conflicting previous value instead of kg_add", async () => {
  const { call, calls } = makeFakePalace({
    drawers: ["d1"],
    kgFacts: { "d1|es-source-type": [factFor("d1", "doc")] },
  });
  const totals = await backfillRoom({ call, wing: "w", room: "source-transcripts", pageSize: 10, concurrency: 2, apply: true });

  assert.equal(totals.stamped, 1);
  const write = calls.find((c) => c.name === "kg_supersede");
  assert.equal(write.args.old_object, "doc");
  assert.equal(write.args.new_object, "transcript");
});

test("backfillRoom counts a failed write without aborting the room", async () => {
  const { call } = makeFakePalace({ drawers: ["ok", "bad"], failWrites: new Set(["bad"]) });
  const totals = await backfillRoom({ call, wing: "w", room: "transcripts", pageSize: 10, concurrency: 2, apply: true });

  assert.equal(totals.stamped, 1);
  assert.equal(totals.stamp_failed, 1);
});

test("backfillRoom counts a failing edge check as check_failed, never as synthesis", async () => {
  const { call } = makeFakePalace({ drawers: ["d1"], kgFacts: { "d1|synthesized-from": "throw" } });
  const totals = await backfillRoom({ call, wing: "w", room: "docs", pageSize: 10, concurrency: 2, apply: false });

  assert.equal(totals.check_failed, 1);
  assert.equal(totals.unknown, 1);
  assert.equal(totals.inferred_synthesis, 0);
});
