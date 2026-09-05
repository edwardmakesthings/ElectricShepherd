/**
 * File a skill definition as a drawer in the project
 * wing's `skills` room and stamp it `es-source-type: skill`.
 *
 * The point is not storage — skills IMPROVE FROM USE. The procedure text goes in
 * verbatim (goal, preconditions, steps, failure modes, verification); refinement
 * afterwards happens via `refined-by` KG edges (see propose_refinements.ts) and,
 * if the procedure itself changes, by filing a NEW drawer + `merged-into` edge —
 * never by rewriting this one. The raw-drawer verbatim invariant is preserved.
 *
 * Room selection reuses the shared picker (`pickPurposeRoom` in ingest_docs.ts):
 * `get_taxonomy`, reuse an existing skill-like room under the kebab-case/purpose
 * contract before minting `skills`. No second taxonomy walk exists in the codebase.
 *
 * Dry-run by default — the first call makes NO mutating MCP call: it performs a
 * read-only `check_duplicate` guard (exact-duplicate sprawl guard, R1) plus a
 * bounded one-page listing of the destination room and returns a plan + next_step.
 * Apply = check_duplicate → add_drawer → stamp `es-source-type: skill`. If
 * add_drawer fails, stop (nothing else ran). If the stamp fails, report
 * `stamp_failed: 1` with a retry next_step; re-running is safe because identical
 * content gets a deterministic drawer ID from the substrate dedup.
 *
 * `es-status` is intentionally NOT touched — a skill is authoritative on arrival,
 * like a doc; the two axes are orthogonal (spec: never conflate them).
 */

import { tool } from "@opencode-ai/plugin";
import { SKILL_DOMAINS, type SkillDomain } from "../core/memgraph.ts";
import { asObject, asText, createPalaceClient, parseRows, parseTaxonomy } from "../core/palace-tools.ts";
import { applyRuntimeConfigToEnv, loadRuntimeConfig } from "../core/runtime-config.ts";
import { runCheckDuplicate, runCheckpointWrite, runKgAddWrites } from "../core/operation.ts";
import { normalizeDryRunArg } from "../core/substrate.ts";
import { loadRuntimeEnv } from "../scripts/runtime-env.ts";
import { pickPurposeRoom } from "./ingest_docs.ts";

declare const process: {
  env: Record<string, string | undefined>;
};

export const SKILLS_ROOM = "skills";
// Purpose-named stems that count as an existing skills room (checked against the
// kebab-case/purpose contract via pickPurposeRoom before reuse).
export const SKILL_LIKE_STEMS = ["skills", "skill"];

const DRY_RUN_PAGE_SIZE = 25; // one bounded page, never paged to exhaustion

export type CallTool = (name: string, payload: Record<string, unknown>) => Promise<unknown>;

export type SkillFilingReport = {
  ok: boolean;
  wing: string;
  room: string;
  reused: boolean;
  dry_run: boolean;
  error?: string;
  duplicate_drawer_id?: string;
  pre_snapshot?: { total: number; covered: number };
  /** The resolved es-domain (explicit arg, or the `general` default). */
  domain?: SkillDomain;
  drawer_id?: string;
  stamp_failed?: number;
  next_step?: string;
};

/**
 * Pure core: file one skill drawer into the skills room and stamp it
 * `es-source-type: skill`. Exported for unit testing with a fake transport,
 * mirroring runDocIngest in ingest_docs.ts.
 */
