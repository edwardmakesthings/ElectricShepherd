# Electric Shepherd — Quick Start

A setup checklist. This file is not architecture authority: [`README.md`](README.md) covers
what Electric Shepherd is, [`docs/memory-graph-design.md`](docs/memory-graph-design.md) the
semantics.

Sections 1–4: setup. 5–7: operation. 8–9: reference.

---

## 1. Wire into OpenCode

OpenCode merges global config (`~/.config/opencode/opencode.jsonc`) with project config
(`./opencode.jsonc`) — it does not replace one with the other. Enable the plugin in either:

```jsonc
"plugin": ["electric-shepherd"]
```

One line. On startup the plugin's `config` hook reads its bundled markdown and injects it
into your resolved config, so the assets load in any project that enables the plugin — no
need to run OpenCode from inside this repo or copy files into `.opencode/`.

**What that injects, and what it can't:**

| Asset | Injected? | Mechanism |
|---|---|---|
| plugin | yes | `plugin: ["electric-shepherd"]` |
| `agents/*.md` | yes | appended to `config.agent` |
| `command/*.md` | yes | appended to `config.command` |
| `instructions/agent-discipline.md` | yes | absolute path appended to `config.instructions` (opt out: `assets.injectInstructions=false`) |
| `skills/eshepherd/SKILL.md` | **no** | OpenCode has no skill config key — copy it to `.opencode/skills/eshepherd/SKILL.md` yourself |
| `snippets/*.md` | **no** | OpenChamber assets; not an OpenCode auto-load concept |

Your own agents and commands override bundled ones on a name collision.

> `agent-discipline.md` is the single statement of the memory contract. Do not restate it in
> individual agent prompts; a copy will drift.

---

## 2. Config and secrets

```bash
cp eshepherd-config.example.jsonc eshepherd-config.jsonc
cp .env.example .env
```

**`eshepherd-config.jsonc` holds all behaviour. `.env` holds secrets only.** Runtime scripts
and plugin paths do not read behaviour toggles from the environment.

Env files auto-load in this order; no `source .env` step:

1. `ESHEPHERD_ENV_FILE` if set
2. `./.env` then `./.env.local` in the repo root
3. `../docker/.env` (monorepo fallback)

Allowed keys and defaults live in `src/core/runtime-config.ts` (`RUNTIME_CONFIG_SPECS`).

---

## 3. Point at MemPalace

### 3.1 Tool prefix

MemPalace tool names vary by how it is registered with your MCP host. A wrong prefix fails
every substrate call, and the failure is indistinguishable from an empty palace.

| Registration | Tool name shape | `mcp.toolPrefix` |
|---|---|---|
| Direct MCP at `:8093` | `mempalace_search` | `mempalace_` *(default)* |
| Namespaced gateway | `<ns>mempalace_search` | `<ns>mempalace_` |

```jsonc
{ "mcp": { "toolPrefix": "mygateway_mempalace_" } }
```

Agent prompts that call MemPalace tools directly need the full prefix stated in the prompt,
or `skills/eshepherd/SKILL.md` loaded as an extra instruction so the agent knows the names.

