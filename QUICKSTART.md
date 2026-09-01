# Electric Shepherd — Quick Start

Electric Shepherd is the **policy layer** for memory consolidation. It decides when to
consolidate, what to merge, and how to derive durable memory. MemPalace is the **substrate** — store,
graph, traversal. This repo is a client of MemPalace; it never reaches into MemPalace
internals.

---

## 1. Wire into OpenCode

OpenCode merges global config (`~/.config/opencode/opencode.jsonc`) with project config
(`./opencode.jsonc`). ElectricShepherd includes a project-level `opencode.jsonc` so this
repo can own its plugin + instruction wiring without duplicating global settings.

Enable the plugin in `opencode.jsonc`:

```jsonc
"plugin": ["electric-shepherd"]
```

That one line is enough. On startup the plugin's `config` hook injects its bundled agents,
slash commands, and instruction rules into your resolved config, so they load in any project
that enables the plugin. `agent-discipline.md` (the full agent ruleset) is appended to
`instructions` automatically; live mem-core is loaded from scoped `memory.md` renders under
`.electric-shepherd/memory/`.

### 1a. Asset loading matrix

ElectricShepherd is a plugin, so it loads the same way wherever it is enabled. The plugin's
`config` hook reads its bundled markdown at startup and injects it into the resolved config:

- Plugin: yes — via `plugin: ["electric-shepherd"]`
- Agents (`agents/*.md`): yes — injected into `config.agent` by the `config` hook
- Commands (`command/*.md`): yes — injected into `config.command` by the `config` hook
- Instructions (`instructions/agent-discipline.md`): yes — absolute paths appended to `config.instructions`
  (opt out with `assets.injectInstructions=false` in `eshepherd-config.jsonc`)

Not config-injectable:

- Skills (`skills/*/SKILL.md`): OpenCode has no skill config key — place a copy under your own
  `.opencode/skills/<name>/SKILL.md` if you want it auto-discovered
- Snippets (`snippets/*.md`): OpenChamber snippet assets, not an OpenCode auto-load concept

> Why the hook is needed: OpenCode only auto-discovers `agents/` / `command/` / `skills/`
> folders for the active **project** root. An installed plugin is never the project root, so
> folder discovery never fires for it — the `config` hook is what makes the bundled assets load
> like the rest of the plugin. User-defined agents/commands with the same name always override
> the bundled ones.

## 1b. Local config + secrets setup

Create runtime behavior config and machine-local secrets:

```bash
cp eshepherd-config.example.jsonc eshepherd-config.jsonc
cp .env.example .env
```

Use `eshepherd-config.jsonc` for non-secret behavior settings.
Use `.env` for secrets (API keys/tokens) only.

Runtime scripts auto-load env files in this order:

1. `ESHEPHERD_ENV_FILE` (if set)
2. `./.env` and `./.env.local` in ElectricShepherd root
3. fallback: `../docker/.env` (for monorepo setups)

No manual `source .env` step is required.

## 1c. Quick sanity check

Before trying the heavier policy flows, run:

```bash
npm test
npm run policy:mem-core:load -- --format markdown
```

`npm test` collects the full suite (unit + integration files). Integration tests
self-skip without a MemPalace endpoint and `ESHEPHERD_TEST_INTEGRATION=1`, so this
still runs offline. If the unit suite fails, fix the local Node/runtime issue first;
the mem-core loader check is a lightweight way to confirm the scoped loader path is
wired correctly.

## 2. Set the tool prefix

MemPalace tool names vary by how MemPalace is registered with your MCP host:

| Registration | Tool name shape | Correct `mcp.toolPrefix` |
|---|---|---|
| Direct MCP at `:8093` | `mempalace_search` | `mempalace_` *(default, no action needed)* |
| Namespaced gateway | `<namespace>mempalace_search` | `<namespace>mempalace_` |

For agent prompts (the dreamer and mapper subagents) you also need to state the full
prefix in any agent prompt that calls MemPalace tools directly, or load `skills/eshepherd/SKILL.md`
as an additional instruction so the agent knows which names to use.

