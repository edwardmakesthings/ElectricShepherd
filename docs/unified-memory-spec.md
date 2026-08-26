# Spec: unify episodic, semantic, and procedural memory

## Goal

Electric Shepherd currently consolidates ONE kind of input: session transcripts
(episodic memory — what happened). This adds two more:

- **Semantic memory** — authoritative external knowledge: library docs, API references,
  Obsidian notes, specs. What is *true*, independent of any session.
- **Procedural memory** — skills: how to do a recurring task, refined by the sessions
  where it was actually used.

The value is not storing three things separately. It is **linking them**: a synthesis
about a bug points at the API doc it concerned, and at the skill that encodes the fix.
Retrieval then returns "here is what we decided, here is the authority it rests on, here
is the procedure."

Read `docs/memory-graph-design.md` first. Do not restate its contents back; act on them.

---

## Phase 0 — INVESTIGATE FIRST. Do not write code in this phase.

Three things must be verified against the actual MemPalace build before anything is
designed around them. Report findings and STOP for review.

1. **`mempalace_mine`** — what does it actually do? Confirm it ingests a directory into a
   given wing/room, what it sets `source_file` to, and whether re-running it on changed
   files updates or duplicates. This determines whether doc ingestion needs any new code
   at all.
2. **`mempalace_sync`** — confirm it prunes drawers whose source file was deleted. This is
   the doc-deletion path.
3. **`mempalace_search`** — can it filter or post-filter by a KG fact (e.g. only drawers
   with `es-source-type = doc`)? If NOT, the alternative is retrieve-then-filter in
   Electric Shepherd, costing one `kg_query` per candidate. Measure that cost against a
   realistic result set before deciding it is acceptable.

---

## Phase 1 — the source-type axis (Electric Shepherd only)

Add a KG predicate `es-source-type` with values: `transcript`, `doc`, `synthesis`, `skill`.

**This is ORTHOGONAL to `es-status`. Do not conflate them.**
- `es-status` (provisional/active) answers "has this been VALIDATED?"
- `es-source-type` answers "what KIND of thing is this, and how much AUTHORITY does it have?"

A doc is authoritative on arrival and never needs validation. A synthesis is derived and
must earn promotion. Collapsing these into one field breaks both.

Stamp it at every write path, alongside the existing `es-status` stamp:
- `synthesis-consolidation.ts` / `createDerivedDrawer` → `synthesis`
- the source-capture pipeline → `transcript`
- doc ingestion (Phase 3) → `doc`
- skill filing (Phase 5) → `skill`

Backfill existing drawers by inferring from room: transcript-like rooms (there is already
an `isTranscriptLikeRoom` helper in `adapter/palace-tools.ts` — reuse it, do not write a
second one) → `transcript`; drawers with outgoing `synthesized-from` edges → `synthesis`;
everything else → leave unstamped rather than guessing. Unstamped must be treated as
"unknown authority," never as a default type.

---

## Phase 2 — authority-aware retrieval

`adapter/retrieval-expansion.ts` currently ranks on height(3), lineage(2), connection(1),
retrieval(1), labelMatch(0.75), plus seed/neighborhood/always-labeled boosts. It has no
notion of authority.

Add an `authority` weight and an optional `intent` argument (`factual` | `historical` |
`procedural`, default: no preference):

- `factual` ("how does X work") — boost `doc`, then `synthesis`. A transcript is the
  weakest evidence for a factual claim.
- `historical` ("what did we decide / why is it like this") — boost `synthesis` and
  `transcript`. A doc cannot answer this.
- `procedural` ("how do I do X here") — boost `skill`, then `synthesis`.

**Hard rule, and the reason this phase exists: a `provisional` synthesis must never
outrank a `doc` on a factual query.** A wrong conclusion reached at 2am, presented above
the actual API reference, is worse than having no memory at all. Encode that as a floor,
not just a weight — weights can be overwhelmed by a high-height node.

---

## Phase 3 — doc ingestion

Add a command `/ingest-docs <path>` (agent: `dreamer`) that mines a directory into a
`reference` room in the project wing.

- Room naming follows the existing contract: kebab-case, purpose-named, never
  derivation-level. Call `get_taxonomy` and reuse an existing room before minting one.
- Stamp every ingested drawer `es-source-type: doc`.
- Record the source path so `mempalace_sync` can prune deletions.
- **Staleness:** docs version. On re-ingest of a changed file, `kg_invalidate` the old
  drawer's facts and file the new one, rather than leaving both live. Existing work on
  "continual knowledge editing" is the right frame: outdated knowledge that stays
  retrievable is a correctness bug, not just clutter.
- Dry-run by default, like every other mutating tool in this project.

---

## Phase 4 — cross-type linking

Add predicate `concerns`: `{subject: <synthesis id>, predicate: "concerns", object: <doc id>}`.

During consolidation, when a synthesis references a library, API, or documented concept
that exists in the `reference` room, propose the edge. Follow the existing relocation
pattern exactly: **propose as a numbered list at the end of the pass, apply only what the
user approves.** Do not auto-link — a wrong link silently corrupts retrieval for that topic.

Retrieval expansion should then pull `concerns` neighbours alongside `synthesized-from`
ones, so a hit on a synthesis surfaces its authority.

---

## Phase 5 — skills as procedural memory

File skill definitions as drawers in a `skills` room, `es-source-type: skill`.

The point is not storage — it is that skills **improve from use**:
- `refined-by`: `{subject: <skill id>, object: <session/synthesis id>}` when a session
  changed how the skill should work.
- When `solve-deep-cloud` files a worked example to the `apprenticeship` room, link it to the
  skill it exercised, if one exists.

Procedural memory tooling is the least-served layer in the ecosystem and the one where
agent performance compounds. Keep this phase simple and correct rather than elaborate.

---

## Guardrails (these are all bugs this project has actually shipped)

- **Declaration order:** a `const` referenced above its declaration line is a
  temporal-dead-zone `ReferenceError` that silently disables the whole plugin at load.
  Verify every new const is declared above all uses.
- **Never page a room to exhaustion.** Take one bounded page and begin. Backlogs here run
  to tens of thousands of drawers.
- **Verify a tool exists before building on it.** Several agents in this repo have been
  granted tools that were never wired, and instructed to use tools they were denied.
- **Any new agent capability needs the tool grant AND the prompt AND the permission.**
  Check all three; missing any one fails silently.
- **Do not add a new room per content type inside a wing without checking taxonomy.**
  Room sprawl splits a topic across rooms that never co-retrieve.

## Verify before reporting

- Typecheck.
- For each phase, state which files changed and which existing helper you reused rather
  than reimplemented.
- Confirm `es-status` and `es-source-type` are independently settable and neither
  overwrites the other.
- Confirm a `provisional` synthesis cannot outrank a `doc` on a `factual` query — show the
  computed scores for one worked example, do not assert it.

## Report

- FILES: each path touched, what changed
- VERIFIED: commands run and results, plus the ranking example above
- MEMPALACE: whether a substrate change is genuinely required, with the Phase 0 evidence
- NOTES: assumptions, anything that looked wrong, scope deliberately not touched
