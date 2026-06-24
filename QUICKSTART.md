# Electric Shepherd — Quick Start

Electric Shepherd is the **policy layer** for memory consolidation. It decides when to
consolidate, what to merge, and how to synthesize. MemPalace is the **substrate** — store,
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
that enables the plugin. `agent-discipline.md` (the full agent ruleset) and `memory-blocks.md`
(the always-loaded mem-core render artifact) are appended to `instructions` automatically.

### 1a. Asset loading matrix

ElectricShepherd is a plugin, so it loads the same way wherever it is enabled. The plugin's
`config` hook reads its bundled markdown at startup and injects it into the resolved config:

- Plugin: yes — via `plugin: ["electric-shepherd"]`
- Agents (`agents/*.md`): yes — injected into `config.agent` by the `config` hook
- Commands (`command/*.md`): yes — injected into `config.command` by the `config` hook
- Instructions (`instructions/*.md`): yes — absolute paths appended to `config.instructions`
  (opt out with `ESHEPHERD_INJECT_INSTRUCTIONS=false`)

Not config-injectable:

- Skills (`skills/*/SKILL.md`): OpenCode has no skill config key — place a copy under your own
  `.opencode/skills/<name>/SKILL.md` if you want it auto-discovered
- Snippets (`snippets/*.md`): OpenChamber snippet assets, not an OpenCode auto-load concept

> Why the hook is needed: OpenCode only auto-discovers `agents/` / `command/` / `skills/`
> folders for the active **project** root. An installed plugin is never the project root, so
> folder discovery never fires for it — the `config` hook is what makes the bundled assets load
> like the rest of the plugin. User-defined agents/commands with the same name always override
> the bundled ones.

## 1b. Local env setup

Create your machine-local env file from the tracked template:

```bash
cp .env.example .env
```

Runtime scripts auto-load env files in this order:

1. `ESHEPHERD_ENV_FILE` (if set)
2. `./.env` and `./.env.local` in ElectricShepherd root
3. fallback: `../docker/.env` (for monorepo setups)

No manual `source .env` step is required.

Optional explicit override:

```bash
export ESHEPHERD_ENV_FILE="/absolute/path/to/your.env"
```

## 1c. Quick sanity check

Before trying the heavier policy flows, run:

```bash
npm test
npm run policy:mem-core:load -- --format markdown
```

If the unit suite fails, fix the local Node/runtime issue first; the mem-core loader
check is a lightweight way to confirm the scoped loader path is wired correctly.

## 2. Set the tool prefix

MemPalace tool names vary by how MemPalace is registered with your MCP host:

| Registration | Tool name shape | Correct `MEMGRAPH_TOOL_PREFIX` |
|---|---|---|
| Direct MCP at `:8093` | `mempalace_search` | `mempalace_` *(default, no action needed)* |
| Namespaced gateway | `<namespace>mempalace_search` | `<namespace>mempalace_` |

For agent prompts (the dreamer and mapper subagents) you also need to state the full
prefix in any agent prompt that calls MemPalace tools directly, or load `skills/mempalace/SKILL.md`
as an additional instruction so the agent knows which names to use.

For the TypeScript adapter (`adapter/memgraph.ts`), set the env var in your shell
profile or in the environment passed to the process:

```bash
# Set this only when your gateway rewrites tool names.
# Example for namespaced tools: export MEMGRAPH_TOOL_PREFIX="mygateway_mempalace_"
```

For standalone runtime scripts (`policy:cycle`, `policy:consolidate-validate`,
`policy:cadence`) on authenticated MCP endpoints, set MCP auth via env:

```bash
export MEMPALACE_MCP_URL="http://your-mcp-endpoint/mcp"
# Generic API key/token value
export MEMPALACE_MCP_API_KEY="<your-key-or-token>"
# Optional: force auth header name (default: Authorization)
# export MEMPALACE_MCP_AUTH_HEADER="Authorization"
# Optional: prepend a scheme (for example Bearer)
# export MEMPALACE_MCP_AUTH_SCHEME="Bearer"
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

## 3b. Run consolidation + validation pipeline

```bash
npm run policy:consolidate-validate -- \
  --query "memory consolidation candidates" \
  --wing context-blocks \
  --room context-blocks \
  --scope-room context-blocks
