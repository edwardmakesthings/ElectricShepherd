# Drawer-ready chunk-aware consolidation

Production mapper and reducer return natural text, not JSON. Prose, Markdown,
unfamiliar headings and fences are accepted and preserved verbatim. No required
headings, arrays, completion flags, quotes, model identities or confidence.
Host-only metadata describes execution, never semantic accuracy. Not bulk-ready;
tests and successful execution do not establish independent source-based accuracy.

## Prompt/output example

Prompt excerpt:

    Consolidate PRIMARY sources into drawer-ready natural text.
    Preserve important outcomes, later corrections and scope limits.
    PRIMARY
    The migration proposal was canceled after compatibility review.

Valid output (headings optional):

    ## Compatibility outcome
    The migration proposal was canceled after compatibility review.

The host never parses this heading or regenerates the output as fabricated
structured findings. One source-wide drawer is reduced across chronological
batches; topic identity is not inferred from arbitrary text. Model output is the
actual add_drawers item content, byte for byte. Host provenance is stored separately
in metadata.desc, source_file, coverage checkpoint and verified KG lineage.
No negative-knowledge drawers or rules-out edges are inferred from raw prose.
Legacy/manual structured summaries, confidence filtering and dead-end behavior
remain separate and compatible.
Optional downstream auditing receives the actual raw draft. Mem-core rendering
keeps a synthesis pointer and explicitly marks structured facts/tasks unavailable
from raw text; it does not interpret missing sections as an empty task list.

## Original source clocks

New captures keep optional session/message `time` objects in ISO8601 UTC, with
millisecond precision. OpenCode v1 `info.time` and v2 `time` numeric fields are
Unix milliseconds: `created`, `updated`, `completed`, `streamed`, `idle`, `viewed`
and `archived` retain their
exported meanings where present. `updated` is last update, not session end;
`idle` is an activity boundary, not proof the session ended. No end is fabricated.
OMP session-header `timestamp` becomes session `time.created`; nested
`message.timestamp` (Unix milliseconds) becomes message `time.created`, while
entry `timestamp` (ISO string) becomes `time.recorded`, the original log append
clock. Neither is this capture's time. Invalid/absent clocks stay absent.
Physical message order remains authoritative, even when clocks disagree.

Retained message time bytes survive in PRIMARY spans, including cross-chunk
messages; reserved policy turns and their times remain omitted. Summary prose
has no required timestamp wording. Each generated drawer's JSON `metadata.desc`
contains `sourceChronology`: source-associated `sourceDrawerId`, optional
`sessionId`, `sessionTime`, and `retainedMessageTimeRange` (`earliest`/`latest`
across valid retained message event clocks, including OMP log-recording clocks).
This is conservative source evidence, not per-claim grounding or reconciliation.
Normal layered intake carries prior `metadata.desc.sourceChronology` forward
without walking parents; explicit reconsolidation processes its selected source
parents. `persistedSourceChronology` reads this format. Unknown legacy time is
absent, never inferred from `filed_at`, capture URI, or consolidation run time.
`filed_at` stays server-owned: raw filing/capture time or synthesized filing time.

Consolidation uses a one-item `add_drawers` call because MemPalace's actual
`add_drawer` schema rejects `desc`. The supported metadata route stores the JSON
as `metadata.desc`, and content plus provenance are read back before completion.
Metadata-bearing writes cannot fall back to metadata-free `add_drawer`. Existing
drawers are never overwritten to add missing provenance; conflicting idempotent
write/readback evidence fails closed. No backfill, cross-closet merge, date-sort,
or timestamp-based semantic correction gate is implemented.

## Bounds, coverage and audit

- Verify complete physical inventory and metadata, hash all source content and
  recheck immutable source versions during and after processing.
- Split oversized chunks deterministically without losing source characters or
  splitting surrogate pairs. Batch at most four ordered pieces, sequentially.
  Extraction prompts remain within 16000 characters, including boundary context.
