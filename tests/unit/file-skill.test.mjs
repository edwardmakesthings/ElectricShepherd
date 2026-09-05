import assert from "node:assert/strict";
import test from "node:test";

import { runSkillFiling, SKILLS_ROOM, SKILL_LIKE_STEMS } from "../../src/tools/file_skill.ts";
import { pickPurposeRoom, pickReferenceRoom } from "../../src/tools/ingest_docs.ts";

/**
 * Phase 5 (unified memory): the `file_skill` core (`runSkillFiling`) against a fake
 * MCP transport — no network. Proves:
 *   1. room selection reuses an existing skill-like room, else mints `skills`,
 *      via the shared pickPurposeRoom (and that pickReferenceRoom still works);
 *   2. dry-run makes NO add_drawer / kg_add calls;
 *   3. apply files verbatim into the picked room and stamps es-source-type: skill +
 *      es-domain (Phase 12, closed vocabulary, default `general`) with source_closet
 *      provenance — and never touches es-status;
 *   4. exact-duplicate guard skips filing (dry-run reports it, apply writes nothing);
 *   5. missing wing is an error report, not a throw;
 *   6. add_drawer failure stops the pass before any stamp; stamp failure is counted;
 *   7. dry-run listing is bounded to one page even for a large room.
 */

const WING = "proj";
const CONTENT = "Goal: ingest docs.\n1. Run /ingest-docs\n2. Verify stamps.";

function makeFakePalace({ taxonomy = {}, rooms = {}, duplicateOf = null, failAddDrawer = false, failStampFor = new Set() } = {}) {
  const state = {};
  for (const [key, rows] of Object.entries(rooms)) state[key] = rows.map((row) => ({ ...row }));
  const calls = [];

  // AC #11: production drawer creation in file_skill goes through the checkpoint
  // write path; the fake emulates the substrate's per-item add_drawer semantics.
  const fileItem = (item) => {
    if (failAddDrawer) throw new Error("add_drawer exploded");
    const id = `drawer_${item.wing}_${item.room}_new`;
    state[`${item.wing}/${item.room}`] = [...(state[`${item.wing}/${item.room}`] || []), { drawer_id: id, content: item.content }];
    return { drawer_id: id };
  };

  const call = async (name, payload) => {
    calls.push({ name, args: payload });
    if (name === "get_taxonomy") return { taxonomy };
    if (name === "list_drawers") {
      const all = state[`${payload.wing}/${payload.room}`] || [];
      return { drawers: all.slice(payload.offset, payload.offset + payload.limit), total: all.length };
    }
    if (name === "check_duplicate") {
      return duplicateOf ? { is_duplicate: true, drawer_id: duplicateOf } : { is_duplicate: false };
    }
    if (name === "checkpoint") {
      const results = (payload.items || []).map(fileItem);
      return { ok: true, results };
    }
    if (name === "add_drawer") {
      return fileItem(payload);
    }
    if (name === "kg_add") {
      if (failStampFor.has(String(payload.subject))) throw new Error(`kg_add failed for ${payload.subject}`);
      return {};
    }
    return {};
  };

  return { call, calls, state };
}

test("pickPurposeRoom reuses a skill-like room; pickReferenceRoom still works", () => {
  assert.deepEqual(pickPurposeRoom([{ room: "notes", drawers: 5 }, { room: "skills", drawers: 3 }], SKILLS_ROOM, SKILL_LIKE_STEMS), {
    room: "skills",
    reused: true,
  });
  assert.deepEqual(pickPurposeRoom([{ room: "notes", drawers: 5 }], SKILLS_ROOM, SKILL_LIKE_STEMS), {
    room: SKILLS_ROOM,
    reused: false,
  });
  // Derivation-level names are rejected even if they end with a skill stem.
  assert.deepEqual(pickPurposeRoom([{ room: "synthesis-skill", drawers: 9 }, { room: "skill", drawers: 1 }], SKILLS_ROOM, SKILL_LIKE_STEMS), {
    room: "skill",
    reused: true,
  });
  // Phase 3 picker unchanged.
  assert.deepEqual(pickReferenceRoom([{ room: "notes", drawers: 5 }, { room: "api-reference", drawers: 3 }]), {
    room: "api-reference",
    reused: true,
  });
});

