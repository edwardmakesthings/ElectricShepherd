/**
 * Subagent invocation helpers (mapper + auditor) for the consolidation pipeline.
 * Extracted from run-memory-consolidation-and-validation.ts (criterion 2).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { drawerContentFrom, scratchFileNameFor } from "../../core/palace-tools.ts";
import type { TranscriptInsightSummary } from "../../capability/episodic/synthesis-consolidation.ts";
import { asObject, asArray, asString, parsePositiveInt } from "./cli-options.ts";
import type { PromptModelRouting } from "./runtime-utils.ts";

/** Which CLI drives a one-shot subagent, and the absolute binary to invoke. */
export type SubagentRunner = { kind: "opencode" | "omp"; bin: string };

export type SubagentVia = "opencode-run" | "omp-run" | "none";

export type MapperEnvelope = {
  summaries: TranscriptInsightSummary[];
  raw: unknown;
  via: SubagentVia;
};

export type AuditorEnvelope = {
  verdict: "pass" | "revise" | "escalate";
  findings: string[];
  recommendedActions: string[];
  raw: unknown;
  via: SubagentVia;
};

export type { PromptModelRouting } from "./runtime-utils.ts";

// Raw subagent stdout is written here when it cannot be parsed, so an unusable
// answer can be diagnosed without re-running a multi-minute mapper pass.
const SUBAGENT_DEBUG_DIR = ".electric-shepherd/scratch/subagent-output";

// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_PATTERN = /\u001B\[[0-9;]*[A-Za-z]/g;
const FENCED_BLOCK_PATTERN = /```(?:json)?\s*([\s\S]*?)```/g;

export function formatPromptModelArg(model: PromptModelRouting | undefined): string | undefined {
  if (!model) return undefined;
  return `${model.providerID},${model.modelID}`;
}

export function parseEmbeddedJSON(text: string, accept: (value: unknown) => boolean = () => true): unknown {
  const trimmed = text.replace(ANSI_ESCAPE_PATTERN, "").trim();
  if (!trimmed) return undefined;

  const tryParse = (candidate: string): { value: unknown } | undefined => {
    try {
      const value = JSON.parse(candidate);
      return accept(value) ? { value } : undefined;
    } catch {
      return undefined;
    }
  };

  const whole = tryParse(trimmed);
  if (whole) return whole.value;

  for (const match of trimmed.matchAll(FENCED_BLOCK_PATTERN)) {
    const body = (match[1] ?? "").trim();
    if (!body) continue;
    const fenced = tryParse(body);
    if (fenced) return fenced.value;
  }

  for (let start = trimmed.length - 1; start >= 0; start -= 1) {
    const openChar = trimmed[start];
    if (openChar !== "[" && openChar !== "{") continue;
    const endChar = openChar === "[" ? "]" : "}";
    for (let end = trimmed.lastIndexOf(endChar); end > start; end = trimmed.lastIndexOf(endChar, end - 1)) {
      const scanned = tryParse(trimmed.slice(start, end + 1));
      if (scanned) return scanned.value;
    }
  }

  return undefined;
}

/**
 * Parse the mapper's SECTION format into summaries.
 *
 * `agents/dream-mapper.md` specifies markdown sections (DURABLE_FACTS,
 * DECISIONS, ...) while the task prompt asks for a JSON array. The agent's own
 * system prompt wins, so a mapper that follows its definition emitted prose the
 * JSON parser could not read — and the pipeline recorded that as every drawer
 * failing. Accepting both shapes removes the contract mismatch as a failure mode
 * regardless of which instruction the model follows.
 */
