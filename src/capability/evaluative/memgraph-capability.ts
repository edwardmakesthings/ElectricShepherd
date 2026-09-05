/**
 * MemgraphClient capability / failure-mode / calibration method group (Criterion 2 split).
 *
 * Moved verbatim from adapter/memgraph.ts: learned-routing evidence,
 * per-model failure-mode memory + intervention patches, and
 * confidence calibration. The closed vocabulary constants live here; the
 * MemgraphClient facade re-exports them as static members so external references
 * (MemgraphClient.OUTCOME_VALUES etc.) keep working unchanged. Each function takes
 * a `MemgraphInternals` context.
 */

import { asBoolean, asString, parseKgFacts, uniq } from "../../core/memgraph-transport.ts";
import type { MemgraphInternals } from "../../core/memgraph-internals.ts";

export const OUTCOME_VALUES: readonly string[] = ["accept", "revise", "failed", "unused"];

// ── Capability memory (learned routing) axes ───────────────────────
// `es-capability-outcome` edges record the outcome of one unit of work run at a
// given tier for a given task shape. The subject is the deterministic capability
// bucket id (`capability::<shapeKey>::<tier>`); the object is one of accept |
// revise | failed | unused (the same closed set as es-outcome). Edges ACCUMULATE —
// multiple edges per bucket are expected and meaningful, so nothing here ever
// invalidates or collapses them.
//
// `es-capability-shape` / `es-capability-tier` carry the explainable metadata
// (canonical shape summary string, tier value) on the same bucket node so a
// human can read WHY a tier was chosen without re-deriving the shape. These are
// best-effort: a failed stamp leaves the axis "unknown" but does not invalidate
// the recorded outcome.
//
// NOTE: `es-capability-*` predicates are NEW and deliberately distinct from the
// reserved set (synthesized-from, consolidated-into, merged-into, in-hall,
// es-status, es-source-type, es-outcome, concerns, triggers-on, rules-out,
// es-staleness). They must never count toward height or feed lineage traversal.

export const CAPABILITY_OUTCOME_PREDICATE = "es-capability-outcome";
export const CAPABILITY_SHAPE_PREDICATE = "es-capability-shape";
export const CAPABILITY_TIER_PREDICATE = "es-capability-tier";

/**
 * Record ONE capability outcome edge for a (shape, tier) bucket. Accumulation —
 * never invalidates or overwrites existing edges. `validFrom` timestamps the edge
 * so consumers can window recent history. Throws on an invalid outcome value:
 * the axis is closed to exactly accept | revise | failed | unused.
 */
export async function recordCapabilityOutcome(core: MemgraphInternals, bucketId: string, outcome: string, validFrom?: string): Promise<void> {
  const id = asString(bucketId).trim();
  if (!id) throw new Error("recordCapabilityOutcome: bucketId is required");
  if (!(OUTCOME_VALUES as readonly string[]).includes(outcome)) {
    throw new Error(
      `recordCapabilityOutcome: invalid outcome "${outcome}" — must be one of ${OUTCOME_VALUES.join(" | ")}`,
    );
  }
  await core.call("kgAdd", {
    subject: id,
    predicate: CAPABILITY_OUTCOME_PREDICATE,
    object: outcome,
    valid_from: validFrom,
    source_closet: id,
  });
}

/**
 * Best-effort stamp of the canonical shape summary on a capability bucket.
 * Returns true on success, false on failure — never throws in the normal flow.
 */
export async function setCapabilityShape(core: MemgraphInternals, bucketId: string, canonicalShape: string): Promise<boolean> {
  const id = asString(bucketId).trim();
  const shape = asString(canonicalShape).trim();
  if (!id || !shape) return false;
  const res = await core.invoke("kgAdd", {
    subject: id,
    predicate: CAPABILITY_SHAPE_PREDICATE,
    object: shape,
    source_closet: id,
  });
  if (res.ok === false) {
    // non-fatal: leave the axis "unknown" rather than fail the caller (logged).
    console.warn(`[memgraph] es-capability-shape set for ${id} failed (kind=${res.kind}), leaving axis unknown: ${res.detail}`);
    return false;
  }
  return true;
}

/**
 * Best-effort stamp of the tier value on a capability bucket. Returns true on
 * success, false on failure — never throws in the normal flow.
 */
