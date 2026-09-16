import assert from "node:assert/strict";
import test from "node:test";

import {
  parseTriageFindings,
  parseTriageOptions,
  runTriagePhase,
  triageVerdict,
} from "../../src/scripts/memory-pipeline/triage.ts";

/**
 * Unit coverage for the triage pass — pass 1 of two-pass consolidation.
 *
 * The properties under test are the ones that decide whether a mis-handled
 * drawer is recoverable:
 *   - a tooling failure must never read as "no value here",
 *   - below-threshold drawers go to their OWN room, not the processed room, and
 *   - the score is stamped, so the threshold stays recalibratable.
 */

function item(drawerId, familyIds) {
  return { drawer_id: drawerId, wing: "w", room: "source-transcripts", ...(familyIds ? { family_drawer_ids: familyIds } : {}) };
}

function recordingClient() {
  const kgAdds = [];
  const moves = [];
  return {
    kgAdds,
    moves,
    kgAdd: async (args) => { kgAdds.push(args); return { ok: true }; },
    updateDrawer: async (args) => { moves.push(args); return { ok: true }; },
  };
}

const baseOptions = {
  only: true,
  agentName: "drawer-triage",
  batchSize: 10,
  minScore: 1,
  rejectedRoom: "source-transcripts-triage-rejected",
  timeoutMs: 1000,
  keepSessions: false,
};

test("parseTriageFindings keeps requested ids and drops fabricated ones", () => {
  const findings = parseTriageFindings(
    [
      { transcriptId: "a", spans: [{ kind: "decision", start: 1, end: 5 }] },
      { transcriptId: "ghost", spans: [{ kind: "fix", start: 1, end: 2 }] },
    ],
    ["a", "b"],
  );

  assert.deepEqual(findings.map((f) => f.transcriptId), ["a"]);
  assert.equal(findings[0].score, 1);
});

test("parseTriageFindings normalizes kind spellings and rejects unknown kinds", () => {
  const findings = parseTriageFindings(
    [{ transcriptId: "a", spans: [{ kind: "Root_Cause", start: 1, end: 2 }, { kind: "vibes", start: 3, end: 4 }] }],
    ["a"],
  );

  assert.deepEqual(findings[0].kinds, ["root-cause"]);
  assert.equal(findings[0].score, 1, "an unrecognised kind must not inflate the score");
});

test("parseTriageFindings merges repeated ids instead of overwriting", () => {
  const findings = parseTriageFindings(
    [
      { transcriptId: "a", spans: [{ kind: "decision", start: 1, end: 2 }] },
      { transcriptId: "a", spans: [{ kind: "fix", start: 9, end: 10 }] },
    ],
    ["a"],
  );

  assert.equal(findings.length, 1);
  assert.equal(findings[0].score, 2);
  assert.deepEqual(findings[0].kinds, ["decision", "fix"]);
});

test("an empty spans array is a valid answer scoring zero, not a parse failure", () => {
  const findings = parseTriageFindings([{ transcriptId: "a", spans: [] }], ["a"]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].score, 0);
  assert.equal(triageVerdict(findings[0].score, 1), "noise");
});

test("triageVerdict is a pure threshold over the stamped score", () => {
  assert.equal(triageVerdict(0, 1), "noise");
  assert.equal(triageVerdict(1, 1), "rich");
  assert.equal(triageVerdict(2, 3), "noise");
  assert.equal(triageVerdict(3, 3), "rich");
});

function envelopeOf(findings) {
  return async () => ({
    findings: findings.map((f) => ({ ...f, score: f.spans.length, kinds: [...new Set(f.spans.map((s) => s.kind))].sort() })),
    raw: null,
    via: "omp-run",
  });
}

const fakeRunner = { kind: "omp", bin: "/fake/omp" };

test("noise is stamped with its score and moved to the rejected room, never the processed room", async () => {
  const client = recordingClient();
  const result = await runTriagePhase({
    client,
    chunks: [[item("d1")]],
    options: baseOptions,
    toolPrefix: "mp_",
    runner: fakeRunner,
    targetWing: "w",
    sourceRoom: "source-transcripts",
    applyWrites: true,
    runId: "run-1",
    callTriage: envelopeOf([{ transcriptId: "d1", spans: [] }]),
  });

  assert.equal(result.noise, 1);
  assert.equal(result.rich, 0);

  assert.deepEqual(
    client.kgAdds.map((c) => [c.predicate, c.object]),
    [["es-triage", "noise"], ["es-triage-score", "0"]],
    "both the verdict and the raw score must be stamped so the threshold stays recalibratable",
  );
  assert.equal(client.kgAdds[0].source_run_id, "run-1");

  assert.equal(client.moves.length, 1);
  assert.equal(client.moves[0].room, "source-transcripts-triage-rejected");
  assert.notEqual(client.moves[0].room, "source-transcripts-processed");
});