### 3.2 Endpoint and auth

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
export MEMPALACE_MCP_API_KEY="<key-or-token>"
# alternatives:
# export MEMPALACE_MCP_BEARER_TOKEN="<token>"
# export MEMPALACE_MCP_HEADERS_JSON='{"X-Api-Key":"<key>"}'
```

With `mcp.autoDiscover: true` and `mcp.url` unset, runtime scripts discover a live hub
endpoint and token from MemPalace's local server registry.

---

## 4. Sanity check

```bash
npm test
npm run policy:mem-core:load -- --format markdown
```

`npm test` collects the full suite. Integration files self-skip without a MemPalace endpoint
and `ESHEPHERD_TEST_INTEGRATION=1`, so this runs offline. The loader call confirms the
scoped mem-core read path works without loading a model.

**Then confirm mem-core reaches a session.** Rendering and loading are separate; only
rendering is visible from outside. Start a fresh session and ask *"what is in your
mem-core?"* If the model cannot see it, it is rendered and unloaded. Add the render path to
`instructions` — a static prompt prefix, not turn injection:

```jsonc
{ "instructions": [".electric-shepherd/memory/**/memory.md"] }
```

Full read-path ladder: [`docs/memory-test-plan.md`](docs/memory-test-plan.md).

---

## 5. Slash commands

Commands are **prompts**, not script calls — each markdown template is sent to the agent
named in its frontmatter. `subtask: true` runs it as an isolated subagent so a memory aside
does not pollute the session you are in; only a short summary returns (expand it in the TUI
to watch). `subtask: false` runs in-session.

| Command | Does | Isolation | Scheduler equivalent |
|---|---|---|---|
| `/consolidate` | Promote unconsolidated source drawers into closets + KG facts. Additive only. Args: `apply`, `all`, `retry-failed`, `live`, `room=…` | subagent | `npm run sheep:count` |
| `/consolidate-deep` | Consolidate **plus** merge/dedupe existing closets and run a drift audit | subagent | `npm run sheep:consolidate-deep` |
| `/memory-status` | Read-only: pending vs derived counts, provisional backlog, re-synthesis and promotion candidates | subagent | `npm run sheep:memory-status` |
| `/memory-refresh` | Report the mem-core scope ladder and staleness for the current directory | in-session | `npm run sheep:memory-refresh` |
| `/ingest-docs <path>` | Mine a docs directory into the wing's `reference` room, stamp `es-source-type: doc` (§6.4) | in-session | — |
| `/remind <action> …` | Create / update / close prospective reminders (§6.5) | in-session | — |
| `/reminders [filters]` | Read-only reminder listing; flags active reminders past expiry | subagent | — |
| `/promote-skill <id>` | Copy a project skill into the shared skills wing (§6.6) | in-session | — |

Most take an optional scope argument: `/consolidate context-blocks`.

> `/memory-refresh` reports; it does not re-render. mem-core render happens only inside a
> consolidation run — `/consolidate` is what actually rebuilds it.

> A command can isolate work into a subagent, but it cannot spin up a new *top-level*
> session and switch the TUI to it. For unattended work in a separate process, use the
> `npm run sheep:*` entrypoints or auto-consolidation (§7).

---

## 6. Runtime scripts

### 6.1 Retrieval

```bash
npm run policy:cycle -- \
  --query "recent architecture decisions" \
  --scope-wing context-blocks --scope-room context-blocks \
  --labels pinned --match-mode any --top-n 12
```

Probabilistic entry plus deterministic expansion over scoped lineage, printing a JSON
plan/result payload.

**Intent** (`--intent factual|historical|procedural`) changes what ranks:

- `factual` favours doc-stamped sources, and enforces a hard floor: **a provisional
  synthesis can never outrank a doc.** Doc-stamped drawers in scope enter the ranked pool
  directly, with or without a `concerns` edge.
- `historical` favours syntheses and transcripts.
- `procedural` favours skills, and is the only intent that reaches the shared skills wing
  from another project wing (§6.6).

`--include-docs` turns on direct doc admission for non-factual intents. One-hop `concerns`
neighbours — the authority docs linked to a hit synthesis — come along as grounding either
way.

**Outcome history** is a ranking term: net-positive nodes are boosted, repeated `revise` is
penalised, no history is exactly neutral. It is weighted strictly below authority, and the
factual floor is applied *after* it, so a doc with no history still beats a synthesis with
two accepts.

### 6.2 Consolidation and validation

```bash
npm run policy:consolidate-validate -- \
  --query "memory consolidation candidates" \
  --wing context-blocks --room context-blocks --scope-room context-blocks