export async function setCapabilityTier(core: MemgraphInternals, bucketId: string, tier: string): Promise<boolean> {
  const id = asString(bucketId).trim();
  const value = asString(tier).trim();
  if (!id || !value) return false;
  const res = await core.invoke("kgAdd", {
    subject: id,
    predicate: CAPABILITY_TIER_PREDICATE,
    object: value,
    source_closet: id,
  });
  if (res.ok === false) {
    // non-fatal: leave the axis "unknown" rather than fail the caller (logged).
    console.warn(`[memgraph] es-capability-tier set for ${id} failed (kind=${res.kind}), leaving axis unknown: ${res.detail}`);
    return false;
  }
  return true;
}

/**
 * CONSUME: aggregate capability evidence per tier for a shape bucket.
 * One one-hop outgoing kg_query per tier bucket (local, cloud, deep), run with
 * bounded concurrency (8 — the only validated level in this repo). Read failures
 * degrade to zero counts (neutral) per tier, matching getOutcomeCounts' discipline.
 *
 * Returns per-tier counts plus a recommendation:
 *   - Only tiers with total >= minSample (default 5) are eligible.
 *   - Pick the highest accept_rate (accept/total); deterministic tie-break order:
 *     local, cloud, deep.
 *   - If none eligible => recommendation "no-data", fallback true.
 */
export async function getCapabilityRoutingEvidence(
  core: MemgraphInternals,
  shapeKeyOrCanonical: string,
  options?: { minSample?: number; concurrency?: number },
): Promise<{
  tiers: Record<string, { accept: number; revise: number; failed: number; unused: number; total: number; sufficient_sample: boolean }>;
  recommendation: string;
  fallback: boolean;
  threshold: number;
}> {
  const shapeKey = asString(shapeKeyOrCanonical).trim();
  if (!shapeKey) {
    return {
      tiers: {},
      recommendation: "no-data",
      fallback: true,
      threshold: Math.max(1, Number(options?.minSample ?? 5)),
    };
  }

  const minSample = Math.max(1, Number(options?.minSample ?? 5));
  const concurrency = Math.max(1, Math.min(8, Number(options?.concurrency ?? 8)));
  const tiers: Array<{ tier: string; bucketId: string }> = [
    { tier: "local", bucketId: `capability::${shapeKey}::local` },
    { tier: "cloud", bucketId: `capability::${shapeKey}::cloud` },
    { tier: "deep", bucketId: `capability::${shapeKey}::deep` },
  ];

  const empty = () => ({ accept: 0, revise: 0, failed: 0, unused: 0, total: 0 });
  const countsByTier = new Map<string, ReturnType<typeof empty>>();
  let cursor = 0;
  const run = async () => {
    while (cursor < tiers.length) {
      const index = cursor;
      cursor += 1;
      const { tier, bucketId } = tiers[index];
      const counts = empty();
      // Degrade to "no history" on read failure (logged).
      const result = await core.kgQueryIgnoringFailure({
        entity: bucketId,
        direction: "outgoing",
        predicate: CAPABILITY_OUTCOME_PREDICATE,
        recurse: false,
        max_depth: 1,
      }, `getCapabilityRoutingEvidence(${bucketId}) read failure degrades to no history`);
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
      countsByTier.set(tier, counts);
    }
  };
  const slots = Math.max(1, Math.min(concurrency, tiers.length));
  await Promise.all(Array.from({ length: slots }, () => run()));

  const tierCounts: Record<string, { accept: number; revise: number; failed: number; unused: number; total: number; sufficient_sample: boolean }> = {};
  for (const { tier } of tiers) {
    const counts = countsByTier.get(tier) || empty();
    tierCounts[tier] = {
      accept: counts.accept,
      revise: counts.revise,
      failed: counts.failed,
      unused: counts.unused,
      total: counts.total,
      sufficient_sample: counts.total >= minSample,
    };
  }

  // Recommendation: highest accept_rate among eligible tiers; deterministic tie-break.
  let recommendation = "no-data";
  let fallback = true;
  let bestRate = -1;
  for (const { tier } of tiers) {
    const counts = tierCounts[tier];
    if (!counts.sufficient_sample || counts.total === 0) continue;
    const rate = counts.accept / counts.total;
    if (rate > bestRate) {
      bestRate = rate;
      recommendation = tier;
      fallback = false;
    }
  }

  return { tiers: tierCounts, recommendation, fallback, threshold: minSample };
}