test("rich drawers are stamped but left in the source room for the thorough pass", async () => {
  const client = recordingClient();
  const result = await runTriagePhase({
    client,
    chunks: [[item("d1")]],
    options: baseOptions,
    toolPrefix: "mp_",
    runner: fakeRunner,
    targetWing: "w",
    sourceRoom: "source-transcripts",
    applyWrites: true,
    callTriage: envelopeOf([
      { transcriptId: "d1", spans: [{ kind: "decision", start: 1, end: 4 }, { kind: "fix", start: 7, end: 9 }] },
    ]),
  });

  assert.equal(result.rich, 1);
  assert.equal(client.moves.length, 0, "a rich drawer must stay where the consolidation worklist will find it");
  assert.deepEqual(
    client.kgAdds.map((c) => [c.predicate, c.object]),
    [["es-triage", "rich"], ["es-triage-score", "2"]],
  );
});

test("an id the triage pass omitted is left in place rather than treated as noise", async () => {
  const client = recordingClient();
  const result = await runTriagePhase({
    client,
    chunks: [[item("d1"), item("d2")]],
    options: baseOptions,
    toolPrefix: "mp_",
    runner: fakeRunner,
    targetWing: "w",
    sourceRoom: "source-transcripts",
    applyWrites: true,
    callTriage: envelopeOf([{ transcriptId: "d1", spans: [] }]),
  });

  assert.equal(result.noise, 1, "d1 answered with zero spans");
  assert.equal(result.unavailable, 1, "d2 was never answered for");
  assert.equal(
    result.outcomes.find((o) => o.drawer_id === "d2").reason,
    "triage-omitted-id",
    "an omitted id is a tooling gap and must be distinguishable from a real zero-span answer",
  );
  assert.equal(client.moves.length, 1, "only the answered-and-empty drawer moves");
  assert.equal(client.moves[0].drawer_id, "d1");
});

test("a family drawer scores on spans found in any of its parts", async () => {
  const client = recordingClient();
  const result = await runTriagePhase({
    client,
    chunks: [[item("d1", ["d1", "d1b"])]],
    options: baseOptions,
    toolPrefix: "mp_",
    runner: fakeRunner,
    targetWing: "w",
    sourceRoom: "source-transcripts",
    applyWrites: true,
    callTriage: envelopeOf([{ transcriptId: "d1b", spans: [{ kind: "decision", start: 2, end: 3 }] }]),
  });

  assert.equal(result.rich, 1);
  assert.equal(client.kgAdds.length, 4, "both family members get both stamps");
});

test("dry run scores and reports without stamping or moving anything", async () => {
  const client = recordingClient();
  const result = await runTriagePhase({
    client,
    chunks: [[item("d1")]],
    options: baseOptions,
    toolPrefix: "mp_",
    runner: fakeRunner,
    targetWing: "w",
    sourceRoom: "source-transcripts",
    applyWrites: false,
    callTriage: envelopeOf([{ transcriptId: "d1", spans: [] }]),
  });

  assert.equal(result.noise, 1);
  assert.equal(result.applyWrites, false);
  assert.equal(client.kgAdds.length, 0);
  assert.equal(client.moves.length, 0);
});

test("a missing runner leaves every drawer in place rather than rejecting it", async () => {
  const client = recordingClient();
  const result = await runTriagePhase({
    client,
    chunks: [[item("d1"), item("d2")]],
    options: baseOptions,
    toolPrefix: "mp_",
    runner: undefined,
    targetWing: "w",
    sourceRoom: "source-transcripts",
    applyWrites: true,
  });

  assert.equal(result.examined, 2);
  assert.equal(result.unavailable, 2);
  assert.equal(result.rich + result.noise, 0);
  assert.deepEqual(result.outcomes.map((o) => o.reason), ["triage-unavailable", "triage-unavailable"]);
  assert.equal(client.moves.length, 0);
  assert.equal(client.kgAdds.length, 0);
});

test("parseTriageOptions defaults the rejected room off the source room", () => {
  const options = parseTriageOptions([], { valuesByPath: {} }, "source-transcripts");
  assert.equal(options.rejectedRoom, "source-transcripts-triage-rejected");
  assert.notEqual(options.rejectedRoom, "source-transcripts-processed");
  assert.equal(options.only, false);
  assert.equal(options.minScore, 1);
  assert.equal(options.batchSize, 10);
  assert.equal(options.agentName, "drawer-triage");
});

test("parseTriageOptions lets CLI flags beat config", () => {
  const options = parseTriageOptions(
    ["--triage-only", "--triage-min-score", "4", "--triage-batch-size", "25", "--triage-model", "litellm/general-gemma4:26b"],
    { valuesByPath: { consolidation: { triage: { minScore: 1, batchSize: 10 } } } },
    "source-transcripts",
  );

  assert.equal(options.only, true);
  assert.equal(options.minScore, 4);
  assert.equal(options.batchSize, 25);
  assert.deepEqual(options.model, { providerID: "litellm", modelID: "general-gemma4:26b" });
});

test("parseTriageOptions ignores a malformed model selector instead of throwing", () => {
  const options = parseTriageOptions(["--triage-model", "not-a-selector"], { valuesByPath: {} }, "source-transcripts");
  assert.equal(options.model, undefined);
});