For the TypeScript adapter (`adapter/memgraph.ts`), set the prefix in
`eshepherd-config.jsonc`:

```jsonc
{
  "mcp": {
    "toolPrefix": "mygateway_mempalace_"
  }
}
```

For standalone runtime scripts (`policy:cycle`, `policy:consolidate-validate`,
`policy:cadence`) on authenticated MCP endpoints, set endpoint/prefix in config and
auth in env:

```jsonc
{
  "mcp": {
    "url": "http://your-mcp-endpoint/mcp",
    "toolPrefix": "mempalace_",
    "authHeader": "Authorization",
    "authScheme": "Bearer"
  }
}
```

```bash
# Generic API key/token value
export MEMPALACE_MCP_API_KEY="<your-key-or-token>"
# Optional: explicit bearer token shortcut for Authorization header
# export MEMPALACE_MCP_BEARER_TOKEN="<your-token>"
# Optional: full custom headers as JSON
# export MEMPALACE_MCP_HEADERS_JSON='{"X-Api-Key":"<your-key>"}'
```

Or pass it at construction time:

```typescript
const client = createMemgraphClient({
  callTool,
  toolPrefix: "mygateway_mempalace_",
});
```

## 3. Run deterministic retrieval expansion

```bash
npm run policy:cycle -- \
  --query "recent architecture decisions" \
  --scope-room context-blocks \
  --scope-wing context-blocks \
  --labels pinned \
  --match-mode any \
  --top-n 12
```

This executes probabilistic-entry + deterministic-expansion via MemPalace scoped
lineage and labels tools, and prints a JSON result payload for policy consumption.

### 3a. Intent-aware retrieval

Retrieval is intent-aware: pass `--intent factual|historical|procedural` to rank the
candidate pool by what kind of answer you want.

```bash
npm run policy:cycle -- \
  --query "what does the config schema define" \
  --scope-room context-blocks \
  --intent factual
```

The intent shapes per-source-type boosts over the `es-source-type` axis (see §4):
`factual` favors `doc` then `synthesis`, `historical` favors `synthesis` then
`transcript`, `procedural` favors `skill` then `synthesis`.

**Factual hard rule:** on a factual intent, a provisional synthesis can never outrank a
doc — if any doc-stamped node is in the candidate set, provisional syntheses are clamped
down to the lowest doc score (a weight-based floor, applied after all scoring). A
provisional synthesis still ranks first when no doc is in the candidate set.

On a factual intent, retrieval has a **direct doc-admission path**: doc-stamped drawers in
scope enter the ranked candidates even without a `concerns` edge. Pass `--include-docs` to
enable that same scan for non-factual/default intents.

Retrieval also surfaces **one-hop `concerns` neighbors** as a grounding/neighbor path: a hit
on a synthesis admits its linked authority docs into the ranked pool, so a synthesis hit
carries its grounding docs along (see §4a for how those links are created).

Retrieval also reads **`es-outcome` history** as a ranking term: net-positive outcomes boost a
node, repeated `revise` penalises it, and nodes with no outcome history score exactly as before.
The term is weighted strictly below authority (a doc with no history still outranks a synthesis
with two accepts on a factual query), and the factual floor is applied after it. Outcomes are
written only by the human-authoritative `record_outcome` tool (§4a).

**Procedural scope (Phase 10):** on a `procedural` intent, retrieval also reaches skills that
were promoted into the shared skills wing (`shared-skills`, override via
`ESHEPHERD_SHARED_SKILLS_WING`). A freshly promoted skill has no edges into the querying
project, so this is a bounded one-page scan of the shared wing's `skills` room with a hard
`es-source-type: skill` check — only skill-stamped drawers in that exact wing are admitted.
Every other intent (factual/historical/default) stays single-wing and byte-identical to
pre-Phase-10 output: no shared-wing calls, no cross-wing nodes. Promote a skill with
`/promote-skill <drawer_id>` (§3h).