export function parseMapperSections(text: string, transcriptIds: readonly string[]): TranscriptInsightSummary[] {
  const clean = text.replace(ANSI_ESCAPE_PATTERN, "");
  const SECTIONS: Array<[keyof TranscriptInsightSummary, string]> = [
    ["durableFacts", "DURABLE_FACTS"],
    ["decisions", "DECISIONS"],
    ["rootCausesAndWorkedExamples", "ROOT_CAUSES_AND_WORKED_EXAMPLES"],
    ["subsystemsAndFiles", "SUBSYSTEMS_AND_FILES"],
    ["openItems", "OPEN_ITEMS"],
    ["deadEnds", "DEAD_ENDS"],
  ];

  // Headings appear as `**NAME**`, `## NAME`, or bare `NAME`, optionally colon-terminated.
  // Both edges are tracked: content starts after a heading, but a section ends at
  // the START of the next one, or the next heading's own text lands in the bullets.
  const found = SECTIONS.map(([key, name]) => {
    const match = new RegExp(`^[\\s>#*]*${name}\\s*:?[\\s*]*$`, "im").exec(clean);
    return match
      ? { key, start: match.index, contentStart: match.index + match[0].length }
      : { key, start: -1, contentStart: -1 };
  });
  const headingStarts = found.filter((entry) => entry.start >= 0).map((entry) => entry.start);
  if (headingStarts.length === 0) return [];

  // The CONFIDENCE trailer terminates the last section; without it that section
  // swallows the trailer as a bullet.
  const confidenceMatch = /^[\s>#*]*CONFIDENCE\s*:?\s*\**\s*(high|medium|low)/im.exec(clean);
  const boundaries = confidenceMatch ? [...headingStarts, confidenceMatch.index] : headingStarts;

  const bulletsFor = (contentStart: number): string[] => {
    if (contentStart < 0) return [];
    const laterStarts = boundaries.filter((index) => index >= contentStart);
    const end = laterStarts.length > 0 ? Math.min(...laterStarts) : clean.length;
    return clean
      .slice(contentStart, end)
      .split("\n")
      .map((line) => line.replace(/^[\s>]*[-*]\s+/, "").trim())
      .filter((line) => line && !/^\**[A-Z_]{4,}\**\s*:?$/.test(line));
  };

  const sections = Object.fromEntries(
    found.map((entry) => [entry.key, bulletsFor(entry.contentStart)]),
  ) as Record<string, string[]>;

  const confidence = (confidenceMatch?.[1]?.toLowerCase() ?? "medium") as "high" | "medium" | "low";

  const populated = Object.values(sections).filter((list) => list.length > 0).length;
  if (populated === 0) return [];

  // One section set describes the whole batch; attribute it to every transcript
  // the batch asked about so lineage still points at real sources.
  return transcriptIds.filter(Boolean).map((transcriptId) => ({
    transcriptId,
    confidence,
    durableFacts: sections.durableFacts,
    decisions: sections.decisions,
    rootCausesAndWorkedExamples: sections.rootCausesAndWorkedExamples,
    subsystemsAndFiles: sections.subsystemsAndFiles,
    openItems: sections.openItems,
    deadEnds: sections.deadEnds,
  }));
}

export function toSummaryFromRaw(raw: unknown): TranscriptInsightSummary[] {
  const out: TranscriptInsightSummary[] = [];
  const arr = asArray(raw);
  for (const item of arr) {
    const obj = asObject(item);
    const byNormalizedKey = new Map<string, unknown>();
    for (const [key, value] of Object.entries(obj)) {
      byNormalizedKey.set(key.toLowerCase().replace(/[^a-z0-9]/g, ""), value);
    }
    const field = (name: string): unknown => byNormalizedKey.get(name);

    const transcriptId = asString(field("transcriptid") ?? field("id")).trim();
    if (!transcriptId) continue;

    const pickList = (name: string): string[] =>
      asArray(field(name)).map((v) => asString(v).trim()).filter(Boolean);

    const confidenceRaw = asString(field("confidence")).trim().toLowerCase();
    const confidence =
      confidenceRaw === "high" || confidenceRaw === "medium" || confidenceRaw === "low"
        ? (confidenceRaw as "high" | "medium" | "low")
        : "low";

    out.push({
      transcriptId,
      confidence,
      durableFacts: pickList("durablefacts"),
      decisions: pickList("decisions"),
      rootCausesAndWorkedExamples: pickList("rootcausesandworkedexamples"),
      subsystemsAndFiles: pickList("subsystemsandfiles"),
      openItems: pickList("openitems"),
      deadEnds: pickList("deadends"),
      rawExcerpt: asString(field("rawexcerpt")) || undefined,
    });
  }
  return out;
}

/**
 * Environment for one-shot subagent runs.
 *
 * These runs must be clean of external context: the mapper/auditor see only the
 * prompt we hand them. It is also what makes them terminate — mem-core
 * reinjection on idle injects a fresh user turn after every completed turn, so
 * a non-interactive `opencode run` never reaches a final state and dies on the
 * spawn timeout instead of returning output.
 */
export function buildIsolatedSubagentEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    // The OpenCode surface loads as a plugin inside `opencode run` and logs to
    // stdout, which is the same channel the mapper answers on. Its banner and
    // per-turn lines were landing in the parsed output. This flag makes the
    // plugin no-op, which also stops a subagent pass re-entering capture and
    // consolidation -- the guarantee `--no-extensions` gives on the omp side.
    ESHEPHERD_SUBAGENT_RUN: "1",
    ESHEPHERD_MEMCORE_REINJECT_ENABLED: "false",
    ESHEPHERD_MEMCORE_REINJECT_ON_IDLE: "false",
    ESHEPHERD_MEMCORE_REINJECT_ON_START: "false",
    ESHEPHERD_MEMCORE_REINJECT_ON_COMPACT: "false",
    ESHEPHERD_AUTO_CONSOLIDATION_ENABLED: "false",
    ESHEPHERD_AUTO_CONSOLIDATION_ON_IDLE: "false",
    ESHEPHERD_AUTO_CONSOLIDATION_ON_COMPACT: "false",
  };
}

