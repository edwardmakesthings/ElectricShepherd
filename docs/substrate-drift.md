# Substrate drift record — MemPalace tool signatures vs. fork docs

Date: 2026-09-03

This repo's authoritative tool signatures (as exposed by the running MCP surface and the
`skills/eshepherd/SKILL.md` reference) currently differ from what the MemPalace fork docs
path expectations assume. Where they diverge, this record is the source of truth **in this
repo**.

## Known drift

- `mempalace_search` supports `since`, `before`, `source_file`, and `max_distance`.
- `mempalace_kg_add` supports `valid_to` (backfilling an already-ended historical fact in a
  single call).

## Authoritative side

The authoritative signatures are the ones implemented here (this repo / running MCP surface),
not the fork docs path expectations. Until the fork docs catch up, treat this file as the
source for these parameters in this repo.

Note: `docs/mcp-tools.md` is absent from this repo, so this drift record is the source for
these tool-signature facts here.
