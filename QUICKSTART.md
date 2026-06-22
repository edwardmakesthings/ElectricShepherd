# Electric Shepherd — Quick Start

Electric Shepherd is the **policy layer** for memory consolidation. It decides when to
consolidate, what to merge, and how to synthesize. MemPalace is the **substrate** — store,
graph, traversal. This repo is a client of MemPalace; it never reaches into MemPalace
internals.

---

## 1. Wire into OpenCode

Enable the plugin package and memory instructions in `opencode.jsonc`:

```jsonc
"plugin": ["electric-shepherd"],
"instructions": [
  "~/path/to/ElectricShepherd/instructions/agent-discipline.md",
  "~/path/to/ElectricShepherd/instructions/memory-blocks.md"
]
```

`agent-discipline.md` contains the full agent ruleset. `memory-blocks.md` is the
always-loaded mem-core render artifact for the active scope.

## 2. Set the tool prefix

MemPalace tool names vary by how MemPalace is registered with your MCP host:

| Registration | Tool name shape | Correct `MEMGRAPH_TOOL_PREFIX` |
|---|---|---|
| Direct MCP at `:8093` | `mempalace_search` | `mempalace_` *(default, no action needed)* |
| LiteLLM MCP gateway | `litellm_mempalace-mempalace_search` | `litellm_mempalace-mempalace_` |

For agent prompts (the dreamer and mapper subagents) you also need to state the full
prefix in any agent prompt that calls MemPalace tools directly, or load `skills/mempalace/SKILL.md`
as an additional instruction so the agent knows which names to use.

For the TypeScript adapter (`adapter/memgraph.ts`), set the env var in your shell
profile or in the environment passed to the process:

```bash
# If calling through LiteLLM gateway:
export MEMGRAPH_TOOL_PREFIX="litellm_mempalace-mempalace_"
```

Or pass it at construction time:

```typescript
const client = createMemgraphClient({
  callTool,
  toolPrefix: "litellm_mempalace-mempalace_",
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
# Required: full MCP endpoint URL, including any toolset path used by your gateway.
export ESHEPHERD_MEMPALACE_MCP_URL="${LITELLM_MCP_URL:-}"
# Optional when gateway requires auth:
# export ESHEPHERD_MEMPALACE_API_KEY="Bearer <your-litellm-key>"
# Optional capture command on stop/compact events:
# export ESHEPHERD_MEMRAW_CAPTURE_CMD="bash ./scripts/capture-memraw.sh"
```

Plugin status/verification output is written to `./.electric-shepherd/turn-guard-status.json`.

## 4. Memory tiers at a glance

| Tier | Role | Location | Writable by dreamer? |
|---|---|---|---|
| **mem-raw** | Append-only verbatim transcripts | diary room, tagged by session | No — source of truth |
| **mem-synth** | Synthesized searchable memory | drawers / kg / worked-examples | Yes — dreamer's working surface |
| **mem-core** | Always-loaded working set | directory-scoped rendered memory files (`eshepherd/memory` or `memory`) | Yes — auto-updated render |

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
