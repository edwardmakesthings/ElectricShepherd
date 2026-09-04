/**
 * Phase 5 (unified memory): `refined-by` edges — skill → evidence links from a
 * skill drawer to the session/synthesis/apprenticeship drawers that changed how
 * the skill should work.
 *
 * Predicate shape: `{subject: <skill id>, predicate: "refined-by", object: <session/synthesis id>}`.
 * Direction is skill → evidence (outgoing from the skill), mirroring `concerns`
 * (synthesis → doc): the node that benefits from the link holds the outgoing edge
 * to its supporting material. Apprenticeship worked examples use the SAME
 * predicate — a worked example IS "a session that changed/confirmed how the skill
 * works", so one tool serves both proposal surfaces.
 *
 * This is a KG edge, NOT lineage: it never counts toward height and is never
 * consumed by getLineageSources/getLineageDerivatives (those hardcode
 * `synthesized-from`). Retrieval expansion (Phase 5 Unit B) pulls one-hop
 * `refined-by` neighbors into the ranked pool on procedural intent.
 *
 * Approval-gated by design (same rule as Phase 4 concerns): a wrong `refined-by`
 * edge silently pollutes procedural retrieval — every future "how do I do X"
 * query would surface the wrong session as evidence for the skill. The dreamer
 * proposes candidates as a numbered list at the end of a consolidation pass and
 * re-runs this tool with dry_run:false ONLY for user-approved items.
 *
 * Endpoint validation runs on BOTH the dry-run and apply paths — it is the
 * false-link guard:
 *   1. subject must be a real skill drawer: it exists AND carries
 *      `es-source-type: skill` (the hard check — unstamped or wrongly-typed
 *      subjects reject every edge with "rejected-not-skill");
 *   2. object must EXIST as a drawer (`get_drawer`). No es-source-type is
 *      required on the object — evidence can be a transcript, a synthesis, or an
 *      unstamped session/apprenticeship note; requiring a stamp would reject
 *      valid evidence. The hard check is existence only;
 *   3. no self-link (skill_id === evidence_id) and no duplicate existing
 *      `refined-by` edge with the same object (idempotent re-apply = reported
 *      skip, matching kg_add's triple idempotency).
 *
 * Dry-run by default — the first call makes NO mutating MCP call (no kg_add); it
 * only reads endpoints. Per-edge failures are counted, never abort the batch
 * (relocate_memory lineage pattern). `es-status` is intentionally not touched —
 * orthogonal axis.
 */

import { tool } from "@opencode-ai/plugin";
import { asObject, asText, createPalaceClient, parseFacts } from "../adapter/palace-tools.ts";
import { applyRuntimeConfigToEnv, loadRuntimeConfig } from "../adapter/runtime-config.ts";
import { runKgAddWrites } from "../core/operation.ts";
import { normalizeDryRunArg } from "../core/substrate.ts";
import { loadRuntimeEnv } from "../scripts/runtime-env.ts";

declare const process: {
  env: Record<string, string | undefined>;
};

export const REFINED_BY_PREDICATE = "refined-by";

export type CallTool = (name: string, payload: Record<string, unknown>) => Promise<unknown>;

export type RefinementEdgeStatus =
  | "proposed"
  | "skipped-duplicate"
  | "rejected-not-skill"
  | "rejected-evidence-missing"
  | "rejected-self-link"
  | "added"
  | "add-failed";

export type RefinementProposalItem = {
  skill_id: string;
  evidence_id: string;
  status: RefinementEdgeStatus;
  evidence_desc?: string;
  reason?: string;
  proposed_edge?: { subject: string; predicate: string; object: string };
  error?: string;
};