- Generated summaries have no artificial byte cap. A modest substance floor requires
  at least 40 Unicode letters/numbers. Empty output is a retryable missing response;
  short acknowledgements such as Done fail substance without retry. This floor
  can reject short valid findings or accept long acknowledgements and inventions;
  it is not keyword-based truth judgement. No implicit empty-source success is
  implemented. Empty sources cannot establish substantive replacement coverage.
- Entire successful batch responses are atomically cached with source/version,
  membership and complete prompt hashes. Original accepted text is retained
  unchanged for audit/retry, including reducer intermediate responses. Cache
  reuse validates substance and membership; it does not reshape batches.
- Contracts drawer-text-batches-v10 and drawer-text-reconciliation-v6 use new
  versioned extraction schema-4/reduction schema-3 files. Historical v9/v5 and
  older checkpoints/evidence remain untouched and are never admitted as new caches.
- Full processing coverage precedes reconciliation/writes/completion/retirement.
  Coverage is not proof that every fact or correction was captured. Each accepted
  text is conservatively attributed to its whole PRIMARY batch, not per claim
  or per piece. Boundary context is never primary provenance. Final lineage
  includes all chronological PRIMARY batches supplied to reduction.
- Reducer receives the complete previous revised text and next accepted batch
  in source order, returning full revised text, without an artificial input cap.
  Real model-context, transport/resource and deadline failures remain failures; never
  truncate findings or enable automatic compaction/continuations to make them fit.
  A model-derived output budget and the worker resource ceilings remain.
- Before any final palace write, reject content exceeding MemPalace's 100000 Unicode
  character storage maximum. This storage check does not cap read-only drafts or
  intermediate summaries. Exact write/readback validation remains mandatory.
- Changed extraction/reducer wording changes prompt hashes and versioned cache
  identities naturally; historical checkpoints remain intact. Contracts and schemas
  are unchanged because the scheduling and response shapes remain compatible.

## Reserved policy-turn preprocessing

Future normalized OpenCode and OMP captures exclude whole user messages beginning,
after leading ECMAScript whitespace, with one of five reserved markers:
[Memory Checkpoint], [Auto-Retry Guard], [Spiral Guard], [Loop Guard],
[Mem-core Reinjection]. The marker must end the text or precede whitespace;
[Loop Guard]ian is not reserved. Bodies may drift. This legacy-prefix convention
also excludes manually authored user turns with that exact prefix. Quoted,
mid-message, unknown/DCP and appended reminders remain intact; assistant outcomes
and supported substantive tool-result text remain. Existing sessions/drawers are
not rewritten. OpenCode synthetic-part exclusion remains; OMP's supported session
entry types have no established synthetic flag, so no invented synthetic field
is used. OMP continuations carry the shared checkpoint marker. OpenCode now honors
checkpoint.enabled/ESHEPHERD_CHECKPOINT_ENABLED (default true) without changing
trigger/agent gates, reply behavior, model prompts or raw-worker isolation.

Existing sources use reserved-user-turns-source-time-v2 before extraction. Raw physical
inventory and hashes remain authoritative and are re-read before/after inference.
Reassembly is explicitly capped at 8 MiB UTF-8, independent of model prompt bounds;
oversized sources retain the previous sliding raw-input path. Complete compact
{session,messages:[{role,text,time?}]} captures are supported, including legacy
messages without time and the shell
capture's separate chunked_capture JSON suffix appended to physical chunk zero,
only when its exact chunk count/IDs match inventory. Unsupported/malformed JSON,
extra message fields other than optional time, duplicate message/root keys, depth over 64 and invalid
suffixes fall back unchanged with an explicit no-filter reason; never truncate.
Mixed real text plus appended guards is never surgically split.