/** Candidate install locations, checked when the binary is not on PATH. */
const WELL_KNOWN_BINS: ReadonlyArray<{ kind: "opencode" | "omp"; relative: string }> = [
  { kind: "opencode", relative: ".opencode/bin/opencode" },
  { kind: "omp", relative: ".local/bin/omp" },
];

function kindForBin(bin: string): "opencode" | "omp" {
  return /(^|[^a-z])omp(\.[a-z]+)?$/i.test(basename(bin)) ? "omp" : "opencode";
}

function findOnPath(name: string, env: Record<string, string | undefined>): string | undefined {
  for (const dir of String(env.PATH || "").split(process.platform === "win32" ? ";" : ":")) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Resolve the CLI that runs mapper/auditor passes.
 *
 * Bare `execFileSync("opencode", ...)` was ENOENT for every caller that did not
 * inherit a LOGIN shell's PATH — the systemd service, a detached spawn, cron —
 * which surfaced as a mapper that returned nothing and quarantined every
 * transcript as `no-created-node` rather than as a missing-binary error. So the
 * binary is resolved to an absolute path here, falling back to the well-known
 * install locations that a non-login PATH omits.
 */
export function resolveSubagentRunner(args: {
  explicitBin?: string;
  env: Record<string, string | undefined>;
  home?: string;
  /** Harness to try first. Without it the probe order is opencode, then omp. */
  preferKind?: "opencode" | "omp";
}): SubagentRunner | undefined {
  const explicit = String(args.explicitBin || args.env.ESHEPHERD_SUBAGENT_BIN || "").trim();
  if (explicit) return { kind: kindForBin(explicit), bin: explicit };

  const home = args.home || homedir();
  const prefer = args.preferKind || (args.env.ESHEPHERD_SUBAGENT_HARNESS || "").trim().toLowerCase();
  // A run started under omp must not spawn opencode: that loads the other
  // harness's whole plugin surface (its loop guard writes .opencode state) and
  // downgrades extension isolation from `--no-extensions` to an env-var opt-out.
  const candidates = prefer === "omp" || prefer === "opencode"
    ? [...WELL_KNOWN_BINS].sort((a, b) => (a.kind === prefer ? -1 : b.kind === prefer ? 1 : 0))
    : WELL_KNOWN_BINS;

  for (const { kind, relative } of candidates) {
    const onPath = findOnPath(kind, args.env);
    if (onPath) return { kind, bin: onPath };
    const installed = join(home, relative);
    if (existsSync(installed)) return { kind, bin: installed };
  }
  return undefined;
}

/** Strip YAML frontmatter so an agent definition can be appended as a system prompt. */
export function stripFrontmatter(markdown: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(markdown);
  return (match ? markdown.slice(match[0].length) : markdown).trim();
}

function ompAgentPromptFile(agentName: string, esRoot: string): string | undefined {
  const source = join(esRoot, "agents", `${agentName}.md`);
  if (!existsSync(source)) return undefined;
  const dir = mkdtempSync(join(tmpdir(), "eshepherd-agent-"));
  const target = join(dir, `${agentName}.md`);
  writeFileSync(target, stripFrontmatter(readFileSync(source, "utf8")), "utf8");
  return target;
}

export type SubagentInvocation = {
  runner: SubagentRunner;
  agentName?: string;
  modelArg?: string;
  prompt: string;
  esRoot?: string;
  /** Keep the pass as a readable harness session instead of an ephemeral one. */
  keepSession?: boolean;
  /** Session title when kept, so a run's passes are identifiable in a session list. */
  sessionTitle?: string;
};

/** Build the harness CLI argv for one subagent pass. Exported for tests. */
export function buildSubagentArgs(args: SubagentInvocation, promptFile?: string): string[] {
  if (args.runner.kind === "omp") {
    // omp has no --agent for a top-level run (agents are `task` subagents), so the
    // agent definition rides in as an appended system prompt. Extensions stay off
    // so a subagent pass cannot re-enter Electric Shepherd and recursively trigger
    // capture/consolidation.
    const argv = ["-p", args.prompt, "--no-extensions", "--auto-approve"];
    // omp writes the session JSONL when the run exits, not while it streams, so
    // keeping it buys a transcript per completed pass — not a live feed.
    if (args.keepSession) {
      if (args.sessionTitle) argv.push("--title", args.sessionTitle);
    } else {
      argv.push("--no-session", "--no-title");
    }
    if (promptFile) argv.push(`--append-system-prompt=${promptFile}`);
    if (args.modelArg) argv.push("--model", args.modelArg.replace(",", "/"));
    return argv;
  }

  // `opencode run` has no --no-session: it always persists. Only the title is
  // ours to set, so keepSession just makes the session findable.
  const argv = ["run", args.prompt];
  if (args.keepSession && args.sessionTitle) argv.push("--title", args.sessionTitle);
  if (args.agentName) argv.push("--agent", args.agentName);
  if (args.modelArg) argv.push("--model", args.modelArg);
  return argv;
}

export function runSubagent(args: SubagentInvocation & { timeoutMs: number }): string {
  const promptFile =
    args.runner.kind === "omp" && args.agentName && args.esRoot
      ? ompAgentPromptFile(args.agentName, args.esRoot)
      : undefined;
  const commandArgs = buildSubagentArgs(args, promptFile);

  return execFileSync(args.runner.bin, commandArgs, {
    encoding: "utf8",
    timeout: args.timeoutMs,
    maxBuffer: 2 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    env: buildIsolatedSubagentEnv(process.env),
  });
}

// A mapper pass reads every worklist drawer over MCP before it answers; a
// two-drawer batch measured ~250s, so 180s guaranteed a timeout kill on work
// that was progressing normally. Budget for real batches, not the empty case.
export function resolveSubagentTimeoutMs(env: Record<string, string | undefined>): number {
  return parsePositiveInt(env.ESHEPHERD_SUBAGENT_TIMEOUT_MS, 900000, 1000);
}

// Where worklist transcripts are staged for the mapper to read as files.
const MAPPER_EXPORT_DIR = ".electric-shepherd/scratch/mapper";

export type ReadToolFn = (name: string, args: Record<string, unknown>) => Promise<unknown>;

/**
 * A captured session transcript arrives as one enormous single-line JSON blob,
 * which every line-based reader treats as a 1-line file: paging it returns
 * "Offset 2 is out of range for this file (1 lines)", the mapper never sees the
 * content, and it falls back to broad palace queries until it burns its spawn
 * budget. Pretty-printing turns that one line into thousands, so the ordinary
 * read tools work and the mapper does not have to pick one exotic tool to make
 * progress. Content that is not JSON is written through untouched.
 */
function readableTranscript(content: string): string {
  try {
    return `${JSON.stringify(JSON.parse(content), null, 2)}\n`;
  } catch {
    return content;
  }
}

/**
 * Stage each worklist transcript as a local file and return the paths.
 *
 * The mapper used to be told to call get_drawer for every worklist id itself.
 * For a raw session transcript that returns one oversized single-line JSON
 * payload, which truncates in the agent's tool output and drives it to refetch
 * the drawer chunk by chunk — ~93 sequential MCP round-trips for one drawer,
 * enough to blow the spawn timeout and land the drawer in the failed room. A
 * programmatic get_drawer has no such display limit, so one fetch per drawer
 * here replaces the entire storm, and dream-mapper reads files instead (which
 * is what its own brief already assumed: "an `export_drawer` file path it
 * hands you").
 */
export async function exportWorklistTranscripts(args: {
  toolPrefix: string;
  worklistIds: string[];
  readTool: ReadToolFn;
}): Promise<{ drawerId: string; filePath: string }[]> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
  const exported: { drawerId: string; filePath: string }[] = [];
  for (const drawerId of args.worklistIds) {
    const response = await args.readTool(`${args.toolPrefix}get_drawer`, { drawer_id: drawerId });
    const content = drawerContentFrom(response);
    // A drawer that yields no content means the export contract is broken (wrong
    // result shape, missing drawer). Staying silent here just re-creates the
    // fetch storm via the fallback prompt, so say so and skip loudly.
    if (!content) {
      process.stderr.write(
        `[memory-consolidation-validation] mapper export skipped ${drawerId}: get_drawer returned no content\n`,
      );
      continue;
    }
    const filePath = resolve(MAPPER_EXPORT_DIR, scratchFileNameFor(drawerId, stamp));
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, readableTranscript(content), "utf8");
    exported.push({ drawerId, filePath });
  }
  return exported;
}

