/**
 * MemgraphClient `es-*` axis + cross-type edge method group (Criterion 2 split).
 *
 * Moved verbatim from adapter/memgraph.ts: closet status / source-type / domain
 * axes, es-staleness flags, es-outcome counts, the one-hop cross-type readers
 * (concerns / refined-by / promoted-from / rules-out), and the Phase 8
 * prospective-memory read side (listReminders). Each function takes a
 * `MemgraphInternals` context; the MemgraphClient facade delegates to them.
 */

import { CLOSET_SOURCE_TYPES, SKILL_DOMAINS, type ClosetSourceType, type JsonMap, type SkillDomain } from "./memgraph-structure.ts";
import { asBoolean, asObject, asString, parseKgFacts, uniq, uniqueFromFactsByDirection } from "./memgraph-transport.ts";
import type { MemgraphInternals } from "./memgraph-internals.ts";

// ── P2-2: provisional -> active closet status ───────────────────────────────
// Status is an `es-status` KG fact on the closet, NOT a hall/label (halls are
// categorization). Written `provisional` at creation, promoted to `active` by
// validation once the closet has enough DIRECT source support. Every operation
// here is one-hop kg_query/kg_add/kg_invalidate — vanilla MemPalace only, no
// dependency on the graph-tools PR — so behavior is identical with or without it.

/** Count a closet's DIRECT sources via its outgoing one-hop synthesized-from edges. */
export async function countDirectSources(core: MemgraphInternals, closetId: string): Promise<number> {
  // Degrade to "no direct sources" on read failure (logged).
  const result = await core.kgQueryIgnoringFailure({
    entity: closetId,
    direction: "outgoing",
    predicate: "synthesized-from",
    recurse: false,
    max_depth: 1,
  }, `countDirectSources(${closetId}) read failure degrades to zero`);
  return uniqueFromFactsByDirection(parseKgFacts(result), "outgoing")
    .filter((id) => id !== closetId).length;
}

/** Read a closet's es-status. "provisional" | "active" | "unknown" (no stamp / legacy). */
export async function getClosetStatus(core: MemgraphInternals, closetId: string): Promise<"provisional" | "active" | "unknown"> {
  // Degrade to "unknown" on read failure (logged).
  const result = await core.kgQueryIgnoringFailure({
    entity: closetId,
    direction: "outgoing",
    predicate: "es-status",
    recurse: false,
    max_depth: 1,
  }, `getClosetStatus(${closetId}) read failure degrades to unknown`);
  const values = uniqueFromFactsByDirection(parseKgFacts(result), "outgoing");
  if (values.includes("active")) return "active";
  if (values.includes("provisional")) return "provisional";
  return "unknown";
}

/** Set a closet's es-status, invalidating the opposite value first. Idempotent-safe. */
export async function setClosetStatus(core: MemgraphInternals, closetId: string, status: "provisional" | "active", sourceRunId?: string): Promise<void> {
  const opposite = status === "active" ? "provisional" : "active";
  // Best-effort invalidation of the opposite value (logged on failure): a stale
  // opposite fact does not block setting the new status — the add below is the
  // authoritative write. The add itself is NOT best-effort: it throws on failure.
  const invalidateRes = await core.invoke("kgInvalidate", { subject: closetId, predicate: "es-status", object: opposite });
  if (invalidateRes.ok === false) {
    console.warn(`[memgraph] es-status invalidation of ${closetId}/${opposite} failed (kind=${invalidateRes.kind}), continuing to set new status: ${invalidateRes.detail}`);
  }
  await core.call("kgAdd", {
    subject: closetId,
    predicate: "es-status",
    object: status,
    source_closet: closetId,
    source_run_id: sourceRunId,
  });
}

// ── Phase 1: es-source-type stamp (orthogonal to es-status) ────────────────
// The `es-source-type` KG fact records what KIND of material a closet holds
// (transcript | doc | synthesis | skill). It is stamped at write time, never
// conflated with `es-status` — each setter scopes its kg_invalidate to its own
// predicate, so the two axes are independently settable by construction.

