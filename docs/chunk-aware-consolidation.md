# Chunk-aware consolidation

The live consolidation CLI uses sequential physical-chunk extraction and separate
topical writes. Source batch default (1), local model and existing safety fixes
are unchanged. Tests are offline; no live model/processing run is implied.

## Inventory and extraction

Host smoke: `node /home/ejaworenko/Cloud-Professional/1-Armet/opencode/context/chunk-aware-live-smoke.mjs`
runs the actual CLI with `--no-lock --wing armet --room source-transcripts --only-drawer
drawer_armet_source-transcripts_2eeaab9e7632c5d3214aa0aa --checkpoint-dir <fresh-directory>`.
This selects the captured Deploy Configurator Summary work session, not a synthetic model exercise.
`SMOKE_TIMEOUT_MS` is an explicit configurable wall-clock bound (default 21600000 ms / six hours),
not a workload-derived budget. Serial mapper/reducer calls retain the configurable
`ESHEPHERD_SUBAGENT_TIMEOUT_MS` default 900000 ms / 15 minutes; there is no artificial nine-call cap.
The read-only route guards both raw transport tool methods and Memgraph calls; transport startup
only performs `initialize` and `notifications/initialized`, not substrate tools. Capture is explicitly
disabled for this route and isolated mapper environments; memcore apply remains disabled.
The harness checks `worklist.chunkCoverage` against the actual extraction, reconciliation and draft
fields. Offline host regression reuses the existing caller fixture and real run-report emitter.
Passing these structural checks is not evidence of live model quality or factual accuracy;
source-versus-output manual review is still required. No live run is claimed here.

`extractSourceChunks` in `src/scripts/memory-pipeline/chunk-extraction.ts` is a
read-only caller with injected substrate reads and mapper execution. It requires
an authoritative complete `SourceChunkInventory`: logical `parentDrawerId`,
`requiredChunkCount`, and ordered physical IDs with contiguous `chunkIndex` values.
`discoverSourceChunks` obtains this inventory through `get_drawer` on the logical
parent, using `metadata.chunk_ids` and `metadata.chunks` (or equivalent top-level
fields). Physical IDs resolve through `parent_drawer_id` or the supported legacy
`parent_entry_id`; discovery, physical verification and direct-source counting
use the same precedence. Standalone unchunked drawers remain one coverage unit.
No chunk IDs are manufactured. Missing inventory, mismatched parent/index
metadata and changed content fail closed.

Reads are sequential: hash each physical row, retain a rolling three-chunk
window, and recheck hashes at the end. Configurable server chunk sizes are
supported through deterministic internal pieces of at most 16,000 characters
without clipping or splitting surrogate pairs. Each piece receives at most
1,000 characters of previous/next boundary context. These are raw text fragments,
not assumed parseable message JSON. Physical chunk IDs remain the persistent
provenance unit; internal piece indices are not a public range system.

The `physical-chunk-topics-v7` contract requires complete bounded JSON, exact
parent/chunk identity, and echoed `pieceIndex`/`pieceCount` for multi-piece
chunks. Each piece must return `complete:true`, topics and a required
`contextualEvidence` array. Corrections, resolutions and qualifiers retain exact
primary quotes (verified against the source piece) even without a new topic;
context-only pieces use `assessment:context`, not `zero-substance`. An extractor's
window boundary or next-piece reading need must never become a source open task.
A physical chunk is assessed only after all its pieces succeed.
Multiple topics are retained; grouping uses topic key plus normalized subject
title. A repeated key with incompatible titles fails closed before any topic
write, movement or retirement. No semantic alias merging is attempted.
Contributing IDs come only from primary physical chunks, never boundary context.

Successful piece responses persist in `.electric-shepherd/coverage/extraction/`
under the CLI coordination guard. Schema-v2 checkpoints record deterministic
piece indices and hashes per physical ID. Source versions include every physical
ID/hash, piece hash, size limit, contract and caller `extractorVersion` (model/
prompt identity). Partial retries reuse only strictly validated successful
pieces and rerun missing pieces. Changed source/extractor versions invalidate
the cache, including old schema-v1 extraction. Files use local temporary
files and rename. This is **not** an atomic palace write protocol. Do not use
`--no-lock` with concurrent writers to the same source.

The extraction flag is `extractionComplete`, not semantic or source completion.

## Bounded topic reconciliation

Before any topic write, `reconcileSourceTopics` uses the existing runner/model to
fold structured evidence into each expected topic. It never reads/searches a raw
transcript. One topic record seeds the state; subsequent records are source-ordered
with physical chunk/piece indices. Every contextual record is offered to every
topic and must receive a disposition, reason and supported affected evidence IDs.
At least one topic must account for each context record as relevant; otherwise
the source blocks for review. A context-only source without a topic also blocks.
Exact expected topic identity/title is preserved and confidence cannot upgrade.
Missing/truncated/incomplete responses or changed identities block all source
writes, completion, movement and retirement. Every expected topic must finish.

