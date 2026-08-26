import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";

import { expandScopedRetrieval } from "../../adapter/retrieval-expansion.ts";
import { runDocIngest } from "../../tools/ingest_docs.ts";

/**
 * Phase 3 close-out (unified memory): ingest -> retrieval consumption in ONE scenario.
 *
 * The Phase 6 consumption audit ruled Phase 3 PARTIAL because ingested docs were
 * invisible to scoped ranked retrieval until a Phase 4 `concerns` edge linked them.
 * This test proves the closed loop against a single fake palace shared by both sides:
 *   1. dry-run makes no mine/KG calls; apply mines and stamps es-source-type: doc;
 *   2. BEFORE any concerns edge exists, factual retrieval admits the ingested doc
 *      directly (via: "doc") — the exact failure mode the audit flagged;
 *   3. after a synthesis + approved concerns edge are added, the doc is still present
 *      exactly once (no duplicate admission) and outranks its provisional synthesis
 *      (the factual floor engages with real members);
 *   4. idempotency: a second apply over unchanged files changes nothing in the pool.
 */

const WING = "proj";
const ROOM = "reference";

let docDir;

before(() => {
  docDir = mkdtempSync(join(tmpdir(), "ingest-docs-retrieval-"));
});

after(() => {
  rmSync(docDir, { recursive: true, force: true });
});

/**
 * Fake palace shared by the write side (runDocIngest) and the read side
 * (expandScopedRetrieval). `rooms` maps "wing/room" -> drawer rows; `kgFacts` maps
 * entity id -> array of facts or a handler function. The mine behavior mutates the
 * room state to simulate purge+reinsert, exactly like the unit-suite fake.
 */
function makeSharedFakePalace({ rooms = {}, kgFacts = {} } = {}) {
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
    if (name === "get_taxonomy") return { taxonomy: { [WING]: { [ROOM]: (state[`${WING}/${ROOM}`] || []).length } } };
    if (name === "list_drawers") return listDrawers(payload.wing, payload.room, payload.limit, payload.offset);
    if (name === "mine") {
      const existing = state[`${WING}/${ROOM}`] || [];
      const preserved = existing.filter((row) => row.drawer_id !== "doc-1" && row.drawer_id !== "doc-2");
      state[`${WING}/${ROOM}`] = [
        { drawer_id: "doc-1", wing: WING, room: ROOM, desc: "Gateway API reference", metadata: { source_file: "api.md" } },
        { drawer_id: "doc-2", wing: WING, room: ROOM, desc: "Config schema guide", metadata: { source_file: "config.md" } },
        ...preserved,
      ];
      return { success: true, output: "[DRY RUN] api.md -> room:reference (1 drawer)\n[DRY RUN] config.md -> room:reference (1 drawer)" };
    }
    if (name === "kg_query") {
      const handler = kgFacts[payload.entity];
      if (typeof handler === "function") return handler(payload) || { facts: [] };
      if (handler) return { facts: handler };
      return { facts: [] };
    }
    if (name === "kg_add" || name === "kg_invalidate") return {};
    if (name === "get_drawer") {
      for (const rows of Object.values(state)) {
        const row = rows.find((r) => r.drawer_id === payload.drawer_id);
        if (row) return { ...row };
      }
      return {};
    }
    return {};
  };

  // Retrieval-side client over the same state. listScopedDerivedDrawers returns only
  // drawers with an outgoing synthesized-from edge (the strict gate, mirroring
  // memgraph.ts) — standalone docs never pass it, which is why the direct doc scan
  // exists.
  const client = {
    getHallPolicy: async () => ({}),
    search: async () => ({ results: [] }),
    resolveCanonical: async () => ({}),
    getLineageSources: async () => ({}),
    getLineageDerivatives: async () => ({}),
    listScopedDerivedDrawers: async () => {
      const nodes = [];
      for (const rows of Object.values(state)) {
        for (const row of rows) {
          const facts = kgFacts[row.drawer_id];
          const outgoingSynth = Array.isArray(facts) ? facts : typeof facts === "function" ? facts({}) || [] : [];
          if (outgoingSynth.some((f) => f.predicate === "synthesized-from" && f.subject === row.drawer_id && f.current !== false)) {
            nodes.push({
              node_id: row.drawer_id,
              labels: [],
              wing: row.wing || WING,
              room: row.room || ROOM,
              desc: row.desc || "",
              height: 1,
              retrieval_count: 0,
              connection_degree: 0,
              lineage_match_count: 1,
            });
          }
        }
      }
      return { nodes };
    },
    getClosetStatus: async (id) => {
      const facts = kgFacts[id];
      if (Array.isArray(facts)) {
        const status = facts.find((f) => f.predicate === "es-status" && f.subject === id && f.current !== false);
        if (status) return status.object;
      }
      return "unknown";
    },
    getClosetSourceType: async (id) => {
      const facts = kgFacts[id];
      if (Array.isArray(facts)) {
        const type = facts.find((f) => f.predicate === "es-source-type" && f.subject === id && f.current !== false);
        if (type) return type.object;
      }
      return null;
    },
    // Phase 4: outgoing concerns targets of a synthesis (mirrors memgraph.getConcerns).
    getConcerns: async (id) => {
      const facts = kgFacts[id];
      if (!Array.isArray(facts)) return { node_ids: [], count: 0 };
      const ids = [...new Set(
        facts.filter((f) => f.predicate === "concerns" && f.subject === id && f.current !== false).map((f) => f.object),
      )].filter((oid) => oid !== id);
      return { node_ids: ids, count: ids.length };
    },
    getDrawer: async ({ drawer_id }) => {
      for (const rows of Object.values(state)) {
        const row = rows.find((r) => r.drawer_id === drawer_id);
        if (row) return { ...row };
      }
      return {};
    },
    listDrawers: async ({ wing, room, limit, offset }) => listDrawers(wing || WING, room || ROOM, limit, offset),
  };

  return { call, calls, state, client, kgFacts };
}

