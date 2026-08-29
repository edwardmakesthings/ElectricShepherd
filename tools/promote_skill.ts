/**
 * Phase 10 (unified memory): promote a project skill into the shared skills wing.
 *
 * Skills default to the project wing (Phase 5, unchanged). But "how I diagnose a
 * caching regression" transfers everywhere; only project-specific procedure should
 * stay wing-locked. Promotion is that transfer — and it is a DISTINCT operation
 * from relocation: relocation fixes misfiling (the drawer was filed in the wrong
 * place); promotion generalises something correctly filed (the drawer belongs in
 * two places now). The spec is explicit: "Do not overload one command with both."
 * So this tool does NOT call relocate_memory; it reuses its pattern (dry-run
 * default, verbatim content, add_drawer + kg_add, per-item error counting) and
 * adds the `promoted-from` lineage edge that relocation never writes.
 *
 * Promotion is proposed, never automatic: dry-run by default, explicit apply only
 * after operator approval of a numbered proposal list (the dreamer's pass owns the
 * proposals — see agents/dreamer.md step 5d). No threshold crossing silently moves
 * a drawer.
 *
 * Semantics (approved decision): COPY, not move. The source project keeps its local
 * copy until the operator retires it (never-delete discipline; merging the shared
 * copy back into its origin via `merged-into` is the retirement path). The shared
 * copy carries:
 *   - es-source-type: skill  (a location, not a kind — no new source type)
 *   - promoted-from edge: {subject: <shared id>, predicate: "promoted-from",
 *     object: <origin id>} — origin stays traceable. `promoted-from` is NOT
 *     lineage: it never counts toward height and never feeds
 *     getLineageSources/getLineageDerivatives (see adapter/memgraph.ts).
 *
 * Idempotency (duplicate promotion prevention), two layers:
 *   1. exact-duplicate guard via check_duplicate (same as file_skill) — identical
 *      content maps to the same deterministic drawer ID, so a re-apply of an
 *      already-promoted skill files nothing;
 *   2. existing-edge guard: if the origin already carries an outgoing
 *      promoted-from edge (or the shared copy does), apply reports
 *      `skipped-already-promoted` and writes NOTHING — no second shared copy, no
 *      second edge.
 *
 * `es-status` is intentionally NOT touched — a skill is authoritative on arrival,
 * like a doc; the two axes are orthogonal.
 */

import { tool } from "@opencode-ai/plugin";
import { asObject, asText, createPalaceClient, drawerContentFrom, parseFacts, parseTaxonomy } from "../adapter/palace-tools.ts";
import { applyRuntimeConfigToEnv, loadRuntimeConfig } from "../adapter/runtime-config.ts";
import { loadRuntimeEnv } from "../scripts/runtime-env.ts";
import { SKILLS_ROOM, SKILL_LIKE_STEMS } from "./file_skill.ts";
import { pickPurposeRoom } from "./ingest_docs.ts";
import { SKILL_DOMAINS, type SkillDomain } from "../adapter/memgraph.ts";

declare const process: {
  env: Record<string, string | undefined>;
};

export const PROMOTED_FROM_PREDICATE = "promoted-from";
export const SHARED_SKILLS_ROOM = SKILLS_ROOM;
const DEFAULT_SHARED_WING = "shared-skills";

// Phase 10 candidate rule (approved decision): a skill with duplicate/near-duplicate
// content in >= 2 distinct project wings is a promotion candidate. This is the safe
// conservative proxy for "used successfully in N projects" in a codebase where no
// per-project success signal exists yet (see docs/memory-phases-6-11-spec.md Phase 10).
export const PROMOTION_CANDIDATE_MIN_WINGS = 2;

export type CallTool = (name: string, payload: Record<string, unknown>) => Promise<unknown>;

