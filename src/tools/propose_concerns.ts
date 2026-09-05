/**
 * Phase 4 (unified memory): `concerns` edges — cross-type authority links from a
 * synthesis closet to the ingested docs it relies on.
 *
 * Predicate shape: `{subject: <synthesis id>, predicate: "concerns", object: <doc id>}`.
 * This is a KG edge, NOT lineage: it never counts toward height and is never consumed
 * by getLineageSources/getLineageDerivatives. Retrieval expansion (Phase 4) pulls one-hop
 * `concerns` targets into the ranked pool so a hit on a synthesis surfaces its authority.
 *
 * Approval-gated by design (spec: "Do not auto-link — a wrong link silently corrupts
 * retrieval for that topic"). The dreamer proposes candidates as a numbered list at the
 * end of a consolidation pass (mirroring the relocate_memory pattern) and re-runs this
 * tool with dry_run:false ONLY for user-approved items.
 *
 * Endpoint validation runs on BOTH the dry-run and apply paths — it is the false-link
 * guard:
 *   1. subject must be a real synthesis: at least one outgoing `synthesized-from` edge
 *      (it has lineage; it is a derived closet, not a raw drawer or a doc);
 *   2. object must carry `es-source-type: doc` (the hard check — an unstamped or
 *      wrongly-typed target rejects the edge with error "target-is-not-doc");
 *   3. no self-link (synthesis_id === doc_id) and no duplicate existing concerns edge
 *      (idempotent re-apply = reported skip, matching kg_add's triple idempotency).
 *
 * Dry-run by default — the first call makes NO mutating MCP call (no kg_add); it only
 * reads endpoints. Per-edge failures are counted, never abort the batch (relocate_memory
 * lineage pattern). `es-status` is intentionally not touched — orthogonal axis.
 */

import { tool } from "@opencode-ai/plugin";
import { asObject, asText, createPalaceClient, parseFacts } from "../core/palace-tools.ts";
import { applyRuntimeConfigToEnv, loadRuntimeConfig } from "../core/runtime-config.ts";
import { runKgAddWrites } from "../core/operation.ts";
import { normalizeDryRunArg } from "../core/substrate.ts";
import { loadRuntimeEnv } from "../scripts/runtime-env.ts";

declare const process: {
  env: Record<string, string | undefined>;
};

const CONCERNS_PREDICATE = "concerns";

export type CallTool = (name: string, payload: Record<string, unknown>) => Promise<unknown>;

export type ConcernEdgeStatus = "proposed" | "skipped-duplicate" | "rejected-not-synthesis" | "rejected-not-doc" | "rejected-self-link" | "added" | "add-failed";

export type ConcernProposalItem = {
  synthesis_id: string;
  doc_id: string;
  status: ConcernEdgeStatus;
  doc_desc?: string;
  reason?: string;
  proposed_edge?: { subject: string; predicate: string; object: string };
  error?: string;
};

