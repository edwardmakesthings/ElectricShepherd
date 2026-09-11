# Electric Shepherd 🐑⚡

> *Do androids dream of electric sheep?*

Electric Shepherd tends your AI's memory while you sleep. It consolidates raw conversation
transcripts into durable derived memory, links them to the docs and skills they rest on,
and keeps your coding assistant from re-deriving the same conclusions every session.

Built on [MemPalace](https://github.com/MemPalace/mempalace) as the memory substrate, and
on [OpenCode](https://opencode.ai) as the agent harness. The policy runtime is a plain Node
process against MemPalace MCP — no cloud, no API bills.

[QUICKSTART.md](QUICKSTART.md) — setup and operation.
[`docs/memory-graph-design.md`](docs/memory-graph-design.md) — authority on semantics.

---

## What it does

An agent session produces transcripts. A project carries reference docs. MemPalace already
stores both verbatim — that is its job, and it never paraphrases. Electric Shepherd works
*above* that layer, turning a growing pile of verbatim text into something an agent can
actually start a session knowing.

It handles six kinds of memory, each with its own storage-to-retrieval path:

| Kind | What it holds | Example |
|---|---|---|
| **episodic** | what happened — transcripts consolidated into summaries and topic arcs | "the caching regression came from LiteLLM stripping `cache_control`" |
| **semantic** | what is true — ingested docs, API references, specs, and their authority over syntheses | the library doc the conclusion rests on |
| **procedural** | how to do a recurring thing, refined by the sessions that used it | "how I diagnose a caching regression" |
| **prospective** | what to remember *when* — reminders pushed by circumstance, not pulled by query | "when touching `auth/`, check the token refresh path" |
| **negative** | what was ruled out, and why | "tried X — does not work, because Y" |
| **evaluative** | whether the memory actually helped, fed back into ranking | this closet has been revised twice |

The value is not storing six things. It is **linking** them: a synthesis about a bug points
at the doc it concerned and the skill that encodes the fix, and retrieval returns all three
together — what was decided, the authority it rests on, and the procedure.

Everything derived starts life **provisional**, is excluded from retrieval and from
mem-core until a validation pass promotes it, and carries explicit lineage back to its
sources. An unvalidated guess never reaches your context silently.

---

## How it relates to MemPalace

MemPalace stores verbatim content and retrieves it. Electric Shepherd respects that
invariant completely, and builds **entirely out of MemPalace's own native layers** rather
than inventing parallel structures:

| Electric Shepherd concept | Native MemPalace object |
|---|---|
| raw transcripts and ingested docs | **drawers** — frozen, never altered |
| summaries and arcs | **closets** — the revisable summary layer that points back to source |
| durable facts | **KG triples** with `valid_from`/`valid_to`, so a changed fact is superseded with history |
| categories | **halls** (`facts` / `events` / `discoveries` / `preferences` / `advice`) |
| lineage, grounding, outcomes | **KG edges** (`synthesized-from`, `consolidated-into`, `merged-into`, `concerns`, `rules-out`, `promoted-from`, `es-outcome`) |
| source type and status | **KG stamps** on drawers (`es-source-type`, `es-status`) |

Electric Shepherd is a client of MemPalace, not a fork of it.

### Non-invasive by design

Because every artifact it creates is a *native MemPalace object*, two things follow:

- **It works with whatever is already in your palace.** No migration, no schema conversion,
  no "import your memories into our model." Point it at a populated palace and it starts
  organising from there.
- **Removing it leaves your palace fully intact.** Stop running Electric Shepherd and
  MemPalace carries on exactly as before — just less organised. Every closet, triple, hall
  assignment, and edge it created remains valid native data. Nothing depends on it
  continuing to run.

> **On the substrate fork.** An optional MemPalace fork adds two primitives stock MemPalace
> lacks: retrieval counters and recursive lineage traversal. Electric Shepherd uses them
> when present and degrades gracefully without them — the capture, consolidation, and
> mem-core loop are all stock-safe. Only read-tracking and deep-lineage queries are
> affected, and existing data stays valid either way.

### Optional: a code graph alongside the memory

Electric Shepherd deliberately does **not** index your code. Symbols are derived, change
every commit, and are regenerable in seconds; drawers are verbatim and append-only. Putting
a symbol index into the palace would create drawers that are stale after the next refactor
and cannot be retracted.

[Graphify](https://github.com/Graphify-Labs/graphify) fills that other half well, and pairs
cleanly:

| | Graphify | Electric Shepherd |
|---|---|---|
| answers | what the code **is** | why it is **that way** |
| data | derived, high-churn | verbatim, append-only |
| if lost | rebuild in seconds | unrecoverable |

It is optional and nothing here depends on it. If you want it:

```bash
uv tool install graphifyy          # note: package is graphifyy, CLI is graphify
graphify extract . --code-only     # local tree-sitter AST only, no LLM, nothing leaves the machine
graphify hook install              # rebuild on commit and checkout
```

`--code-only` keeps the first build local, but it does **not** persist: the rebuild hooks
call `graphify update`, which has no such flag and will use a model for docs, PDFs and
images the moment an API key is present in the environment — and this stack configures one
for LiteLLM. The guard is therefore declarative, in [.graphifyignore](.graphifyignore),
which every code path honours. Markdown is safe to leave in (graphify reads headings and
links structurally, `_origin: ast`, no model call); PDFs, images and video have no such
path and are excluded there. Verified: every node in this repo's graph is `_origin: ast`
and no `cost.json` is ever written. Community *labelling* is a separate opt-in LLM step
(`graphify label`) — skipping it leaves `Community N` placeholders and nothing else breaks.

Add `graphify-out/` to `.gitignore` unless you have decided to share one map across a team.

Measured on this repo and on a 754-file mixed Python/TypeScript tree: full build in 15s and
29s respectively, zero LLM calls, and **0 of 17,158 edges crossed the Python/TypeScript
boundary** despite 13 genuine name collisions — it lists the candidates and refuses to guess
rather than binding to the wrong one.

Two things to get right, both documented for agents in
[instructions/agent-discipline.md](instructions/agent-discipline.md):

- **Use `explain` and `path`, not `query`.** The natural-language `query` path fuzzy-matches
  several start nodes and pulls in unrelated symbols; worse, narrowing it with `--budget`
  can drop the correct answer while keeping the noise. Graphify's own generated instruction
  files recommend `query` — that guidance is wrong for precise questions and should be
  replaced with the rules above.
- **Leave its memory features off** (`save-result`, `reflect`, `LESSONS.md`). They duplicate
  the `es-source-type` / `es-status` / `es-outcome` axes with different vocabulary. Two
  systems ranking trust differently is worse than one.

---

## Layout

Four layers. **Dependencies point strictly downward** — there are no upward or sideways
imports. Each layer has a one-sentence test for whether code belongs in it:

| Layer | Belongs here if… | Holds |
|---|---|---|
| `src/surface/` | …it exists because the harness exists. | plugin hook registration, asset injection, MCP tool definitions, slash-command wiring |
| `src/policy/` | …it decides *when* or *how much*, and touches no storage. | injection timing, consolidation cadence, retrieval scoring, merge adjudication |
| `src/capability/` | …it is specific to one kind of memory. | one module per kind: `episodic`, `semantic`, `procedural`, `prospective`, `negative`, `evaluative`, `memcore` |
| `src/core/` | …it translates to the substrate, and knows nothing about memory kinds. | substrate client, transport, KG helpers, config, dry-run and approval scaffolding, room resolution, paging, `es-*` stamping |

### The binding rule

> **A capability module may not call the substrate directly.** If a capability needs
> something `core/` does not offer, `core/` grows. A capability never reaches past it.

This is enforced mechanically, not by convention: **the string `mempalace_` may appear in
exactly one directory, `src/core/`.** `npm run verify:structural` fails the build otherwise.

Three sibling checks ride along: no silent catches in `core/` or `capability/`, no
`capability/` import into `core/`, and an 800-line ceiling on any maintained file under
`src/`.

```
src/
  surface/      plugin hooks, asset injection
  policy/       decisions; no substrate calls
  capability/   one module per memory kind
  core/         the only directory that knows MemPalace exists
  tools/        MCP tool modules
  scripts/      operator entrypoints
agents/ commands/ skills/ instructions/ snippets/   assets, resolved by name
docs/ tests/ index.ts
```

Assets are markdown, one file per agent or command, injected into the resolved OpenCode
config at startup. They are coupled to the code **by name only**, so the type-checker cannot
see the coupling; `verify:structural` link-checks every `.md` path mentioned in a comment.

---

## Install

Electric Shepherd runs on two harnesses. The memory layer is identical on both; only the
wiring differs.

**In OpenCode** — one line in `opencode.json`:

```json
{
  "plugin": ["electric-shepherd"]
}
```

That is enough. On startup the plugin's `config` hook injects its bundled agents, slash
commands, and instruction rules into your resolved config, so they load in any project that
enables the plugin. You do not need to run OpenCode from inside this repo or copy anything
into `.opencode/`. Your own agents and commands always win a name collision.

The hook is necessary because OpenCode only auto-discovers `agents/` and `commands/` folders
for the active **project** root, and an installed plugin is never the project root.

**In oh-my-pi (omp)** — omp has no plugin key. It loads an extension package root and
discovers that root's `commands/`, `agents/`, `skills/` and `rules/`:

```bash
npm run omp:assets          # stage + translate the assets into the root
omp -e ./src/surface/omp    # load it (the DIRECTORY, not index.ts)
```

omp implements its own loop guard, stall retry, task watchdog and compaction archive, so
Electric Shepherd does not port those to that surface — running both layers double-fires
their correctives. See [QUICKSTART.md](QUICKSTART.md) §1b for the full difference table.

**The policy runtime** runs headless, outside either harness:

```bash
npm install -g electric-shepherd
# or from source:
git clone https://github.com/edwardmakesthings/electric-shepherd
cd electric-shepherd && npm install
```

Then see [QUICKSTART.md](QUICKSTART.md) for MemPalace wiring, config, and first run.

### What ships

| Asset | OpenCode | omp |
|---|---|---|
| plugin / extension | yes — `plugin: ["electric-shepherd"]` | yes — `-e ./src/surface/omp` |
| agents (`agents/*.md`) — `dreamer`, `dream-mapper`, `dream-auditor` | injected into `config.agent` | staged as omp task agents |
| commands (`commands/*.md`) | injected into `config.command` | staged as omp slash commands |
| instructions (`instructions/agent-discipline.md`) | appended to `config.instructions` | staged as an `alwaysApply` rule |
| skills (`skills/eshepherd/SKILL.md`) | no — no skill config key; copy into `.opencode/skills/` | yes — discovered from the extension root |
| snippets (`snippets/*.md`) | no — OpenChamber assets | no |

**Slash commands:** `/consolidate`, `/consolidate-deep`, `/memory-status`,
`/memory-refresh`, `/ingest-docs`, `/remind`, `/reminders`, `/promote-skill`. Each has a
`npm run sheep:*` equivalent for cron or an external scheduler.

> Commands are prompt templates, so they inherit the session's model. Keep their bodies
> narrow — name one tool and the fields to render. A body that offers a fallback path invites
> a smaller model to take it, which is how a 36-second aggregate call becomes a 15-minute
> enumeration.

---

## Architecture

**Consolidation is a script that owns the loop, with the model as a stateless judgment
function** — not an agent orchestrating a pass. A deterministic script enumerates the
worklist, then calls the model per bounded step: categorize, summarize, judge a connection.
The script writes; the model only judges.

Every model call stays small and isolated, so a consolidation pass cannot fill its own
context and compact before finishing. Consolidation runs against a local model, on a
schedule.

Two invariants follow:

- **Consolidation status is a graph question, never a content question.** A source is
  consumed when a `consolidated-into` edge exists, not when its text looks summarised.
  Reading a drawer cannot tell you; only `kg_query` can.
- **Every write path is dry-run first.** Doc ingestion, reminders, skill promotion, outcome
  recording, and merge application all preview their exact edges and apply only on explicit
  approval. Outcomes in particular are human-authoritative: test failures and reviewer
  verdicts are *evidence*, never writers.

Validation is context-isolated. A `dream-auditor` subagent checks new closets
bidirectionally and recommends promotion; the orchestrating agent executes it. The auditor
cannot write its own verdict, by design.

---

## Configuration

Behaviour is config-file-first. Copy `eshepherd-config.example.jsonc` to
`eshepherd-config.jsonc` and edit there — capture mode, consolidation cadence, guard
thresholds, mem-core scope, command overrides. Allowed keys and defaults are defined in
`src/core/runtime-config.ts` (`RUNTIME_CONFIG_SPECS`).

`.env` is for secrets only (`MEMPALACE_MCP_API_KEY`, `MEMPALACE_MCP_BEARER_TOKEN`,
`MEMPALACE_MCP_HEADERS_JSON`). Runtime scripts and plugin paths do not read behaviour
toggles from the environment.

Full reference: [QUICKSTART.md](QUICKSTART.md) §2.

---

## Status

The core loop — capture, consolidate, validate, promote, render, load — is built, along
with all six memory kinds and their retrieval paths. It has not been exercised end to end.
`docs/memory-test-plan.md` is the read-path test ladder.

Structural specs: [`docs/2026-08_architecture-rebuild-spec.md`](docs/2026-08_architecture-rebuild-spec.md)
(layer separation), [`docs/2026-09_structure-and-comment-audit-spec.md`](docs/2026-09_structure-and-comment-audit-spec.md)
(move into `src/`, comment sweep).

Contributions welcome, especially harness integrations. `surface/` is the only layer that
should need to change.

---

## Why "Electric Shepherd"?

Philip K. Dick asked whether androids dream of electric sheep — whether artificial minds
have inner life. Electric Shepherd is the closest practical answer: a process that tends
your AI's memories while it rests, consolidating the day's experience into something more
refined and lasting. The shepherd tends the flock; the flock is your memory.

Also: a shepherd that doesn't sleep wouldn't be much use.

---

## License

MIT