test("dry-run makes zero add_drawer / kg_add calls and returns a plan", async () => {
  const fake = makeFakePalace({ taxonomy: { [WING]: { notes: 4 } }, rooms: { [`${WING}/notes`]: [{ drawer_id: "n1" }] } });
  const report = await runSkillFiling({ call: fake.call, wing: WING, content: CONTENT, desc: "doc ingest procedure", dryRun: true });

  assert.equal(report.ok, true);
  assert.equal(report.dry_run, true);
  assert.equal(report.room, SKILLS_ROOM);
  assert.equal(report.reused, false);
  assert.deepEqual(
    fake.calls.filter((c) => c.name === "add_drawer" || c.name === "kg_add"),
    [],
    "dry-run must make no mutating calls"
  );
  assert.match(report.next_step, /dry_run:false/);
});

test("Phase 12: dry-run reports the resolved domain (default general) without writing", async () => {
  const fake = makeFakePalace({ taxonomy: { [WING]: {} } });
  const report = await runSkillFiling({ call: fake.call, wing: WING, content: CONTENT, dryRun: true });

  assert.equal(report.domain, "general", "omitted domain defaults to general");
  assert.match(report.next_step, /es-domain: general/);
  assert.deepEqual(
    fake.calls.filter((c) => c.name === "add_drawer" || c.name === "kg_add"),
    [],
    "dry-run must make no mutating calls even with a domain resolved"
  );

  const explicit = await runSkillFiling({ call: fake.call, wing: WING, content: CONTENT, domain: "writing", dryRun: true });
  assert.equal(explicit.domain, "writing");
  assert.match(explicit.next_step, /es-domain: writing/);
});

test("apply files verbatim into the picked room and stamps es-source-type: skill (never es-status)", async () => {
  const fake = makeFakePalace({ taxonomy: { [WING]: { notes: 4 } } });
  const report = await runSkillFiling({ call: fake.call, wing: WING, content: CONTENT, desc: "doc ingest procedure", dryRun: false });

  assert.equal(report.ok, true);
  assert.equal(report.dry_run, false);
  assert.ok(report.drawer_id, "apply must return the new drawer id");
  // AC #11: filing goes through the checkpoint write path with one item.
  const add = fake.calls.find((c) => c.name === "checkpoint");
  assert.equal(add.args.items.length, 1);
  assert.equal(add.args.items[0].wing, WING);
  assert.equal(add.args.items[0].room, SKILLS_ROOM);
  assert.equal(add.args.items[0].content, CONTENT, "content must be filed verbatim");
  assert.equal(add.args.items[0].desc, "doc ingest procedure");

  const stamps = fake.calls.filter((c) => c.name === "kg_add");
  assert.equal(stamps.length, 2, "exactly two stamps on apply (es-source-type + es-domain)");
  assert.deepEqual(stamps[0].args, {
    subject: report.drawer_id,
    predicate: "es-source-type",
    object: "skill",
    source_closet: report.drawer_id,
  });
  // Phase 12: the domain stamp follows the source-type stamp on the same drawer.
  assert.deepEqual(stamps[1].args, {
    subject: report.drawer_id,
    predicate: "es-domain",
    object: "general",
    source_closet: report.drawer_id,
  });
  assert.equal(report.domain, "general");
  assert.ok(!stamps.some((s) => s.args.predicate === "es-status"), "es-status must never be touched");
});

test("Phase 12: an explicit domain is stamped verbatim on apply", async () => {
  const fake = makeFakePalace({ taxonomy: { [WING]: {} } });
  const report = await runSkillFiling({ call: fake.call, wing: WING, content: CONTENT, domain: "code", dryRun: false });

  assert.equal(report.ok, true);
  assert.equal(report.domain, "code");
  const stamps = fake.calls.filter((c) => c.name === "kg_add");
  assert.equal(stamps.length, 2);
  assert.deepEqual(stamps[1].args, {
    subject: report.drawer_id,
    predicate: "es-domain",
    object: "code",
    source_closet: report.drawer_id,
  });
});