/** Read a closet's es-source-type. Returns null when unstamped or on read failure. */
export async function getClosetSourceType(core: MemgraphInternals, closetId: string): Promise<ClosetSourceType | null> {
  // Degrade to "unstamped" on read failure (logged).
  const result = await core.kgQueryIgnoringFailure({
    entity: closetId,
    direction: "outgoing",
    predicate: "es-source-type",
    recurse: false,
    max_depth: 1,
  }, `getClosetSourceType(${closetId}) read failure degrades to unstamped`);
  const values = uniqueFromFactsByDirection(parseKgFacts(result), "outgoing");
  for (const value of values) {
    if ((CLOSET_SOURCE_TYPES as readonly string[]).includes(value)) return value as ClosetSourceType;
  }
  return null;
}

// ── Phase 12: es-domain axis (skill drawers only) ───────────────────────────
// `es-domain` records which project domain a skill belongs to. Written at skill
// creation (file_skill / promote_skill); read by procedural retrieval to filter
// shared-skill admission. Same one-hop read discipline as es-source-type.

/** Read a closet's es-domain. Returns null when unstamped, out-of-vocabulary, or on read failure. */
export async function getClosetDomain(core: MemgraphInternals, closetId: string): Promise<SkillDomain | null> {
  // Degrade to "unstamped" on read failure (logged).
  const result = await core.kgQueryIgnoringFailure({
    entity: closetId,
    direction: "outgoing",
    predicate: "es-domain",
    recurse: false,
    max_depth: 1,
  }, `getClosetDomain(${closetId}) read failure degrades to unstamped`);
  const values = uniqueFromFactsByDirection(parseKgFacts(result), "outgoing");
  for (const value of values) {
    if ((SKILL_DOMAINS as readonly string[]).includes(value)) return value as SkillDomain;
  }
  return null;
}

/**
 * Set a closet's es-source-type, invalidating any previous value first
 * (best-effort). Returns true on success, false on failure — never throws in
 * the normal flow. Does not touch `es-status` facts.
 */
export async function setClosetSourceType(core: MemgraphInternals, closetId: string, sourceType: ClosetSourceType, sourceRunId?: string): Promise<boolean> {
  const previous = await getClosetSourceType(core, closetId);
  if (previous === sourceType) return true;
  if (previous && previous !== sourceType) {
    const supersedeRes = await core.invoke("kgSupersede", {
      subject: closetId,
      predicate: "es-source-type",
      old_object: previous,
      new_object: sourceType,
      source_closet: closetId,
      source_run_id: sourceRunId,
    });
    if (supersedeRes.ok === false) {
      console.warn(`[memgraph] es-source-type supersede for ${closetId} (${previous} -> ${sourceType}) failed (kind=${supersedeRes.kind}), leaving axis unchanged: ${supersedeRes.detail}`);
      return false;
    }
    return true;
  }
  const addRes = await core.invoke("kgAdd", {
    subject: closetId,
    predicate: "es-source-type",
    object: sourceType,
    source_closet: closetId,
    source_run_id: sourceRunId,
  });
  if (addRes.ok === false) {
    // non-fatal: leave the closet unstamped rather than fail the caller (logged).
    console.warn(`[memgraph] es-source-type set for ${closetId} failed (kind=${addRes.kind}), leaving axis unknown: ${addRes.detail}`);
    return false;
  }
  return true;
}


// ── Phase 11: es-staleness axis (temporal validity flag) ───────────────────
// `es-staleness` is a cross-type KG edge, NOT lineage: it must never count toward
// height or feed getLineageSources/getLineageDerivatives. One-hop by design — a
// staleness flag is a single marker on the node whose basis moved. The subject is
// the flagged node (typically a synthesis whose `concerns` target changed); the
// object is the flag value (`source-changed`). Flagging is soft: this axis NEVER
// invalidates or mutates `es-status`, `es-source-type`, `es-outcome`, `rules-out`,
// or any lineage predicate — its setter scopes kg_invalidate to `es-staleness`
// only, same discipline as es-status / es-source-type.

/** Read a node's es-staleness flag. Returns the current value (e.g. "source-changed") or null when unflagged or on read failure. */
export async function getStaleness(core: MemgraphInternals, nodeId: string): Promise<string | null> {
  // Degrade to "unflagged" on read failure (logged).
  const result = await core.kgQueryIgnoringFailure({
    entity: nodeId,
    direction: "outgoing",
    predicate: "es-staleness",
    recurse: false,
    max_depth: 1,
  }, `getStaleness(${nodeId}) read failure degrades to unflagged`);
  const values = uniqueFromFactsByDirection(parseKgFacts(result), "outgoing");
  return values.length > 0 ? values[0] : null;
}