const fact = (subject, predicate, object, current = true) => ({ subject, predicate, object, current });

test("ingest docs -> direct factual retrieval -> concerns edge, no duplicate admission", async () => {
  const { call, calls, state, client, kgFacts } = makeSharedFakePalace();

  // ---- 1) Write side: dry-run first (read-only), then apply. ----
  const dryReport = await runDocIngest({ call, path: docDir, wing: WING, dryRun: true });
  assert.equal(dryReport.ok, true);
  assert.equal(dryReport.dry_run, true);
  assert.equal(dryReport.room, ROOM);
  let mutating = calls.filter((c) => c.name === "mine" || c.name === "kg_add" || c.name === "kg_invalidate");
  assert.equal(mutating.length, 0, "dry-run must make no mine/KG calls");

  const applyReport = await runDocIngest({ call, path: docDir, wing: WING, dryRun: false });
  assert.equal(applyReport.ok, true);
  assert.equal(applyReport.dry_run, false);
  mutating = calls.filter((c) => c.name === "mine" || c.name === "kg_add" || c.name === "kg_invalidate");
  assert.ok(mutating.length > 0, "apply must mine and stamp");
  const stamped = new Set(
    calls.filter((c) => c.name === "kg_add" && c.args.predicate === "es-source-type").map((c) => c.args.subject),
  );
  assert.deepEqual([...stamped].sort(), ["doc-1", "doc-2"], "both ingested drawers must be stamped doc");

  // The fake palace now models the stamps as KG facts (as the substrate would).
  kgFacts["doc-1"] = [fact("doc-1", "es-source-type", "doc")];
  kgFacts["doc-2"] = [fact("doc-2", "es-source-type", "doc")];

  // ---- Step 2: BEFORE any concerns edge, factual retrieval admits the doc directly. ----
  const before = await expandScopedRetrieval(client, {
    query: "what does the gateway API define",
    scope_room: ROOM,
    scope_wing: WING,
    intent: "factual",
    top_n: 10,
  });

  const beforeIds = before.ranked_nodes.map((n) => n.node_id);
  assert.ok(beforeIds.includes("doc-1"), `ingested doc must be ranked before any link exists: ${JSON.stringify(beforeIds)}`);
  const byIdBefore = Object.fromEntries(before.ranked_nodes.map((n) => [n.node_id, n]));
  assert.equal(byIdBefore["doc-1"].via, "doc", `direct admission must be marked via: 'doc', got: ${byIdBefore["doc-1"].via}`);
  assert.equal(byIdBefore["doc-1"].source_type, "doc");
  // No synthesis in the pool yet -> no concerns expansion, no floor work.
  assert.equal(before.filters.doc_scan.enabled, true);
  assert.ok(before.filters.doc_scan.targets_admitted >= 2, `both docs should be admitted: ${JSON.stringify(before.filters.doc_scan)}`);

  // ---- 3) Add a synthesis + approved concerns edge (the way propose_concerns writes it). ----
  state[`${WING}/${ROOM}`].push({ drawer_id: "synth-1", wing: WING, room: ROOM, desc: "Gateway architecture synthesis" });
  kgFacts["synth-1"] = [
    fact("synth-1", "es-source-type", "synthesis"),
    fact("synth-1", "es-status", "provisional"),
    fact("synth-1", "synthesized-from", "doc-1"), // derived drawer: has lineage, passes the scope gate
  ];
  kgFacts["doc-1"] = [fact("doc-1", "es-source-type", "doc")];
  // The concerns edge is stored on the SYNTHESIS (subject) — that is how propose_concerns writes it.
  kgFacts["synth-1"].push(fact("synth-1", "concerns", "doc-1"));

  const after = await expandScopedRetrieval(client, {
    query: "what does the gateway API define",
    scope_room: ROOM,
    scope_wing: WING,
    intent: "factual",
    top_n: 10,
    include_provisional: true,
  });

  const afterIds = after.ranked_nodes.map((n) => n.node_id);
  // Exactly one entry for doc-1 — no duplicate admission by the two paths.
  assert.equal(
    after.ranked_nodes.filter((n) => n.node_id === "doc-1").length,
    1,
    `doc must appear exactly once: ${JSON.stringify(afterIds)}`
  );
  const byIdAfter = Object.fromEntries(after.ranked_nodes.map((n) => [n.node_id, n]));
  // The edge path wins the via precedence: the concerns block runs before the doc scan,
  // so a linked doc is admitted as via: "concern" and the direct scan dedupes it.
  assert.equal(byIdAfter["doc-1"].via, "concern", `via must be 'concern' once linked, got: ${byIdAfter["doc-1"].via}`);
  assert.ok(afterIds.includes("synth-1"), `the synthesis must be in the pool: ${JSON.stringify(afterIds)}`);

  // The factual floor engages with real members: the provisional synthesis is clamped
  // to at most the doc's score and never presents above its own authority doc.
  assert.ok(
    afterIds.indexOf("doc-1") < afterIds.indexOf("synth-1"),
    `doc must outrank its provisional synthesis on factual intent: ${JSON.stringify(afterIds)}`
  );
  assert.ok(
    byIdAfter["synth-1"].score <= byIdAfter["doc-1"].score + 1e-9,
    `floor violated: synth ${byIdAfter["synth-1"].score} above doc ${byIdAfter["doc-1"].score}`
  );

  console.log(
    `[worked-example] ingest->retrieval: before-link doc-1 via=doc score=${byIdBefore["doc-1"].score.toFixed(6)}; ` +
      `after-link doc-1 via=concern score=${byIdAfter["doc-1"].score.toFixed(6)}, synth-1 clamped to ${byIdAfter["synth-1"].score.toFixed(6)}`
  );

  // ---- Step 4: idempotency - a second apply over unchanged files changes nothing. ----
  const poolBefore = JSON.stringify(after.ranked_nodes.map((n) => [n.node_id, n.via, n.score]));
  const rerun = await runDocIngest({ call, path: docDir, wing: WING, dryRun: false });
  assert.equal(rerun.ok, true);

  const again = await expandScopedRetrieval(client, {
    query: "what does the gateway API define",
    scope_room: ROOM,
    scope_wing: WING,
    intent: "factual",
    top_n: 10,
    include_provisional: true,
  });
  const poolAfter = JSON.stringify(again.ranked_nodes.map((n) => [n.node_id, n.via, n.score]));
  assert.equal(poolAfter, poolBefore, "re-ingest over unchanged files must not change the ranked pool");
});
