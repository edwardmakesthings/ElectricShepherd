/**
 * Negative memory capability (spec §3.2, Rung 3).
 *
 * Owns: dead ends and ruled-out approaches — the `rules-out` edge with its
 * two-valued polarity ("tried-failed" strong vs "considered-rejected" weaker).
 * A dead end is a SYNTHESIS with negative polarity (`es-source-type: synthesis`,
 * never a fourth source type); the negative axis rides on the `rules-out` KG
 * edge, which must never count toward height or feed lineage traversal.
 *
 * The spec's main risk: an UNLABELLED dead end reads as a suggestion ("we tried X"
 * looks like advice unless it carries the outcome clause). So this capability owns
 * the label contract in one place — write-time validation (a line without its
 * outcome clause is incomplete and must not be filed) and render-time markers (the
 * hard `[RULED OUT ...]` prefix, never optional).
 *
 * Binding rule (spec §3.1): this module never calls the substrate directly. The
 * pure parse/validate/render half lives in adapter/dead-ends.ts; the write/read/
 * fail legs below are explicit functions over an injected MemgraphClient so the
 * layer-shaped suite can drive them with a fake callTool.
 */

import type { MemgraphClient } from "../../core/memgraph.ts";
import {
  parseDeadEndDrawerContent,
  parseDeadEndLine,
  renderDeadEndLine,
  renderDeadEndsBlock,
  validateDeadEndLines,
  DEFAULT_DEAD_ENDS_CAP,
  DEAD_END_POLARITIES,
  RULED_OUT_MARKER,
  RULES_OUT_PREDICATE,
  type DeadEndLine,
  type DeadEndPolarity,
  type ParsedDeadEndLine,
} from "./dead-ends.ts";
import { getRulesOut } from "./rules-out.ts";
import { fileDeadEnd } from "./dead-end.ts";

export {
  parseDeadEndDrawerContent,
  parseDeadEndLine,
  renderDeadEndLine,
  renderDeadEndsBlock,
  validateDeadEndLines,
  DEFAULT_DEAD_ENDS_CAP,
  DEAD_END_POLARITIES,
  RULED_OUT_MARKER,
  RULES_OUT_PREDICATE,
  type DeadEndLine,
  type DeadEndPolarity,
  type ParsedDeadEndLine,
};

export { getRulesOut };
export { fileDeadEnd };

/**
 * WRITE contract (Rung 3 §6.3 question 1): a dead end is filed via
 * MemgraphClient.fileDeadEnd — one negative-polarity synthesis drawer whose body
 * is the FULL verbatim line (tried + outcome clause + reason) plus its `rules-out`
 * edges (object = the tried statement, and a second edge carrying the polarity
 * token). Write-time validation runs FIRST: a line without its outcome clause is
 * incomplete and must not be filed. Returns per-line outcomes so the test can
 * assert exactly which lines were filed, skipped as incomplete, or failed.
 */
export type DeadEndWriteReport = {
  filed: number;
  failed: number;
  skippedIncomplete: number;
  rulesOutEdgesAdded: number;
  errors: string[];
};

export async function writeDeadEnds(
  client: MemgraphClient,
  args: {
    wing: string;
    room: string;
    lines: string[];
    source_drawer_ids?: string[];
    added_by?: string;
    source_run_id?: string;
  },
): Promise<DeadEndWriteReport> {
  const report: DeadEndWriteReport = { filed: 0, failed: 0, skippedIncomplete: 0, rulesOutEdgesAdded: 0, errors: [] };
  for (const line of args.lines || []) {
    // Write-time validation: the label is enforceable only when both halves are
    // present — what was tried, and what happened. Incomplete lines are never filed.
    const parsed = parseDeadEndLine(line);
    if (!parsed.parsed) {
      report.skippedIncomplete += 1;
      report.errors.push(`dead-end line skipped (incomplete): ${parsed.error ?? "unparseable"}`);
      continue;
    }
    try {
      const result = await client.fileDeadEnd({
        wing: args.wing,
        room: args.room,
        content: line,
        statements: [parsed.parsed.tried],
        polarity: parsed.parsed.polarity,
        source_drawer_ids: args.source_drawer_ids || [],
        desc: parsed.parsed.tried,
        added_by: args.added_by || "electric-shepherd-negative",
        source_run_id: args.source_run_id,
      });
      if (result.success) {
        report.filed += 1;
        report.rulesOutEdgesAdded += result.rules_out_edges_added;
      } else {
        report.failed += 1;
        report.errors.push(...(result.errors.length > 0 ? result.errors : ["fileDeadEnd failed"]));
      }
    } catch (err) {
      // Named failure: a substrate error on one line is recorded, never swallowed —
      // the remaining lines still file, and the operator sees the exact error.
      report.failed += 1;
      report.errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  return report;
}

/**
 * READ contract (Rung 3 §6.3 question 2): a dead end is consumed when it reaches
 * scoped retrieval and is returned EXPLICITLY LABELLED as ruled out — the
 * `ruled_out` marker on the ranked node (set by expandScopedRetrieval's Phase 9
 * block) or the hard `[RULED OUT ...]` bullet in the mem-core `[dead-ends]`
 * render. The label survives both paths; an unlabelled dead end is a contract
 * violation, not a rendering choice.
 */
export function readDeadEndsLabelled(lines: string[], cap?: number): string[] {
  const rendered = renderDeadEndsBlock(lines, cap ?? DEFAULT_DEAD_ENDS_CAP);
  // Contract assertion surface: every bullet (after the two header lines) must
  // carry the hard marker. Callers/tests can assert this without re-parsing.
  return rendered;
}

/**
 * FAIL contract (Rung 3 §6.3 question 3): a substrate error while filing or
 * reading dead ends surfaces as a named, counted failure in the write report /
 * read result — never a silent "nothing ruled out". A failed fileDeadEnd is
 * recorded with its exact error and the remaining lines continue; a read failure
 * degrades to "no dead ends for this scope" WITH a logged reason, so the render
 * omits the section for a stated cause rather than by accident.
 */
export function describeDeadEndFailure(errors: string[]): string {
  if (!errors || errors.length === 0) return "";
  const preview = errors.slice(0, 3).join("; ");
  const extra = errors.length > 3 ? ` (+${errors.length - 3} more)` : "";
  return `negative write failed on ${errors.length} line(s): ${preview}${extra}`;
}
