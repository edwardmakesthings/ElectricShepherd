# Electric Shepherd 🐑⚡

> *Do androids dream of electric sheep?*

Electric Shepherd tends your AI memory while you sleep. It consolidates raw conversation
transcripts into closets and lineage facts, prunes what's stale, connects what's
related, and keeps your AI coding assistant from re-deriving the same things every session.

Built on [MemPalace](https://github.com/MemPalace/mempalace) as the memory substrate.
Designed for [OpenCode](https://opencode.ai) as the agent harness, distributable as an
npm package for one-line install. The deterministic adapter + retrieval policy runtime can be run locally
with Node against MemPalace MCP — no cloud, no API bills.

Current repo status: core policy runtime is in place (plugin, commands, snippets,
adapter, deterministic runtime scripts, and dreamer agent profiles), with
compaction-aware scoped mem-core reinjection, opt-in auto-consolidation, and bounded
MCP/notification timeouts wired. The runtime also now rejects unsafe shell-style
commands for the turn-guard subprocess path.

---

## What it does

Your AI coding sessions produce raw transcripts. MemPalace already mines and stores these
verbatim (that's its job). Electric Shepherd works *above* that layer:

- **Consolidates** raw transcripts into derived memory — durable decisions, root causes,
  worked examples — written as **closets** (summaries/arcs) and **KG triples** (durable facts),
  linked back to source drawers with explicit lineage edges.
- **Connects** related memories across sessions that were written separately, building the
  cross-session links no single session could see.
- **Prunes** what's stale — memories that haven't been retrieved or touched fade as
  candidates for archival.
- **Validates** that lineage and merge connections actually hold, bidirectionally.
- **Notifies** you (via ntfy or similar) when something needs human judgment rather than
  silently guessing.

The result: your AI assistant starts each session knowing what was decided, what was built,
and what was learned — not because you re-explained it, but because Electric Shepherd
maintained it overnight (or when idle).

---

## How it relates to MemPalace

MemPalace stores verbatim content and retrieves it — it never paraphrases or transforms.
Electric Shepherd respects that invariant completely **and builds entirely out of MemPalace's
own native layers** rather than inventing parallel structures:

- **Raw transcripts** stay as drawers — frozen, never altered.
- **Summaries and arcs** are written as **closets** (MemPalace's native revisable summary
  layer that points back to source).
- **Durable facts** are written as **KG triples** with validity windows, so a fact that
  changes is superseded with history (`kg_invalidate` the old, `kg_add` the new) — a native
  changelog.
- **Categories** use the native **halls** (`facts` / `events` / `discoveries` /
  `preferences` / `advice`).
- **Relationships** (`synthesized-from`, `merged-into`) live in MemPalace's existing knowledge
  graph.

Electric Shepherd is a client of MemPalace, not a fork of it.

### Non-invasive by design

Because every artifact Electric Shepherd creates is a *native MemPalace object*, two things
follow that most memory-augmentation tools can't promise:

- **It works with whatever's already in your palace.** No migration, no schema conversion, no
  "import your memories into our model." Point it at an existing populated palace and it starts
  organizing from there.
- **Removing it leaves your palace fully intact.** Stop running Electric Shepherd and MemPalace
  carries on exactly as before — just less organized. The closets, triples, hall assignments,
  and connections it created remain valid native MemPalace data. Nothing depends on it
  continuing to run.

> **Note:** The optional substrate fork adds two primitives MemPalace lacks natively —
> retrieval counters (read-tracking) and recursive lineage traversal. Electric Shepherd uses
> them when present and degrades gracefully without them (existing data stays valid; only
> read-tracking and deep-lineage queries are affected). If you want the full feature set,
> run the forked substrate; if not, the core organizing still works against stock MemPalace.

---

## Install

**As an OpenCode package (recommended):**

Add to your `opencode.json`:

```json
{
  "plugin": ["electric-shepherd"]
}
```

OpenCode resolves this package on startup. This repo currently provides:
- The `turn-guard` plugin (checkpoint + stop-quality retry + compaction-aware mem-core reinjection + scope-aware loader wiring + write-authority/capture guards)
- Dreamer agent profiles (`dreamer`, `dream-consolidator`, `dream-mapper`, `dream-auditor`)
- Slash commands in `command/` (`/count-sheep`, `/herd`, `/lucid-dream`, `/wake-up`, `/headcount`) for consolidation workflows
- The `memsave` / `memload` OpenChamber snippets
- The memory discipline instruction plus runtime-derived mem-core renders under `.electric-shepherd/memory/`

**Policy runtime (separate — runs headless, not inside OpenCode):**

```bash
npm install -g electric-shepherd
# or via the repo directly:
git clone https://github.com/edwardmakesthings/electric-shepherd
cd electric-shepherd
npm install
```

---

## Setup

### 0. Config layering (important)

OpenCode merges config layers; it does not replace one with another. In practice:

- Global defaults come from `~/.config/opencode/opencode.jsonc`.
- Project overrides come from `opencode.jsonc` in this repo.

ElectricShepherd ships a project-level `opencode.jsonc` that only enables the plugin. The
plugin self-provides its agents, slash commands, and instruction rules (see below), so the
project config stays minimal while preserving your global defaults.

### 1. Enable the plugin (everything else comes with it)

In your `opencode.json`:

```json
{
  "plugin": ["electric-shepherd"]
}
```

That single line is enough. On startup the plugin's `config` hook injects its bundled agents,
slash commands, and instruction rules into your resolved OpenCode config, so they load in any
project that enables the plugin — no need to run OpenCode from inside this repo, copy files into
`.opencode/`, or list anything under `agent` / `command` / `instructions` yourself.

User-defined entries always win: if you declare an agent or command with the same name, yours
overrides the bundled one. Opt out of instruction injection with `ESHEPHERD_INJECT_INSTRUCTIONS=false`.

### What loads automatically vs. what is provided

ElectricShepherd is a plugin, so it loads the same way wherever it is enabled — you do **not**
need to run OpenCode from inside this repo. The plugin's `config` hook reads its bundled
markdown files at startup and injects them into the resolved config:

| Asset | Bundled | Auto-loaded in any consumer project | Mechanism |
|---|---|---|---|
| Plugin (`plugin/turn-guard.ts`) | Yes | Yes | `"plugin": ["electric-shepherd"]` |
| Agents (`agents/*.md`) | Yes | Yes | Injected into `config.agent` by the plugin's `config` hook |
| Commands (`command/*.md`) | Yes | Yes | Injected into `config.command` by the plugin's `config` hook |
| Instructions (`instructions/agent-discipline.md`) | Yes | Yes | Absolute paths appended to `config.instructions` (opt out: `ESHEPHERD_INJECT_INSTRUCTIONS=false`) |
| Skills (`skills/*/SKILL.md`) | Yes | No | OpenCode has no config-injection path for skills — place in your own `.opencode/skills/<name>/SKILL.md` if you want it |
| Snippets (`snippets/*.md`) | Yes | No | OpenChamber snippet assets; not an OpenCode auto-load concept |

Why the hook is needed: OpenCode only auto-discovers `agents/` / `command/` / `skills/` folders
for the active **project** (git/cwd root). An installed plugin is never the project root, so
folder discovery never fires for it — the `config` hook is what makes the bundled assets load
like the rest of the plugin. Each agent and command stays in its own standalone markdown file.

### 2. The dreamer agent profiles

The dreamer profiles in `agents/` are markdown agent files that the plugin injects automatically
— no `opencode.json` edits required:
- `agents/dreamer.md`
- `agents/dream-consolidator.md` (alias profile)
- `agents/dream-mapper.md`
- `agents/dream-auditor.md`

### 3. Run deterministic retrieval expansion

```bash
npm run policy:cycle -- \
  --query "recent architecture decisions" \
  --scope-room context-blocks \
  --scope-wing context-blocks \
  --labels pinned \
  --match-mode any \
  --top-n 12
```

This executes probabilistic-entry + deterministic-expansion using MemPalace substrate
tools through the Electric Shepherd adapter and prints a JSON plan/result payload.

---

## Local validation

After installing dependencies, the quickest sanity check is:

```bash
npm test
npm run policy:mem-core:load -- --format markdown
npm run policy:mem-core:rebuild
```

The first command exercises the unit suite; the second confirms the mem-core loader
path works without requiring a live model. The rebuild command writes canonical
scoped mem-core to `.electric-shepherd/memory/memory.md`.

---

## Project layout

```
electric-shepherd/
├── plugin/
│   └── turn-guard.ts          # OpenCode plugin: retry/checkpoint + mem-core injection + authority/capture guards
├── agents/
│   ├── dreamer.md             # primary dream orchestrator profile
│   ├── dream-consolidator.md  # alias profile name used by some setups
│   ├── dream-mapper.md        # per-transcript subagent (isolated context)
│   └── dream-auditor.md       # validator subagent (bidirectional coherence check)
├── command/
│   ├── count-sheep.md         # standard consolidation slash command
│   ├── herd.md                # read-only consolidation preview slash command
│   ├── lucid-dream.md         # deep consolidation+merge slash command
│   ├── wake-up.md             # in-session scoped mem-core refresh slash command
│   └── headcount.md           # pending source-vs-derived counts slash command
├── instructions/
│   ├── agent-discipline.md    # agent behavior rules and guardrails
├── eshepherd/
│   └── memory/
│       └── memory.md          # canonical runtime-rendered mem-core output
├── skills/
│   └── mempalace/SKILL.md     # optional deep reference for MemPalace tool usage
├── snippets/
│   ├── memsave.md             # OpenChamber snippet: manual checkpoint
│   └── memload.md             # OpenChamber snippet: session-start recall
├── adapter/
│   └── memgraph.ts            # Thin adapter: maps Electric Shepherd ops →
│                              #   MemPalace tool names (insulated from upstream renames)
│   └── retrieval-expansion.ts # deterministic ranking/selection over scoped lineage
├── scripts/
│   └── run-policy-cycle.ts    # Runtime entrypoint for deterministic policy cycle
├── docs/
│   └── memory-graph-design.md # architecture and build-order source of truth
│   └── memory-blocks.reference.md # reference/example render shape (not injected)
├── package.json
└── README.md
```

---

## Configuration

All configuration is optional — defaults work out of the box.

| Env var | Default | Description |
|---|---|---|
| `ESHEPHERD_ENV_FILE` | unset | Optional explicit env file path override for runtime scripts |
| `MEMPALACE_MCP_URL` | `http://localhost:8093/mcp` | MemPalace MCP endpoint |
| `MEMPALACE_MCP_API_KEY` | unset | Optional API key header value for MCP gateway auth |
| `MEMPALACE_MCP_AUTH_HEADER` | `Authorization` | Header name used when sending API key/bearer auth |
| `MEMPALACE_MCP_AUTH_SCHEME` | unset | Optional auth scheme prefix (for example `Bearer`) |
| `MEMPALACE_MCP_BEARER_TOKEN` | unset | Optional bearer token (alternate to API-key header style) |
| `MEMPALACE_MCP_HEADERS_JSON` | unset | Optional JSON map of additional MCP HTTP headers |
| `MEMGRAPH_TOOL_PREFIX` | `mempalace_` | Prefix for MemPalace tools (set only if your gateway rewrites tool names) |
| `NTFY_URL` | unset | ntfy endpoint for escalation notifications |
| `ESHEPHERD_SOURCE_CAPTURE_TOOL_PREFIX` | `mempalace_` | Optional tool prefix override for source-transcript capture path |
| `ESHEPHERD_SOURCE_CAPTURE_DEDUP_ENABLED` | `false` | Optional capture dedupe gate (default keeps source-transcript capture append-only) |
| `ESHEPHERD_MEMCORE_REINJECT_ENABLED` | `true` | Enable plugin-driven scoped mem-core reinjection |
| `ESHEPHERD_MEMCORE_REINJECT_ON_COMPACT` | `true` | Force mem-core reload after `session.compacted` |
| `ESHEPHERD_MEMCORE_REINJECT_ON_IDLE` | `true` | Reinject when scope/content changed during idle checks |
| `ESHEPHERD_MEMCORE_REINJECT_ON_START` | `true` | Prime scoped mem-core when a session starts |
| `ESHEPHERD_SCOPE_DIR` | unset | Optional fixed scope directory override for reinjection |
| `ESHEPHERD_MEMCORE_DIRECT_FILE` | `memory.md` | Direct per-directory mem-core filename used by loader wiring |
| `ESHEPHERD_MEMCORE_STORE_ROOTS` | `.electric-shepherd/memory` | Store roots consulted by loader wiring |
| `ESHEPHERD_MEMCORE_MAX_SCOPES` | `6` | Max broad→narrow scopes merged by reinjection loader |
| `ESHEPHERD_MEMCORE_MAX_CHARS` | `12000` | Character cap for injected mem-core payload |
| `ESHEPHERD_CONSOLIDATION_WRITE_GUARD_ENABLED` | `true` | Alert on non-dreamer calls to derived-memory write tools |
| `ESHEPHERD_ALLOWED_CONSOLIDATION_WRITERS` | `dreamer,dream-consolidator` | Allowed agent identities for consolidation writes |
| `ESHEPHERD_SOURCE_CAPTURE_VERIFY_ENABLED` | `true` | Emit OpenCode source-transcript capture verification status |
| `ESHEPHERD_SOURCE_CAPTURE_CMD` | unset | Optional command run on stop/compact verification events |
| `ESHEPHERD_SOURCE_CAPTURE_TIMEOUT_MS` | `20000` | Timeout ceiling for blocking source-transcript capture subprocess |
| `ESHEPHERD_MEMCORE_LOADER_TIMEOUT_MS` | `15000` | Timeout ceiling for blocking mem-core loader subprocess |
| `ESHEPHERD_AUTO_CONSOLIDATION_ENABLED` | `false` | Master switch for background auto-consolidation |
| `ESHEPHERD_AUTO_CONSOLIDATION_ON_IDLE` | `true` | Trigger auto-consolidation after idle debounce window |
| `ESHEPHERD_AUTO_CONSOLIDATION_ON_COMPACT` | `true` | Trigger auto-consolidation after compaction |
| `ESHEPHERD_AUTO_CONSOLIDATION_IDLE_DELAY_MS` | `120000` | Idle debounce delay before idle-triggered run |
| `ESHEPHERD_AUTO_CONSOLIDATION_MESSAGE_THRESHOLD` | `12` | Assistant-turn volume trigger threshold |
| `ESHEPHERD_AUTO_CONSOLIDATION_COOLDOWN_MS` | `600000` | Minimum gap between auto-consolidation run starts |
| `ESHEPHERD_AUTO_CONSOLIDATION_TIMEOUT_MS` | `300000` | Watchdog timeout and stale-lock reclaim window |
| `ESHEPHERD_AUTO_CONSOLIDATION_MAX_TRACKED_SESSIONS` | `512` | Max tracked sessions in auto-consolidation state maps (oldest evicted first) |
| `ESHEPHERD_AUTO_CONSOLIDATION_CMD` | unset | Optional override command for auto-consolidation execution |
| `ESHEPHERD_CONSOLIDATION_LOCK_DISABLED` | unset | Test-only bypass for shared consolidation lock (`1` disables lock) |

Local env workflow:

- Repo template: `.env.example`
- Your machine-specific values: `.env` (ignored by git)
- Auto-discovery order: `ESHEPHERD_ENV_FILE` -> `./.env` + `./.env.local` -> `../docker/.env`
- No manual `source` step required

For trigger semantics and operational caveats, see QUICKSTART section 3f.

---

## Architecture

Consolidation is **a script that owns the loop, with the model as a stateless judgment
function** — not an agent orchestrating the pass. A deterministic script enumerates the
worklist (raw memories not yet synthesized), then calls the model per bounded step:
categorize (assign a native hall), summarize, judge connections. The script writes the
results; the model only judges. This keeps each model call small and isolated, so the pass
never fills a context and compacts before finishing — the failure mode of the earlier
agent-driven design.

Derived memory stays native to MemPalace: **closets** for summaries and arcs, **KG triples**
for durable facts (with `valid_from`/`valid_to` history) and for `synthesized-from` /
`merged-into` lineage, **halls** for categories, and recursive KG traversal for graph
operations. Raw drawers are never altered. A context-isolated `dream-auditor` step provides
bidirectional coherence validation over what was produced.

---

## Why "Electric Shepherd"?

Philip K. Dick asked whether androids dream of electric sheep — whether artificial minds
have inner life. Electric Shepherd is the closest practical answer: a process that tends
your AI's memories while it rests, consolidating the day's experience into something more
refined and lasting. The shepherd tends the flock; the flock is your memory.

Also: a shepherd that doesn't sleep wouldn't be much use.

---

## Status

Core policy runtime in place. The following are committed and usable now:
- Deterministic policy-cycle runtime in `scripts/run-policy-cycle.ts`
- Consolidation + validation runtime pipeline in `scripts/run-memory-consolidation-and-validation.ts`
- Optional live mapper and auditor integration hooks in `scripts/run-memory-consolidation-and-validation.ts` (`--use-live-mapper`, `--use-live-auditor`)
- Automatic file-only mem-core render output in `scripts/run-memory-consolidation-and-validation.ts` (`./.electric-shepherd/memory`, configurable via `--mem-core-dir` / `--mem-core-scope-dir` / `--mem-core-file`)
- Directory-scoped mem-core loader in `scripts/run-mem-core-loader.ts` (`npm run policy:mem-core:load`)
- Cadence orchestration module in `adapter/cadence-orchestrator.ts`
- Cadence state persistence in `scripts/run-memory-consolidation-and-validation.ts` (`--cadence-state-file`)
- OpenCode plugin/snippet/instruction assets in `plugin/`, `snippets/`, and `instructions/`
- OpenCode slash commands in `command/` (both `command/` and `commands/` are recognized by OpenCode)
- Command isolation defaults for memory mutations (`/count-sheep`, `/herd`, `/lucid-dream`, `/headcount` run as subtask-isolated dreamer passes; `/wake-up` runs in-session by design)
- Compaction-aware mem-core reinjection + scope-aware loader wiring in `plugin/turn-guard.ts` (`session.compacted`, `session.started`, `session.idle`)
- consolidation write-authority guard in `plugin/turn-guard.ts` (alerts when non-dreamer agents call protected consolidation write tools)
- OpenCode source-transcript capture verification heartbeat in `plugin/turn-guard.ts` with status output in `./.electric-shepherd/turn-guard-status.json`
- Opt-in auto-consolidation in `plugin/turn-guard.ts` (idle/volume/compaction triggers + cooldown + watchdog)
- Orphan/hang hardening for auto-consolidation (cross-process lockfile, process-tree kill, bounded tracking maps, start-failure cooldown rollback)
- Shared consolidation lock in `scripts/consolidation-lock.ts` used by standalone/cron runs and plugin-triggered runs
- Policy adapter scaffold in `adapter/memgraph.ts`, retrieval expansion in `adapter/retrieval-expansion.ts`, source-to-derived consolidation in `adapter/synthesis-consolidation.ts`, and validation+merge review in `adapter/validation-merge-review.ts`
- Dreamer profile files in `agents/`
- Unit test coverage for auto-consolidation decision + hardening helpers (`npm test`: 34 passing)

Still pending for full autonomy:
- Broader harness integrations outside OpenCode defaults

Contributions welcome — especially if you're using a different agent harness (Claude Code,
Cursor) and want to wire Electric Shepherd to it.

---

## License

MIT