export async function runSkillFiling(args: {
  call: CallTool;
  wing: string;
  content: string;
  desc?: string;
  room?: string;
  /** es-domain axis. Closed vocabulary — unknown values are rejected at write time. */
  domain?: SkillDomain | string;
  dry_run?: boolean;
  dryRun?: boolean;
}): Promise<SkillFilingReport> {
  const wing = String(args.wing || "").trim();
  if (!wing) throw new Error("file_skill: wing is required (no project wing resolved)");
  const content = String(args.content || "").trim();
  if (!content) throw new Error("file_skill: content is required — the full procedure text, not a summary");
  // Validate against the closed vocabulary at write time so drift can never
  // land in the KG (the read side treats unknown values as unstamped, i.e. general).
  const rawDomain = String(args.domain ?? "").trim();
  if (rawDomain && !(SKILL_DOMAINS as readonly string[]).includes(rawDomain)) {
    throw new Error(`file_skill: unknown domain "${rawDomain}" — allowed: ${SKILL_DOMAINS.join(" | ")}`);
  }
  // TEMPORARY CONSERVATIVE DEFAULT until project-domain inference is added (spec wants
  // `general` used sparingly; an explicit arg is the only way to opt out for now).
  const domain = (rawDomain || "general") as SkillDomain;
  const dryRun = normalizeDryRunArg(args);

  const taxonomy = parseTaxonomy(await args.call("get_taxonomy", {}));
  const wingEntry = taxonomy.find((entry) => entry.wing === wing);
  if (!wingEntry) {
    return {
      ok: false,
      wing,
      room: SKILLS_ROOM,
      reused: false,
      dry_run: dryRun,
      error: "Wing not found in taxonomy — check the name and retry.",
      next_step: "Fix the wing name (or set ESHEPHERD_PROJECT_WING) and re-run.",
    };
  }

  const explicitRoom = String(args.room || "").trim();
  const { room, reused } = explicitRoom ? { room: explicitRoom, reused: true } : pickPurposeRoom(wingEntry.rooms, SKILLS_ROOM, SKILL_LIKE_STEMS);

  if (dryRun) {
    // READS ONLY — no add_drawer, no kg_add. The one-page listing tells the user
    // how much of the destination room this run can see; the duplicate guard is a
    // single read-only call that prevents skill sprawl from repeated filings.
    let pre: { total: number; covered: number } = { total: 0, covered: 0 };
    try {
      const page = parseRows(await args.call("list_drawers", { wing, room, limit: DRY_RUN_PAGE_SIZE, offset: 0 }));
      const probe = asObject(await args.call("list_drawers", { wing, room, limit: 1, offset: 0 }));
      pre = { total: Number(probe.total) || page.length, covered: page.length };
    } catch {
      pre = { total: 0, covered: 0 }; // unreadable room — report it, do not guess
    }

    const dup = await runCheckDuplicate(args.call, content);
    const duplicateDrawerId = dup.isDuplicate ? dup.drawerId : undefined;

    return {
      ok: true,
      wing,
      room,
      reused,
      dry_run: true,
      pre_snapshot: pre,
      duplicate_drawer_id: duplicateDrawerId,
      domain,
      next_step:
        duplicateDrawerId
          ? `An exact-duplicate skill drawer already exists (${duplicateDrawerId}) — apply will skip filing. Re-file with different content only if the procedure genuinely changed (then merge old → new).`
          : `Apply will file into ${wing}/${room} (reused=${reused}) and stamp es-source-type: skill + es-domain: ${domain}. Re-run with dry_run:false to apply.`,
    };
  }

  // ---- APPLY: duplicate guard → add_drawer → stamp. ----
  const dup = await runCheckDuplicate(args.call, content);
  if (dup.isDuplicate === true) {
    return {
      ok: true,
      wing,
      room,
      reused,
      dry_run: false,
      duplicate_drawer_id: dup.drawerId,
      next_step: "Exact duplicate already filed — nothing written. Re-file with different content only if the procedure genuinely changed.",
    };
  }

  // AC #11: production drawer creation goes through runCheckpointWrite (the shared
  // checkpoint write path) instead of a direct add_drawer call. Behavior is
  // preserved: one item, same wing/room/content/desc/added_by; the duplicate guard
  // above and the stamps below are unchanged.
  const checkpoint = await runCheckpointWrite(
    args.call,
    {
      items: [
        {
          wing,
          room,
          content,
          desc: String(args.desc || "").trim() || undefined,
          added_by: "electric-shepherd-file-skill",
        },
      ],
    },
    { dry_run: false },
  );

  const raw = asObject(checkpoint.raw);
  const rows = [
    ...(Array.isArray(raw.results) ? raw.results : []),
    ...(Array.isArray(raw.items) ? raw.items : []),
  ].map(asObject);
  const drawerId = asText(
    raw.drawer_id
      || raw.id
      || rows.find((row) => row.ok !== false && asText(row.drawer_id || row.id).trim())?.drawer_id
      || rows.find((row) => row.ok !== false && asText(row.drawer_id || row.id).trim())?.id,
  ).trim();

  if (!checkpoint.ok || !drawerId) {
    return {
      ok: false,
      wing,
      room,
      reused,
      dry_run: false,
      error: `checkpoint failed${drawerId ? "" : " (no drawer_id returned)"}: ${asText(checkpoint.error || checkpoint.failure_summary).slice(0, 500)}`,
      next_step: "Filing aborted — nothing else ran. Re-run to retry; identical content maps to the same deterministic drawer ID.",
    };
  }

  // Stamp the source-type axis, then the es-domain axis. `es-status` is
  // intentionally NOT touched — orthogonal axes; a skill is authoritative on arrival.
  const stampResults = await runKgAddWrites(args.call, [
    { payload: { subject: drawerId, predicate: "es-source-type", object: "skill", source_closet: drawerId } },
    { payload: { subject: drawerId, predicate: "es-domain", object: domain, source_closet: drawerId } },
  ]);
  const stampFailed = stampResults.filter((result) => !result.ok).length;

  const report: SkillFilingReport = { ok: true, wing, room, reused, dry_run: false, drawer_id: drawerId, domain };
  if (stampFailed > 0) {
    report.stamp_failed = stampFailed;
    report.next_step = `Drawer ${drawerId} is filed but UNSTAMPED (${stampFailed}/2 stamps failed). Re-run /file-skill with the same content — the duplicate guard returns the existing ID and the stamp can be retried via palace_stamp_source_type.`;
  }
  return report;
}