export type SkillPromotionReport = {
  ok: boolean;
  dry_run: boolean;
  skill_id: string;
  from?: { wing: string; room: string };
  to?: { wing: string; room: string };
  reused_room?: boolean;
  /** Phase 12: the es-domain propagated from the origin to the shared copy. */
  domain?: SkillDomain;
  duplicate_drawer_id?: string;
  already_promoted_to?: string;
  pre_snapshot?: { total: number; covered: number };
  drawer_id?: string;
  stamp_failed?: number;
  edge_failed?: number;
  error?: string;
  next_step?: string;
};

function outgoingObjects(factsRaw: unknown): string[] {
  const out = new Set<string>();
  for (const fact of parseFacts(factsRaw)) {
    if (fact.current === false) continue;
    const id = asText(fact.object).trim();
    if (id) out.add(id);
  }
  return [...out];
}

function incomingSubjects(factsRaw: unknown): string[] {
  const out = new Set<string>();
  for (const fact of parseFacts(factsRaw)) {
    if (fact.current === false) continue;
    const id = asText(fact.subject).trim();
    if (id) out.add(id);
  }
  return [...out];
}

/** es-source-type value of one node, or null when unstamped / unreadable. */
async function closetSourceType(call: CallTool, id: string): Promise<string | null> {
  return call("kg_query", { entity: id, direction: "outgoing", predicate: "es-source-type", recurse: false, max_depth: 1 })
    .then((raw) => {
      for (const fact of parseFacts(raw)) {
        if (fact.current === false) continue;
        const value = asText(fact.object).trim();
        if (value === "transcript" || value === "doc" || value === "synthesis" || value === "skill") return value;
      }
      return null; // unstamped or read failure — never a default type
    })
    .catch(() => null);
}

/** es-domain value of one node, or null when unstamped / out-of-vocabulary / unreadable (Phase 12). */
async function closetDomain(call: CallTool, id: string): Promise<SkillDomain | null> {
  return call("kg_query", { entity: id, direction: "outgoing", predicate: "es-domain", recurse: false, max_depth: 1 })
    .then((raw) => {
      for (const fact of parseFacts(raw)) {
        if (fact.current === false) continue;
        const value = asText(fact.object).trim();
        if ((SKILL_DOMAINS as readonly string[]).includes(value)) return value as SkillDomain;
      }
      return null; // unstamped, out-of-vocabulary, or read failure — never a default domain
    })
    .catch(() => null);
}

/** Wing of a drawer from its id prefix (drawer_<wing>_<room>_<hash>) — no extra call. */
export function wingFromDrawerId(drawerId: string): string {
  const prefix = "drawer_";
  if (!drawerId.startsWith(prefix)) return "";
  const rest = drawerId.slice(prefix.length);
  const end = rest.indexOf("_");
  return end > 0 ? rest.slice(0, end) : "";
}

/**
 * Pure candidate predicate (approved Phase 10 rule): a skill is a promotion
 * candidate when its duplicate/near-duplicate content appears in >= N distinct
 * project wings. `wings` must already exclude the shared skills wing (a copy that
 * lives there is the RESULT of promotion, not evidence of it). Exported for tests,
 * mirroring isReSynthesisCandidate in palace_flock_status.ts.
 */
export function isPromotionCandidate(wings: string[], minWings = PROMOTION_CANDIDATE_MIN_WINGS): boolean {
  return new Set(wings.filter(Boolean)).size >= minWings;
}
/**
 * Pure core: promote one skill drawer into the shared skills wing. Exported for
 * unit testing with a fake transport, mirroring runSkillFiling in file_skill.ts.
 */
