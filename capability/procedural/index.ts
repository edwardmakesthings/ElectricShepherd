/**
 * Procedural memory capability (spec §3.2, Rung 3).
 *
 * Owns: skills, promotion, refinement, worked examples — `refined-by`,
 * `promoted-from`, `es-domain`. Skills are "how to do X" knowledge; worked
 * examples are solved instances of a task class (stamped
 * `es-source-type: worked-example`) filed with their problem shape. Cross-project
 * skills are promoted into a shared skills wing and filtered by `es-domain` on
 * retrieval.
 *
 * Binding rule (spec §3.1): this module never calls the substrate directly. The
 * retrieve/format/shape logic lives in adapter/retrieval-expansion.ts over an
 * injected MemgraphClient; this capability exposes the procedural surface — write
 * (skill/worked-example filing), read (procedural-intent retrieval + demonstration
 * injection), fail (named errors) — as explicit functions so the layer-shaped
 * suite can drive them with a fake callTool.
 */

import type { MemgraphClient } from "../../adapter/memgraph.ts";
import {
  buildWorkedExampleEntry,
  extractWorkedExampleShape,
  formatWorkedExampleDemonstration,
  retrieveSimilarWorkedExamples,
  WORKED_EXAMPLE_ENTRY_MAX_CHARS,
  WORKED_EXAMPLE_FILE_AGENT_TYPES,
  WORKED_EXAMPLE_MAX_CHARS,
  WORKED_EXAMPLE_MAX_INJECT,
  WORKED_EXAMPLE_MIN_SUBSTANTIVE_CHARS,
  WORKED_EXAMPLE_RELEVANCE_FLOOR,
  type RetrieveWorkedExamplesOptions,
  type WorkedExampleMatch,
  type WorkedExampleShape,
} from "../../adapter/retrieval-expansion.ts";

export {
  buildWorkedExampleEntry,
  extractWorkedExampleShape,
  formatWorkedExampleDemonstration,
  retrieveSimilarWorkedExamples,
  WORKED_EXAMPLE_ENTRY_MAX_CHARS,
  WORKED_EXAMPLE_FILE_AGENT_TYPES,
  WORKED_EXAMPLE_MAX_CHARS,
  WORKED_EXAMPLE_MAX_INJECT,
  WORKED_EXAMPLE_MIN_SUBSTANTIVE_CHARS,
  WORKED_EXAMPLE_RELEVANCE_FLOOR,
  type RetrieveWorkedExamplesOptions,
  type WorkedExampleMatch,
  type WorkedExampleShape,
};

/**
 * WRITE contract (Rung 3 §6.3 question 1): a worked example is filed to the
 * `apprenticeship` room as a drawer stamped `es-source-type: worked-example`,
 * carrying its problem shape (work-class, file-types, hard-areas, size-bucket) so
 * retrieval matches on the PROBLEM, not the solution. A skill is filed to the
 * project wing's `skills` room stamped `es-source-type: skill`; promotion into the
 * shared wing adds a `promoted-from` edge back to the origin and an `es-domain`
 * stamp. Returns the exact drawer + edges so the test can assert the stamp exists.
 */
export type WorkedExampleWritePlan = {
  room: string;
  content: string;
  edges: Array<{ subject: string; predicate: string; object: string }>;
};

export function planWorkedExampleWrite(args: {
  subagentType: string;
  description: string;
  output: string;
  drawer_id?: string;
}): WorkedExampleWritePlan | null {
  // Gate mirrors the live turn-guard filing decision: only target subagent types
  // with substantive output file. Returns null (not an error) when the gate is
  // not met — "nothing to file" is a legitimate outcome, not a failure.
  if (!WORKED_EXAMPLE_FILE_AGENT_TYPES.has(args.subagentType)) return null;
  const body = String(args.output || "").trim();
  if (body.length < WORKED_EXAMPLE_MIN_SUBSTANTIVE_CHARS) return null;

  const shape = extractWorkedExampleShape(`${args.description}\n${body}`);
  const content = buildWorkedExampleEntry({
    subagentType: args.subagentType,
    description: args.description,
    output: body,
    shape,
  });
  const drawerId = args.drawer_id || "(new apprenticeship drawer)";
  return {
    room: "apprenticeship",
    content,
    edges: [
      // The knowledge-class stamp — distinct from procedural skills.
      { subject: drawerId, predicate: "es-source-type", object: "worked-example" },
      // Problem shape for retrieval matching (the WHAT MADE IT HARD axis).
      {
        subject: drawerId,
        predicate: "es-worked-example-shape",
        object: `${shape.workClass}/${shape.sizeBucket}/${shape.shapeKey}`,
      },
    ],
  };
}

/**
 * READ contract (Rung 3 §6.3 question 2): a worked example is consumed when it is
 * injected as a demonstration into a delegation prompt — retrieveSimilarWorkedExamples
 * searches the apprenticeship room, scores by token-overlap relevance, and returns
 * at most WORKED_EXAMPLE_MAX_INJECT (2) examples above the relevance floor;
 * formatWorkedExampleDemonstration renders them as a delimited section. Skills are
 * consumed via procedural-intent retrieval (refined-by expansion + shared-wing
 * admission filtered by es-domain). Both paths change a decision: the prompt gains
 * a demonstration it would not have had.
 */
export async function readWorkedExampleDemonstrations(
  client: MemgraphClient,
  options: RetrieveWorkedExamplesOptions,
): Promise<{ examples: WorkedExampleMatch[]; section: string }> {
  const examples = await retrieveSimilarWorkedExamples(client, options);
  return { examples, section: formatWorkedExampleDemonstration(examples) };
}

/**
 * FAIL contract (Rung 3 §6.3 question 3): a substrate error during worked-example
 * retrieval degrades to "no examples" — the caller injects nothing and the turn
 * continues — but the degradation is NAMED (the search call failed), not mistaken
 * for "examples exist but none relevant". A filing failure is recorded as a named
 * write error, never silently dropped.
 */
export class ProceduralReadError extends Error {
  readonly kind: string;
  constructor(kind: string, detail: string) {
    super(detail);
    this.name = "ProceduralReadError";
    this.kind = kind;
  }
}

export async function readWorkedExampleDemonstrationsStrict(
  client: MemgraphClient,
  options: RetrieveWorkedExamplesOptions,
): Promise<{ examples: WorkedExampleMatch[]; section: string }> {
  try {
    return await readWorkedExampleDemonstrations(client, options);
  } catch (err) {
    // Named failure: a broken search must not masquerade as "nothing relevant".
    const detail = err instanceof Error ? err.message : String(err);
    throw new ProceduralReadError("protocol", `worked-example retrieval failed: ${detail}`);
  }
}