## 3b. Run consolidation + validation pipeline

```bash
npm run policy:consolidate-validate -- \
  --query "memory consolidation candidates" \
  --wing context-blocks \
  --room context-blocks \
  --scope-room context-blocks
```

This runs:
- **Source-to-derived consolidation:** map/reduce proposal with deterministic inflation guard checks.
- **Validation + merge review:** downward validation, merge adjudication, and optional escalation notification.

Add `--apply` to allow derived-drawer creation when checks pass.
Add `--apply-merges` to apply auto-merge decisions above configured score threshold.

Optional integration flags:
- `--use-live-mapper` and `--mapper-agent <name>` to request mapper summaries via subagent task calls.
- `--use-live-auditor` and `--auditor-agent <name>` to request an auditor verdict over consolidation + validation output.
- mem-core is auto-rendered by default to `./.electric-shepherd/memory`.
- use `--mem-core-dir <path>` to choose a base directory, `--mem-core-scope-dir <path>` to control directory scope, `--mem-core-file <path>` for one explicit file, and `--no-mem-core-auto` to disable auto-write.
- use `npm run policy:mem-core:load -- --format markdown` to load the layered mem-core view for the current directory.

## 3c. Run cadence orchestration foundation

```bash
npm run policy:cadence -- \
  --query "memory consolidation candidates" \
  --wing context-blocks \
  --room context-blocks \
  --scope-room context-blocks \
  --current-idle-minutes 25 \
  --nightly-backstop
```

Use `npm run policy:cadence:execute -- ...` to execute consolidation+validation for triggered areas.

For cadence history across runs, add:

```bash
--cadence-state-file ./.electric-shepherd-cadence-state.json
```

## 3c2. Ingest a docs directory (`/ingest-docs`)

Docs are first-class sources, not just transcripts. `/ingest-docs <path>` mines a docs
directory into the project wing's `reference` room (reusing an existing reference-like
room before minting one) and stamps every ingested drawer with `es-source-type: doc`.

It is **dry-run-first**: the first call previews the resolved wing/room and target path
without writing; only after you approve does it run for real. On apply, changed files are
purged+reinserted under the same drawer IDs (unchanged files are skipped), open outgoing
KG facts on changed drawers are invalidated as a staleness pass, and `es-source-type: doc`
is re-stamped. Partial failures are reported; re-running converges (every step is
idempotent). It never touches the `es-status` axis — that stays orthogonal to
`es-source-type`.

## 3d. Enable consolidation plumbing

The plugin now wires deterministic events directly:

- mem-core re-injection on `session.compacted`, `session.started`, and scope drift observed during `session.idle`
- scope-aware loader calls through `scripts/run-mem-core-loader.ts`
- write-authority guard for consolidation writes (`add_drawer`/`kg_add` lineage + `apply_merge`)
- OpenCode source-transcript capture verification heartbeat

Recommended setup:

```bash
# 1) Runtime behavior: config file
cp eshepherd-config.example.jsonc eshepherd-config.jsonc

# 2) Secrets only: env
export MEMPALACE_MCP_API_KEY="<your-key-or-token>"
# export MEMPALACE_MCP_HEADERS_JSON='{"X-Api-Key":"<your-key>"}'
```

Plugin status/verification output is written to `./.electric-shepherd/turn-guard-status.json`.

## 3f. Automatic consolidation ("count sheep in the background")

> ⚠️ **This writes to your memory in the background when enabled.**
> The plugin can spawn the deterministic consolidation script on its own (no
> prompt, no confirmation) after the session goes quiet, after enough new turns
> accumulate, or after compaction. It can create closets, KG facts, and re-render
> your mem-core files without you asking. **Only leave this enabled once you
> understand the triggers below.** Everything it does is logged to
> `./.electric-shepherd/turn-guard-status.json` (`type: "auto-consolidation-*"` entries).

Control it in `eshepherd-config.jsonc`:

```jsonc
{
  "consolidation": {
    "auto": {
      "enabled": true
    }
  }
}
```

