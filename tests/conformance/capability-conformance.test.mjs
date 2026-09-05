import assert from "node:assert/strict";
import test from "node:test";

import {
  writeEpisodicSynthesis,
  writeEpisodicSynthesisStrict,
  readEpisodicLineage,
  EpisodicWriteError,
} from "../../src/capability/episodic/index.ts";
import {
  planDocIngest,
  readAuthorityRanked,
  readAuthorityRankedStrict,
  SemanticReadError,
} from "../../src/capability/semantic/index.ts";
import {
  planWorkedExampleWrite,
  readWorkedExampleDemonstrations,
} from "../../src/capability/procedural/index.ts";
import {
  planReminderWrite,
  readPendingForScope,
  readRemindersSafe,
} from "../../src/capability/prospective/index.ts";
import {
  writeDeadEnds,
  readDeadEndsLabelled,
  describeDeadEndFailure,
  RULED_OUT_MARKER,
} from "../../src/capability/negative/index.ts";
import {
  planCapabilityTuple,
  readCapabilityRouting,
  readCapabilityRoutingStrict,
  EvaluativeReadError,
} from "../../src/capability/evaluative/index.ts";

const BASE_OPTIONS = {
  query: "how to fix gateway retries",
  targetWing: "w",
  targetRoom: "synthesis",
  mapperSummaries: [
    {
      transcriptId: "raw-1",
      confidence: "high",
      durableFacts: ["f1"],
      decisions: ["d1"],
      rootCausesAndWorkedExamples: ["r1"],
      subsystemsAndFiles: ["a.ts"],
      openItems: ["o1"],
    },
    {
      transcriptId: "raw-2",
      confidence: "medium",
      durableFacts: ["f2"],
      decisions: ["d2"],
      rootCausesAndWorkedExamples: ["r2"],
      subsystemsAndFiles: ["b.ts"],
      openItems: ["o2"],
    },
  ],
};

function makeRetrievalClient(overrides = {}) {
  return {
    getHallPolicy: async () => ({}),
    search: async () => ({ results: [] }),
    resolveCanonical: async (id) => ({ canonical_node_id: id }),
    getLineageSources: async () => ({ node_ids: [] }),
    getLineageDerivatives: async () => ({ node_ids: [] }),
    listScopedDerivedDrawers: async () => ({
      nodes: [
        {
          node_id: "doc-1",
          wing: "w",
          room: "synthesis",
          labels: [],
          desc: "doc",
          height: 0,
          retrieval_count: 0,
          connection_degree: 0,
          lineage_match_count: 0,
        },
      ],
    }),
    getClosetStatus: async () => "active",
    getClosetSourceType: async () => "doc",
    ...overrides,
  };
}

test("conformance: episodic write/read/fail", async () => {
  const writeClient = {
    search: async () => ({ results: [] }),
    createDerivedDrawer: async () => ({ node_id: "synth-1" }),
    kgAdd: async () => ({ success: true }),
    fileDeadEnd: async () => ({ success: true, node_id: "dead-1", rules_out_edges_added: 1, errors: [] }),
  };
  const writeRes = await writeEpisodicSynthesis(writeClient, { ...BASE_OPTIONS, applyWrites: true });
  assert.equal(writeRes.inflationGuard.passed, true);
  assert.equal(writeRes.createdNodeId, "synth-1");

  const readRes = await readEpisodicLineage(
    {
      getLineageSources: async () => ({ node_ids: ["raw-1", "raw-2"] }),
      getLineageDerivatives: async () => ({ node_ids: ["synth-1"] }),
    },
    "synth-1",
  );
  assert.deepEqual(readRes.sources.sort(), ["raw-1", "raw-2"]);
  assert.deepEqual(readRes.derivatives, ["synth-1"]);

  await assert.rejects(
    () =>
      writeEpisodicSynthesisStrict(
        {
          search: async () => ({ results: [] }),
          createDerivedDrawer: async () => ({ success: false }),
          kgAdd: async () => ({ success: true }),
          fileDeadEnd: async () => ({ success: true, node_id: "dead-1", rules_out_edges_added: 1, errors: [] }),
        },
        { ...BASE_OPTIONS, applyWrites: true },
      ),
    (err) => err instanceof EpisodicWriteError,
  );
});

test("conformance: semantic write/read/fail", async () => {
  const plan = planDocIngest({
    wing: "w",
    room: "reference",
    content: "doc content",
    drawer_id: "doc-1",
    concerns_synthesis_ids: ["synth-1"],
  });
  assert.equal(plan.edges.some((e) => e.predicate === "es-source-type" && e.object === "doc"), true);

  const readRes = await readAuthorityRanked(makeRetrievalClient(), {
    query: "gateway",
    scope_room: "synthesis",
    top_n: 5,
  });
  assert.equal(Array.isArray(readRes.ranked_nodes), true);

  await assert.rejects(
    () =>
      readAuthorityRankedStrict(
        makeRetrievalClient({
          search: async () => {
            throw new Error("search down");
          },
        }),
        { query: "gateway", scope_room: "synthesis" },
      ),
    (err) => err instanceof SemanticReadError,
  );
});