Filtered PRIMARY input consists of original serialized session metadata and retained
message-object spans, in order, with newline separators. Original JSON escapes stay
unchanged. Span offsets are half-open UTF-16 indices within each authoritative raw
physical chunk. Checkpoint/output audits record policy version, parent/raw hashes,
retained/omitted message indices, marker kinds, original chunk/span mappings,
session spans, counts, inspected versus contributing chunks and derived hashes.
Chunks containing only omitted messages/scaffolding do not contribute PRIMARY;
boundary context comes only from retained derived fragments. Conservative batch
provenance remains not per-claim grounding. Policy, exact derived inputs and omission
maps participate in cache identity; old versioned evidence is retained, never deleted.
An all-policy session records policy-only/no-substantive-source: every raw chunk is
inspected, but no mapper/reducer, finding, closet write or completion/retirement
certification occurs. Empty normalized message arrays take the same no-substantive
path with an explicit reason. Session metadata alone is not a substantive replacement.
No filtering or mechanical success guarantees semantic accuracy.

## Retries and deadlines

At most **two inference attempts per batch/reduction step**, one initial plus one
retry. Only typed observed transport errors (ECONNRESET, ECONNREFUSED, EPIPE),
timeouts (ETIMEDOUT), empty responses and authoritative length/error completions
are retryable. Useful normal-stop prose/Markdown is not a format failure: no JSON,
heading or unknown-field admission check exists. Unknown process exits, invalid
  streams, tool-use and insubstantial text are not retried.

The production --run-timeout-ms bound defaults to 1800000ms from CLI startup,
shared across sources, mapper and reducer. Each inference timeout is clipped to
the remaining deadline and normal per-call bound; expiry prevents another call,
admission or new write. Host read/KG operations cannot be forcibly canceled by
this deadline; writes already in flight are never retried to satisfy a deadline.
A resumed run starts a fresh finite budget; successful checkpoints remain reusable.
Exhaustion leaves coverage incomplete. Attempts, failure categories, available
finish reasons and usage are recorded safely. Secure attempt journal files (0600,
new directories 0700) retain rejection byte counts/hashes, not raw rejected text,
error strings, credentials, tool arguments or reasoning traces. Raw rejected
length/error content is intentionally not stored; existing telemetry retains
finish/usage/size. Successful text checkpoints are 0600.

## Runner-independent orchestration and isolated adapters

Raw batching, checkpoints, chronological reduction, retry admission, deadlines,
provenance and drawer storage are shared. Only invocation and authoritative
completion retrieval differ. Select a runner explicitly with `--subagent-bin`
(an absolute installed binary path); no fallback occurs with that option.
Raw adapters currently support Linux with `/usr/bin/setsid`, OMP v18.1.18 and
OpenCode V2 (explicit-provider regressions on v2.0.21; catalog access on v2.0.23).
Packaged agents inherit the host model. Explicit `consolidation.mapperModel` selection
wins over the calling session's model; a headless invocation without either fails with a
configuration error. There is no personal model catalog or automatic paid fallback.
OMP selects the exact configured provider/model from `models.yml`, with only that model
copied into the private catalog. It currently requires `openai-completions`.
Both runtimes check the selected identity and require positive output/context metadata.
The default output allowance is `min(8192, outputLimit, floor(contextWindow / 2))`;
`ESHEPHERD_MAPPER_OUTPUT_TOKENS` can override it within declared output/context limits.
OpenCode additionally requires a `/chat/completions` request path; other wire protocols
and model drift fail closed instead of weakening tool guards.

Each worker has an owned configuration directory and separate process group.
OMP and explicit OpenCode custom providers retain a private HOME/data/cache.
Cleanup removes only the owned directory and, on timeout, signals only the owned
process group.

OpenCode copies only an explicitly configured custom provider/model from the V2
JSON/JSONC config (or `ESHEPHERD_WORKER_OPENCODE_CONFIG`); missing custom models
still fail closed. Catalog providers need no explicit provider/model entry:
OpenCode resolves them normally, retaining the normal HOME, XDG data/cache/state
and database-backed login, without copying credentials. The configuration
directory remains private and project discovery disabled, so ambient capture/DCP
plugins and MCP configuration are not inherited. Normal local session history
can be retained in that database; no capture plugin is loaded. No new login or
global mapper-default change is required. Explicit custom-provider credentials
remain in 0600 private configuration, never telemetry. Both routes use
`--standalone --format json` with only the safe runtime plugin explicitly loaded
and empty MCP. All tool permissions are denied. The runtime plugin removes contributed
tools persistently, checks the permission-filtered executable context snapshot,
then independently checks zero wire tools/functions through `http.request`.
`tool.list()` is a registered inventory, **not** an active-tool count. The context
hook sets `options.maxTokens` from the selected model limits; the HTTP hook checks the actual wire budget.
WebSocket/unrecognized request contracts fail closed. Title generation is supplied
locally, compaction/warming are disabled, and native retry decisions are vetoed.