/**
 * Aggregate es-staleness flags for a bounded set of node ids. One one-hop outgoing
 * kg_query per id, run with bounded concurrency (8 — the only validated level in
 * this repo), never more than `maxNodes` ids. Read failures degrade to null
 * (unflagged) per node, matching getClosetSourceType's discipline.
 */
export async function getStalenessFlags(
  core: MemgraphInternals,
  nodeIds: string[],
  options?: { maxNodes?: number; concurrency?: number },
): Promise<Map<string, string | null>> {
  const ids = uniq(nodeIds).slice(0, Math.max(1, Number(options?.maxNodes ?? 50)));
  const concurrency = Math.max(1, Math.min(8, Number(options?.concurrency ?? 8)));

  const out = new Map<string, string | null>();
  let cursor = 0;
  const run = async () => {
    while (cursor < ids.length) {
      const index = cursor;
      cursor += 1;
      const id = ids[index];
      // getStaleness already degrades a failed read to null (logged) and never
      // throws, so no wrapper is needed — the aggregate stays neutral per node.
      out.set(id, await getStaleness(core, id));
    }
  };
  const slots = Math.max(1, Math.min(concurrency, ids.length));
  if (ids.length > 0) await Promise.all(Array.from({ length: slots }, () => run()));
  return out;
}

/**
 * Set a node's es-staleness flag. If a previous `es-staleness` value exists and
 * differs, invalidate ONLY the prior `es-staleness` fact(s) for that node — never
 * `es-status`, `es-source-type`, `es-outcome`, `rules-out`, or lineage predicates.
 * Idempotent: when the current value already matches, no invalidation and no
 * duplicate kg_add are issued. Returns true on success, false on failure — never
 * throws in the normal flow.
 */
export async function setStalenessFlag(core: MemgraphInternals, nodeId: string, value: string, sourceRunId?: string): Promise<boolean> {
  const id = asString(nodeId).trim();
  if (!id) return false;
  const previous = await getStaleness(core, id);
  if (previous === value) {
    // Already current — no invalidation, no duplicate write.
    return true;
  }
  if (previous && previous !== value) {
    const supersedeRes = await core.invoke("kgSupersede", {
      subject: id,
      predicate: "es-staleness",
      old_object: previous,
      new_object: value,
      source_closet: id,
      source_run_id: sourceRunId,
    });
    if (supersedeRes.ok === false) {
      console.warn(`[memgraph] es-staleness supersede for ${id} (${previous} -> ${value}) failed (kind=${supersedeRes.kind}), leaving node unchanged: ${supersedeRes.detail}`);
      return false;
    }
    return true;
  }
  const addRes = await core.invoke("kgAdd", {
    subject: id,
    predicate: "es-staleness",
    object: value,
    source_closet: id,
    source_run_id: sourceRunId,
  });
  if (addRes.ok === false) {
    // non-fatal: leave the node unflagged rather than fail the caller (logged).
    console.warn(`[memgraph] es-staleness set for ${id} failed (kind=${addRes.kind}), leaving node unflagged: ${addRes.detail}`);
    return false;
  }
  return true;
}

// ── Phase 7: es-outcome axis (human-authoritative outcome feedback) ───────────
// `es-outcome` edges record whether a closet actually helped a unit of work that
// consulted it. Values: accept | revise | failed | unused. They ACCUMULATE —
// multiple edges per closet are expected and meaningful (6 accepts + 1 revise is
// different from 1 accept), so nothing here ever invalidates or collapses them.
// Writes go through recordOutcome only (the human-authoritative path); this class
// exposes the read side plus a validated single-edge writer for that path.

export const OUTCOME_VALUES: readonly string[] = ["accept", "revise", "failed", "unused"];

/**
 * Aggregate es-outcome counts for a bounded set of candidate node ids. One one-hop
 * outgoing kg_query per id, run with bounded concurrency (8 — the only validated
 * level in this repo), never more than `maxNodes` ids. Read failures degrade to
 * zero counts (neutral) per node, matching getClosetSourceType's discipline.
 */