export type RefinementProposalReport = {
  ok: boolean;
  dry_run: boolean;
  skill_id: string;
  edges: RefinementProposalItem[];
  counts: { proposed: number; added: number; skipped_duplicate: number; rejected: number; add_failed: number };
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

/** es-source-type value of one node, or null when unstamped / unreadable. */
function closetSourceType(call: CallTool, id: string): Promise<string | null> {
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

/** Drawer existence + desc in one bounded get_drawer. Returns null when the drawer does not exist. */
function drawerInfo(call: CallTool, id: string): Promise<{ exists: boolean; desc: string } | null> {
  return call("get_drawer", { drawer_id: id })
    .then((raw) => {
      const drawer = asObject(raw);
      if (asText(drawer.error)) return null; // explicit error → does not exist
      const meta = asObject(drawer.metadata);
      const desc = asText(drawer.desc || drawer.title || drawer.summary || meta.desc).trim();
      const hasId = Boolean(asText(drawer.drawer_id || drawer.id || id).trim());
      if (!hasId && !desc) return null; // empty result → does not exist
      return { exists: true, desc };
    })
    .catch(() => null);
}

/**
 * Pure core: validate endpoints and (when dry_run is false) add the approved
 * `refined-by` edges. Exported for unit testing with a fake transport, mirroring
 * runConcernProposal in propose_concerns.ts.
 */
export async function runRefinementProposal(args: {
  call: CallTool;
  skillId: string;
  evidenceIds: string[];
  dry_run?: boolean;
  dryRun?: boolean;
}): Promise<RefinementProposalReport> {
  const skillId = String(args.skillId || "").trim();
  if (!skillId) throw new Error("propose_refinements: skill_id is required");
  const evidenceIds = [...new Set((args.evidenceIds || []).map((id) => String(id).trim()).filter(Boolean))];
  if (evidenceIds.length === 0) throw new Error("propose_refinements: at least one evidence_id is required");
  const dryRun = normalizeDryRunArg(args);

  // Endpoint validation — shared by preview and apply. One bounded fan-out of
  // one-hop reads per endpoint; no room scans, no content reads beyond a desc
  // lookup for the preview payload.
  const [skillExists, skillType, evidenceInfos, existingRefined] = await Promise.all([
    drawerInfo(args.call, skillId).then((info) => info !== null),
    closetSourceType(args.call, skillId),
    Promise.all(evidenceIds.map((id) => drawerInfo(args.call, id))),
    args.call("kg_query", { entity: skillId, direction: "outgoing", predicate: REFINED_BY_PREDICATE, recurse: false, max_depth: 1 }).catch(() => ({})),
  ]);
  const existingRefinedBy = outgoingObjects(existingRefined);

  const edges: RefinementProposalItem[] = evidenceIds.map((evidenceId, i) => ({
    skill_id: skillId,
    evidence_id: evidenceId,
    status: "proposed" as RefinementEdgeStatus,
    evidence_desc: evidenceInfos[i]?.desc || undefined,
    proposed_edge: { subject: skillId, predicate: REFINED_BY_PREDICATE, object: evidenceId },
  }));

  // Apply the rejection rules (same order on preview and apply). The subject
  // check applies to every edge; per-edge checks run only when the subject is a
  // real skill drawer.
  if (!skillExists || skillType !== "skill") {
    for (const edge of edges) {
      edge.status = "rejected-not-skill";
      edge.reason = !skillExists
        ? "skill drawer does not exist"
        : `subject es-source-type is ${skillType ?? "unknown"}, not skill`;
    }
  } else {
    edges.forEach((edge, i) => {
      if (edge.evidence_id === skillId) {
        edge.status = "rejected-self-link";
        edge.reason = "self-link: evidence_id equals skill_id";
        return;
      }
      if (evidenceInfos[i] === null) {
        edge.status = "rejected-evidence-missing";
        edge.reason = "target drawer does not exist (session/synthesis/apprenticeship IDs must be real drawer IDs)";
        return;
      }
      if (existingRefinedBy.includes(edge.evidence_id)) {
        edge.status = "skipped-duplicate";
        edge.reason = "refined-by edge already exists (idempotent re-apply)";
      }
    });
  }

  const counts = { proposed: 0, added: 0, skipped_duplicate: 0, rejected: 0, add_failed: 0 };
  for (const edge of edges) {
    if (edge.status === "proposed") counts.proposed += 1;
    else if (edge.status === "skipped-duplicate") counts.skipped_duplicate += 1;
    else counts.rejected += 1;
  }

  if (dryRun) {
    return {
      ok: true,
      dry_run: true,
      skill_id: skillId,
      edges,
      counts,
      next_step: "Show this preview to the user; re-run with dry_run:false only after they approve.",
    };
  }

  // APPLY: one kg_add per approved edge. Best-effort per edge — one failure never
  // aborts the rest (relocate_memory lineage pattern).
  const proposed = edges.filter((edge) => edge.status === "proposed");
  const results = await runKgAddWrites(
    args.call,
    proposed.map((edge) => ({
      payload: {
        subject: skillId,
        predicate: REFINED_BY_PREDICATE,
        object: edge.evidence_id,
        source_closet: skillId,
      },
    })),
  );
  for (let i = 0; i < proposed.length; i += 1) {
    const edge = proposed[i];
    const result = results[i];
    if (result?.ok) {
      edge.status = "added";
      counts.added += 1;
    } else {
      edge.status = "add-failed";
      edge.error = String(result?.error || "kg_add failed");
      counts.add_failed += 1;
    }
  }

  const report: RefinementProposalReport = { ok: true, dry_run: false, skill_id: skillId, edges, counts };
  if (counts.add_failed > 0) {
    report.next_step = `Re-run with the same args to retry ${counts.add_failed} failed edge(s); kg_add of an identical triple is a no-op.`;
  }
  return report;
}

export default tool({
  description:
    "Phase 5 procedural memory: validate and (when approved) add `refined-by` edges from a skill drawer to the session/synthesis/apprenticeship drawers that changed how the skill should work. Edge shape: {subject: <skill id>, predicate: 'refined-by', object: <evidence id>}. Validates both endpoints before preview or apply: subject must exist and carry es-source-type: skill, each evidence drawer must exist (any source type — transcript, synthesis, or unstamped session note); rejects self-links and duplicates (idempotent). NOT lineage — never counts toward height. Dry-run by default — the first call makes no kg_add; pass dry_run:false to apply only after user approval of the numbered proposal list.",
  args: {
    skill_id: tool.schema.string().describe("Skill drawer ID (subject of the refined-by edges) — must carry es-source-type: skill."),
    evidence_ids: tool.schema.array(tool.schema.string()).describe("Evidence drawer IDs (objects): session transcripts, synthesis closets, or apprenticeship worked examples that changed how the skill works. One apply call per approved item keeps approval atomic per edge."),
    dry_run: tool.schema.boolean().optional().describe("Preview without writing (default true)."),
    tool_prefix: tool.schema.string().optional().describe("MCP tool prefix override."),
  },
  async execute(args, context) {
    const cwd = context.worktree || context.directory;
    loadRuntimeEnv({ scriptUrl: import.meta.url, env: process.env, cwd });
    const runtimeConfig = loadRuntimeConfig({ cwd, env: process.env });
    applyRuntimeConfigToEnv(process.env, runtimeConfig);

    const { client, prefix } = await createPalaceClient({
      env: process.env,
      clientName: "electric-shepherd-propose-refinements",
      toolPrefix: args.tool_prefix,
    });
    const call = async (name: string, payload: Record<string, unknown>) =>
      client.callTool(`${prefix}${name}`, payload);

    const report = await runRefinementProposal({
      call,
      skillId: String(args.skill_id || ""),
      evidenceIds: Array.isArray(args.evidence_ids) ? args.evidence_ids.map(String) : [],
      dryRun: args.dry_run,
    });

    return JSON.stringify(report, null, 2);
  },
});