test("conformance: procedural write/read/fail", async () => {
  const writePlan = planWorkedExampleWrite({
    subagentType: "implement-cloud",
    description: "Fix retry loop",
    output:
      "Applied targeted fix with verification and regression coverage across transport retry classification, gateway status propagation, and conformance flow guards. " +
      "Added focused tests for stale-library error surfacing, no-retry classification semantics, lineage-bearing synthesis creation constraints, and read/write/fail coverage paths that exercise successful write planning and deterministic retrieval shaping under bounded candidate expansion.",
    drawer_id: "ex-1",
  });
  assert.ok(writePlan);
  assert.equal(writePlan.edges.some((e) => e.predicate === "es-source-type" && e.object === "worked-example"), true);

  const readRes = await readWorkedExampleDemonstrations(
    {
      search: async () => ({
        results: [
          { drawer_id: "ex-1", content: "retry loop fix with gateway backoff cleanup" },
        ],
      }),
      getDrawer: async () => ({ drawer_id: "ex-1", wing: "w", room: "apprenticeship", content: "retry loop fix with gateway backoff cleanup" }),
      getClosetSourceType: async () => "worked-example",
    },
    { query: "retry loop fix", limit: 2 },
  );
  assert.equal(readRes.examples.length, 1);
  assert.match(readRes.section, /Demonstrations/);

  const degraded = await readWorkedExampleDemonstrations(
    {
      search: async () => {
        throw new Error("search unavailable");
      },
    },
    { query: "retry loop fix", limit: 2 },
  );
  assert.deepEqual(degraded.examples, []);
  assert.equal(degraded.section, "");
});

test("conformance: prospective write/read/fail", async () => {
  const writePlan = planReminderWrite({
    wing: "w",
    what: "check retry metrics",
    conditions: ["adapter/**"],
    expires_at: "2026-12-31T00:00:00.000Z",
    drawer_id: "rem-1",
  });
  assert.equal(writePlan.edges.some((e) => e.predicate === "triggers-on"), true);

  const readRes = readPendingForScope(
    [
      {
        drawer_id: "rem-1",
        what: "check retry metrics",
        conditions: ["adapter/**"],
        status: "active",
        expires_at: "2026-12-31T00:00:00.000Z",
      },
    ],
    { relScopes: ["", "adapter"], wing: "w", room: "synthesis" },
    new Date("2026-09-03T00:00:00.000Z"),
  );
  assert.equal(readRes.matches.length, 1);
  assert.equal(readRes.lines[0], "## [pending]");

  const failed = await readRemindersSafe(
    {
      listReminders: async () => {
        throw new Error("kg_query failed");
      },
    },
    "w",
  );
  assert.equal(failed.ok, false);
  if (failed.ok === false) {
    assert.equal(failed.kind, "read-failed");
  }
});

test("conformance: negative write/read/fail", async () => {
  const writeRes = await writeDeadEnds(
    {
      fileDeadEnd: async () => ({ success: true, node_id: "dead-1", rules_out_edges_added: 2, errors: [] }),
    },
    {
      wing: "w",
      room: "synthesis",
      lines: [
        'cache marker approach | outcome: failed in practice | because: "stripped" | polarity: tried-failed',
      ],
      source_drawer_ids: ["raw-1", "raw-2"],
    },
  );
  assert.equal(writeRes.filed, 1);
  assert.equal(writeRes.failed, 0);

  const rendered = readDeadEndsLabelled([
    'cache marker approach | outcome: failed in practice | because: "stripped" | polarity: tried-failed',
  ]);
  assert.equal(rendered.some((line) => line.includes(RULED_OUT_MARKER)), true);

  const failedWrite = await writeDeadEnds(
    {
      fileDeadEnd: async () => {
        throw new Error("fileDeadEnd exploded");
      },
    },
    {
      wing: "w",
      room: "synthesis",
      lines: [
        'cache marker approach | outcome: failed in practice | because: "stripped" | polarity: tried-failed',
      ],
      source_drawer_ids: ["raw-1", "raw-2"],
    },
  );
  assert.equal(failedWrite.failed, 1);
  assert.match(describeDeadEndFailure(failedWrite.errors), /negative write failed/);
});

test("conformance: evaluative write/read/fail", async () => {
  const tuple = planCapabilityTuple({
    subagentType: "implement-local",
    taskText: "Fix retry loop in gateway.ts",
    status: "success",
  });
  assert.ok(tuple);
  assert.equal(tuple.edges.some((e) => e.predicate === "es-capability-outcome"), true);

  const readRes = await readCapabilityRouting(
    {
      getCapabilityRoutingEvidence: async () => ({
        tiers: { local: { accept: 5, revise: 0, failed: 0, unused: 0, total: 5, sufficient_sample: true } },
        recommendation: "local",
        fallback: false,
        threshold: 5,
      }),
    },
    "shape-1",
  );
  assert.equal(readRes.recommendation, "local");

  await assert.rejects(
    () =>
      readCapabilityRoutingStrict(
        {
          getCapabilityRoutingEvidence: async () => {
            throw new Error("kg unavailable");
          },
        },
        "shape-1",
      ),
    (err) => err instanceof EvaluativeReadError,
  );
});
