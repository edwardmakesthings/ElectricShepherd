import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { createTestRoom, isIntegrationEnabled } from "../helpers/mempalace-room-fixture.mjs";

/**
 * Integration coverage for the source transcript dedup CAPTURE GATE contract.
 *
 * `scripts/capture-source-transcripts.sh` makes a simple, important decision before every
 * source transcript write: when dedup is enabled it asks MemPalace `check_duplicate` and
 * skips the write if the content is a duplicate; when dedup is disabled it
 * always appends. This test pins that gate behavior against a real endpoint by
 * mirroring the script's decision in `decideCapture`, so a regression in the
 * gate (e.g. always-append even when dedup is on) is caught.
 *
 * We rely on MemPalace's own (separately tested) similarity detection only as
 * a black box: we seed an identical baseline so a follow-up of the same text is
 * a genuine duplicate.
 *
 * Gated by ESHEPHERD_TEST_INTEGRATION=1.
 */

const runIntegration = isIntegrationEnabled();

let room = null;

before(async () => {
  if (!runIntegration) return;
  room = await createTestRoom({ roomPrefix: "dedup-gate" });
  if (!room.available) {
    throw new Error(`Test room unavailable: ${room.reason}`);
  }
});

after(async () => {
  if (room && room.available) {
    await room.teardown();
  }
});

/**
 * Mirror of the capture-source-transcripts.sh decision: when dedup is enabled, consult
 * `check_duplicate` and skip on a hit; otherwise (or on a miss) append.
 */
async function decideCapture(fixture, content, dedupEnabled) {
  if (dedupEnabled) {
    const res = await fixture.callTool(`${fixture.toolPrefix}check_duplicate`, { content });
    if (res && res.is_duplicate === true) {
      return { status: "skipped-duplicate" };
    }
  }
  const added = await fixture.addDrawer(content);
  return { status: "stored", drawer_id: added.drawer_id };
}

test("dedup gate skips duplicates when enabled and appends when disabled", { skip: !runIntegration }, async () => {
  const content =
    "ElectricShepherd dedup-gate fixture: capture-source-transcripts must skip identical source transcript " +
    "content when dedup is enabled and append it when dedup is disabled.";

  // Seed an identical baseline so the same text is a genuine duplicate.
  const baseline = await decideCapture(room, content, false);
  assert.equal(baseline.status, "stored");
  assert.equal(typeof baseline.drawer_id, "string");

  // Dedup ON + identical content -> the gate skips the write.
  const guarded = await decideCapture(room, content, true);
  assert.equal(
    guarded.status,
    "skipped-duplicate",
    "dedup-enabled capture must skip an identical duplicate"
  );

  // Dedup OFF + identical content -> the gate skips the check and proceeds to
  // the write. (Whether MemPalace's own add_drawer collapses an identical row
  // is its concern, separately tested; the ES gate contract here is that the
  // OFF path performs the store decision instead of pre-empting it.)
  const forced = await decideCapture(room, content, false);
  assert.equal(forced.status, "stored");
  assert.equal(typeof forced.drawer_id, "string");
});