// ── Per-model failure-mode memory axes ────────────────────────────
// `es-failure-event` edges record one turn-guard intervention (spiral / loop)
// attributed to a (model, task-shape) bucket. The subject is the deterministic
// failure bucket id (`failure::<provider/model>::<shapeKey>`, shapeKey from the
// SAME capability shape function — no second shape system); the object is one
// of spiral | loop. Edges ACCUMULATE like es-capability-outcome: multiple edges
// per bucket are expected and meaningful, nothing here invalidates them.
//
// `es-failure-shape` carries the canonical shape summary on the same bucket for
// explainability (best-effort). `es-intervention-label` / `es-intervention-text`
// live on patch nodes (`failure-patch::<model>::<shapeKey>::<label>`) and record
// the prompt intervention that broke the loop for that (model, shape) — durable
// procedural knowledge about a specific model.
//
// NOTE: `es-failure-*` / `es-intervention-*` predicates are NEW and deliberately
// distinct from the reserved set (synthesized-from, consolidated-into, merged-into,
// in-hall, es-status, es-source-type, es-outcome, concerns, triggers-on, rules-out,
// es-staleness) and from the `es-capability-*` predicates. They must never count toward
// height or feed lineage traversal.

export const FAILURE_EVENT_PREDICATE = "es-failure-event";
export const FAILURE_SHAPE_PREDICATE = "es-failure-shape";
export const INTERVENTION_LABEL_PREDICATE = "es-intervention-label";
export const INTERVENTION_TEXT_PREDICATE = "es-intervention-text";

/**
 * Record ONE failure event edge for a (model, shape) bucket. Accumulation —
 * never invalidates or overwrites existing edges. `validFrom` timestamps the
 * edge so consumers can window recent history. Throws on an invalid event value:
 * the axis is closed to exactly spiral | loop.
 */
export async function recordFailureEvent(core: MemgraphInternals, bucketId: string, event: string, validFrom?: string): Promise<void> {
  const id = asString(bucketId).trim();
  if (!id) throw new Error("recordFailureEvent: bucketId is required");
  if (event !== "spiral" && event !== "loop") {
    throw new Error(`recordFailureEvent: invalid event "${event}" — must be spiral | loop`);
  }
  await core.call("kgAdd", {
    subject: id,
    predicate: FAILURE_EVENT_PREDICATE,
    object: event,
    valid_from: validFrom,
    source_closet: id,
  });
}

/**
 * Best-effort stamp of the canonical shape summary on a failure bucket. Returns
 * true on success, false on failure — never throws in the normal flow.
 */
export async function setFailureShape(core: MemgraphInternals, bucketId: string, canonicalShape: string): Promise<boolean> {
  const id = asString(bucketId).trim();
  const shape = asString(canonicalShape).trim();
  if (!id || !shape) return false;
  const res = await core.invoke("kgAdd", {
    subject: id,
    predicate: FAILURE_SHAPE_PREDICATE,
    object: shape.slice(0, 200),
    source_closet: id,
  });
  if (res.ok === false) {
    // non-fatal: leave the axis "unknown" rather than fail the caller (logged).
    console.warn(`[memgraph] es-failure-shape set for ${id} failed (kind=${res.kind}), leaving axis unknown: ${res.detail}`);
    return false;
  }
  return true;
}

/**
 * Record a successful intervention (prompt patch) for a (model, shape, label)
 * node. The label is stamped on every write (idempotent — repeated identical
 * writes are harmless); the text is bounded by the caller before being passed.
 * Never throws in the normal flow.
 */
export async function recordIntervention(core: MemgraphInternals, patchId: string, label: string, text: string): Promise<boolean> {
  const id = asString(patchId).trim();
  const lbl = asString(label).trim();
  if (!id || !lbl) return false;
  const labelRes = await core.invoke("kgAdd", { subject: id, predicate: INTERVENTION_LABEL_PREDICATE, object: lbl, source_closet: id });
  if (labelRes.ok === false) {
    // non-fatal: an intervention write failure degrades to "no known patch" (logged).
    console.warn(`[memgraph] intervention label write for ${id} failed (kind=${labelRes.kind}), degrading to no known patch: ${labelRes.detail}`);
    return false;
  }
  const clipped = asString(text).trim().slice(0, 500);
  if (clipped) {
    const textRes = await core.invoke("kgAdd", { subject: id, predicate: INTERVENTION_TEXT_PREDICATE, object: clipped, source_closet: id });
    if (textRes.ok === false) {
      // non-fatal: the label is already stamped; a failed text write degrades to a
      // patch with no text (logged).
      console.warn(`[memgraph] intervention text write for ${id} failed (kind=${textRes.kind}), leaving patch without text: ${textRes.detail}`);
    }
  }
  return true;
}