OpenCode's native SSE response is inspected before protocol lowering, rejecting
tool calls without logging arguments. `execute.before` is a second execution
guard. CLI text parts are preserved exactly. Completion uses an authoritative
CLI `step_finish` when present, otherwise the observed native provider finish
frame: installed v2.0.21 can omit step_finish from JSON output. Conflicting/missing
finish evidence is rejected; CLI exit zero is not completion evidence. Available
usage is retained, but usage frames not consumed after finish can be unavailable.

## Verified OMP controls and lifecycle

Installed OMP v18.1.18 --help exposes --no-tools. The matching upstream main.ts
passes an empty toolNames list. This flag alone is not treated as proof against
MCP/custom tools. The scoped runtime extension uses supported setActiveTools([])
and getActiveTools() at session_start and before_agent_start. Every outgoing
request checks zero active tools and zero wire tools/functions, emitting a
safe isolation record. Host rejects success without that evidence.

The supported tool_call result {block:true} prevents execution; message_end
also detects toolCall/toolUse turns and aborts. Host scans all assistant turns
and execution events, even if final output is normal stop. Safe telemetry includes
sanitized tool names, event phase and input presence, never arguments/results.
Unexpected tool use is nonretryable. OMP extension runner catches handler
exceptions, so isolation failures explicitly exit the owned worker (70), not
merely throw. Fatal records now include exact phase/predicate and safe counts.
Model/provider/budget-contract failures also explicitly terminate rather than
throwing an exception the extension runner could swallow.

OMP copies only the selected model/provider from `models.yml` into the worker.
The installed library can reactivate newly discovered MCP tools after a clear:
`MCPManager.connectServers` late completion or tools/list_changed calls
`session.refreshMCPTools`, which enables connected manager tools immediately.
Both paths were reproduced offline against the installed binary. Model-only
HOME/cwd prevents discovery and connection in the first place; the zero-tool
guards remain in force, not weakened or replaced with late wire stripping.

OMP can also internally auto-continue empty replies or retry within its provider
stream wrapper. The runtime exits with a typed retryable failure on authoritative
empty/length/error message endings before auto-continuation. Any further request
without such retained evidence is refused as `unobserved-native-retry`, without
dispatching it. Thus the shared host owns the two-attempt bound. An opaque inner
transport/empty failure may conservatively stop without a retry. No provider/model
replacement or global sampling/settings change is made.

Offline installed-runtime regressions cover both adapters: verbatim text,
length/error/empty/timeout, denied ambient MCP/plugins, zero wire tools, scoped
2,048-token small-model allowance, and injected tool-use rejected without continuation. Shared
tests cover retries/deadlines and uncertain-write refusal; no model/palace calls
are used by these offline tests. OpenCode source controls are the installed
`@opencode/plugin` v2.0.21 session/tool hook types, config loading and CLI event
lowering, plus https://opencode.ai/v2/docs/build/plugins and /config.
Evidence APIs: v18.1.18 packages/coding-agent/src/main.ts (noTools), src/sdk.ts
(custom/MCP activation), src/extensibility/extensions/types.ts (active tools),
src/extensibility/shared-events.ts (tool_call block), and
src/extensibility/extensions/runner.ts (exception handling), at
https://github.com/can1357/oh-my-pi/tree/v18.1.18/packages/coding-agent .

## Writes and semantic limitations