export type ConcernProposalReport = {
  ok: boolean;
  dry_run: boolean;
  synthesis_id: string;
  edges: ConcernProposalItem[];
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

function drawerDesc(call: CallTool, id: string): Promise<string> {
  return call("get_drawer", { drawer_id: id })
    .then((raw) => {
      const drawer = asObject(raw);
      if (asText(drawer.error)) return "";
      const meta = asObject(drawer.metadata);
      return asText(drawer.desc || drawer.title || drawer.summary || meta.desc).trim();
    })
    .catch(() => "");
}

/**
 * Pure core: validate endpoints and (when dry_run is false) add the approved `concerns`
 * edges. Exported for unit testing with a fake transport, mirroring runDocIngest /
 * pickReferenceRoom in ingest_docs.ts.
 */
export async function runConcernProposal(args: {
  call: CallTool;
  synthesisId: string;
  docIds: string[];
  dry_run?: boolean;
  dryRun?: boolean;
}): Promise<ConcernProposalReport> {
  const synthesisId = String(args.synthesisId || "").trim();
  if (!synthesisId) throw new Error("propose_concerns: synthesis_id is required");
  const docIds = [...new Set((args.docIds || []).map((id) => String(id).trim()).filter(Boolean))];
  if (docIds.length === 0) throw new Error("propose_concerns: at least one doc_id is required");
  const dryRun = normalizeDryRunArg(args);

  // Endpoint validation — shared by preview and apply. One bounded fan-out of one-hop
  // reads per endpoint; no room scans, no content reads beyond a desc lookup for the
  // preview payload.
  const [lineageTargets, subjectType, docTypes, docDescs] = await Promise.all([
    args.call("kg_query", { entity: synthesisId, direction: "outgoing", predicate: "synthesized-from", recurse: false, max_depth: 1 }).catch(() => ({})),
    closetSourceType(args.call, synthesisId),
    Promise.all(docIds.map((id) => closetSourceType(args.call, id))),
    Promise.all(docIds.map((id) => drawerDesc(args.call, id))),
  ]);
  const hasLineage = outgoingObjects(lineageTargets).length > 0;

  let existingConcerns: string[] = [];
  try {
    existingConcerns = outgoingObjects(await args.call("kg_query", { entity: synthesisId, direction: "outgoing", predicate: CONCERNS_PREDICATE, recurse: false, max_depth: 1 }));
  } catch {
    existingConcerns = []; // unreadable -> treat as none; kg_add idempotency is the backstop
  }

  const edges: ConcernProposalItem[] = docIds.map((docId, i) => ({
    synthesis_id: synthesisId,
    doc_id: docId,
    status: "proposed" as ConcernEdgeStatus,
    doc_desc: docDescs[i] || undefined,
    proposed_edge: { subject: synthesisId, predicate: CONCERNS_PREDICATE, object: docId },
  }));

  // Apply the rejection rules (same order on preview and apply).
  if (!hasLineage) {
    for (const edge of edges) {
      edge.status = "rejected-not-synthesis";
      edge.reason = "subject has no outgoing synthesized-from lineage — it is not a synthesis closet";
    }
  } else {
    edges.forEach((edge, i) => {
      if (edge.doc_id === synthesisId) {
        edge.status = "rejected-self-link";
        edge.reason = "self-link: doc_id equals synthesis_id";
        return;
      }
      if (docTypes[i] !== "doc") {
        edge.status = "rejected-not-doc";
        edge.reason = `target es-source-type is ${docTypes[i] ?? "unknown"}, not doc`;
        return;
      }
      if (existingConcerns.includes(edge.doc_id)) {
        edge.status = "skipped-duplicate";
        edge.reason = "concerns edge already exists (idempotent re-apply)";
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
      synthesis_id: synthesisId,
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
        subject: synthesisId,
        predicate: CONCERNS_PREDICATE,
        object: edge.doc_id,
        source_closet: synthesisId,
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

  const report: ConcernProposalReport = { ok: true, dry_run: false, synthesis_id: synthesisId, edges, counts };
  if (counts.add_failed > 0) {
    report.next_step = `Re-run with the same args to retry ${counts.add_failed} failed edge(s); kg_add of an identical triple is a no-op.`;
  }
  return report;
}

export default tool({
  description:
    "Phase 4 cross-type linking: validate and (when approved) add `concerns` edges from a synthesis closet to its authority docs. Edge shape: {subject: <synthesis id>, predicate: 'concerns', object: <doc id>}. Validates both endpoints before preview or apply: subject must have synthesized-from lineage, each target must carry es-source-type: doc; rejects self-links and duplicates (idempotent). Dry-run by default — the first call makes no kg_add; pass dry_run:false to apply only after user approval of the numbered proposal list.",
  args: {
    synthesis_id: tool.schema.string().describe("Synthesis closet ID (subject of the concerns edges)."),
    doc_ids: tool.schema.array(tool.schema.string()).describe("Doc drawer IDs (objects of the concerns edges) — one apply call per approved item keeps approval atomic per edge."),
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
      clientName: "electric-shepherd-propose-concerns",
      toolPrefix: args.tool_prefix,
    });
    const call = async (name: string, payload: Record<string, unknown>) =>
      client.callTool(`${prefix}${name}`, payload);

    const report = await runConcernProposal({
      call,
      synthesisId: String(args.synthesis_id || ""),
      docIds: Array.isArray(args.doc_ids) ? args.doc_ids.map(String) : [],
      dryRun: args.dry_run,
    });

    return JSON.stringify(report, null, 2);
  },
});