/**
 * CONSUME (routing signal): aggregate failure events for a
 * (model, shape) bucket. One one-hop outgoing kg_query on es-failure-event.
 * Read failures degrade to zero counts (neutral) — a failed read must never look
 * like "this model is bad" or "this model is fine"; it looks like "no data".
 */
export async function getFailureCounts(
  core: MemgraphInternals,
  bucketId: string,
): Promise<{ spiral: number; loop: number; total: number }> {
  const id = asString(bucketId).trim();
  if (!id) return { spiral: 0, loop: 0, total: 0 };
  // Degrade to "no history" on read failure (logged). A failed read must never look
  // like "this model is bad" or "fine".
  const result = await core.kgQueryIgnoringFailure({
    entity: id,
    direction: "outgoing",
    predicate: FAILURE_EVENT_PREDICATE,
    recurse: false,
    max_depth: 1,
  }, `getFailureCounts(${id}) read failure degrades to no history`);
  let spiral = 0;
  let loop = 0;
  for (const fact of parseKgFacts(result)) {
    if (!asBoolean(fact.current, true)) continue;
    const value = asString(fact.object).trim();
    if (value === "spiral") spiral += 1;
    else if (value === "loop") loop += 1;
    // unknown values are ignored — the axis is closed by construction
  }
  return { spiral, loop, total: spiral + loop };
}

/**
 * CONSUME (prompt patches): fetch known successful intervention texts
 * for every patch node of a (model, shape). Bounded by maxPatches (default 4) —
 * one one-hop kg_query per candidate label. Read failures degrade to no patches;
 * absent data yields an empty list (no injection, no prompt bloat).
 */
export async function getFailureInterventions(
  core: MemgraphInternals,
  modelId: string,
  shapeKey: string,
  options?: { maxPatches?: number },
): Promise<string[]> {
  const model = asString(modelId).trim();
  const shape = asString(shapeKey).trim();
  if (!model || !shape) return [];
  const maxPatches = Math.max(1, Math.min(8, Number(options?.maxPatches ?? 4)));
  // Closed label vocabulary — the only patch nodes that can exist.
  const labels = ["spiral-nudge", "retry-nudge", "loop-block"];
  const out: string[] = [];
  for (const label of labels.slice(0, maxPatches)) {
    const patchId = `failure-patch::${model}::${shape}::${label}`;
    // Degrade to "no patch text" on read failure (logged). Absent data yields no
    // injection, no prompt bloat.
    const result = await core.kgQueryIgnoringFailure({
      entity: patchId,
      direction: "outgoing",
      predicate: INTERVENTION_TEXT_PREDICATE,
      recurse: false,
      max_depth: 1,
    }, `getFailureInterventions(${patchId}) read failure skips label`);
    for (const fact of parseKgFacts(result)) {
      if (!asBoolean(fact.current, true)) continue;
      const text = asString(fact.object).trim();
      if (text && !out.includes(text)) out.push(text);
    }
  }
  return out.slice(0, maxPatches);
}

/**
 * CONSUME (routing signal): combine capability evidence with
 * per-model failure counts into an ADJUSTED tier recommendation.
 *
 * This repo has no in-repo tier SELECTOR — the orchestrator that delegates units
 * to tiers lives outside this codebase (the task tool is invoked by the agent, not
 * by a routing function here). So the penalty integration is exposed as a
 * deterministic composed API: an external consumer calls this once before
 * choosing a tier and reads `recommendation` + `evidence`.
 * TODO(external-consumer): wire this into orchestrate-cloud's tier selection.
 *
 * Deterministic scoring (no LLM, no embeddings):
 *   base(tier)      = accept / total            (capability evidence; undefined if total < minSample)
 *   failureRate(m,s)= failures / max(failures, MIN_FAILURE_SAMPLE)
 *                    where failures = es-failure-event count for `failure::<model>::<shapeKey>`;
 *                    the denominator is clamped at MIN_FAILURE_SAMPLE so a single nudge
 *                    cannot dominate (mirrors the capability min-sample discipline).
 *   score(tier)     = base(tier) - failureRate(modelOf(tier), shape)
 *   pick            = highest score among tiers with base defined; deterministic
 *                     tie-break order: local, cloud, deep. No eligible tier => "no-data".
 *
 * A model whose outputs get REVISE'd / nudged on a task class loses to a sibling
 * on that class independent of overall capability — exactly the spec's CONSUME #1.
 */