export async function getOutcomeCounts(
  core: MemgraphInternals,
  nodeIds: string[],
  options?: { maxNodes?: number; concurrency?: number },
): Promise<Map<string, { accept: number; revise: number; failed: number; unused: number; total: number }>> {
  const ids = uniq(nodeIds).slice(0, Math.max(1, Number(options?.maxNodes ?? 50)));
  const concurrency = Math.max(1, Math.min(8, Number(options?.concurrency ?? 8)));
  const empty = () => ({ accept: 0, revise: 0, failed: 0, unused: 0, total: 0 });

  const out = new Map<string, { accept: number; revise: number; failed: number; unused: number; total: number }>();
  let cursor = 0;
  const run = async () => {
    while (cursor < ids.length) {
      const index = cursor;
      cursor += 1;
      const id = ids[index];
      // Degrade to "no history" on read failure (logged).
      const result = await core.kgQueryIgnoringFailure({
        entity: id,
        direction: "outgoing",
        predicate: "es-outcome",
        recurse: false,
        max_depth: 1,
      }, `getOutcomeCounts(${id}) read failure degrades to no history`);
      const counts = empty();
      for (const fact of parseKgFacts(result)) {
        if (!asBoolean(fact.current, true)) continue;
        const value = asString(fact.object).trim();
        if (value === "accept") counts.accept += 1;
        else if (value === "revise") counts.revise += 1;
        else if (value === "failed") counts.failed += 1;
        else if (value === "unused") counts.unused += 1;
        // unknown values are ignored — the axis is closed by construction
      }
      counts.total = counts.accept + counts.revise + counts.failed + counts.unused;
      out.set(id, counts);
    }
  };
  const slots = Math.max(1, Math.min(concurrency, ids.length));
  await Promise.all(Array.from({ length: slots }, () => run()));
  return out;
}

/**
 * Record ONE es-outcome edge for a closet (accumulation — never invalidates or
 * overwrites existing edges). `validFrom` timestamps the edge so consumers can
 * window recent history. Throws on an invalid outcome value: the axis is closed to
 * exactly accept | revise | failed | unused, and nothing else may enter it.
 */
export async function recordOutcome(core: MemgraphInternals, nodeId: string, outcome: string, validFrom?: string): Promise<void> {
  const id = asString(nodeId).trim();
  if (!id) throw new Error("recordOutcome: nodeId is required");
  if (!(OUTCOME_VALUES as readonly string[]).includes(outcome)) {
    throw new Error(
      `recordOutcome: invalid outcome "${outcome}" — must be one of ${OUTCOME_VALUES.join(" | ")}`,
    );
  }
  await core.call("kgAdd", {
    subject: id,
    predicate: "es-outcome",
    object: outcome,
    valid_from: validFrom,
    source_closet: id,
  });
}

// ── Phase 4: concerns (synthesis -> doc authority pointer) ────────────────
// `concerns` is a cross-type KG edge, NOT lineage: it must never count toward
// height or feed getLineageSources/getLineageDerivatives. One-hop by design —
// recursive concerns would create cycles through unrelated syntheses.

/**
 * One-hop outgoing `concerns` targets for a synthesis node (its authority docs).
 * Degrades to "no concerns" on read failure, matching getOutgoingObjects.
 */
export async function getConcerns(core: MemgraphInternals, nodeId: string): Promise<{ node_ids: string[]; count: number }> {
  // Degrade to "no concerns" on read failure (logged), matching getOutgoingObjects.
  const result = await core.kgQueryIgnoringFailure({
    entity: nodeId,
    direction: "outgoing",
    predicate: "concerns",
    recurse: false,
    max_depth: 1,
  }, `getConcerns(${nodeId}) read failure degrades to no concerns`);
  const nodeIds = uniqueFromFactsByDirection(parseKgFacts(result), "outgoing").filter(
    (id) => id !== nodeId,
  );
  return { node_ids: nodeIds, count: nodeIds.length };
}

// ── Phase 5: refined-by (skill -> evidence pointer) ───────────────────────
// `refined-by` is a cross-type KG edge, NOT lineage: it must never count toward
// height or feed getLineageSources/getLineageDerivatives. One-hop by design —
// recursive refined-by would create cycles through unrelated sessions/syntheses.