export default tool({
  description:
    "Procedural memory: file a skill definition as a drawer in the project wing's `skills` room (reusing an existing skill-like room via get_taxonomy before minting one) and stamp it es-source-type: skill. Stores the full procedure verbatim; refinement happens later via refined-by edges, never by rewriting. Exact-duplicate guard prevents sprawl. Dry-run by default — the first call makes no mutating MCP call (read-only duplicate check + bounded one-page room listing); pass dry_run:false to apply. Never touches es-status.",
  args: {
    content: tool.schema.string().describe("The skill procedure, verbatim and complete (goal, preconditions, steps, failure modes, verification)."),
    desc: tool.schema.string().optional().describe("One-line description for discoverability."),
    wing: tool.schema.string().optional().describe("Wing to file into. Defaults to this project's wing."),
    room: tool.schema.string().optional().describe("Explicit destination room. Default: reuse an existing skill-like room, else `skills`."),
    domain: tool.schema.string().optional().describe("es-domain axis: code | writing | infra | research | general. Defaults to 'general' (temporary conservative default until project-domain inference is added)."),
    dry_run: tool.schema.boolean().optional().describe("Preview without writing (default true)."),
    tool_prefix: tool.schema.string().optional().describe("MCP tool prefix override."),
  },
  async execute(args, context) {
    const cwd = context.worktree || context.directory;
    loadRuntimeEnv({ scriptUrl: import.meta.url, env: process.env, cwd });
    const runtimeConfig = loadRuntimeConfig({ cwd, env: process.env });
    applyRuntimeConfigToEnv(process.env, runtimeConfig);

    const wing = String(args.wing || runtimeConfig.valuesByPath.memory?.projectWing || "").trim();
    if (!wing) throw new Error("file_skill: wing is required (no project wing resolved)");

    const { client, prefix } = await createPalaceClient({
      env: process.env,
      clientName: "electric-shepherd-file-skill",
      toolPrefix: args.tool_prefix,
    });
    const call = async (name: string, payload: Record<string, unknown>) =>
      client.callTool(`${prefix}${name}`, payload);

    const report = await runSkillFiling({
      call,
      wing,
      content: String(args.content || ""),
      desc: args.desc,
      room: args.room,
      domain: args.domain,
      dryRun: args.dry_run,
    });

    return JSON.stringify(report, null, 2);
  },
});