It triggers on three conditions, each independently gated:

| Trigger | Fires when | Config path(s) | Default |
|---|---|---|---|
| **idle-timer** | The session stays quiet for the full delay after going idle. The timer is **reset every time you send a new message**, so it only fires once the session has *actually* been left alone — it is a debounce, not a fixed schedule. Requires ≥1 new turn since the last run. | `consolidation.auto.onIdle`, `consolidation.auto.idleDelayMs` | `true`, `120000` (2 min) |
| **volume-threshold** | Enough new assistant turns accumulate; runs eagerly without waiting. | `consolidation.auto.messageThreshold` | `12` |
| **compacted** | The session is compacted (a natural consolidation point). | `consolidation.auto.onCompact` | `true` |

Shared throttles and overrides:

| Config path | Meaning | Default |
|---|---|---|
| `consolidation.auto.cooldownMs` | Minimum time between auto-consolidation runs (counted from when a run starts). | `600000` (10 min) |
| `commands.autoConsolidation.timeoutMs` | Watchdog: a run exceeding this is killed, and the in-flight flag/lock is released. Also the staleness window for the cross-process lock. | `300000` (5 min) |
| `commands.autoConsolidation.command` | Override the command that is run. The default is deterministic (`--run-cadence --cadence-mode execute --apply`, **no** live mapper) so it never forces a model to load. | deterministic script |
| `commands.sourceCapture.timeoutMs` | Ceiling for the blocking source-transcript capture call so a hung script can't freeze the session. | `20000` |
| `commands.memcoreLoader.timeoutMs` | Ceiling for the blocking mem-core loader call. | `15000` |

How the timer actually works (the important bit): OpenCode emits a `session.idle`
event when the conversation stops. On that event the plugin **arms** a real
`setTimeout` for `consolidation.auto.idleDelayMs`. If you send another message before
it fires, the next `message.updated` **clears** the timer — so the delay is
genuinely "quiet for N ms," and any new activity overrides it.