export async function getFailureAdjustedRouting(
  core: MemgraphInternals,
  shapeKey: string,
  modelByTier: Record<string, string | null>,
  options?: { minSample?: number; minFailureSample?: number },
): Promise<{
  recommendation: string;
  fallback: boolean;
  threshold: number;
  tiers: Record<string, { baseRate: number | null; failureTotal: number; adjustedScore: number | null }>;
}> {
  const key = asString(shapeKey).trim();
  const minSample = Math.max(1, Number(options?.minSample ?? 5));
  const minFailureSample = Math.max(1, Number(options?.minFailureSample ?? 5));

  if (!key) {
    return { recommendation: "no-data", fallback: true, threshold: minSample, tiers: {} };
  }

  const evidence = await getCapabilityRoutingEvidence(core, key, { minSample });
  const tierNames = ["local", "cloud", "deep"];
  const tiers: Record<string, { baseRate: number | null; failureTotal: number; adjustedScore: number | null }> = {};

  for (const tier of tierNames) {
    const counts = evidence.tiers[tier];
    const total = counts?.total ?? 0;
    const sufficient = Boolean(counts?.sufficient_sample);
    const baseRate = sufficient && total > 0 ? counts.accept / total : null;

    // Failure propensity of the model pinned to this tier for THIS shape.
    // Unknown model (null/empty) => no penalty: an unattributable bucket must not
    // look like "this model is bad" or "fine" — it looks like no data.
    const modelId = asString(modelByTier?.[tier] ?? "").trim();
    let failureTotal = 0;
    if (modelId) {
      const counts2 = await getFailureCounts(core, `failure::${modelId}::${key}`);
      failureTotal = counts2.total;
    }
    const failureRate = failureTotal / Math.max(failureTotal, minFailureSample);
    tiers[tier] = {
      baseRate,
      failureTotal,
      adjustedScore: baseRate === null ? null : baseRate - failureRate,
    };
  }

  let recommendation = "no-data";
  let fallback = true;
  let bestScore = -Infinity;
  for (const tier of tierNames) {
    const score = tiers[tier].adjustedScore;
    if (score === null) continue;
    if (score > bestScore) {
      bestScore = score;
      recommendation = tier;
      fallback = false;
    }
  }

  return { recommendation, fallback, threshold: minSample, tiers };
}



// ── Confidence calibration axes ─────────────────────────────────
// `es-calibration-outcome` edges record one completed unit's tuple: the
// self-reported confidence level (high | medium | low) paired with the ACTUAL
// outcome — the es-outcome value (accept | revise | failed | unused),
// written ONLY by the human-authoritative record_outcome path. The subject is
// the deterministic calibration bucket id (`calibration::<model>::<shapeKey>::<confidence>`,
// model from canonicalModelId, shapeKey from the SAME capability shape
// function — no second shape system). Edges ACCUMULATE like es-capability-outcome:
// multiple edges per bucket are expected and meaningful; nothing here ever
// invalidates or collapses them.
//
// MINIMUM SAMPLE GATE (spec's most dangerous failure mode): a calibration figure
// is only reported/used once its (model, confidence-level) cell holds >= 20 pairs.
// Below that, every consumer must report "insufficient data" and fall back to
// default behaviour — an undersampled curve looks quantitative and gets believed.
//
// NOTE: `es-calibration-outcome` is NEW and deliberately distinct from the reserved
// set (synthesized-from, consolidated-into, merged-into, in-hall, es-status,
// es-source-type, es-outcome, concerns, triggers-on, rules-out, es-staleness) and
// from `es-capability-*` / `es-failure-*` /
// `es-intervention-*`. It must never count toward height or feed lineage traversal.

export const CALIBRATION_OUTCOME_PREDICATE = "es-calibration-outcome";
/** Minimum pairs per (model, confidence-level) cell before any figure is reported/used. */
export const MIN_CALIBRATION_SAMPLE = 20;
/** Closed confidence vocabulary for calibration cells (self-reported levels). */
export const CALIBRATION_CONFIDENCE_VALUES: readonly string[] = ["high", "medium", "low"];