```

This runs:
- **Synthesis consolidation:** map/reduce-style synthesis proposal with deterministic inflation guard checks.
- **Validation + merge review:** downward validation, merge adjudication, and optional escalation notification.

Add `--apply` to allow synthesis-node creation when checks pass.
Add `--apply-merges` to apply auto-merge decisions above configured score threshold.

Optional integration flags:
- `--use-live-mapper` and `--mapper-agent <name>` to request mapper summaries via subagent task calls.
- `--use-live-auditor` and `--auditor-agent <name>` to request an auditor verdict over consolidation + validation output.
- mem-core is auto-rendered by default to `./eshepherd/memory` (or `./memory` if that already exists).
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

## 3d. Enable tier-enforcement plumbing

The plugin now wires deterministic events directly:

- mem-core re-injection on `session.compacted`, `session.started`, and scope drift observed during `session.idle`
- scope-aware loader calls through `scripts/run-mem-core-loader.ts`
- write-authority guard for synthesis writes (`create_synthesis_node`, `apply_merge`)
- OpenCode mem-raw capture verification heartbeat

Recommended environment settings:

```bash
export ESHEPHERD_MEMCORE_REINJECT_ENABLED=true
export ESHEPHERD_MEMCORE_REINJECT_ON_COMPACT=true
export ESHEPHERD_MEMCORE_REINJECT_ON_IDLE=true
export ESHEPHERD_MEMCORE_REINJECT_ON_START=true
export ESHEPHERD_ALLOWED_SYNTH_WRITERS="dreamer,dream-consolidator"
export ESHEPHERD_MEMRAW_VERIFY_ENABLED=true
# Required: full MCP endpoint URL used for mem-raw verification/capture.
export MEMPALACE_MCP_URL="http://your-mcp-endpoint/mcp"
# Optional auth controls for capture pipeline:
# export MEMPALACE_MCP_API_KEY="<your-key-or-token>"
# export MEMPALACE_MCP_AUTH_HEADER="Authorization"
# export MEMPALACE_MCP_AUTH_SCHEME="Bearer"
# export MEMPALACE_MCP_HEADERS_JSON='{"X-Api-Key":"<your-key>"}'
# Optional tool prefix for capture endpoint (default: mempalace_):
# export ESHEPHERD_MEMRAW_TOOL_PREFIX="mempalace_"
# Optional duplicate suppression (default false keeps mem_raw append-only):
# export ESHEPHERD_MEMRAW_DEDUP_ENABLED=true
# Optional capture command on stop/compact events:
# export ESHEPHERD_MEMRAW_CAPTURE_CMD="bash ./scripts/capture-memraw.sh"
```

Plugin status/verification output is written to `./.electric-shepherd/turn-guard-status.json`.

## 3f. Automatic synthesis ("count sheep in the background") — OPT-IN

> ⚠️ **This is OFF by default and writes to your memory in the background.**
> When enabled, the plugin will spawn the deterministic consolidation script on
> its own (no prompt, no confirmation) after the session goes quiet, after enough
> new turns accumulate, or after compaction. It can create synthesis nodes and
> re-render your mem-core files without you asking. **Only turn this on once you
> understand the triggers below.** Everything it does is logged to
> `./.electric-shepherd/turn-guard-status.json` (`type: "auto-synth-*"` entries).

Enable it deliberately:

```bash
export ESHEPHERD_AUTO_SYNTH_ENABLED=true        # master switch (default: false)
```

It triggers on three conditions, each independently gated:

| Trigger | Fires when | Env var(s) | Default |
|---|---|---|---|
| **idle-timer** | The session stays quiet for the full delay after going idle. The timer is **reset every time you send a new message**, so it only fires once the session has *actually* been left alone — it is a debounce, not a fixed schedule. Requires ≥1 new turn since the last run. | `ESHEPHERD_AUTO_SYNTH_ON_IDLE`, `ESHEPHERD_AUTO_SYNTH_IDLE_DELAY_MS` | `true`, `120000` (2 min) |
| **volume-threshold** | Enough new assistant turns accumulate; runs eagerly without waiting. | `ESHEPHERD_AUTO_SYNTH_MESSAGE_THRESHOLD` | `12` |
| **compacted** | The session is compacted (a natural consolidation point). | `ESHEPHERD_AUTO_SYNTH_ON_COMPACT` | `true` |

Shared throttles and overrides:

| Env var | Meaning | Default |
|---|---|---|
| `ESHEPHERD_AUTO_SYNTH_COOLDOWN_MS` | Minimum time between auto-synth runs (counted from when a run starts). | `600000` (10 min) |
| `ESHEPHERD_AUTO_SYNTH_TIMEOUT_MS` | Watchdog: a run exceeding this is killed, and the in-flight flag/lock is released. Also the staleness window for the cross-process lock. | `300000` (5 min) |
| `ESHEPHERD_AUTO_SYNTH_CMD` | Override the command that is run. The default is deterministic (`--run-cadence --cadence-mode execute --apply`, **no** live mapper) so it never forces a model to load. | deterministic script |
| `ESHEPHERD_MEMRAW_CAPTURE_TIMEOUT_MS` | Ceiling for the blocking mem-raw capture call so a hung script can't freeze the session. | `20000` |
| `ESHEPHERD_MEMCORE_LOADER_TIMEOUT_MS` | Ceiling for the blocking mem-core loader call. | `15000` |

How the timer actually works (the important bit): OpenCode emits a `session.idle`
event when the conversation stops. On that event the plugin **arms** a real
`setTimeout` for `ESHEPHERD_AUTO_SYNTH_IDLE_DELAY_MS`. If you send another message
before it fires, the next `message.updated` **clears** the timer — so the delay is
genuinely "quiet for N ms," and any new activity overrides it.

Failure containment (so a run that begins can't get stuck or orphaned):
- A single in-flight flag plus a **shared cross-process lockfile**
  (`.electric-shepherd/auto-synth.lock`, pid + start time) prevent overlapping
  runs. The **same lock is taken by the CLI/cron/n8n entrypoint too** — when the
  plugin spawns the script it passes `ESHEPHERD_SYNTH_LOCK_INHERITED=1` so the
  child trusts the parent's lock, while a standalone `sheep:*` / cron run acquires
  the lock itself. So a plugin run and a cron run firing at the same instant
  cannot both proceed.
- A **watchdog** kills any run that exceeds `ESHEPHERD_AUTO_SYNTH_TIMEOUT_MS`, so a
  hung MCP endpoint can never wedge auto-synth permanently. The kill targets the
  **whole process tree** (`taskkill /T` on Windows, process-group signal on
  POSIX), so a shell-wrapped `ESHEPHERD_AUTO_SYNTH_CMD` can't leave an orphaned
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
  `ESHEPHERD_AUTO_SYNTH_MAX_TRACKED_SESSIONS` (default 512, oldest evicted first)
  so a long-lived process can't leak memory across many sessions.

The deterministic script re-renders mem-core, which the existing mem-core
re-injection then picks up on the next idle/compaction — closing the loop.

**Prefer an external scheduler?** Auto-synth is entirely optional. You can leave
`ESHEPHERD_AUTO_SYNTH_ENABLED=false` and instead have n8n, cron, or Windows Task
Scheduler call the same entrypoint on a timer — there is no coupling, and the
shared lock keeps a scheduled run from colliding with a plugin run:

```bash
npm run sheep:lucid-dream   # == policy:cadence:execute --apply --apply-merges
```

> Testing/automation note: pass `--no-lock` (or set
> `ESHEPHERD_SYNTH_LOCK_DISABLED=1`) to bypass the shared lock when you knowingly
> want concurrent runs (e.g. isolated test fixtures).

## 3g. Playful commands

These are OpenCode slash-commands defined in `command/*.md` in this repo and
discovered via `OPENCODE_CONFIG_DIR` (the same mechanism that loads the agents in
`agents/`). OpenCode recognises both a `command/` and a `commands/` directory —
this repo uses the singular `command/`.

The commands are **prompts**, not raw script calls — each markdown template is sent
to the `dreamer` agent. To keep an aside about memory from polluting the codebase
session you are in, the consolidation commands run as **isolated subagents**
(`subtask: true`): the dreamer works in its own context and only a short summary
returns to your session (expand the subtask in the TUI to watch/debug it). The one
exception is `/wake-up`, which deliberately runs **in-session** (`subtask: false`)
because its whole purpose is to refresh the *current* session's memory.

| Command | Does | Isolation | CLI / scheduler equivalent |
|---|---|---|---|
| `/count-sheep` | Standard consolidation: synthesize pending raw memories into synthesis nodes (additive only). | isolated subagent | `npm run sheep:count` |
| `/herd` | Round-up/preview: list what is pending and what *would* consolidate — read-only, no writes. | isolated subagent | `npm run sheep:herd` |
| `/lucid-dream` | Deep pass: consolidate **plus** merge/dedupe existing synthesis nodes and run a drift audit. | isolated subagent | `npm run sheep:lucid-dream` |
| `/wake-up` | Refresh and re-inject mem-core for the current scope. | in-session | `npm run sheep:wake-up` |
| `/headcount` | Quick counts of pending raw vs existing synthesis memories. | isolated subagent | — |

Each command takes an optional scope argument, e.g. `/count-sheep context-blocks`.

> Note on "a different session": OpenCode commands can isolate work into a
> subagent (above), which gives you the no-pollution benefit. They cannot, on
> their own, spin up a brand-new *top-level* session and switch the TUI to it —
> that is a manual action. For unattended consolidation in a truly separate
> process, use the `npm run sheep:*` CLI entrypoints (or auto-synth) instead.

## 3e. Running tests

Unit tests run fully offline:

```bash
npm test
```

Integration tests exercise the adapters against a real MemPalace MCP endpoint
and are gated behind `ESHEPHERD_TEST_INTEGRATION=1`. They use `MEMPALACE_MCP_URL`
from your env file — the configured endpoint must expose the full tool surface
(synthesis-graph traversal, scoped-node lookup, single/bulk delete).

```bash
export ESHEPHERD_TEST_INTEGRATION=1
npm run test:integration   # or: npm run test:all
```

GitHub Actions wiring:

- `.github/workflows/ci.yml` always runs `npm test`.
- If `MEMPALACE_MCP_URL` is configured as a repository variable/secret, CI uses
  that endpoint for integration suites.
- If no endpoint is configured, CI starts an ephemeral local MemPalace MCP
  server in the job, points tests at `http://127.0.0.1:8093/mcp`, and tears it
  down at the end of the run.
- In both cases, the integration step runs with
  `ESHEPHERD_TEST_INTEGRATION=1`.

The suite seeds a disposable per-run room in the `eshepherd-test` wing and
deletes exactly the drawers it created on teardown, so it never touches live wings.

## 4. Memory tiers at a glance

| Tier | Role | Location | Writable by dreamer? |
|---|---|---|---|
| **mem-raw** | Append-only verbatim transcripts | diary room, tagged by session | No — source of truth |
| **mem-synth** | Synthesized searchable memory | drawers / kg / worked-examples | Yes — dreamer's working surface |
| **mem-core** | Always-loaded working set | directory-scoped rendered memory files (`eshepherd/memory` or `memory`) | Yes — auto-updated render |

## 4b. How mem-core scope is chosen

The mem-core that gets injected into a session is **location-based**, and it
**works upward** from that location:

1. **Starting point.** The plugin resolves a scope directory from the session
   event (working directory / `cwd`), then `ESHEPHERD_SCOPE_DIR`, then the
   directory OpenCode was launched in, then the process cwd — the first one that
   exists wins.
2. **File-follow override.** If your recent messages reference a concrete file
   (an attached file part or a path in the text), the scope **follows that file's
   directory** instead. So when you're actively working on a file, mem-core tracks
   wherever that file lives.
3. **Walk upward + merge broad→narrow.** From that directory, the loader walks
   **up to the project root** (the nearest folder with `package.json`/`.git`) and
   merges every `memory.md` it finds along the way — plus the matching
   `eshepherd/memory/<relative-scope>/memory.md` store files — ordered broad
   (root) first, narrow (current directory) last. So you always get the project's
   top-level memory *plus* every intermediate folder *plus* the current folder.

Knobs:

```bash
export ESHEPHERD_SCOPE_DIR="/absolute/scope/dir"   # force the starting point
export ESHEPHERD_MEMCORE_MAX_SCOPES=6              # cap how many scope levels merge (default 6)
export ESHEPHERD_MEMCORE_STORE_ROOTS="eshepherd/memory,memory"
export ESHEPHERD_MEMCORE_MAX_CHARS=12000           # clip the merged payload
```

## 5. Updating mem-core

`instructions/memory-blocks.md` is a shape/example for scoped mem-core render output.
Runtime + plugin wiring keep live mem-core in sync by deriving it from mem-synth:

1. The runtime auto-writes a scoped `memory.md` render under `eshepherd/memory/<directory-scope>/memory.md` (or `memory/<directory-scope>/memory.md` when `memory` already exists).
2. The loader composes broad-to-local memory layers by directory scope (`npm run policy:mem-core:load -- --format markdown`).
3. The plugin re-injects scoped mem-core on compaction/start and when scope drifts during idle.

mem-core does not round-trip into MemPalace drawers and is not hand-authored. Human audit focus remains mem-synth consistency and label/pin tuning.

## 6. Snippets

| Snippet | When to use |
|---|---|
| `snippets/memload.md` | Session start when context is uncertain |
| `snippets/memsave.md` | Before ending substantial work |
| `skills/mempalace/SKILL.md` | When doing intensive memory work (add to instructions temporarily) |

## Architecture reference

`docs/memory-graph-design.md` is the authoritative architecture document. Build order,
substrate/policy boundary, and synthesis-height DAG design are all there.
Do not treat this file as architecture authority; it is a setup checklist.
