# Harness support — OpenCode v1, OpenCode v2, omp

Electric Shepherd runs on three harness surfaces. The memory layer (MemPalace tools, the
policy runtime, consolidation) is the same on all of them; what differs is how each harness
lets a plugin load assets, see the conversation, and change a model request. This page is the
one place that records those differences. Setup steps are in [QUICKSTART.md](QUICKSTART.md) §1.

| Surface | Load it with | Code |
|---|---|---|
| **OpenCode v2** (default) | `"plugin": ["electric-shepherd"]` (or a file in `~/.config/opencode/plugins/`) | `src/surface/plugin/session-policy-v2.ts`, `src/surface/opencode-v2/` |
| **OpenCode v1** | the same, plus `ESHEPHERD_OPENCODE_PLUGIN_API=v1` (also `1` / `opencode-v1`) | `src/surface/plugin/session-policy-v1.ts`, `src/surface/opencode-v1/` |
| **oh-my-pi (omp)** | `npm run omp:assets`, then `omp -e ./src/surface/omp` (the directory) | `src/surface/omp/` |

The v2 surface runs the v1 turn-guard (loop guard, retry, checkpoint, capture, consolidation
triggers) behind a client/event bridge, and uses native v2 hooks wherever v2 offers a better
seam. So "v1 and v2: yes" below means the same code, not two implementations.

---

## Assets

| Asset | OpenCode v1 | OpenCode v2 | omp |
|---|---|---|---|
| agents (`agents/*.md`) | `config` hook → `config.agent` | `ctx.agent.transform`; frontmatter `permission`/`tools` translated to v2 permission rules | staged as task agents |
| commands (`commands/*.md`) | `config` hook → `config.command` | `ctx.command.transform`; `$ARGUMENTS`/`$1…` expanded, `agent:` switched before the prompt | staged slash commands; `agent:` becomes a `task` delegation |
| instructions (`instructions/agent-discipline.md`) | path appended to `config.instructions` | text appended to the system prompt via the `context` hook (v2 does not load `config.instructions`) | staged as an `alwaysApply` rule |
| skills (`skills/*/SKILL.md`) | **no** — copy into `.opencode/skills/` by hand | `ctx.skill.transform`; a same-id skill in your skill directories overrides it | discovered from the extension root |
| snippets (`snippets/*.md`) | no — OpenChamber assets | no | no |

Your own agents, commands and skills always win a name collision.

## Memory

| Behaviour | OpenCode v1 | OpenCode v2 | omp |
|---|---|---|---|
| mem-core delivery (`memcore.reinject.enabled`) | re-sent as a **user prompt** on the enabled `onIdle`/`onStart`/`onCompact` triggers, with a cooldown — each one costs a model turn | appended to the **system prompt** of every agent request (`context` hook), cached per project; triggers ignored | appended to the system prompt at `before_agent_start` |
| survives compaction | only if `onCompact` re-injects | yes — it is part of every request | yes — the per-turn override survives the fold |
| compaction archive (`compaction.archiveEnabled`) | reconstructed after the fact from the summary marker | written from the `compaction` hook with exactly the messages being folded | not written — omp keeps a `CompactionEntry` itself |
| transcript capture | `opencode --pure export` | `opencode session export` (the script tries v2, then v1) | reads omp's own session JSONL |
| memory checkpoint at settle | every session | every session | interactive sessions only |
| auto-consolidation | on idle / compaction triggers | same | on `session_stop` |
| consolidation subagent passes | `opencode run` | `opencode run --standalone`, so the pass's isolation env reaches the plugin | `omp -p --no-extensions` |

## Guards and safety

| Behaviour | OpenCode v1 | OpenCode v2 | omp |
|---|---|---|---|
| loop guard, spiral guard, stall retry, task watchdog | yes | yes (via the bridge) | **omp's own** — not ported, or both fire |
| `delete_drawers` / `move_drawers` approval | `config.permission` default `ask` | permission `evaluate` hook: `allow` becomes `ask` unless the agent has its own rule; never loosens a `deny`; covers `opencode.jsonc` agents too | not provided |
| agent tool restrictions (`tools:` map) | enforced | enforced (translated to permission rules) | **not enforced** — the map is dropped rather than mistranslated |
| stopping a session mid-tool | the tool runs to completion or timeout | the session stops waiting at once; `capture_transcript` kills its child process; other tools finish their MemPalace call in the background | runs to completion or timeout |

## Commands

| Behaviour | OpenCode v1 | OpenCode v2 | omp |
|---|---|---|---|
| `subtask: true` (`/memory-status`, `/reminders`) | runs in a background child session | runs in the **current** session — the v2 plugin API cannot create child sessions | delegated to a `task` agent |
| shell blocks (`` !`cmd` ``) in a template | expanded by OpenCode | **not expanded** (plugin commands get the raw template) — no bundled command uses them | not expanded |

---

## OpenCode v2 operational notes

- **One shared server.** v2 clients (TUI, CLI, desktop) talk to one background service, and
  each server loads its own copy of the plugin and its state. If something else needs a fixed
  port — OpenChamber, for example — make the service listen there rather than running a second
  server:

  ```bash
  opencode service set port 4095
  opencode service set hostname 0.0.0.0
  # systemd: ExecStart=…/opencode serve --service
  ```

  If the service is not running, the next `opencode` command starts its own, without your
  systemd environment. Put plugin env in the unit *and* `opencode service set env NAME VALUE`
  if you need it in both cases.
- **Clients need the service password.** v2's API requires auth. Clients that connect over HTTP
  (OpenChamber: `OPENCODE_SERVER_PASSWORD`) must use the password in
  `~/.config/opencode/service.json`.
- **Plugin files must default-export a definition.** A local shim in `~/.config/opencode/plugins/`
  must `export default Plugin.define({ id, setup })`; a bare function fails to load with
  "Plugin must export a default definition with an id and an effect or setup function".
- **Not used (yet):** plugin storage (`ctx.storage`). Electric Shepherd's state is shared with the
  v1 and omp surfaces and its status files are read by scripts, so it stays where it is.

When you change what one surface does, update this page in the same commit.