/**
 * CONSUME: read one calibration cell — the (model, shapeKey, confidence)
 * bucket's outcome counts plus hit rate. One one-hop outgoing kg_query on
 * es-calibration-outcome. Read failures degrade to zero counts (neutral): a failed
 * read must look like "no data", never like "this model is miscalibrated".
 *
 * Hit rate = accept / total over the cell's tuples (the only positive outcome in
 * the closed set). `sufficient` enforces the 20-pair minimum: below it,
 * `hitRate` is still computed for reporting transparency but consumers MUST treat
 * the cell as unusable and fall back to default behaviour.
 */
export async function getCalibrationCell(
  core: MemgraphInternals,
  modelId: string,
  shapeKey: string,
  confidence: string,
  options?: { minSample?: number },
): Promise<{
  bucketId: string;
  accept: number;
  revise: number;
  failed: number;
  unused: number;
  total: number;
  hitRate: number | null;
  sufficient: boolean;
  threshold: number;
}> {
  const model = asString(modelId).trim();
  const shape = asString(shapeKey).trim();
  const level = asString(confidence).trim().toLowerCase();
  const minSample = Math.max(1, Number(options?.minSample ?? MIN_CALIBRATION_SAMPLE));
  if (!model || !shape || !(CALIBRATION_CONFIDENCE_VALUES as readonly string[]).includes(level)) {
    return { bucketId: "", accept: 0, revise: 0, failed: 0, unused: 0, total: 0, hitRate: null, sufficient: false, threshold: minSample };
  }

  const bucketId = `calibration::${model}::${shape}::${level}`;
  let accept = 0;
  let revise = 0;
  let failed = 0;
  let unused = 0;
  // Degrade to "no history" on read failure (logged). A failed read must look like
  // "no data", never like "this model is miscalibrated".
  const result = await core.kgQueryIgnoringFailure({
    entity: bucketId,
    direction: "outgoing",
    predicate: CALIBRATION_OUTCOME_PREDICATE,
    recurse: false,
    max_depth: 1,
  }, `getCalibrationCell(${bucketId}) read failure degrades to no history`);
  for (const fact of parseKgFacts(result)) {
    if (!asBoolean(fact.current, true)) continue;
    const value = asString(fact.object).trim();
    if (value === "accept") accept += 1;
    else if (value === "revise") revise += 1;
    else if (value === "failed") failed += 1;
    else if (value === "unused") unused += 1;
    // unknown values are ignored — the axis is closed by construction
  }
  const total = accept + revise + failed + unused;
  return {
    bucketId,
    accept,
    revise,
    failed,
    unused,
    total,
    hitRate: total > 0 ? accept / total : null,
    sufficient: total >= minSample,
    threshold: minSample,
  };
}

/**
 * CONSUME (reporting): the calibration table for one model across a
 * BOUNDED set of shape keys — rows of (shapeKey x confidence-level) with counts,
 * hit rate, and the 20-pair sufficiency flag. maxShapes caps the query fan-out
 * (default 8); concurrency is capped at 8 (the only validated level in this repo).
 * No shape keys => empty table with a note — there is deliberately no unbounded
 * enumeration of shapes (a room-paging-to-exhaustion analogue for graph nodes).
 */