/**
 * One-hop incoming `refined-by` subjects for a session/synthesis/apprenticeship
 * node (the skills that point at it as evidence). Degrades to "no refined-by"
 * on read failure, matching getConcerns.
 */
export async function getRefinedBy(core: MemgraphInternals, nodeId: string): Promise<{ node_ids: string[]; count: number }> {
  // Degrade to "no refined-by" on read failure (logged), matching getConcerns.
  const result = await core.kgQueryIgnoringFailure({
    entity: nodeId,
    direction: "incoming",
    predicate: "refined-by",
    recurse: false,
    max_depth: 1,
  }, `getRefinedBy(${nodeId}) read failure degrades to no refined-by`);
  const nodeIds = uniqueFromFactsByDirection(parseKgFacts(result), "incoming").filter(
    (id) => id !== nodeId,
  );
  return { node_ids: nodeIds, count: nodeIds.length };
}

/**
 * One-hop outgoing `refined-by` targets for a skill node (the sessions/syntheses/
 * apprenticeship worked examples that changed how it should work). Degrades to
 * "no refined-by" on read failure, matching getConcerns.
 */
export async function getRefines(core: MemgraphInternals, nodeId: string): Promise<{ node_ids: string[]; count: number }> {
  // Degrade to "no refined-by" on read failure (logged), matching getConcerns.
  const result = await core.kgQueryIgnoringFailure({
    entity: nodeId,
    direction: "outgoing",
    predicate: "refined-by",
    recurse: false,
    max_depth: 1,
  }, `getRefines(${nodeId}) read failure degrades to no refined-by`);
  const nodeIds = uniqueFromFactsByDirection(parseKgFacts(result), "outgoing").filter(
    (id) => id !== nodeId,
  );
  return { node_ids: nodeIds, count: nodeIds.length };
}


// ── Phase 9: rules-out (dead-end / negative-knowledge pointer) ─────────────
// `rules-out` is a cross-type KG edge, NOT lineage: it must never count toward
// height or feed getLineageSources/getLineageDerivatives. One-hop by design —
// recursive rules-out would create cycles through unrelated syntheses. The
// subject is the dead-end drawer (a synthesis with negative polarity); the object
// is the ruled-out statement text (free-text by approved Phase 9 design).

// ── Phase 10: promoted-from (shared skill -> origin project skill) ───────────
// `promoted-from` is a cross-type KG edge, NOT lineage: it must never count toward
// height or feed getLineageSources/getLineageDerivatives. One-hop by design — the
// origin drawer is a single, stable pointer (a skill is promoted at most once; the
// duplicate guard in tools/promote_skill.ts keeps exactly one shared copy). The
// subject is the SHARED wing's skill drawer; the object is the originating project
// skill drawer, so provenance stays traceable after promotion.

/**
 * One-hop `promoted-from` origin for a (shared) skill node: the originating
 * project skill drawer id(s). Degrades to "no origin" on read failure, matching
 * getConcerns. Read-only — promotion itself is written by tools/promote_skill.ts.
 */
export async function getPromotedFrom(core: MemgraphInternals, nodeId: string): Promise<{ node_ids: string[]; count: number }> {
  // Degrade to "no origin" on read failure (logged), matching getConcerns.
  const result = await core.kgQueryIgnoringFailure({
    entity: nodeId,
    direction: "outgoing",
    predicate: "promoted-from",
    recurse: false,
    max_depth: 1,
  }, `getPromotedFrom(${nodeId}) read failure degrades to no origin`);
  const nodeIds = uniqueFromFactsByDirection(parseKgFacts(result), "outgoing").filter(
    (id) => id !== nodeId,
  );
  return { node_ids: nodeIds, count: nodeIds.length };
}

/**
 * One-hop outgoing `rules-out` facts for a dead-end node: the ruled-out statement
 * texts plus any polarity tokens ("tried-failed" | "considered-rejected"). Degrades
 * to "no rules-out" on read failure, matching getConcerns.
 */