```

Runs source-to-derived consolidation (map/reduce with inflation guards) then validation and
merge review, with optional escalation notification.

| Flag | Effect |
|---|---|
| `--apply` | allow derived-drawer creation when checks pass |
| `--apply-merges` | apply auto-merge decisions above the score threshold |
| `--use-live-mapper` / `--mapper-agent <n>` | request mapper summaries via subagent task calls |
| `--use-live-auditor` / `--auditor-agent <n>` | request an auditor verdict over the output |
| `--mem-core-dir` / `--mem-core-scope-dir` / `--mem-core-file` | control the render target |
| `--no-mem-core-auto` | skip the mem-core render (on by default, to `./.electric-shepherd/memory`) |

### 6.3 Cadence

```bash
npm run policy:cadence -- \
  --query "memory consolidation candidates" \
  --wing context-blocks --room context-blocks --scope-room context-blocks \
  --current-idle-minutes 25 --nightly-backstop \
  --cadence-state-file ./.electric-shepherd-cadence-state.json
```

`policy:cadence:execute` runs consolidation+validation for the triggered areas. The state
file carries history across runs.

### 6.4 Doc ingestion

`/ingest-docs <path>` mines a directory into the project wing's `reference` room, reusing an
existing reference-like room before minting one, and stamps every drawer
`es-source-type: doc`.

**Dry-run first:** the first call previews the resolved wing, room, and target path without
writing. On apply, changed files are purged and reinserted under the same drawer IDs
(unchanged files skipped), open outgoing KG facts on changed drawers are invalidated as a
staleness pass, and the doc stamp is reapplied. Partial failures are reported and re-running
converges — every step is idempotent. It never touches `es-status`.

### 6.5 Prospective reminders

Reminders are "remember to do X when Y." They fire into mem-core under a `[pending]` block
when their trigger matches the current scope — a path glob, a topic keyword, or a wing/room.
Pushed by circumstance, not pulled by query.

```
/remind create <condition> <what> --expires <ISO date>
/remind update <drawer_id> <new text and/or --expires ISO>
/remind close  <drawer_id> [satisfied|expired]
/reminders [--status …] [--condition …]
```

**Expiry is required on create.** Dry-run first, as with every write path. Reminders live in
the wing's `reminders` room and never touch `es-status`, source drawers, or synthesis
lineage.

### 6.6 Skill promotion

Skills default to the project wing. Promotion copies one into the shared wing so any
project can reach it. It is **distinct from relocation**: relocation fixes misfiling,
promotion generalises something correctly filed.

`/promote-skill <drawer_id>` copies one skill into the shared skills wing (`shared-skills`,
override with `ESHEPHERD_SHARED_SKILLS_WING`). The source must already carry
`es-source-type: skill`. On apply:

- **Idempotency guard runs first.** An existing `promoted-from` edge in either direction, or
  an exact content match in the shared wing, makes the re-run a no-op.
- **Copy, never move.** The source drawer is untouched; retiring the local copy later via
  `merged-into` is your call.
- **Stamps** the copy `es-source-type: skill` and writes one `promoted-from` edge back to
  the origin. That edge is **not lineage** — it never counts toward height and never feeds
  recursive traversal.

Promotion is proposed, never automatic. A skill present in ≥2 project wings surfaces as a
candidate in `/memory-status`; no threshold silently moves anything.

### 6.7 Recording an outcome

`policy:cycle` output includes an `outcome_proposal` block: a prefilled dry-run
`record_outcome` payload with the run's `selected_nodes` mirrored into `node_ids` and a
generated `cycle_ref`. It is **informational only — the script never writes outcome edges.**

```
1. Run the cycle, note outcome_proposal in the JSON.
2. Set `outcome` to your judgment: accept | revise | failed | unused.
3. Call record_outcome with dry_run: true, read the echoed edges.
4. Re-run with dry_run: false only after you have confirmed them.
```

`record_outcome` is the **only** writer of this axis, and it takes an explicit node-id set —
there is no wing/room/scope write mode, and an empty list is rejected. Test results,
reviewer verdicts, and loop/spiral logs are evidence for your judgment, never writers.

---

## 7. Automatic consolidation

> ⚠️ **This writes to your memory in the background, with no prompt and no confirmation.**
> It can create closets and KG facts and re-render mem-core without you asking. Only enable
> it once you understand the triggers. Everything it does is logged to
> `./.electric-shepherd/turn-guard-status.json` as `type: "auto-consolidation-*"`.

```jsonc
{ "consolidation": { "auto": { "enabled": true } } }
```

Three independently gated triggers:

| Trigger | Fires when | Config | Default |
|---|---|---|---|
| **idle-timer** | The session stays quiet for the full delay. A **debounce, not a schedule** — every new message resets it. Needs ≥1 new turn since the last run. | `auto.onIdle`, `auto.idleDelayMs` | `true`, 2 min |
| **volume** | Enough new assistant turns accumulate; runs eagerly. | `auto.messageThreshold` | `12` |
| **compacted** | The session compacts — a natural consolidation point. | `auto.onCompact` | `true` |

| Throttle | Meaning | Default |
|---|---|---|
| `consolidation.auto.cooldownMs` | minimum gap between runs, counted from run start | 10 min |
| `commands.autoConsolidation.timeoutMs` | watchdog kill, and the staleness window for the cross-process lock | 5 min |
| `commands.autoConsolidation.command` | override the command. Default is deterministic (`--run-cadence --cadence-mode execute --apply`, **no** live mapper) so it never forces a model load | — |
| `commands.sourceCapture.timeoutMs` | ceiling on the blocking capture call | 20 s |
| `commands.memcoreLoader.timeoutMs` | ceiling on the blocking loader call | 15 s |
| `consolidation.auto.maxTrackedSessions` | bound on per-session tracking maps, oldest evicted | 512 |

**Containment**, so a run that starts cannot wedge or orphan:

- An in-flight flag plus a **shared cross-process lockfile** (`auto-consolidation.lock`,
  pid + start time) prevents overlap. The CLI, cron, and n8n entrypoints take the *same*
  lock; the plugin passes `ESHEPHERD_CONSOLIDATION_LOCK_INHERITED=1` to its child so the
  child trusts the parent's. A plugin run and a cron run firing together cannot both proceed.
- A **watchdog** kills anything past the timeout, targeting the whole process tree
  (`taskkill /T` on Windows, process-group signal on POSIX) so a shell-wrapped override
  cannot leave an orphaned grandchild.
- An **orphaned** run's lock goes stale after the timeout window and the next trigger
  reclaims it. The substrate is append-only and the mem-core file is written atomically
  (temp + rename), so a killed run leaves both intact rather than half-written.
- A run that **never starts** (spawn error) rolls back its cooldown stamp. A run that
  started and then failed keeps it, as anti-thrash.

**Prefer an external scheduler?** Leave `auto.enabled=false` and point cron, n8n, or Task
Scheduler at the same entrypoint — the shared lock keeps it from colliding with a plugin run:

```bash
npm run sheep:consolidate-deep   # == policy:cadence:execute --apply --apply-merges
```

> Pass `--no-lock` (or `consolidation.lock.disabled=true`) only when you knowingly want
> concurrent runs, such as isolated test fixtures.

---

## 8. Reference

### 8.1 Memory layers

These map onto MemPalace's **native** layers — Electric Shepherd invents no storage.

| Layer | Native home | Written by consolidation? |
|---|---|---|
| raw transcripts | **drawers** in the `source-transcripts` room, via capture | no — frozen, source of truth |
| ingested docs | **drawers** in the wing's `reference` room, via `/ingest-docs` | no — mined verbatim |
| summaries / arcs | **closets**, pointing back to source | yes |
| durable facts | **KG triples** with `valid_from`/`valid_to` | yes |
| categories | **halls** (`facts` / `events` / `discoveries` / `preferences` / `advice`) | yes, re-assignable |
| lineage | **KG edges** (`synthesized-from`, `consolidated-into`, `merged-into`) | yes |
| mem-core | directory-scoped render files under `.electric-shepherd/memory/` | yes — derived, never hand-authored |

### 8.2 The axes and edges

**`es-source-type`** — `transcript | doc | synthesis | skill`. **Orthogonal to `es-status`**:
where a node came from is independent of how settled it is. Unstamped nodes rank as
`unknown`.

**`es-status`** — `provisional` at creation, promoted to `active` only after validation
confirms ≥2 direct sources. **Retrieval and mem-core render exclude provisional by default.**
Check the provisional-vs-total ratio in `/memory-status`.

**`consolidated-into`** (`{source drawer → closet}`) — the **only** signal that a source has
been consumed. Without it the next pass re-processes the same transcript, because
`synthesized-from` points the other way and leaves the source looking untouched.
Consolidation status is a graph question: answer it with `kg_query`, never by reading
content.

**`concerns`** (`{synthesis → doc}`) — grounding, created by `propose_concerns` as an
approval-gated proposal. It validates both endpoints, rejects self-links and duplicates,
prints a numbered list, and applies only what you approve.

**`rules-out`** — dead ends. The mapper extracts approaches that were tried and failed or
considered and rejected, each with its outcome clause. **A line without an outcome must not
be filed**: "we tried X" reads as advice without "and it does not work, because Y." Dead
ends are stored as negative-polarity syntheses (never a fourth source type), the edge is
one-hop and never counts toward height, and retrieval labels them `[RULED OUT …]` without
re-ranking.

**`es-outcome`** — `accept | revise | failed | unused`, written only by `record_outcome`
(§6.7). Edges **accumulate**; six accepts and one revise is meaningfully different from one
accept, and nothing collapses them. `/memory-status` surfaces closets with `revise >= 2` and
`revise > accept` over a recent window as re-synthesis candidates.

**`promoted-from`** — skill promotion provenance (§6.6). Not lineage.

### 8.3 mem-core scope

The injected mem-core is **location-based and works upward**:

1. **Start** from the session event's working directory, then `memcore.scopeDir`, then
   OpenCode's launch directory, then process cwd — first one that exists wins.
2. **File-follow.** If recent messages reference a concrete file — attached, or a path in
   the text — scope follows that file's directory instead. Working on a file tracks where
   that file lives.
3. **Walk up and merge broad→narrow.** From there the loader walks to the project root
   (nearest `package.json` or `.git`), merging every `memory.md` on the way plus the matching
   `.electric-shepherd/memory/<relative-scope>/memory.md` store files. Root first, current
   directory last, so narrow context wins ties.

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

Render toggles:

| Env var | Default | Effect |
|---|---|---|
| `ESHEPHERD_MEMCORE_RENDER_INCLUDE_PENDING` | `true` | the `[pending]` reminders block |
| `ESHEPHERD_MEMCORE_RENDER_INCLUDE_DEAD_ENDS` | `true` | the `[dead-ends]` block |
| `ESHEPHERD_MEMCORE_RENDER_MAX_DEAD_ENDS` | `3` | cap on dead-end bullets per scope (0 disables) |

An empty list omits the section entirely.

`docs/memory-blocks.reference.md` shows the render shape. mem-core never round-trips into
drawers and is never hand-authored; force a canonical rebuild with
`npm run policy:mem-core:rebuild`.

---

## 9. Tests

**The default verification command is `npm test`, and it collects the full suite — unit and
integration.** Completion claims cite `npm test` (or its alias `npm run test:all`), never a
narrower script.

```bash
npm test

export ESHEPHERD_TEST_INTEGRATION=1
npm run test:integration    # integration alone, gate open
npm run test:unit           # unit only, when you specifically want it
npm run verify:structural   # the layer-boundary checks
```

Integration tests exercise the adapters against a real MemPalace MCP endpoint, gated behind
`ESHEPHERD_TEST_INTEGRATION=1`. They read `mcp.url` from `eshepherd-config.jsonc` (or
`MEMPALACE_MCP_URL` if you deliberately override in env), and need the full tool surface:
lineage traversal, scoped-node lookup, single and bulk delete. Without the gate they are
collected and self-skip, so `npm test` stays offline.

The suite seeds a disposable per-run room in the `eshepherd-test` wing and deletes exactly
the drawers it created on teardown. It never touches live wings.

**CI** (`.github/workflows/ci.yml`) always runs `npm test`. If `MEMPALACE_MCP_URL` is set as
a repository variable or secret, integration runs against it; otherwise CI starts an
ephemeral local MemPalace MCP server at `http://127.0.0.1:8093/mcp` and tears it down at the
end. Either way the integration step runs with the gate open.