Failure containment (so a run that begins can't get stuck or orphaned):
- A single in-flight flag plus a **shared cross-process lockfile**
  (`.electric-shepherd/auto-consolidation.lock`, pid + start time) prevent overlapping
  runs. The **same lock is taken by the CLI/cron/n8n entrypoint too** — when the
  plugin spawns the script it passes `ESHEPHERD_CONSOLIDATION_LOCK_INHERITED=1` so the
  child trusts the parent's lock, while a standalone `sheep:*` / cron run acquires
  the lock itself. So a plugin run and a cron run firing at the same instant
  cannot both proceed.
- A **watchdog** kills any run that exceeds `commands.autoConsolidation.timeoutMs`, so a
  hung MCP endpoint can never wedge auto-consolidation permanently. The kill targets the
  **whole process tree** (`taskkill /T` on Windows, process-group signal on
  POSIX), so a shell-wrapped `commands.autoConsolidation.command` can't leave an orphaned
  grandchild behind.
- If a run is **orphaned** (OpenCode exits before the background process
  finishes), the lock is treated as stale after the timeout window and the next
  trigger reclaims it. The substrate is append-only, and the mem-core file is
  written **atomically** (temp file + rename), so a killed run leaves both the
  palace and the rendered file intact rather than half-written.
- A run that **never actually starts** (spawn error) rolls back its cooldown stamp,
  so a transient failure doesn't make you wait out a phantom cooldown; a run that
  started and then failed/timed out keeps the cooldown as anti-thrash.
- The per-session tracking maps are **bounded** by
  `consolidation.auto.maxTrackedSessions` (default 512, oldest evicted first)
  so a long-lived process can't leak memory across many sessions.

The deterministic script re-renders mem-core, which the existing mem-core
re-injection then picks up on the next idle/compaction — closing the loop.

**Prefer an external scheduler?** Auto-consolidation is entirely optional. You can leave
`consolidation.auto.enabled=false` and instead have n8n, cron, or Windows Task
Scheduler call the same entrypoint on a timer — there is no coupling, and the
shared lock keeps a scheduled run from colliding with a plugin run:

```bash
npm run sheep:consolidate-deep   # == policy:cadence:execute --apply --apply-merges
```

> Testing/automation note: pass `--no-lock` (or set
> `consolidation.lock.disabled=true`) to bypass the shared lock when you knowingly
> want concurrent runs (e.g. isolated test fixtures).

## 3g. Playful commands

These are OpenCode slash-commands defined in `command/*.md` in this repo and
discovered via `OPENCODE_CONFIG_DIR` (the same mechanism that loads the agents in
`agents/`). OpenCode recognises both a `command/` and a `commands/` directory —
this repo uses the singular `command/`.

The commands are **prompts**, not raw script calls — each markdown template is sent
to its configured agent (`agent:` in the command frontmatter). To keep an aside about memory
from polluting the codebase session you are in, commands marked `subtask: true` run as
**isolated subagents**: that agent works in its own context and only a short summary
returns to your session (expand the subtask in the TUI to watch/debug it). Commands with
`subtask: false` run in-session.

| Command | Does | Isolation | CLI / scheduler equivalent |
|---|---|---|---|
| `/consolidate` | Standard consolidation: promote unconsolidated source drawers into closets + KG facts (additive only). Supports `apply`, `all`, `retry-failed`, `live`, `room=...`, `processed-room=...`, `failed-room=...`. | isolated subagent | `npm run sheep:count` |
| `/memory-status` | Round-up/preview: list what is pending and what *would* consolidate — read-only, no writes. | isolated subagent | `npm run sheep:memory-status` |
| `/consolidate-deep` | Deep pass: consolidate **plus** merge/dedupe existing closets and run a drift audit. | isolated subagent | `npm run sheep:consolidate-deep` |
| `/memory-refresh` | Refresh and re-inject mem-core for the current scope. | in-session | `npm run sheep:memory-refresh` |
| `/memory-status` | Quick counts of pending source vs existing derived memories. | isolated subagent | — |
| `/ingest-docs <path>` | Mine a docs directory into the project wing's `reference` room and stamp `es-source-type: doc`. Dry-run-first (see §3c2). | in-session | — |
| `/remind <action> ...` | Create/update/close prospective reminders ("remember to do X when Y"). Dry-run-first; expiry required for create. Actions: `create`, `update`, `close`, `list` (see §3g2). | in-session | — |
| `/reminders [filters]` | Read-only listing of the project's reminders with optional `status`/`condition` filters; flags stale active reminders past their expiry. | isolated subagent | — |
| `/promote-skill <drawer_id>` | Promote a project skill into the shared skills wing so any project's procedural retrieval can reach it. Copy (source untouched), approval-gated, idempotent (see §3h). | in-session | — |

Each command takes an optional scope argument, e.g. `/consolidate context-blocks`.

> Note on "a different session": OpenCode commands can isolate work into a
> subagent (above), which gives you the no-pollution benefit. They cannot, on
> their own, spin up a brand-new *top-level* session and switch the TUI to it —
> that is a manual action. For unattended consolidation in a truly separate
> process, use the `npm run sheep:*` CLI entrypoints (or auto-consolidation) instead.

## 3g2. Prospective reminders (`/remind`, `/reminders`)

Reminders are "remember to do X when Y" items: they fire into the session's mem-core
under a `[pending]` block when their trigger matches the current scope (a path/glob,
a topic keyword, or a wing/room). They are pushed by circumstance, not pulled by query.

- `/remind create <condition> <what> --expires <ISO date>` — file a new reminder.
  **Expiry is required**: if `--expires` is missing or invalid, the tool rejects the
  capture. Dry-run-first: the first call previews the exact drawer + KG edges that
  would be written; apply only after explicit confirmation.
- `/remind update <drawer_id> <new what and/or --expires ISO>` — change the text or expiry of one existing reminder.
- `/remind close <drawer_id> [satisfied|expired]` — retire a reminder (default `satisfied`).
- `/reminders [filters]` — read-only listing with optional `status`/`condition` filters
  (bounded, default 20). Active reminders are grouped first; reminders whose expiry has
  passed but that are still `active` are flagged for closing.

Reminders live in the project wing's `reminders` room and never touch `es-status`,
source drawers, or synthesis lineage. They render into mem-core under a bounded
`[pending]` block (default enabled; disable via
`ESHEPHERD_MEMCORE_RENDER_INCLUDE_PENDING=false`).

## 3h. Promote a skill to the shared wing (`/promote-skill`)

Skills default to the project wing (§4). But "how I diagnose a caching regression"
transfers everywhere; only project-specific procedure should stay wing-locked.
Promotion is that transfer — and it is a **distinct operation from relocation**:
relocation fixes misfiling (the drawer was in the wrong place); promotion generalises
something correctly filed (the drawer now belongs in two places).

- `/promote-skill <drawer_id>` — promote one skill into the shared skills wing
  (`shared-skills`, override via `ESHEPHERD_SHARED_SKILLS_WING`). The source must already
  carry `es-source-type: skill` (file it with `/file-skill` first if not). Dry-run-first:
  the first call previews the destination room + idempotency-guard result; apply only after
  explicit confirmation.

What apply does:

- **Idempotency guard first**: an existing `promoted-from` edge (either direction) or an
  exact-duplicate content match in the shared wing makes the re-run a no-op — no second
  copy, no second edge.
- **Files verbatim** into `<shared-wing>/skills`. The source drawer is left untouched —
  COPY semantics, never a move (retiring the local copy later via `merged-into` is the
  operator's call).
- **Stamps** the shared copy `es-source-type: skill` and writes one `promoted-from` edge
  `{subject: <shared>, predicate: "promoted-from", object: <origin>}`. This edge is **not
  lineage**: it never counts toward height and never feeds recursive lineage traversal. It
  exists so the origin stays traceable after promotion.

Promotion is **proposed, never automatic**. A skill present in >= 2 project wings surfaces
as a candidate via the memory-status scan (`findPromotionCandidates` — read-only); no
threshold crossing silently moves a drawer. Once promoted, a `procedural`-intent retrieval
from ANY project wing reaches it (§3a).

### 3d-2. Phase 9 — negative knowledge (what was ruled out)

The mapper extracts `DEAD_ENDS` from each transcript: approaches that were **tried and
failed** or **considered and rejected**, one line each with its outcome clause attached.
A line without an outcome is incomplete and must not be filed — "we tried X" reads as
advice unless it carries "— this does not work, here's why."

Dead ends are stored as negative-polarity **syntheses** (never a fourth source type) and
carry a `rules-out` KG edge (one-hop, not lineage — it never counts toward height or feeds
lineage traversal). In scoped retrieval they are surfaced with an explicit `[RULED OUT …]`
label. This phase labels but does **not** re-rank: the dead-end node's score is unchanged,
so a ruled-out approach can't accidentally sink below the noise floor or float to the top.

They render into mem-core under a bounded `[dead-ends]` block (default enabled; cap 3;
disable via `ESHEPHERD_MEMCORE_RENDER_INCLUDE_DEAD_ENDS=false`, tune the cap via
`ESHEPHERD_MEMCORE_RENDER_MAX_DEAD_ENDS=<n>`). An empty list omits the whole section — no
per-prompt tax when nothing was ruled out.

## 3e. Running tests

**The default verification command is `npm test`, and it collects the full suite —
unit AND integration files.** Phase-completion claims must cite `npm test` (or
`npm run test:all`, an alias for it), never a narrower script.

```bash
npm test
```

Integration tests exercise the adapters against a real MemPalace MCP endpoint and
are gated behind `ESHEPHERD_TEST_INTEGRATION=1`. They use `mcp.url` from
`eshepherd-config.jsonc` (or `MEMPALACE_MCP_URL` if you intentionally
override in env) — the configured endpoint must expose the full tool surface
(lineage graph traversal, scoped-node lookup, single/bulk delete). Without the gate
they are collected but self-skip, so `npm test` still runs offline.

To run the integration files alone (or with the gate open):

```bash
export ESHEPHERD_TEST_INTEGRATION=1
npm run test:integration   # or: npm run test:all (alias for npm test)
# unit-only, when you specifically want it: npm run test:unit
```

GitHub Actions wiring:

- `.github/workflows/ci.yml` always runs `npm test`, which collects the
  integration files too; they self-skip unless the gate is open.
- If `MEMPALACE_MCP_URL` is configured as a repository variable/secret, CI uses
  that endpoint for integration suites (env wins over config only when set deliberately).
- If no endpoint is configured, CI starts an ephemeral local MemPalace MCP
  server in the job, points tests at `http://127.0.0.1:8093/mcp`, and tears it
  down at the end of the run.
- In both cases, the integration step runs with
  `ESHEPHERD_TEST_INTEGRATION=1`.

The suite seeds a disposable per-run room in the `eshepherd-test` wing and
deletes exactly the drawers it created on teardown, so it never touches live wings.

## 4. Memory layers at a glance

These map onto MemPalace's **native** layers — Electric Shepherd doesn't invent storage:

| Memory | Role | Native MemPalace home | Written by consolidation? |
|---|---|---|---|
| **raw transcripts** | Append-only verbatim transcripts | **drawers** (in `mem-raw` rooms, tagged by session) | No — frozen, source of truth |
| **summaries / arcs** | Consolidated, revisable synthesis | **closets** (point back to source) | Yes |
| **durable facts** | Decisions/state, supersedable with history | **KG triples** (`valid_from`/`valid_to`, `kg_invalidate`) | Yes |
| **categories** | What kind of memory this is | **halls** (`facts`/`events`/`discoveries`/`preferences`/`advice`) | Yes (re-assignable) |
| **lineage** | How memories derive/merge | **KG edges** (`synthesized-from`, `merged-into`) | Yes |
| **mem-core** | Always-loaded working set | directory-scoped render files (`.electric-shepherd/memory`) | Yes — derived render, never hand-authored |

Raw drawers are never altered. "Synthesize" creates closets + KG edges; it doesn't rewrite the
verbatim store. Removing Electric Shepherd leaves all of the above as valid native MemPalace
data — see the README's "Non-invasive by design."

### 4a. The `es-source-type` axis and cross-type linking

Every drawer can carry an `es-source-type` stamp: `transcript | doc | synthesis | skill`.
It is **orthogonal to `es-status`** — a node's source type (where it came from) is
independent of its consolidation status (how settled it is). Retrieval reads this axis to
apply intent-based boosts (§3a); unstamped nodes rank as `"unknown"`.

On top of lineage, synthesis closets can link to their authority docs with **`concerns`
edges** (`{subject: <synthesis id>, predicate: "concerns", object: <doc id>}`). These are
created by the `propose_concerns` tool as **approval-gated proposals**: it validates both
endpoints (the synthesis must have `synthesized-from` lineage; each target must carry
`es-source-type: doc`; self-links and duplicates are rejected), prints a numbered proposal
list, and applies only the items you approve. Retrieval then surfaces one-hop `concerns`
neighbors as a grounding/neighbor path (§3a), so a synthesis hit carries its grounding docs
into the ranked pool; direct doc admission (§3a) lets doc-stamped drawers enter the ranked
pool without any `concerns` edge at all.

### 4a-2. The `es-outcome` axis and human-authoritative outcome writing

Every closet a unit of work actually consulted can carry **`es-outcome` edges**
(`{subject: <node id>, predicate: "es-outcome", object: accept | revise | failed | unused}`).
They **accumulate** — multiple edges per closet are expected and meaningful (a closet with 6
accepts + 1 revise is different from one with 1 accept); nothing ever overwrites or collapses them.

Writing is **human-authoritative by design**: the `record_outcome` tool is the only writer, and
it requires an explicit operator judgment at cycle close (one bounded work unit). Test pass/fail,
reviewer verdicts, and loop/spiral intervention logs are **evidence only — never writers**; a
failed test run does not auto-write `failed`. The operator reads the evidence and decides
(loop/spiral alone maps toward `unused` unless a hard failure was human-confirmed).

Attribution is strict: the tool accepts ONLY an explicit node-id set — the `selected_nodes`
retrieval returned for that unit of work. There is no wing/room/scope write mode, and an empty
id list is rejected: when the consulted set cannot be determined, it writes NOTHING rather than
blame closets that had no part in the outcome.

Dry-run first: the default call makes no `kg_add` and echoes the exact edges; pass
`dry_run:false` only after explicit operator confirmation. Each edge carries a `valid_from`
timestamp so consumers can window recent history.

**Operator flow — recording an outcome after a policy cycle.** The `policy:cycle` output
includes an `outcome_proposal` section: a prefilled dry-run `record_outcome` payload with the
run's `selected_nodes` mirrored into `node_ids` and a generated `cycle_ref`. It is informational
only — the script never writes. Copy the payload, set `outcome` to your judgment
(`accept | revise | failed | unused`), call `record_outcome` with `dry_run: true`, then re-run
with `dry_run: false` only after your explicit confirmation.

Two things read this axis (§3a): retrieval ranking (below-authority boost/penalty) and
`/memory-status`, which surfaces **re-synthesis candidates** — closets with `revise >= 2` and
`revise > accept` over a recent window — the same way provisional backlog is surfaced.

## 4b. How mem-core scope is chosen

The mem-core that gets injected into a session is **location-based**, and it
**works upward** from that location:

1. **Starting point.** The plugin resolves a scope directory from the session
  event (working directory / `cwd`), then `memcore.scopeDir`, then the
   directory OpenCode was launched in, then the process cwd — the first one that
   exists wins.
2. **File-follow override.** If your recent messages reference a concrete file
   (an attached file part or a path in the text), the scope **follows that file's
   directory** instead. So when you're actively working on a file, mem-core tracks
   wherever that file lives.
3. **Walk upward + merge broad→narrow.** From that directory, the loader walks
   **up to the project root** (the nearest folder with `package.json`/`.git`) and
   merges every `memory.md` it finds along the way — plus the matching
  `.electric-shepherd/memory/<relative-scope>/memory.md` store files — ordered broad
   (root) first, narrow (current directory) last. So you always get the project's
   top-level memory *plus* every intermediate folder *plus* the current folder.

Knobs:

```jsonc
{
  "memcore": {
    "scopeDir": "/absolute/scope/dir",
    "maxScopes": 6,
    "storeRoots": ".electric-shepherd/memory",
    "maxChars": 12000
  }
}
```

## 5. Updating mem-core

`docs/memory-blocks.reference.md` is a shape/example for scoped mem-core render output.
Runtime + plugin wiring keep live mem-core in sync by deriving it from consolidated summaries and KG facts:

1. The runtime auto-writes a scoped `memory.md` render under `.electric-shepherd/memory/<directory-scope>/memory.md`.
2. The loader composes broad-to-local memory layers by directory scope (`npm run policy:mem-core:load -- --format markdown`).
3. The plugin re-injects scoped mem-core on compaction/start and when scope drifts during idle.

To force a canonical rebuild to the top-level render file:

```bash
npm run policy:mem-core:rebuild
```

mem-core does not round-trip into MemPalace drawers and is not hand-authored. Human audit focus remains consolidation consistency and label/hall tuning.

## 6. Snippets

| Snippet | When to use |
|---|---|
| `skills/eshepherd/SKILL.md` | When doing intensive memory work (add to instructions temporarily) |

## Architecture reference

`docs/memory-graph-design.md` is the authoritative architecture document. Build order,
substrate/policy boundary, and lineage/merge graph design are all there.
Do not treat this file as architecture authority; it is a setup checklist.