test("Phase 12: an out-of-vocabulary domain is rejected before any MCP call", async () => {
  const fake = makeFakePalace({ taxonomy: { [WING]: {} } });
  await assert.rejects(
    () => runSkillFiling({ call: fake.call, wing: WING, content: CONTENT, domain: "coding", dryRun: false }),
    /unknown domain/
  );
  assert.deepEqual(fake.calls, [], "no MCP call may precede the validation error");
});

test("exact-duplicate guard: dry-run reports it, apply writes nothing", async () => {
  const fake = makeFakePalace({ taxonomy: { [WING]: {} }, duplicateOf: "drawer_proj_skills_old" });

  const preview = await runSkillFiling({ call: fake.call, wing: WING, content: CONTENT, dryRun: true });
  assert.equal(preview.duplicate_drawer_id, "drawer_proj_skills_old");
  assert.match(preview.next_step, /duplicate/i);

  const apply = await runSkillFiling({ call: fake.call, wing: WING, content: CONTENT, dryRun: false });
  assert.equal(apply.ok, true);
  assert.equal(apply.duplicate_drawer_id, "drawer_proj_skills_old");
  assert.deepEqual(fake.calls.filter((c) => c.name === "add_drawer"), [], "duplicate must not be filed twice");
  assert.deepEqual(fake.calls.filter((c) => c.name === "kg_add"), [], "no stamp when nothing is filed");
});

test("missing wing is an error report, not a throw", async () => {
  const fake = makeFakePalace({ taxonomy: { other: {} } });
  const report = await runSkillFiling({ call: fake.call, wing: WING, content: CONTENT, dryRun: true });
  assert.equal(report.ok, false);
  assert.match(report.error, /Wing not found/);
});

test("empty content throws", async () => {
  const fake = makeFakePalace({ taxonomy: { [WING]: {} } });
  await assert.rejects(() => runSkillFiling({ call: fake.call, wing: WING, content: "   ", dryRun: true }), /content is required/);
});

test("filing failure stops the pass before any stamp", async () => {
  const fake = makeFakePalace({ taxonomy: { [WING]: {} }, failAddDrawer: true });
  const report = await runSkillFiling({ call: fake.call, wing: WING, content: CONTENT, dryRun: false });

  assert.equal(report.ok, false);
  assert.match(report.error, /checkpoint failed/);
  assert.deepEqual(fake.calls.filter((c) => c.name === "kg_add"), [], "no stamp after a failed filing");
});

test("stamp failure is counted with a retry next_step", async () => {
  // The flag object is read at call time (the fake's closure captured the Set by
  // value at creation), so it must be MUTATED after add_drawer resolves.
  const failStampFor = new Set();
  const fake = makeFakePalace({ taxonomy: { [WING]: {} }, failStampFor });
  const originalCall = fake.call;
  fake.call = async (name, payload) => {
    if (name === "checkpoint") {
      const result = await originalCall(name, payload);
      for (const row of result.results || []) failStampFor.add(row.drawer_id);
      return result;
    }
    return originalCall(name, payload);
  };

  const report = await runSkillFiling({ call: fake.call, wing: WING, content: CONTENT, dryRun: false });
  assert.equal(report.ok, true);
  // Both kg_adds (es-source-type + es-domain) hit the same failing subject.
  assert.equal(report.stamp_failed, 2);
  assert.match(report.next_step, /UNSTAMPED/);
});

test("dry-run listing is bounded to one page even for a large room", async () => {
  const rows = Array.from({ length: 200 }, (_, i) => ({ drawer_id: `s${i}` }));
  const fake = makeFakePalace({ taxonomy: { [WING]: { skills: 200 } }, rooms: { [`${WING}/skills`]: rows } });

  const report = await runSkillFiling({ call: fake.call, wing: WING, content: CONTENT, dryRun: true });
  assert.equal(report.ok, true);
  assert.equal(report.room, "skills", "reuses the existing skills room");
  assert.equal(report.reused, true);
  const listings = fake.calls.filter((c) => c.name === "list_drawers");
  // probe (limit 1) + one bounded page — never paged past it.
  assert.ok(listings.length <= 3, `expected at most 3 list_drawers calls, got ${listings.length}`);
  assert.ok(listings.every((c) => c.args.limit <= 25), "no listing may exceed the bounded page size");
  assert.equal(report.pre_snapshot.total, 200);
});