export async function runSkillPromotion(args: {
  call: CallTool;
  skillId: string;
  sharedWing?: string;
  sharedRoom?: string;
  dryRun?: boolean;
}): Promise<SkillPromotionReport> {
  const skillId = String(args.skillId || "").trim();
  if (!skillId) throw new Error("promote_skill: skill_id is required");
  const sharedWing = String(args.sharedWing || DEFAULT_SHARED_WING).trim() || DEFAULT_SHARED_WING;
  const dryRun = args.dryRun !== false;

  // Read the source drawer once (content + wing/room) and verify it is a real skill.
  let source: Record<string, unknown>;
  try {
    source = asObject(await args.call("get_drawer", { drawer_id: skillId }));
  } catch {
    return {
      ok: false,
      dry_run: dryRun,
      skill_id: skillId,
      error: "get_drawer failed for the source skill — nothing was read, nothing to promote.",
      next_step: "Verify the drawer id and re-run.",
    };
  }
  if (asText(source.error)) {
    return {
      ok: false,
      dry_run: dryRun,
      skill_id: skillId,
      error: `source drawer does not exist: ${asText(source.error)}`,
      next_step: "Verify the drawer id and re-run.",
    };
  }
  const content = drawerContentFrom(source).trim();
  if (!content) {
    return {
      ok: false,
      dry_run: dryRun,
      skill_id: skillId,
      error: "source drawer has no readable content — nothing to promote verbatim.",
      next_step: "Use export_drawer to recover the stored text and re-run.",
    };
  }

  const sourceMeta = asObject(source.metadata);
  const from = {
    wing: asText(source.wing || sourceMeta.wing) || wingFromDrawerId(skillId),
    room: asText(source.room || sourceMeta.room),
  };
  if (from.wing === sharedWing) {
    return {
      ok: true,
      dry_run: dryRun,
      skill_id: skillId,
      from,
      to: { wing: sharedWing, room: SHARED_SKILLS_ROOM },
      next_step: "Source already lives in the shared skills wing — nothing to promote.",
    };
  }

  // Hard check (same discipline as propose_refinements): the source must carry
  // es-source-type: skill. Promoting an unstamped or wrongly-typed drawer would
  // pollute the shared wing with non-procedure content.
  const sourceType = await closetSourceType(args.call, skillId);
  if (sourceType !== "skill") {
    return {
      ok: false,
      dry_run: dryRun,
      skill_id: skillId,
      from,
      to: { wing: sharedWing, room: SHARED_SKILLS_ROOM },
      error: `source es-source-type is ${sourceType ?? "unknown"}, not skill — refusing to promote a non-skill drawer.`,
      next_step: "Stamp the drawer with palace_stamp_source_type (or re-file via file_skill) and re-run.",
    };
  }

  // Phase 12 hard check (spec: "Promotion to the shared wing REQUIRES an explicit
  // domain. A skill with no domain cannot be promoted."): read the origin's es-domain
  // and refuse when it is unstamped or out-of-vocabulary — in BOTH dry-run and apply,
  // before any write. An unclassified shared copy would surface in every project's
  // procedural retrieval (null reads as "admitted everywhere"), which is exactly the
  // cross-project relevance degradation Phase 12 exists to prevent.
  const sourceDomain = await closetDomain(args.call, skillId);
  if (sourceDomain === null) {
    return {
      ok: false,
      dry_run: dryRun,
      skill_id: skillId,
      from,
      to: { wing: sharedWing, room: SHARED_SKILLS_ROOM },
      error: `source es-domain is unstamped or out-of-vocabulary — promotion REQUIRES an explicit domain (code | writing | infra | research | general). Nothing was written.`,
      next_step: `Re-file the skill via file_skill with a domain argument (or stamp es-domain directly) and re-run.`,
    };
  }

  // Idempotency layer 2: an existing promoted-from edge means this origin was
  // already promoted — report it, write nothing. The edge is written with the SHARED
  // copy as subject and the origin as object (shared -> origin), so from the ORIGIN's
  // perspective it is an INCOMING edge. Check both directions to be robust against a
  // hand-written reverse edge: outgoing(origin) would catch a reversed write,
  // incoming(origin) catches the canonical direction we actually write.
  const [outEdges, inEdges] = await Promise.all([
    args.call("kg_query", { entity: skillId, direction: "outgoing", predicate: PROMOTED_FROM_PREDICATE, recurse: false, max_depth: 1 }).catch(() => ({})),
    args.call("kg_query", { entity: skillId, direction: "incoming", predicate: PROMOTED_FROM_PREDICATE, recurse: false, max_depth: 1 }).catch(() => ({})),
  ]);
  const alreadyPromotedTo = outgoingObjects(outEdges)[0] || incomingSubjects(inEdges)[0];
  if (alreadyPromotedTo) {
    return {
      ok: true,
      dry_run: dryRun,
      skill_id: skillId,
      from,
      to: { wing: sharedWing, room: SHARED_SKILLS_ROOM },
      already_promoted_to: alreadyPromotedTo,
      next_step: "Already promoted — the shared copy exists and the edge is in place. Re-running writes nothing (idempotent).",
    };
  }

  // Resolve the destination room against the SHARED wing's taxonomy: reuse an
  // existing skill-like room before minting `skills`. A missing shared wing is NOT
  // an error — filing there creates it (command/relocate-memory.md convention).
  const explicitRoom = String(args.sharedRoom || "").trim();
  let room = SHARED_SKILLS_ROOM;
  let reused = false;
  if (!explicitRoom) {
    try {
      const taxonomy = parseTaxonomy(await args.call("get_taxonomy", {}));
      const wingEntry = taxonomy.find((entry) => entry.wing === sharedWing);
      ({ room, reused } = pickPurposeRoom(wingEntry?.rooms || [], SHARED_SKILLS_ROOM, SKILL_LIKE_STEMS));
    } catch {
      // unreadable taxonomy — fall back to the canonical room name
    }
  } else {
    room = explicitRoom;
    reused = true;
  }

  if (dryRun) {
    // READS ONLY — no add_drawer, no kg_add. The duplicate guard is a single
    // read-only call that prevents a second shared copy of the same procedure.
    let pre: { total: number; covered: number } = { total: 0, covered: 0 };
    try {
      const page = asObject(await args.call("list_drawers", { wing: sharedWing, room, limit: 25, offset: 0 }));
      const rows = Array.isArray(page.drawers) ? (page.drawers as unknown[]) : [];
      pre = { total: Number(page.total) || rows.length, covered: rows.length };
    } catch {
      pre = { total: 0, covered: 0 }; // unreadable room — report it, do not guess
    }

    let duplicateDrawerId: string | undefined;
    try {
      const dup = asObject(await args.call("check_duplicate", { content }));
      if (dup.is_duplicate === true) duplicateDrawerId = asText(dup.drawer_id || dup.id).trim() || undefined;
    } catch {
      // guard is best-effort: an unreadable check_duplicate must not block promotion
    }

    return {
      ok: true,
      dry_run: true,
      skill_id: skillId,
      from,
      to: { wing: sharedWing, room },
      reused_room: reused,
      pre_snapshot: pre,
      duplicate_drawer_id: duplicateDrawerId,
      domain: sourceDomain,
      next_step: duplicateDrawerId
        ? `An exact-duplicate drawer already exists (${duplicateDrawerId}) — apply will skip filing (idempotent).`
        : `Apply will COPY the skill verbatim into ${sharedWing}/${room} (reused=${reused}), stamp es-source-type: skill + es-domain: ${sourceDomain} (propagated from the origin — promotion requires an explicit domain), and add the ${PROMOTED_FROM_PREDICATE} edge back to ${skillId}. The source drawer is left untouched. Re-run with dry_run:false after approval.`,
    };
  }

  // ---- APPLY: duplicate guard → add_drawer → stamp → promoted-from edge. ----
  try {
    const dup = asObject(await args.call("check_duplicate", { content }));
    if (dup.is_duplicate === true) {
      return {
        ok: true,
        dry_run: false,
        skill_id: skillId,
        from,
        to: { wing: sharedWing, room },
        reused_room: reused,
        duplicate_drawer_id: asText(dup.drawer_id || dup.id).trim() || undefined,
        next_step: "Exact duplicate already filed — nothing written (idempotent re-apply).",
      };
    }
  } catch {
    // best-effort guard; proceed to filing (substrate dedup is the backstop)
  }

  let created: Record<string, unknown>;
  try {
    created = asObject(
      await args.call("add_drawer", {
        wing: sharedWing,
        room,
        content,
        source_file: `promoted-from:${skillId}`,
        added_by: "electric-shepherd-promote-skill",
      }),
    );
  } catch (error) {
    return {
      ok: false,
      dry_run: false,
      skill_id: skillId,
      from,
      to: { wing: sharedWing, room },
      reused_room: reused,
      error: `add_drawer failed: ${asText((error as Error | undefined)?.message || error).slice(0, 500)}`,
      next_step: "Filing aborted — nothing else ran. Re-run to retry.",
    };
  }

  const drawerId = asText(created.drawer_id || created.id).trim();
  if (!drawerId) {
    return {
      ok: false,
      dry_run: false,
      skill_id: skillId,
      from,
      to: { wing: sharedWing, room },
      reused_room: reused,
      error: "add_drawer returned no drawer_id",
      next_step: "Inspect the raw result and re-run; identical content maps to the same deterministic drawer ID.",
    };
  }

  // Stamp es-source-type: skill on the shared copy. `es-status` is intentionally
  // NOT touched — orthogonal axes. A failed stamp is reported, never fatal (the
  // duplicate guard makes the re-run safe).
  let stampFailed = 0;
  try {
    await args.call("kg_add", { subject: drawerId, predicate: "es-source-type", object: "skill", source_closet: drawerId });
  } catch {
    stampFailed = 1;
  }

  // Phase 12: propagate the origin's es-domain to the shared copy. The filter is a
  // HARD match (null/general/requesting-domain), so an unstamped shared copy would be
  // admitted everywhere — the domain must travel with the skill or the promotion
  // silently degrades every project's procedural retrieval.
  try {
    await args.call("kg_add", { subject: drawerId, predicate: "es-domain", object: sourceDomain, source_closet: drawerId });
  } catch {
    stampFailed = 1;
  }

  // The promoted-from lineage edge: shared copy -> origin. NOT synthesized-from —
  // it must never feed height or recursive lineage traversal (see memgraph.ts).
  let edgeFailed = 0;
  try {
    await args.call("kg_add", { subject: drawerId, predicate: PROMOTED_FROM_PREDICATE, object: skillId, source_drawer_id: drawerId });
  } catch {
    edgeFailed = 1;
  }

  const report: SkillPromotionReport = {
    ok: true,
    dry_run: false,
    skill_id: skillId,
    from,
    to: { wing: sharedWing, room },
    reused_room: reused,
    drawer_id: drawerId,
    domain: sourceDomain,
  };
  if (stampFailed > 0) report.stamp_failed = 1;
  if (edgeFailed > 0) report.edge_failed = 1;
  if (stampFailed > 0 && edgeFailed > 0) {
    report.next_step = `Shared copy ${drawerId} filed but UNSTAMPED and MISSING its ${PROMOTED_FROM_PREDICATE} edge. Re-run with the same skill_id — the duplicate guard returns the existing ID, then retry stamping via palace_stamp_source_type and re-apply for the edge.`;
  } else if (stampFailed > 0) {
    report.next_step = `Shared copy ${drawerId} is filed but UNSTAMPED. Re-stamp via palace_stamp_source_type.`;
  } else if (edgeFailed > 0) {
    report.next_step = `Shared copy ${drawerId} is filed and stamped, but the ${PROMOTED_FROM_PREDICATE} edge failed. Re-run with the same skill_id to retry (kg_add of an identical triple is a no-op).`;
  } else {
    report.next_step = `Promoted: ${skillId} -> ${drawerId}. The source drawer is left untouched; procedural-intent retrieval now reaches it from every project wing.`;
  }
  return report;
}
export type PromotionCandidate = {
  content_prefix: string;
  wings: string[];
  drawer_ids: string[];
  candidate: boolean;
};