`topic-reconciliation-v4` responses are limited to 16000 UTF-8 bytes, six sections
of at most eight 300-character items, and a typed evidence receipt. Each request
has one record plus bounded previous state; its JSON payload is capped at 32000
bytes. Exhausting capacity fails closed rather than dropping evidence. Existing
model/token settings are unchanged. Later source-supported clarification must
correct stale conclusions/open items without inventing a resolved outcome.

`.electric-shepherd/coverage/reconciliation/<sha256-parent>.json` stores successful
responses per topic/step. Identity hashes include extraction version, all topical
and contextual records, reducer contract/model/prompt identity and prior state/
receipts. Retries replay and validate cached steps and call only missing steps.
Source or reducer changes invalidate this cache. Failed reads have no palace
side effects; existing ambiguous-write intents remain blocked across versions.
Final write plans/coverage include the reconciliation version, original evidence
and correction receipts; relevant correction chunks get verified lineage too.
An audit may retain a superseded assertion as evidence, not as a current fact.

## Topic writes, completion and resume

`runChunkConsolidation` builds a separate draft from each reconciled topic state,
then uses `addDrawer` rather than the legacy `createDerivedDrawer` path. Each
write is read back for exact content, stamped `synthesis`/`provisional`, and gets
verified `synthesized-from` edges to the logical parent and contributing physical
chunks. The topic content includes the parent, source version, topic key and
exact chunk IDs. Dead ends retain separate negative drawers and verified
`rules-out` edges. The supported KG `source_drawer_id` provenance field is also
written, but is not used as verification evidence because KG queries omit it.
Direct-source counting resolves drawer parent metadata so physical evidence
cannot inflate one transcript into several independent sources for promotion.

`.electric-shepherd/coverage/<sha256-parent>.json` stores extraction/reconciliation,
source/plan version, content hashes, returned IDs and write states. The caller
persists `writing` before creation, `returned` with its ID before verification,
and `verified` only after checking content and lineage. Returned/verified IDs are
rechecked on retry without another drawer creation. Only not-yet-attempted topics
are created. Drawer creation uses a zero-retry transport; KG retries first query
the exact edge. Source/model/prompt/target/plan changes invalidate coverage, but
an unresolved write intent blocks even across version changes.

A `writing` entry without a returned ID is uncertain: a crash, timeout or lost
receipt may have hidden a successful write. The CLI reports
`manual-reconciliation-required` and the checkpoint path, and does not create a
duplicate. An operator must locate the exact drawer using its recorded content
hash, source-file provenance and source version, verify the stored content, then
record its `drawerId` and `returned` state in the operational checkpoint. If its
existence cannot be established, keep the intent blocked; never just delete it.
The normal retry then verifies content and every required lineage edge itself.

Only after all chunks are completely assessed and every topic passes the
confidence/substance guards and write verification does the coordinator emit
verified `consolidated-into` edges and mark coverage complete. It rechecks source
inventory/content before completion. Partial completion-edge failures resume
without duplicate topic writes. Zero-substance chunks are explicitly accounted
in the manifest; they are never listed as contributing evidence. An entirely
zero-substance source may move to processed, but produces no replacement closet
and cannot authorize retirement. Missing chunks, malformed responses,
low-confidence/guard-rejected topics and unverified writes leave sources in place
and preserve old closets.

Live worklist intake does not exclude legacy parent-only completion edges.
Reconsolidation coverage is granted only by the full verified coordinator result
and successful source-family movement. `--no-live-mapper` keeps the legacy
heuristic/manual path but cannot authorize chunk-aware retirement. Manual search
and legacy parser APIs remain available; they are not upgraded to full coverage.

Actual CLI mock tests cover later corrections resolving stale open items while
retaining unrelated/minority subjects, reducer failure/truncation/identity and
receipt guards, exact correction provenance and stable partial reducer resume.
They also cover multi-topic writes, late/minority evidence, exact
lineage, coverage gaps, partial/ambiguous writes, durable resume, source changes,
completion retries, zero-substance spans and preservation of old closets. Live
model quality and real endpoint behavior remain untested; completion is not a
claim of cross-system atomicity or semantic completeness beyond the explicit
validated mapper/reducer contracts. Structural receipts cannot prove every model
judgment correct: omitted source meaning, identical misleading subject labels,
or unsupported semantic inferences still require review/live smoke. Reconciliation
is record-level, not claim-offset lineage; semantic aliases are not merged.

## Open-task integrity (reducer v4, extraction v6)