Substantive raw drafts, verified exact content and lineage, read-only guards,
capture-off isolation, uncertain-write blocking and retirement gates remain.
A persisted writing state without returned ID requires manual reconciliation,
including across source-version changes. Never wrap add_drawer or other palace
writes in inference retries. Sources move/retire only after verified replacements
and completion edges cover the entire source family. Independent logical source
counting still collapses physical chunks to their parent.

The structured open-task/dead-end ledger gate was explicitly removed for the
raw route with product approval. Arbitrary text has no reliable deterministic
task boundary. No mandatory task headings, keyword detector or semantic evaluator
replaces it. Invented/reworded tasks, hallucinations, reading-window leakage,
missing later corrections and omitted important outcomes may pass admission.
Prompt instructions are not enforcement. Accuracy requires evaluation against
full source content; conservative provenance is not entailment. The legacy/manual
route remains structured, not silently converted to raw text. Palace-source smokes
use `--only-drawer` without `--apply`. Neither that route nor a local smoke
authorizes palace mutation or retirement, global defaults, or bulk-readiness claims.

## Read-only local normalized transcripts

`--local-transcript-file <path> --checkpoint-dir <path>` processes exactly one
complete normalized capture JSON (`session` plus ordered `messages`), not an
OpenCode export envelope. Session ID/title/directory, conversation roles/text,
and any original timestamp fields are validated before model execution. Older
undated captures remain undated; no filing clock is invented. Exact UTF-8 bytes
are hashed without rewriting or truncation and rechecked through extraction and
after reduction, including cache-only runs. A changed input creates a new source
version; prior checkpoints are retained. The 8 MiB preprocessing ceiling fails
closed for local input instead of silently bypassing transcript validation.

The local branch returns before substrate initialization, shared coordination,
triage, validation/merge, retirement/moves, mem-core rendering and run-journal
writes. It has no palace client or tool transport; no palace reads are needed.
A strict local option allowlist rejects `--apply`, `--only-drawer`, reconsolidation,
all/full-scope, triage, cadence, merge/apply, manual-summary and heuristic routes
(and unknown flags). Only source/checkpoint, query, mapper agent/binary, deadline,
and harmless read-only switches are accepted. Automatic mem-core output is
unreachable even without `--no-mem-core-auto`.

The source ID is the real `opencode://session/<sessionID>` URI. Provenance
`localSource` records the canonical local file URI, SHA-256, byte size and
`local-host-fragment` kind. Legacy `parentDrawerId`/`sourceDrawerIds` field names
are reused for the session URI, not a fabricated palace drawer; contributing
chunk IDs are explicitly `file:...#local-host-fragment-0`. Host extraction pieces
are not stored palace chunks. Original clocks survive `sourceChronology` in the
final local draft. These drafts prove neither palace persistence nor timestamp
recovery for older palace captures.

The same production extraction/reduction prompts (including Zinsser), policy
filtering, versioned hashes/checkpoints, 16k/four-piece scheduling, model-derived
worker budget, zero-tool controls, bounded retries and shared 30-minute deadline
are reused. Model requests still require provider network access: this is a
**no-substrate-network** route, not an offline inference implementation.
`ESHEPHERD_CONSOLIDATION_MAPPER_MODEL` overrides the mapper for this invocation
without changing persisted defaults. Normal OpenCode authentication is retained;
capture is off. Local worker session history is retained, not recaptured into
the palace. The CLI writes the complete draft/provenance envelope to stdout;
redirect it into the evidence directory. Use a fresh checkpoint directory for
a fresh smoke and review before running paid inference.

```sh
ESHEPHERD_CONSOLIDATION_MAPPER_MODEL=custom/my-model \
ESHEPHERD_SOURCE_CAPTURE_ENABLED=false \
node --experimental-strip-types src/scripts/run-memory-consolidation-and-validation.ts \
  --local-transcript-file /absolute/path/normalized.json \
  --checkpoint-dir /absolute/path/fresh-checkpoint \
  --subagent-bin "$(command -v opencode)" \
  --run-timeout-ms 1800000 > /absolute/path/final-local-draft.json
```