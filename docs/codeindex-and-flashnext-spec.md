# Spec: codebase index + Qwen3.8-Flash-Next

Two independent tracks. Track A is cheap and decides itself. Track B is a hardware bet
with one blocking unknown — verify that unknown before downloading 60GB.

---

# TRACK A — codebase index

## A0 — DECIDED (2026-08-26): tree-sitter-analyzer

Audit result on this repo: 35,810 call edges analysed, a name-only resolver would mis-wire
**1,534 (4.28%)**, of which **1,209 are genuine cross-language collisions** — not builtins
a basic index could special-case. TSA mis-wires 0.

The decisive factor is Pyodide: `web/public/solver/pyodide/pyodide.asm.js` contains
Python-derived symbol names inside a JavaScript file, so a name-only index systematically
wires real Python calls (`pop`, `values`) into compiled Pyodide artifacts. Generic names
(`log`, `error`, `replace`) collide the ordinary way between `database/src/*.js` and
`houdini/scripts/python/armet/*`.

codebase-memory-mcp is NOT selected. Its advantage is token reduction; that is worth
nothing against a call graph wrong 4% of the time in ways nobody would notice.

Re-run the audit after major structural changes:

```bash
uvx --from tree-sitter-analyzer miswire-audit .
```

### Original decision rule (kept for reference)

```bash
uvx --from tree-sitter-analyzer miswire-audit .
```

Run at the Armet repo root. It reports how many call edges a name-only code index would
mis-wire across a language boundary. Record the number.

**Decision rule:**
- **Non-trivial mis-wire count** -> tree-sitter-analyzer (TSA). Correctness is the problem;
  a confidently wrong call graph is worse than no call graph.
- **Near zero** -> codebase-memory-mcp. Correctness is not the problem, so pick the one
  with the token/tool-call benchmark (31 repos: 83% answer quality, 10x fewer tokens,
  2.1x fewer tool calls vs file-by-file exploration).

Report the number and the choice before installing anything.

## A1 — install and index

Both are MCP servers and local-only. Install per their README, index the repo, and time it.
Record: index duration, on-disk size, and whether incremental re-index works after a single
file edit. An index that must be fully rebuilt on every edit is not viable at your session
length.

Add to `opencode.jsonc` under `mcp`. Do NOT grant it to every agent — see A2.

## A2 — CONSUME (the part that is easy to skip and makes the whole thing pointless)

An index nothing queries is the mem-core failure again.

Grant the new tools to **`explore`, `scout`, `gather-context`, and `implement-local`** —
the agents that currently answer structural questions by reading files. Do not grant to
`orchestrate-cloud`; it should keep delegating, not start querying.

Update `explore`'s prompt so the index is the FIRST move for structural questions
("where is X", "what calls Y", "what would this change break"), with `search-tools_grep`
and `serena_*` as fallbacks when the index misses. Right now the prompt sends it to grep
first, and it will keep doing that if nothing tells it otherwise.

### Tool ownership — RESOLVED, put this table in the prompts

These three do not overlap once split by JOB rather than by capability. TSA reads,
ast-tools transforms mechanically, Serena refactors semantically.

| The question | Tool | Why it owns it |
|---|---|---|
| where is X / what calls Y / what would this break / repo shape | **TSA** | indexed, cross-language-correct, cheap to query repeatedly |
| find every instance of a syntactic PATTERN, and rewrite it | **ast-tools** | stateless, works on any path, pattern-with-metavariables is its whole point |
| rename or move a symbol SAFELY (type-aware) | **Serena** | LSP resolves types; tree-sitter cannot. A rename needs to know `foo.bar()` binds to THIS bar |
| read a known range of a known file | **file-reader** | no index needed |
| plain text / non-structural search | **search-tools_grep** | regex, comments, strings, config |

**Serena's role narrows to WRITE-side work.** Observed in practice: cloud models reach for
it more than local ones, which fits — refactoring is judgment-heavy and type-aware safety
is exactly what a large model exploits. Reading and navigation move to TSA.

Grant accordingly, and prune while you are there:
- **TSA** -> `explore`, `scout`, `gather-context`, `implement-local` (and the cloud
  implementers).
- **Serena** -> keep everywhere it is currently granted, INCLUDING `explore` and `scout`.
  An earlier draft of this spec suggested dropping it from the read-only agents because it
  "was not being used effectively." That premise was WRONG. The cause was that Serena had
  no ACTIVE PROJECT and silently failed when called from outside one; auto-activating the
  project on start changed usage dramatically. Serena and TSA compose rather than compete —
  TSA answers structural questions from an index, Serena resolves the specific symbol
  semantically — and together they measurably reduce the number of checks an explorer makes
  before it can write a report.