Open items are typed: the caller derives a stable task ID from parent/topic/exact
extracted text and supplies `eligibleOpenTasks` (previously retained tasks plus the
current topic record's extracted tasks). The reducer returns `openTaskIds` only; it
cannot emit open-item text. The caller constructs `topic.openItems` from the ledger
entries for those IDs, in order, so wording cannot drift. Unknown IDs, or an `add`
section other than the five delta sections (including `openItems`), fail closed.
Qualifiers, corrections, source limitations or window metadata cannot create a task;
a real new authored task must be extracted into `openItems` first. Task candidates and
retained IDs are persisted in
coverage. Contract bumps invalidate older cached reducer/extraction state. Limitation:
a task the extractor never emitted cannot be added by reconciliation.

`boundary-only` is assigned only by the coordinator to `reader-window` context (reducer v4); a model returning it is rejected as an invalid disposition.

## Quote grounding (extraction v6)

`contextualEvidence.sourceQuote` must be an exact substring of the primary piece. Because
raw sources are JSON-escaped transcript text (literal `\n`, `\"`, `\\`), a quote with real
control characters/quotes/backslashes is accepted only if its JSON string-escaped form
(`JSON.stringify`, exact-first fallback) is an exact primary substring; the canonical literal
source text is stored. No whitespace folding, fuzzy or one-way unescaping of the source; adjacent
context, fabricated, altered or differently-escaped quotes still fail. Limitation: escapes the
transcript writer represented differently (e.g. `\u00e9` vs a real accent) are rejected.


## Bounded delta reconciliation and reader-window origin (extraction v6 / reducer v4)

Live smoke showed the v3 reducer re-emitting the whole topic state per step (reasoning plus full output exhausted the 8192-token budget, truncating JSON) and leaking the extractor's own window commentary into durable facts.

- Reducer steps now return a DELTA: `add` strings and `remove` 0-based indices per section, plus `openTaskIds`, optional lower `confidence`, and the receipt. The caller applies it to the previous state and validates the merged result with the same topic parser (sections <=8 entries, <=300 chars; overflow fails closed with `reconciliation-section-capacity`). Open items are never part of a delta: the caller fills them from the authored-task ledger, so a delta cannot add or reword a task. Response size tracks the delta, not accumulated state.
- The response must be a strict delta object: only the allowed top-level fields; `add`, `remove` and `receipt` must be plain objects (missing, null, array or primitive values fail with `invalid-reconciliation-delta`). A legacy full-`topic` response is rejected, never treated as an empty delta.
- `boundary-only` receipts (reader-window context) are excluded from `contributingChunkIds`, so no `synthesized-from` chunk edge is written for them; the receipt stays in the coverage/audit evidence. A chunk holding only reader-window context is still accounted for by its `consolidated-into` completion edge.
- A globally rejected context record truncates the cached reducer responses by model-response index (reader-window records consume no response), so a retry re-asks exactly the rejected step.
- Extraction `contextualEvidence` records carry `origin`: `source` (the source states it, including a page/size limitation) or `reader-window` (an observation about the extractor's view: cut-off identifier, window edge). Origin is required; invalid values fail the piece.
- `reader-window` context is classified deterministically by the coordinator: it records a `boundary-only` receipt with no targets, never reaches the model, and cannot change topic state. `boundary-only` is no longer a model-selectable disposition. Source qualifiers (for example one page of 150 total) still go to the reducer and are retained as facts.
- Limitation: `origin` is an extractor self-classification. The typed contract keeps a correctly labeled reader observation out of facts, but a mislabeled one is not detected by code.

## Topic source grounding (extraction v7)

Every extracted topic declares `origin` (`source` | `reader-window`). A `source` topic must carry 1-4
`sourceQuotes`; the host grounds each with the same exact/JSON-escaped primary-substring match as context quotes
(`groundQuote`) and fails the piece closed (`topic-quote-not-in-primary`, `invalid-topic-source-quotes`) otherwise.
`reader-window` topics (the extractor describing its own window, fragment or cut-off id) are dropped by the host
before topic grouping, so they never create closets or provenance edges; the chunk still counts as assessed
(`zero-substance`/`context` as appropriate) and is completed by its `consolidated-into` edge. Source and reader
claims must be separate topics; there is no per-sentence mixing. Cached pieces are re-admitted on replay, and the
version bump invalidates v6 checkpoints.

Limits: a quote proves a claim was drawn from primary text, not that each sentence is entailed by it, and `origin`
is still the model's self-label. Reducer-added facts are bounded by the delta contract and evidence-only prompt, not
re-grounded per fact by code.

## Prompts and eligibility (simplified)

The extraction and reducer prompts state the task, one output schema and a short rule list; typed guards stay in code
(identity echo, receipts, origin/quote grounding, open-task ledger, limits, cache/provenance). A shorter prompt does not
guarantee accuracy. `agents/dream-mapper.md` separates the live modes from the legacy/manual array mode.

A topic needs no fixed number of populated sections. The default `--min-section-count` is now 1 (was 3, clamped to at
least 2), and the guard additionally always requires at least one substantive section (durable facts, decisions, root
causes/worked examples or dead ends); subsystem/file names and open items alone never count as substance. Content-length,
source-count and coverage guards are unchanged, and an explicit larger `--min-section-count` is still enforced.

Cache identity: the extraction `sourceVersion` includes a hash of the extraction instruction text
(`extractionPromptHash()`) alongside the contract id and extractor version. Any wording change invalidates cached
pieces for the same source hash deterministically; existing checkpoint files are not deleted, they stop matching and are
rewritten on retry.