export async function callSubagentMapper(args: {
  toolPrefix: string;
  readTool?: ReadToolFn;
  mapperAgentName: string;
  activeModel?: PromptModelRouting;
  query: string;
  wing: string;
  room: string;
  worklistIds: string[];
  runner: SubagentRunner;
  esRoot?: string;
  timeoutMs: number;
  keepSession?: boolean;
  sessionLabel?: string;
}): Promise<MapperEnvelope> {
  const getDrawerTool = `${args.toolPrefix}get_drawer`;
  const orderedIds = args.worklistIds.filter(Boolean);
  const serializedIds = orderedIds.join(", ");
  const exported = args.readTool
    ? await exportWorklistTranscripts({
        toolPrefix: args.toolPrefix,
        worklistIds: orderedIds,
        readTool: args.readTool,
      })
    : [];
  const sourceInstructions =
    exported.length > 0
      ? [
          "Each transcript has ALREADY been exported to a local file. Read only these files, in this exact order:",
          ...exported.map((item) => `- transcriptId '${item.drawerId}' -> ${item.filePath}`),
          "These are large single-line JSON session transcripts. Call file-reader_info first for size, then page with file-reader_json_session_extract_messages (start_index/limit). Never read a whole file in one call.",
          `Do NOT call ${getDrawerTool}, search, or any other MemPalace tool. The files are the complete source.`,
        ]
      : [
          `Use tool: ${getDrawerTool} for EACH drawer id in this exact order: ${serializedIds}.`,
          "Do not use search or any broad query tools. Process only the provided IDs.",
        ];
  const taskPrompt = [
    "Read the exact worklist transcripts and produce mapper summaries as JSON array.",
    `Scope context: wing='${args.wing}', room='${args.room}', query='${args.query}'.`,
    ...sourceInstructions,
    "Return ONLY valid JSON array with items shaped as:",
    "{ transcriptId, confidence, durableFacts[], decisions[], rootCausesAndWorkedExamples[], subsystemsAndFiles[], openItems[], deadEnds[], rawExcerpt? }",
    "deadEnds[]: one line each for approaches TRIED AND FAILED or CONSIDERED AND REJECTED in this transcript, shaped `- <what was tried> | outcome: <what happened> | because: \"<why abandoned>\" | polarity: tried-failed|considered-rejected`. Each line MUST carry its outcome clause. Write an empty array when nothing qualifies — do not manufacture dead ends.",
  ].join("\n");

  try {
    const startedAt = Date.now();
    process.stderr.write(
      `[memory-consolidation-validation] mapper ${args.runner.kind}-run start agent=${args.mapperAgentName} bin=${args.runner.bin} timeoutMs=${args.timeoutMs}\n`,
    );
    const output = runSubagent({
      runner: args.runner,
      esRoot: args.esRoot,
      agentName: args.mapperAgentName,
      modelArg: formatPromptModelArg(args.activeModel),
      prompt: taskPrompt,
      timeoutMs: args.timeoutMs,
      keepSession: args.keepSession,
      sessionTitle: args.sessionLabel ? `es-mapper ${args.sessionLabel}` : undefined,
    });
    const parsedJSON = parseEmbeddedJSON(output, (value) => toSummaryFromRaw(value).length > 0);
    if (parsedJSON) {
      const summaries = toSummaryFromRaw(parsedJSON);
      if (summaries.length > 0) {
        process.stderr.write(
          `[memory-consolidation-validation] mapper ${args.runner.kind}-run done summaries=${summaries.length} durationMs=${Date.now() - startedAt}\n`,
        );
        return { summaries, raw: output, via: `${args.runner.kind}-run` as SubagentVia };
      }
    }
    const sectionSummaries = parseMapperSections(output, orderedIds);
    if (sectionSummaries.length > 0) {
      process.stderr.write(
        `[memory-consolidation-validation] mapper ${args.runner.kind}-run done summaries=${sectionSummaries.length} format=sections durationMs=${Date.now() - startedAt}\n`,
      );
      return { summaries: sectionSummaries, raw: output, via: `${args.runner.kind}-run` as SubagentVia };
    }
    const debugPath = `${SUBAGENT_DEBUG_DIR}/mapper-${Date.now()}.txt`;
    try {
      mkdirSync(SUBAGENT_DEBUG_DIR, { recursive: true });
      writeFileSync(debugPath, output, "utf8");
      process.stderr.write(
        `[memory-consolidation-validation] mapper output unusable parsed=${parsedJSON ? "yes" : "no"} raw=${debugPath}\n`,
      );
    } catch {
      // Debug capture is best-effort.
    }
  } catch (err) {
    process.stderr.write(
      `[memory-consolidation-validation] mapper ${args.runner.kind}-run failed err=${String(err)}\n`,
    );
  }

  process.stderr.write("[memory-consolidation-validation] mapper unavailable (no parseable opencode output)\n");

  return { summaries: [], raw: null, via: "none" };
}