- Note Serena is cross-language-safe by construction (one LSP per language never sees
  another's symbols), so the mis-wire problem TSA solves was never Serena's problem. TSA
  replaces the *grep-and-guess* path, not the LSP path.

## A3 — PROVE

Take one structural question you have actually asked this month. Answer it twice: once with
the index, once with the current grep/Serena path. Compare tool-call count and tokens
consumed. State the delta. If it is not materially better, say so and remove the tool.

---

# TRACK B — Qwen3.8-Flash-Next

## B0 — RESOLVED (2026-08-27): llama.cpp support MERGED

`ggml-org/llama.cpp#27742` — "model: add Qwen3.8-Flash-Next (qwen4exp)" by danielhanchen
(Unsloth) — is **merged to master**. Build from mainline; do NOT fork, and do not build the
`unslothai:qwen4exp/qwen3.8-flash-next` branch.

Adds HF `model_type: qwen4_exp` / `Qwen4ExpForConditionalGeneration`: converter, text graph,
QSA sparse attention, vision, and three quantizer fixes the model required.

### Correctness, from the PR (against the reference implementation)

| check | result |
|---|---|
| wikitext-2 perplexity, 145 chunks @ ctx 2048 | 4.0068 +/- 0.02271 vs 4.0126 reference |
| top-1 agreement, 512 tokens of prose | 98.0% |
| QSA vs dense BELOW the budget | bit-identical, max logit delta 0.0 over 2051 rows |
| QSA vs dense ABOVE the budget, 8192 tokens | diverges on 3% of positions |
| indexer selection vs reference | 0.975 mean jaccard (0.991 precision floor) |
| `test-llama-archs -a qwen4exp` | OK on CPU (0.00e+00) and CUDA (8.00e-08) |

This is a well-validated port, not a rough one.

### DO NOT convert or quantize locally

Both exceed 128GB by a wide margin. Download a pre-made GGUF.

- Conversion peaked ~300 GB RSS even after the shard-streaming fix.
- `llama-quantize` measured **VmHWM 485 GB per process**; the buffer fix removes ~150 GB.

### Which GGUF — this decides whether it fits at all

The n-gram (PLE) table is 97.7 GiB of the 337.6 GiB BF16 file, about **46% of a 4-bit
build**, and it is read by `ggml_get_rows` rather than a matmul so no imatrix covers it.

| Q4_K_M build | PLE table | total |
|---|---|---|
| default (follows `--token-embedding-type`) | q8_0, 51.9 GiB | **113.5 GiB** |
| PLE pinned via `--tensor-type` | q4_1, 30.5 GiB | **92.1 GiB** |

At 92.1 GiB there is real headroom across 128 GB RAM + 24 GB VRAM. At 113.5 GiB it is
scraping once OS and KV cache are counted. **Check the publisher's file sizes before
pulling ~100 GB**; if the total is near 113 GiB the table was not pinned.

### Runtime notes from the PR

- **Pass `--jinja`.** The Qwen3.8-Flash-Next chat template is required; without it the
  model can emit malformed turns.
- **Multi-slot serving works only from commit `bea3b12` onward.** `set_input_qsa`
  previously asserted `n_stream == 1`, so `llama-server` aborted with more than one slot
  unless `-kvu` was passed. Non-unified is also 22% faster at batch 16 (1205 vs 984 t/s).
- Attention cache is ~25 KB/token, roughly a tenth of the dense 27B, so the 262K context is
  genuinely affordable rather than theoretical.
- Vision works end-to-end via `llama-mtmd-cli` with an F16 mmproj.

### Memory bandwidth — MEASURED (2026-08-27)

Quad channel DDR4-2666, one 32GB DIMM per channel (A/B/C/D), 128 GB total:

```
4 channels x 2666 MT/s x 8 bytes = ~85 GB/s
```

Comparable to dual-channel DDR5-5600, roughly double dual-channel DDR4, and about 3x slower
than DGX Spark (~273 GB/s) and 11x slower than the 3090's VRAM (936 GB/s).

This does not block the attempt — the 6B-active design and lookup-shaped n-gram access
tolerate slow memory far better than dense matmuls. It sets the EXPECTATION: the published
Mac/Spark speed impressions will not transfer. If B4 comes back slow, bandwidth is the first
suspect and the number is recorded here rather than guessed at afterwards.

## B1 — RESOLVED (2026-08-29): on-demand through llama-swap

The dedicated resident-server proposal was rejected because this host can keep only one
large model resident anyway. Flash-Next is an ordinary `llama-swap` entry and is loaded
only when selected. The 30-minute global TTL unloads it after idle; restarting llama-swap
also cleanly leaves no model resident.

- Official Unsloth `UD-IQ4_XS`: 93,682,584,224 bytes (87.23 GiB), three shards.
- llama-swap points at shard `00001-of-00003`; llama.cpp discovers the remaining shards.
- New llama.cpp `b10688` automatic fitting places the model across the 24GB GPU and system
  RAM with `--n-gpu-layers auto --fit on`.
- Empty-host measured health-check time was 19 seconds on first load and 16 seconds on a
  later swap with warm filesystem cache. That is acceptable for this one-resident workflow.
- Swapping Flash-Next to dense Qwen3.8-27B and back was verified through llama-swap; only
  the selected model remained resident each time.

## B2 — configuration

Initial deployed configuration (2026-08-29):

- Server context: 65,536 pending a measured context tune; client input/output budgets are
  49,152/16,384 for implementer/general and 32,768/32,768 for HA debug.
- Thinking: explicitly on, effort `high`, preserve reasoning off.
- Sampling: temperature 1.0, top_p 0.95, top_k 20, min_p 0.0, presence_penalty 0.0.
- Required `--jinja` is inherited from the Flash-specific llama-swap server macro.
- LiteLLM, OpenCode catalog, and DCP entries were added in the same deployment.
- Existing dense Qwen3.8-27B remains available non-thinking; a separate
  `implementer-qwen3.8-27b-thinking` alias uses the same GGUF with server-side thinking on.

- **Context:** 262,144 native. Do not set it there on day one. Tune with
  `context_tune_litellm.py` like every other model, and remember KV cache scales with it.
- **Thinking effort defaults to EXTRA HIGH, and Preserve Thinking is on by default**
  (it carries prior thinking traces forward). This is the exact latency trap already hit
  with Qwen3.8-27B. Set both explicitly rather than inheriting.
- **Sampling:** thinking mode temp 1.0 / top_p 0.95 / top_k 20 / min_p 0.0 /
  presence_penalty 0.0. Non-thinking: temp 0.7 / top_p 0.80 / top_k 20 / presence_penalty
  1.5. The presence_penalty difference is load-bearing -- zero penalty on a
  non-thinking Qwen previously caused identical phrases repeated 8x.
- **`--jinja` is REQUIRED** on the llama-server command (see B0). Without it the chat
  template is not applied and the model can emit malformed turns. Easy to omit and the
  failure looks like a model quality problem rather than a missing flag.
- Add the DCP limits and the `opencode.jsonc` catalog entry in the same pass. A model in
  LiteLLM but absent from the catalog is unreachable from any agent.

## B3 — decide its ROLE before wiring it to anything

125B total but **6B active**. That is twice the active compute of your 35B-A3B, but the
bulk (the 51B n-gram table) is capacity, not reasoning. Expect it to KNOW more and REASON
at roughly 6B-active class.

Candidate roles, in order of likely fit:
- `gather-context` / research -- large context and broad knowledge, judgment-light.
- A second opinion in the critic-actor loop -- different architecture from both Qwen dense
  and Gemma, so genuinely decorrelated.
- `implement-local` -- only if it beats qwen3.8-27b on a real A/B. Do not assume the
  parameter count wins; agentic implementation is reasoning-heavy.

## B4 — PROVE

Run the same 3 real tasks through Flash-Next and through `implementer-qwen3.8-27b`. Record
tokens/sec, time to first token (with the model already resident -- do not include load
time, that is a one-off), review verdicts, and revise cycles. Report which won on what.
State plainly if it does not beat the 27B; a 125B model that loses to a 27B on your work is
a real finding, not a failed experiment.

---

## Guardrails

- Verify a tool exists and loads on a STOCK build before designing around it.
- A capability needs the tool grant AND the prompt AND the permission; missing one fails
  silently.
- Any new model needs the llama-swap/server entry AND the LiteLLM alias AND the OpenCode
  catalog entry AND the DCP limits. Missing the catalog entry makes it unreachable;
  missing the DCP limit makes it uncapped.
- Never page a room or index to exhaustion inside an agent turn.

## Report

- TRACK A: the mis-wire number, the choice and why, index timings, the A3 comparison
- TRACK B: the B0 findings first (this gates everything), then config, then the B4 numbers
- FILES: each path touched
- NOTES: assumptions, anything that looked wrong, scope deliberately not touched