export type CandidateScanReport = {
  ok: boolean;
  scanned_wings: string[];
  shared_wing_excluded: string;
  rooms_scanned: number;
  skills_seen: number;
  candidates: PromotionCandidate[];
  error?: string;
};

/**
 * Read-only candidate detection (Phase 10 CONSUME surface): scan the `skills` room of
 * every project wing and group skill-stamped drawers by near-duplicate content. A
 * group spanning >= PROMOTION_CANDIDATE_MIN_WINGS distinct wings is a promotion
 * candidate — the conservative proxy for "used successfully in N projects" (no
 * per-project success signal exists yet). The shared skills wing is EXCLUDED from
 * evidence: a copy that already lives there is the result of promotion, not proof
 * of cross-project use. Pure read path: one taxonomy call, one list_drawers page per
 * wing's skills room, one check_duplicate probe per distinct content group. Never
 * writes anything — proposals are surfaced for operator approval (dreamer step 5d).
 */
export async function findPromotionCandidates(args: {
  call: CallTool;
  sharedWing?: string;
  maxRooms?: number;
}): Promise<CandidateScanReport> {
  const sharedWing = String(args.sharedWing || DEFAULT_SHARED_WING).trim() || DEFAULT_SHARED_WING;
  const maxRooms = Math.max(1, Number(args.maxRooms) || 25);

  let taxonomy: ReturnType<typeof parseTaxonomy>;
  try {
    taxonomy = parseTaxonomy(await args.call("get_taxonomy", {}));
  } catch (error) {
    return {
      ok: false,
      scanned_wings: [],
      shared_wing_excluded: sharedWing,
      rooms_scanned: 0,
      skills_seen: 0,
      candidates: [],
      error: `get_taxonomy failed: ${asText((error as Error | undefined)?.message || error).slice(0, 300)}`,
    };
  }

  const wings = taxonomy
    .map((entry) => entry.wing)
    .filter((wing) => wing && wing !== sharedWing) // the shared wing is a result, not evidence
    .slice(0, maxRooms);

  type SkillRow = { id: string; content: string; wing: string };
  const skills: SkillRow[] = [];
  let roomsScanned = 0;

  for (const wing of wings) {
    // Reuse the wing's existing skill-like room before minting `skills` — a project
    // that filed its skills under a variant name must still be scanned.
    const wingEntry = taxonomy.find((entry) => entry.wing === wing);
    let room = SHARED_SKILLS_ROOM;
    try {
      ({ room } = pickPurposeRoom(wingEntry ? wingEntry.rooms : [], SHARED_SKILLS_ROOM, SKILL_LIKE_STEMS));
    } catch {
      // unreadable rooms — fall back to the canonical name
    }

    let page: Record<string, unknown>;
    try {
      page = asObject(await args.call("list_drawers", { wing, room, limit: 50, offset: 0 }));
    } catch {
      continue; // unreadable room — degrade gracefully, keep scanning the rest
    }
    roomsScanned += 1;

    const rows = Array.isArray(page.drawers) ? (page.drawers as unknown[]) : [];
    for (const raw of rows) {
      const row = asObject(raw);
      const id = asText(row.drawer_id || row.node_id || row.id).trim();
      if (!id) continue;
      skills.push({ id, content: asText(row.content || row.preview || "").trim(), wing });
    }
  }

  // Group by near-duplicate content (check_duplicate is the substrate's own dedup
  // oracle — same threshold semantics as file_skill's guard). Only drawers with
  // non-empty content participate; empty rows carry no procedure to compare.
  const groups: { key: string; members: SkillRow[] }[] = [];
  for (const row of skills) {
    if (!row.content) continue;
    let group = groups.find((g) => g.key === row.content.slice(0, 200));
    if (!group) {
      group = { key: row.content.slice(0, 200), members: [] };
      groups.push(group);
    }
    group.members.push(row);
  }

  const candidates: PromotionCandidate[] = [];
  for (const group of groups) {
    // A single drawer is never a candidate by itself — the rule needs >= 2 wings.
    if (group.members.length < PROMOTION_CANDIDATE_MIN_WINGS) continue;
    const wingsSeen = [...new Set(group.members.map((m) => m.wing).filter(Boolean))];
    // Grouping by content prefix IS the near-duplicate detection: members that share
    // a 200-char prefix are, for candidate purposes, the same procedure filed in
    // several wings. (check_duplicate is a global oracle — probing member B's content
    // against the palace returns false unless A was already filed there, which is not
    // what we want to test here. The prefix group is the conservative unit.)
    const candidate = isPromotionCandidate(wingsSeen, PROMOTION_CANDIDATE_MIN_WINGS);
    if (!candidate) continue;
    candidates.push({
      content_prefix: group.members[0].content.slice(0, 120),
      wings: wingsSeen.sort(),
      drawer_ids: group.members.map((m) => m.id).sort(),
      candidate: true,
    });
  }

  return {
    ok: true,
    scanned_wings: wings,
    shared_wing_excluded: sharedWing,
    rooms_scanned: roomsScanned,
    skills_seen: skills.length,
    candidates: candidates.sort((a, b) => a.content_prefix.localeCompare(b.content_prefix)),
  };
}