export async function getRulesOut(core: MemgraphInternals, nodeId: string): Promise<{ statements: string[]; polarities: string[]; count: number }> {
  // Degrade to "no rules-out" on read failure (logged), matching getConcerns.
  const result = await core.kgQueryIgnoringFailure({
    entity: nodeId,
    direction: "outgoing",
    predicate: "rules-out",
    recurse: false,
    max_depth: 1,
  }, `getRulesOut(${nodeId}) read failure degrades to no rules-out`);
  const statements: string[] = [];
  const polarities: string[] = [];
  for (const fact of parseKgFacts(result)) {
    if (!asBoolean(fact.current, true)) continue;
    const object = asString(fact.object).trim();
    if (!object) continue;
    if (object === "tried-failed" || object === "considered-rejected") polarities.push(object);
    else statements.push(object);
  }
  return { statements: uniq(statements), polarities: uniq(polarities), count: uniq([...statements, ...polarities]).length };
}

/**
 * Phase 8 (unified memory): prospective-memory read side. One bounded page of
 * the reminders room + per-drawer one-hop kg_query for the reminder axes
 * (triggers-on / es-reminder-status / es-reminder-expires-at /
 * es-reminder-satisfied-at). Concurrency 8 — the only validated level in this
 * repo. Read failures degrade to empty facts per drawer (the render drops the
 * pending section rather than throwing); a failed room page degrades to [].
 */
export async function listReminders(
  core: MemgraphInternals,
  args: { wing: string; room?: string; limit?: number },
): Promise<
  Array<{
    drawer_id: string;
    what: string;
    status: string;
    conditions: string[];
    expires_at?: string;
    satisfied_at?: string;
  }>
> {
  const wing = asString(args.wing).trim();
  if (!wing) return [];
  const room = asString(args.room).trim() || "reminders";
  const limit = Math.max(1, Math.min(50, Number(args.limit) || 20));

  const pageRes = await core.invoke("listDrawers", { wing, room, limit, offset: 0 });
  if (pageRes.ok === false) {
    // non-fatal: the render degrades to "no pending section" (logged). A failed
    // room page must not look like "there are no reminders".
    console.warn(`[memgraph] listReminders room page (${wing}/${room}) failed (kind=${pageRes.kind}), rendering no pending section: ${pageRes.detail}`);
    return [];
  }
  const root = asObject(pageRes.value);
  const pool = Array.isArray(root.drawers)
    ? (root.drawers as unknown[])
    : Array.isArray(root.results)
      ? (root.results as unknown[])
      : [];
  const rows = pool.slice(0, limit).map((row) => asObject(row));

  const ids = rows
    .map((row) => asString(row.drawer_id || row.node_id || row.id).trim())
    .filter(Boolean);
  const byId = new Map<string, JsonMap>();
  for (const row of rows) {
    const id = asString(row.drawer_id || row.node_id || row.id).trim();
    if (id) byId.set(id, row);
  }

  const out: Array<{
    drawer_id: string;
    what: string;
    status: string;
    conditions: string[];
    expires_at?: string;
    satisfied_at?: string;
  }> = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < ids.length) {
      const index = cursor;
      cursor += 1;
      const id = ids[index];
      const row = byId.get(id) || {};
      const item: {
        drawer_id: string;
        what: string;
        status: string;
        conditions: string[];
        expires_at?: string;
        satisfied_at?: string;
      } = {
        drawer_id: id,
        what: asString(row.content || row.text).trim(),
        status: "unknown",
        conditions: [],
      };
      // Degrade to "no facts" on edge-read failure (logged).
      const result = await core.kgQueryIgnoringFailure(
        { entity: id, direction: "outgoing" },
        `listReminders(${id}) edge read failure degrades to no facts`,
      );
      for (const fact of parseKgFacts(result)) {
        if (!asBoolean(fact.current, true)) continue;
        const predicate = asString(fact.predicate).trim();
        const object = asString(fact.object).trim();
        if (!object) continue;
        if (predicate === "triggers-on") item.conditions.push(object);
        else if (predicate === "es-reminder-status") item.status = object.toLowerCase();
        else if (predicate === "es-reminder-expires-at") item.expires_at = object;
        else if (predicate === "es-reminder-satisfied-at") item.satisfied_at = object;
      }
      out.push(item);
    }
  };
  const slots = Math.max(1, Math.min(8, ids.length));
  if (ids.length > 0) await Promise.all(Array.from({ length: slots }, () => worker()));
  return out;
}
