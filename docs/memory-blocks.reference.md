# Labeled memory blocks (reference shape)

This file is a **reference artifact** that shows the expected shape of scoped mem-core
renders. Live mem-core is loaded from runtime-rendered `memory.md` files under
`.electric-shepherd/memory` rather than being injected from `instructions/`.
It is derived, never hand-authored.

## Storage convention

- Durable facts are written to **derived memory** (drawers, kg facts, synthesis nodes).
- mem-core files are deterministic renders generated under `.electric-shepherd/memory`
  as layered `memory.md` outputs.
- This file is a representative scope render example, not a template that agents maintain.
- Keep each block to a few hundred tokens. If a block outgrows that, it is too detailed —
  move specifics to a normal drawer/diary entry and keep only the durable summary here.
- mem-core does not round-trip into MemPalace drawers.

The blocks below are illustrative of render output for this scope. Agents should write
durable state to derived memory and let runtime regeneration update mem-core automatically.

---

## [project-state]

- Electric Shepherd is the policy layer for memory consolidation (Dreamer orchestration,
  mapper/auditor coordination, drift review, and scheduling).
- MemPalace is the substrate layer for durable storage and graph mechanics (drawers,
  derived-drawer creation, traversal, canonical resolution, merge/orphan queries, KG).
- Raw transcripts remain append-only source-of-truth; Dreamer writes synthesized outputs and
  auto-refreshes mem-core renders for always-loaded context.

## [active-conventions]

- Keep the substrate/policy boundary strict: deterministic graph/store mechanics in MemPalace,
  consolidation judgment and cadence in Electric Shepherd.
- When a substrate tool has required fields, trust the tool schema and provide them directly.
- Adhere to the "Review" requirement at the end of execution loops to prevent Auto-Retry Guard triggers.
  Do not add parallel formatting rules that duplicate schema enforcement.
- Keep mem-core blocks compact and current; move detailed implementation notes into normal
  drawers/diary entries instead of bloating always-loaded context.
- Prefer machine-neutral configuration guidance in this repository. Put host-specific paths,
  ports, and aliases in local private config, not shared prompts.

## [user-preferences]

- Keep prompts concise, actionable, and testable.
- Prefer one end-of-pass validation sweep over repetitive incremental checks unless debugging.
- Keep memory entries high-signal: durable decisions, root causes, and reusable patterns.