export async function getCalibrationTable(
  core: MemgraphInternals,
  modelId: string,
  shapeKeys: string[],
  options?: { minSample?: number; maxShapes?: number; concurrency?: number },
): Promise<{
  model: string;
  threshold: number;
  rows: Array<{
    shapeKey: string;
    confidence: string;
    accept: number;
    revise: number;
    failed: number;
    unused: number;
    total: number;
    hitRate: number | null;
    sufficient: boolean;
  }>;
}> {
  const model = asString(modelId).trim();
  const minSample = Math.max(1, Number(options?.minSample ?? MIN_CALIBRATION_SAMPLE));
  const maxShapes = Math.max(1, Math.min(16, Number(options?.maxShapes ?? 8)));
  const concurrency = Math.max(1, Math.min(8, Number(options?.concurrency ?? 8)));
  if (!model) {
    return { model: "", threshold: minSample, rows: [] };
  }

  const shapes = uniq(shapeKeys).slice(0, maxShapes);
  const confidences = [...CALIBRATION_CONFIDENCE_VALUES];
  const cells: Array<{ shapeKey: string; confidence: string }> = [];
  for (const shape of shapes) {
    for (const level of confidences) {
      cells.push({ shapeKey: shape, confidence: level });
    }
  }

  const rows: Array<{
    shapeKey: string;
    confidence: string;
    accept: number;
    revise: number;
    failed: number;
    unused: number;
    total: number;
    hitRate: number | null;
    sufficient: boolean;
  }> = [];
  let cursor = 0;
  const run = async () => {
    while (cursor < cells.length) {
      const index = cursor;
      cursor += 1;
      const cell = cells[index];
      const result = await getCalibrationCell(core, model, cell.shapeKey, cell.confidence, { minSample });
      rows.push({
        shapeKey: cell.shapeKey,
        confidence: cell.confidence,
        accept: result.accept,
        revise: result.revise,
        failed: result.failed,
        unused: result.unused,
        total: result.total,
        hitRate: result.hitRate,
        sufficient: result.sufficient,
      });
    }
  };
  const slots = Math.max(1, Math.min(concurrency, cells.length || 1));
  if (cells.length > 0) {
    await Promise.all(Array.from({ length: slots }, () => run()));
  }

  // Deterministic row order: shapeKey ascending, then confidence high/medium/low.
  const levelRank = new Map(confidences.map((level, i) => [level, i]));
  rows.sort((a, b) => (a.shapeKey === b.shapeKey ? levelRank.get(a.confidence)! - levelRank.get(b.confidence)! : a.shapeKey.localeCompare(b.shapeKey)));
  return { model, threshold: minSample, rows };
}

/**
 * CONSUME (escalation triggers): the composed API for orchestrate-cloud.
 * This repo has no in-repo tier SELECTOR — the orchestrator that delegates units
 * lives outside this codebase — so the calibration decision is exposed as a
 * deterministic composed call: an external consumer invokes it once with the
 * unit's model, shape, and the self-reported confidence, and reads `action` +
 * `reason`. TODO(external-consumer): wire into orchestrate-cloud's escalation logic.
 *
 * Decision rule (deterministic, no LLM):
 *   - Cell insufficient (< 20 pairs) or unreadable => action = defaultAction,
 *     reason "insufficient-data" — fall back to current behaviour. A calibration
 *     curve built on five points is confidently wrong about confidence.
 *   - Cell sufficient: hitRate >= minHitRate (default 0.6) => "trust" the reported
 *     confidence (no escalation forced by calibration); hitRate < minHitRate =>
 *     "escalate" — the model's self-report at this level on this shape is measured
 *     unreliable, so a "high" report is weak evidence, not a green light.
 */
export async function decideCalibratedEscalation(core: MemgraphInternals, args: {
  modelId: string;
  shapeKey: string;
  reportedConfidence: string;
  defaultAction?: "trust" | "escalate";
  minHitRate?: number;
  minSample?: number;
}): Promise<{
  action: "trust" | "escalate";
  reason: string;
  hitRate: number | null;
  total: number;
  threshold: number;
}> {
  const defaultAction = args.defaultAction === "escalate" ? "escalate" : "trust";
  const minHitRate = Math.max(0, Math.min(1, Number(args.minHitRate ?? 0.6)));
  const cell = await getCalibrationCell(core, args.modelId, args.shapeKey, args.reportedConfidence, {
    minSample: args.minSample,
  });

  if (!cell.sufficient || cell.hitRate === null) {
    return {
      action: defaultAction,
      reason: `insufficient-data (${cell.total}/${cell.threshold} pairs on ${args.modelId || "unknown-model"} / ${asString(args.reportedConfidence).trim().toLowerCase() || "unknown-level"})`,
      hitRate: cell.hitRate,
      total: cell.total,
      threshold: cell.threshold,
    };
  }

  if (cell.hitRate >= minHitRate) {
    return {
      action: "trust",
      reason: `measured-reliable (${(cell.hitRate * 100).toFixed(0)}% hit rate >= ${Math.round(minHitRate * 100)}% floor across ${cell.total} pairs on this shape)`,
      hitRate: cell.hitRate,
      total: cell.total,
      threshold: cell.threshold,
    };
  }
  return {
    action: "escalate",
    reason: `measured-unreliable (${(cell.hitRate * 100).toFixed(0)}% hit rate < ${Math.round(minHitRate * 100)}% floor on this shape)`,
    hitRate: cell.hitRate,
    total: cell.total,
    threshold: cell.threshold,
  };
}
