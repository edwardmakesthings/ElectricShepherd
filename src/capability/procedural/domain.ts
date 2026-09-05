/**
 * Skill domain axis — `es-domain` (skill drawers only).
 *
 * `es-domain` records which project domain a skill belongs to. Written at skill
 * creation (file_skill / promote_skill); read by procedural retrieval to filter
 * shared-skill admission. Same one-hop read discipline as es-source-type.
 */

import type { SkillDomain } from "../../core/memgraph-structure.ts";
import { SKILL_DOMAINS } from "../../core/memgraph-structure.ts";
import type { MemgraphInternals } from "../../core/memgraph-internals.ts";
import { parseKgFacts, uniqueFromFactsByDirection } from "../../core/memgraph-transport.ts";

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