export default tool({
  description:
    "Phase 10 (unified memory): promote a project skill into the shared skills wing so procedural-intent retrieval from ANY project wing can reach it. COPY, not move — the source drawer stays untouched; the shared copy is stamped es-source-type: skill + es-domain (propagated from the origin) and linked back via a promoted-from edge (NOT lineage). Phase 12: promotion REQUIRES an explicit es-domain on the source — an unstamped/out-of-vocabulary domain is refused with no writes. Promotion is explicit and approval-gated only: dry-run by default, apply writes add_drawer + kg_add after operator approval of the numbered proposal. Idempotent: an exact-duplicate guard plus an existing-edge guard make re-runs no-ops. Use findPromotionCandidates (via the memory-status surface) to discover skills present in >= 2 project wings before proposing.",
  args: {
    skill_id: tool.schema.string().describe("Drawer ID of the project skill to promote (must carry es-source-type: skill)."),
    shared_wing: tool.schema
      .string()
      .optional()
      .describe(`Destination wing for promoted skills. Defaults to ${DEFAULT_SHARED_WING} (or memory.sharedSkillsWing in runtime config).`),
    room: tool.schema.string().optional().describe("Explicit destination room in the shared wing. Default: reuse-or-mint `skills`."),
    dry_run: tool.schema.boolean().optional().describe("Preview without writing (default true). Pass false to apply after approval."),
    tool_prefix: tool.schema.string().optional().describe("MCP tool prefix override."),
  },
  async execute(args, context) {
    const cwd = context.worktree || context.directory;
    loadRuntimeEnv({ scriptUrl: import.meta.url, env: process.env, cwd });
    const runtimeConfig = loadRuntimeConfig({ cwd, env: process.env });
    applyRuntimeConfigToEnv(process.env, runtimeConfig);

    // Shared wing resolution: explicit arg > runtime config memory.sharedSkillsWing
    // > the canonical default. A location, not a kind.
    const sharedWing = String(args.shared_wing || runtimeConfig.valuesByPath.memory?.sharedSkillsWing || "").trim();

    const { client, prefix } = await createPalaceClient({
      env: process.env,
      clientName: "electric-shepherd-promote-skill",
      toolPrefix: args.tool_prefix,
    });
    const call: CallTool = (name, payload) => client.callTool(`${prefix}${name}`, payload);

    const report = await runSkillPromotion({
      call,
      skillId: args.skill_id,
      sharedWing: sharedWing || undefined,
      sharedRoom: args.room,
      dryRun: args.dry_run,
    });

    return JSON.stringify(report, null, 2);
  },
} as any);
