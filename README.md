# Electric Shepherd 🐑⚡

> *Do androids dream of electric sheep?*

Electric Shepherd tends your AI memory while you sleep. It consolidates raw conversation
transcripts into a synthesized knowledge graph, prunes what's stale, connects what's
related, and keeps your AI coding assistant from re-deriving the same things every session.

Built on [MemPalace](https://github.com/MemPalace/mempalace) as the memory substrate.
Designed for [OpenCode](https://opencode.ai) as the agent harness, distributable as an
npm package for one-line install. The deterministic adapter + retrieval policy runtime can be run locally
with Node against MemPalace MCP — no cloud, no API bills.

Current repo status: policy bootstrap is present (plugin, snippets, adapter, runtime,
and agent profiles) and the substrate graph APIs are available for integration.

---

## What it does

Your AI coding sessions produce raw transcripts. MemPalace already mines and stores these
verbatim (that's its job). Electric Shepherd works *above* that layer:

- **Consolidates** raw transcripts into synthesized memory nodes — durable decisions,
  root causes, worked examples — organized into a synthesis-height graph where height
  reflects how many times something has been refined.
- **Connects** related memories across sessions that were written separately, building the
  cross-session links no single session could see.
- **Prunes** what's stale — memories that haven't been retrieved or touched fade as
  candidates for archival.
- **Validates** that synthesized connections actually hold, bidirectionally.
- **Notifies** you (via ntfy or similar) when something needs human judgment rather than
  silently guessing.

The result: your AI assistant starts each session knowing what was decided, what was built,
and what was learned — not because you re-explained it, but because Electric Shepherd
maintained it overnight (or when idle).

---

## How it relates to MemPalace

MemPalace stores verbatim content and retrieves it — it never paraphrases or transforms.
Electric Shepherd respects that invariant completely: raw drawers are never altered.
Synthesis nodes are *new* drawers (verbatim content, just generated rather than mined),
and the relationships between them live in MemPalace's existing knowledge graph as
`synthesized-from` and `merged-into` predicates. Electric Shepherd is a client of
MemPalace, not a fork of it.

> **Note:** Electric Shepherd expects MemPalace graph substrate APIs (synthesis-node support,
> traversal API, retrieval counters, merge/canonical operations) to be present. If your
> environment does not expose these tools yet, upgrade MemPalace before enabling automation.

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
- The `memsave` / `memload` OpenChamber snippets
- The memory discipline instructions (loadable via `instructions`)

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

### 1. Add Electric Shepherd instructions to your OpenCode instructions

In your `opencode.json`:

```json
{
  "plugin": ["electric-shepherd"],
  "instructions": [
    "node_modules/electric-shepherd/instructions/agent-discipline.md",
    "node_modules/electric-shepherd/instructions/memory-blocks.md"
  ]
}
```

Or copy `instructions/agent-discipline.md` and `instructions/memory-blocks.md`
into your own config and customize them.

### 2. Add the dreamer agent profiles

Merge any profiles you want from `agents/` into your `opencode.json`:
- `agents/dreamer.json`
- `agents/dream-consolidator.json` (alias profile)
- `agents/dream-mapper.json`
- `agents/dream-auditor.json`

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

## Project layout

```
electric-shepherd/
├── plugin/
│   └── turn-guard.ts          # OpenCode plugin: retry/checkpoint + mem-core injection + authority/capture guards
├── agents/
│   ├── dreamer.json           # primary dream orchestrator profile
│   ├── dream-consolidator.json # alias profile name used by some setups
│   ├── dream-mapper.json      # per-transcript subagent (isolated context)
│   └── dream-auditor.json     # validator subagent (bidirectional coherence check)
├── instructions/
│   ├── agent-discipline.md    # agent behavior rules and guardrails
│   └── memory-blocks.md       # always-loaded mem-core render artifact
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
├── package.json
└── README.md
```

---

## Configuration

All configuration is optional — defaults work out of the box.

| Env var | Default | Description |
|---|---|---|
| `MEMPALACE_MCP_URL` | `http://localhost:8093/mcp` | MemPalace MCP endpoint |
| `MEMGRAPH_TOOL_PREFIX` | `mempalace_` | Prefix for MemPalace tools (use LiteLLM-prefixed value when applicable) |
| `NTFY_URL` | unset | ntfy endpoint for escalation notifications |
| `ESHEPHERD_MEMCORE_REINJECT_ENABLED` | `true` | Enable plugin-driven scoped mem-core reinjection |
| `ESHEPHERD_MEMCORE_REINJECT_ON_COMPACT` | `true` | Force mem-core reload after `session.compacted` |
| `ESHEPHERD_MEMCORE_REINJECT_ON_IDLE` | `true` | Reinject when scope/content changed during idle checks |
| `ESHEPHERD_MEMCORE_REINJECT_ON_START` | `true` | Prime scoped mem-core when a session starts |
| `ESHEPHERD_SCOPE_DIR` | unset | Optional fixed scope directory override for reinjection |
| `ESHEPHERD_MEMCORE_STORE_ROOTS` | `eshepherd/memory,memory` | Store roots consulted by loader wiring |
| `ESHEPHERD_MEMCORE_MAX_SCOPES` | `6` | Max broad→narrow scopes merged by reinjection loader |
| `ESHEPHERD_MEMCORE_MAX_CHARS` | `12000` | Character cap for injected mem-core payload |
| `ESHEPHERD_SYNTH_WRITE_GUARD_ENABLED` | `true` | Alert on non-dreamer calls to synthesis write tools |
| `ESHEPHERD_ALLOWED_SYNTH_WRITERS` | `dreamer,dream-consolidator` | Allowed agent identities for synthesis writes |
| `ESHEPHERD_MEMRAW_VERIFY_ENABLED` | `true` | Emit OpenCode mem-raw capture verification status |
| `ESHEPHERD_MEMRAW_CAPTURE_CMD` | unset | Optional command run on stop/compact verification events |

---

## Architecture

The dreamer uses a **map-reduce fan-out**: for each raw transcript, a `dream-mapper`
subagent reads it in isolated context and returns a structured summary + confidence score.
The parent `dream-consolidator` synthesizes across all summaries, creates new synthesis
nodes in MemPalace, links them via `synthesized-from` KG triples, and runs the
`dream-auditor` for bidirectional coherence validation.

Synthesis nodes are ordinary MemPalace drawers marked `node_kind=synthesis`. Edges are
KG triples. The graph is traversal over those structures — no separate graph database.

---

## Why "Electric Shepherd"?

Philip K. Dick asked whether androids dream of electric sheep — whether artificial minds
have inner life. Electric Shepherd is the closest practical answer: a process that tends
your AI's memories while it rests, consolidating the day's experience into something more
refined and lasting. The shepherd tends the flock; the flock is your memory.

Also: a shepherd that doesn't sleep wouldn't be much use.

---

## Status

Bootstrap in place. The following are committed and usable now:
- Deterministic policy-cycle runtime in `scripts/run-policy-cycle.ts`
- Consolidation + validation runtime pipeline in `scripts/run-memory-consolidation-and-validation.ts`
- Optional live mapper and auditor integration hooks in `scripts/run-memory-consolidation-and-validation.ts` (`--use-live-mapper`, `--use-live-auditor`)
- Automatic file-only mem-core render output in `scripts/run-memory-consolidation-and-validation.ts` (`./eshepherd/memory` or `./memory`, configurable via `--mem-core-dir` / `--mem-core-scope-dir` / `--mem-core-file`)
- Directory-scoped mem-core loader in `scripts/run-mem-core-loader.ts` (`npm run policy:mem-core:load`)
- Cadence orchestration module in `adapter/cadence-orchestrator.ts`
- Cadence state persistence in `scripts/run-memory-consolidation-and-validation.ts` (`--cadence-state-file`)
- OpenCode plugin/snippet/instruction assets in `plugin/`, `snippets/`, and `instructions/`
- Compaction-aware mem-core reinjection + scope-aware loader wiring in `plugin/turn-guard.ts` (`session.compacted`, `session.started`, `session.idle`)
- mem-synth write-authority guard in `plugin/turn-guard.ts` (alerts when non-dreamer agents call `create_synthesis_node` / `apply_merge`)
- OpenCode mem-raw capture verification heartbeat in `plugin/turn-guard.ts` with status output in `./.electric-shepherd/turn-guard-status.json`
- Policy adapter scaffold in `adapter/memgraph.ts`, retrieval expansion in `adapter/retrieval-expansion.ts`, synthesis consolidation in `adapter/synthesis-consolidation.ts`, and validation+merge review in `adapter/validation-merge-review.ts`
- Dreamer profile files in `agents/`

Still pending for full autonomy:
- Broader harness integrations outside OpenCode defaults

Contributions welcome — especially if you're using a different agent harness (Claude Code,
Cursor) and want to wire Electric Shepherd to it.

---

## License

MIT