export async function callSubagentAuditor(args: {
  auditorAgentName: string;
  activeModel?: PromptModelRouting;
  consolidationResult: unknown;
  validationResult: unknown;
  runner: SubagentRunner;
  esRoot?: string;
  timeoutMs: number;
  keepSession?: boolean;
  sessionLabel?: string;
}): Promise<AuditorEnvelope> {
  const taskPrompt = [
    "Audit consolidation and validation outputs.",
    "Return ONLY valid JSON object shaped as:",
    "{ verdict: pass|revise|escalate, findings: string[], recommendedActions: string[] }",
    "Consolidation result:",
    JSON.stringify(args.consolidationResult),
    "Validation result:",
    JSON.stringify(args.validationResult),
  ].join("\n");

  let verdict: "pass" | "revise" | "escalate" = "pass";
  let findings: string[] = [];
  let recommendedActions: string[] = [];

  try {
    const startedAt = Date.now();
    process.stderr.write(
      `[memory-consolidation-validation] auditor ${args.runner.kind}-run start agent=${args.auditorAgentName} bin=${args.runner.bin} timeoutMs=${args.timeoutMs}\n`,
    );
    const output = runSubagent({
      runner: args.runner,
      esRoot: args.esRoot,
      agentName: args.auditorAgentName,
      modelArg: formatPromptModelArg(args.activeModel),
      prompt: taskPrompt,
      timeoutMs: args.timeoutMs,
      keepSession: args.keepSession,
      sessionTitle: args.sessionLabel ? `es-auditor ${args.sessionLabel}` : undefined,
    });
    const parsed = asObject(
      parseEmbeddedJSON(output, (value) => {
        const candidate = asString(asObject(value).verdict).toLowerCase();
        return candidate === "pass" || candidate === "revise" || candidate === "escalate";
      }),
    );
    if (Object.keys(parsed).length > 0) {
      const parsedVerdict = asString(parsed.verdict).toLowerCase();
      if (parsedVerdict === "pass" || parsedVerdict === "revise" || parsedVerdict === "escalate") {
        verdict = parsedVerdict;
      }
      findings = asArray(parsed.findings).map((v) => asString(v)).filter(Boolean);
      recommendedActions = asArray(parsed.recommendedActions || parsed.recommended_actions)
        .map((v) => asString(v))
        .filter(Boolean);
      process.stderr.write(
        `[memory-consolidation-validation] auditor ${args.runner.kind}-run done verdict=${verdict} findings=${findings.length} durationMs=${Date.now() - startedAt}\n`,
      );
      return { verdict, findings, recommendedActions, raw: output, via: `${args.runner.kind}-run` as SubagentVia };
    }
  } catch (err) {
    process.stderr.write(
      `[memory-consolidation-validation] auditor ${args.runner.kind}-run failed err=${String(err)}\n`,
    );
  }

  process.stderr.write("[memory-consolidation-validation] auditor unavailable (no parseable subagent output)\n");

  return {
    verdict: "escalate",
    findings: ["auditor output unavailable; no parseable subagent output"],
    recommendedActions: ["retry with --use-live-auditor after confirming agent output format"],
    raw: null,
    via: "none",
  };
}
