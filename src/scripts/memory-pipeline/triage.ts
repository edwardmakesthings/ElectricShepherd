/**
 * Triage — the cheap first pass of a two-pass consolidation.
 *
 * A 15k-drawer transcript backlog cannot be fed to a thorough model directly:
 * the per-drawer cost is dominated by deliberation, and much of a captured
 * session is tool traffic or the memory system narrating itself. This pass runs
 * a fast, shallow model over everything once to locate WHERE durable value sits,
 * so the thorough pass reads marked regions instead of whole transcripts.
 *
 * Two design rules, both load-bearing:
 *
 * 1. The model is asked a DETECTION question ("which ranges contain a decision /
 *    root cause / fix / preference / dead end"), never a judgement one ("is this
 *    valuable"). Shallow models are good at the former and bad at the latter,
 *    and a wrong judgement here silently discards real work. "Noise" is
 *    therefore EMERGENT — it is what zero spans looks like — not a verdict the
 *    model renders.
 *
 * 2. The verdict is computed here, deterministically, from a span count that is
 *    stamped alongside it. Recalibrating the threshold later is then a range
 *    query over `es-triage-score`, not a re-run of the whole backlog.
 *
 * Failure is never rejection. A triage pass that errors, times out, or omits an
 * id leaves that drawer exactly where it was, to be picked up by a later pass.
 * Treating a tooling failure as "no value here" would be indistinguishable from
 * data loss.
 */

import { mkdirSync, writeFileSync } from "node:fs";

import {
  exportWorklistTranscripts,
  formatPromptModelArg,
  parseEmbeddedJSON,
  runSubagent,
  type ReadToolFn,
  type SubagentRunner,
  type SubagentVia,
} from "./subagent.ts";
import type { PromptModelRouting } from "./runtime-utils.ts";
import { parseModelSelector } from "./runtime-utils.ts";
import { asArray, asObject, asString, getArg, hasFlag, parsePositiveInt } from "./cli-options.ts";
import { getFamilyDrawerIds } from "./worklist-helpers.ts";
import type { SourceDrawerWorkItem } from "../../core/memgraph.ts";

const TRIAGE_DEBUG_DIR = ".electric-shepherd/scratch/subagent-output";

/** Evidence kinds the triage pass looks for. Mirrors the mapper's own sections. */
export const TRIAGE_SPAN_KINDS = ["decision", "root-cause", "fix", "preference", "dead-end"] as const;
export type TriageSpanKind = (typeof TRIAGE_SPAN_KINDS)[number];

export type TriageSpan = {
  kind: TriageSpanKind;
  start: number;
  end: number;
  note?: string;
};

export type TriageFinding = {
  transcriptId: string;
  spans: TriageSpan[];
  /** Deterministic salience score. Currently the span count; stamped so the threshold stays recalibratable. */
  score: number;
  kinds: TriageSpanKind[];
};

export type TriageEnvelope = {
  findings: TriageFinding[];
  raw: unknown;
  via: SubagentVia;
};

/** `rich` continues to the thorough pass; `noise` is filed aside but kept. */
export type TriageVerdict = "rich" | "noise";

export type TriageOutcome = {
  drawer_id: string;
  family_drawer_ids: string[];
  verdict: TriageVerdict | "unavailable";
  score: number;
  kinds: TriageSpanKind[];
  reason: string;
};

function normalizeKind(value: unknown): TriageSpanKind | undefined {
  const raw = asString(value).trim().toLowerCase().replace(/[\s_]+/g, "-");
  return (TRIAGE_SPAN_KINDS as readonly string[]).includes(raw) ? (raw as TriageSpanKind) : undefined;
}

/**
 * Parse the triage agent's JSON into findings, keeping only requested ids.
 *
 * A fabricated id is dropped rather than trusted: the whole point of this pass
 * is to decide what happens to a specific drawer, and an id the worklist never
 * contained cannot be resolved to one. Exported for tests.
 */
export function parseTriageFindings(raw: unknown, requestedIds: readonly string[]): TriageFinding[] {
  const requested = new Set(requestedIds.filter(Boolean));
  const byId = new Map<string, TriageFinding>();

  for (const item of asArray(raw)) {
    const obj = asObject(item);
    const transcriptId = asString(obj.transcriptId ?? obj.transcript_id ?? obj.id).trim();
    if (!transcriptId || !requested.has(transcriptId)) continue;

    const spans: TriageSpan[] = [];
    for (const rawSpan of asArray(obj.spans)) {
      const spanObj = asObject(rawSpan);
      const kind = normalizeKind(spanObj.kind ?? spanObj.type);
      if (!kind) continue;
      const start = Number(spanObj.start);
      const end = Number(spanObj.end);
      spans.push({
        kind,
        start: Number.isFinite(start) ? start : 0,
        end: Number.isFinite(end) ? end : 0,
        note: asString(spanObj.note).trim() || undefined,
      });
    }

    // A repeated id merges rather than overwrites, so a model that splits one
    // transcript across entries does not lose the earlier spans.
    const existing = byId.get(transcriptId);
    const merged = existing ? [...existing.spans, ...spans] : spans;
    byId.set(transcriptId, {
      transcriptId,
      spans: merged,
      score: merged.length,
      kinds: [...new Set(merged.map((span) => span.kind))].sort(),
    });
  }

  return [...byId.values()];
}

/** Deterministic verdict from a stamped score. Exported for tests. */
export function triageVerdict(score: number, minScore: number): TriageVerdict {
  return score >= minScore ? "rich" : "noise";
}

export type TriageOptions = {
  /** Run triage as its own phase and stop, so the cheap model loads once for the whole backlog. */
  only: boolean;
  model?: PromptModelRouting;
  agentName: string;
  /** Drawers per subagent call. A large-context triage model should batch generously. */
  batchSize: number;
  /** Minimum span count to stay in the source room. */
  minScore: number;
  /** Where `noise` drawers are filed. Deliberately NOT the processed room. */
  rejectedRoom: string;
  timeoutMs: number;
  keepSessions: boolean;
};

/**
 * Parse triage options.
 *
 * `--triage-only` is a PHASE selector, not a feature toggle, and that is the
 * point: on a single-GPU host, interleaving a cheap triage model with a
 * thorough consolidation model per chunk pays a full model load every time they
 * alternate. Running triage over the whole backlog first, then consolidating
 * the survivors, loads each model once.
 */
export function parseTriageOptions(
  argv: string[],
  runtimeConfig: { valuesByPath: Record<string, any> },
  fallbackSourceRoom: string,
): TriageOptions {
  const configured = (runtimeConfig.valuesByPath.consolidation?.triage || {}) as Record<string, unknown>;
  const modelSelector = String(getArg(argv, "--triage-model") || configured.model || "").trim();
  const model = modelSelector ? parseModelSelector(modelSelector) : undefined;
  if (modelSelector && !model) {
    process.stderr.write(
      `[memory-consolidation-validation] ignoring triage model "${modelSelector}": expected "<provider>/<model>"\n`,
    );
  }

  return {
    only: hasFlag(argv, "--triage-only"),
    model,
    agentName: getArg(argv, "--triage-agent") || String(configured.agent || "").trim() || "drawer-triage",
    batchSize: parsePositiveInt(getArg(argv, "--triage-batch-size") ?? configured.batchSize, 10),
    minScore: parsePositiveInt(getArg(argv, "--triage-min-score") ?? configured.minScore, 1),
    rejectedRoom:
      getArg(argv, "--triage-rejected-room") ||
      String(configured.rejectedRoom || "").trim() ||
      `${fallbackSourceRoom}-triage-rejected`,
    timeoutMs: parsePositiveInt(getArg(argv, "--triage-timeout-ms"), 600000, 1000),
    keepSessions: hasFlag(argv, "--keep-triage-sessions"),
  };
}

export async function callSubagentTriage(args: {
  toolPrefix: string;
  readTool?: ReadToolFn;
  agentName: string;
  activeModel?: PromptModelRouting;
  wing: string;
  room: string;
  worklistIds: string[];
  runner: SubagentRunner;
  esRoot?: string;
  timeoutMs: number;
  keepSession?: boolean;
  sessionLabel?: string;
}): Promise<TriageEnvelope> {
  const orderedIds = args.worklistIds.filter(Boolean);
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
          "Each transcript has ALREADY been exported to a local file. Read only these files:",
          ...exported.map((item) => `- transcriptId '${item.drawerId}' -> ${item.filePath}`),
          "These are large single-line JSON session transcripts. Call file-reader_info first, then outline with file-reader_json_session_extract_messages using roles:[\"user\"] and a large limit before reading any region closely.",
          "Do NOT call any MemPalace tool. The files are the complete source.",
        ]
      : [
          `Use tool: ${args.toolPrefix}get_drawer for EACH drawer id in this exact order: ${orderedIds.join(", ")}.`,
          "Do not use search or any broad query tools. Process only the provided IDs.",
        ];

  const taskPrompt = [
    "Locate where durable value sits in each transcript. Do NOT summarize and do NOT judge whether a transcript is worth keeping.",
    `Scope context: wing='${args.wing}', room='${args.room}'.`,
    ...sourceInstructions,
    `Report a span for each sustained passage of kind: ${TRIAGE_SPAN_KINDS.join(", ")}. A passing mention is not a span; tool traffic and status chatter are not spans.`,
    "Return ONLY a valid JSON array with items shaped as:",
    "{ transcriptId, spans: [{ kind, start, end, note }] }",
    "Include an entry for EVERY transcript id you were given, using an empty spans array when a transcript genuinely has none. A missing id is treated as not-examined and wastes this pass.",
  ].join("\n");

  try {
    const startedAt = Date.now();
    process.stderr.write(
      `[memory-consolidation-validation] triage ${args.runner.kind}-run start agent=${args.agentName} drawers=${orderedIds.length} timeoutMs=${args.timeoutMs}\n`,
    );
    const output = runSubagent({
      runner: args.runner,
      esRoot: args.esRoot,
      agentName: args.agentName,
      modelArg: formatPromptModelArg(args.activeModel),
      prompt: taskPrompt,
      timeoutMs: args.timeoutMs,
      keepSession: args.keepSession,
      sessionTitle: args.sessionLabel ? `es-triage ${args.sessionLabel}` : undefined,
    });

    const parsed = parseEmbeddedJSON(output, (value) => parseTriageFindings(value, orderedIds).length > 0);
    if (parsed) {
      const findings = parseTriageFindings(parsed, orderedIds);
      if (findings.length > 0) {
        process.stderr.write(
          `[memory-consolidation-validation] triage ${args.runner.kind}-run done findings=${findings.length}/${orderedIds.length} durationMs=${Date.now() - startedAt}\n`,
        );
        return { findings, raw: output, via: `${args.runner.kind}-run` as SubagentVia };
      }
    }

    const debugPath = `${TRIAGE_DEBUG_DIR}/triage-${Date.now()}.txt`;
    try {
      mkdirSync(TRIAGE_DEBUG_DIR, { recursive: true });
      writeFileSync(debugPath, output, "utf8");
      process.stderr.write(`[memory-consolidation-validation] triage output unusable raw=${debugPath}\n`);
    } catch {
      // Debug capture is best-effort.
    }
  } catch (err) {
    process.stderr.write(
      `[memory-consolidation-validation] triage ${args.runner.kind}-run failed err=${String(err)}\n`,
    );
  }

  return { findings: [], raw: null, via: "none" };
}

type TriageClient = {
  updateDrawer(args: Record<string, unknown>): Promise<unknown>;
  kgAdd(args: { subject: string; predicate: string; object: string; source_run_id?: string }): Promise<unknown>;
};

/**
 * Stamp one drawer's triage result and file it if it scored below the bar.
 *
 * Both the verdict and the raw score are stamped. The score is what makes the
 * threshold a decision you can revisit: lowering the bar later reads back as a
 * range query instead of another full pass over the backlog.
 */
async function applyTriageOutcome(
  client: TriageClient,
  args: {
    item: SourceDrawerWorkItem;
    finding: TriageFinding;
    verdict: TriageVerdict;
    targetWing: string;
    rejectedRoom: string;
    runId?: string;
  },
): Promise<{ errors: string[] }> {
  const errors: string[] = [];
  const familyIds = getFamilyDrawerIds(args.item);

  for (const drawerId of familyIds) {
    for (const [predicate, object] of [
      ["es-triage", args.verdict],
      ["es-triage-score", String(args.finding.score)],
    ] as const) {
      try {
        await client.kgAdd({ subject: drawerId, predicate, object, source_run_id: args.runId });
      } catch (err) {
        errors.push(`${drawerId} ${predicate}: ${String(err)}`);
      }
    }
  }

  if (args.verdict === "noise") {
    for (const drawerId of familyIds) {
      try {
        await client.updateDrawer({
          drawer_id: drawerId,
          wing: (args.item.wing || "").trim() || args.targetWing,
          room: args.rejectedRoom,
        });
      } catch (err) {
        errors.push(`${drawerId} move: ${String(err)}`);
      }
    }
  }

  return { errors };
}

export type TriagePhaseResult = {
  phase: "triage";
  examined: number;
  rich: number;
  noise: number;
  unavailable: number;
  applyWrites: boolean;
  minScore: number;
  rejectedRoom: string;
  outcomes: TriageOutcome[];
  errors: string[];
};

/**
 * Run the triage pass over a worklist.
 *
 * `rich` drawers are stamped and left in the source room, so the existing
 * consolidation pass picks them up unchanged on the next run. `noise` drawers
 * are stamped and moved to `rejectedRoom` — which stops them being re-examined
 * exactly as effectively as the processed room would, while keeping them
 * answerable later. They are not "done", they are "not looked at closely", and
 * conflating those two is how a mis-scored drawer becomes unrecoverable.
 */
export async function runTriagePhase(args: {
  client: TriageClient;
  chunks: SourceDrawerWorkItem[][];
  options: TriageOptions;
  toolPrefix: string;
  readTool?: ReadToolFn;
  runner?: SubagentRunner;
  esRoot?: string;
  targetWing: string;
  sourceRoom: string;
  applyWrites: boolean;
  runId?: string;
  onProgress?: (patch: Record<string, unknown>, counters: Record<string, number>) => void;
  /** Seam for tests; defaults to the real subagent call. */
  callTriage?: typeof callSubagentTriage;
}): Promise<TriagePhaseResult> {
  const outcomes: TriageOutcome[] = [];
  const errors: string[] = [];
  const callTriage = args.callTriage ?? callSubagentTriage;
  let examined = 0;

  for (const [chunkIndex, chunk] of args.chunks.entries()) {
    const worklistIds = [...new Set(chunk.flatMap((item) => getFamilyDrawerIds(item)))];
    examined += chunk.length;

    const envelope = args.runner
      ? await callTriage({
          toolPrefix: args.toolPrefix,
          readTool: args.readTool,
          agentName: args.options.agentName,
          activeModel: args.options.model,
          wing: args.targetWing,
          room: args.sourceRoom,
          worklistIds,
          runner: args.runner,
          esRoot: args.esRoot,
          timeoutMs: args.options.timeoutMs,
          keepSession: args.options.keepSessions,
          sessionLabel: `${args.runId ?? ""} chunk ${chunkIndex + 1}/${args.chunks.length}`.trim(),
        })
      : ({ findings: [], raw: null, via: "none" } as TriageEnvelope);

    const byId = new Map(envelope.findings.map((finding) => [finding.transcriptId, finding]));

    for (const item of chunk) {
      // Any id in the family answering is enough: the family is one transcript
      // split across drawers, so spans found in any part describe the whole.
      const familyIds = getFamilyDrawerIds(item);
      const found = familyIds.map((id) => byId.get(id)).filter(Boolean) as TriageFinding[];

      if (found.length === 0) {
        outcomes.push({
          drawer_id: item.drawer_id,
          family_drawer_ids: familyIds,
          verdict: "unavailable",
          score: 0,
          kinds: [],
          reason: envelope.via === "none" ? "triage-unavailable" : "triage-omitted-id",
        });
        continue;
      }

      const spans = found.flatMap((finding) => finding.spans);
      const finding: TriageFinding = {
        transcriptId: item.drawer_id,
        spans,
        score: spans.length,
        kinds: [...new Set(spans.map((span) => span.kind))].sort(),
      };
      const verdict = triageVerdict(finding.score, args.options.minScore);

      if (args.applyWrites) {
        const applied = await applyTriageOutcome(args.client, {
          item,
          finding,
          verdict,
          targetWing: args.targetWing,
          rejectedRoom: args.options.rejectedRoom,
          runId: args.runId,
        });
        errors.push(...applied.errors);
      }

      outcomes.push({
        drawer_id: item.drawer_id,
        family_drawer_ids: familyIds,
        verdict,
        score: finding.score,
        kinds: finding.kinds,
        reason: verdict === "rich" ? "spans-found" : "below-min-score",
      });
    }

    args.onProgress?.(
      { phase: "triage-chunk", currentChunk: chunkIndex + 1, totalChunks: args.chunks.length },
      {
        chunkIndex: chunkIndex + 1,
        chunkTotal: args.chunks.length,
        examinedCount: examined,
        triageRichCount: outcomes.filter((o) => o.verdict === "rich").length,
        triageNoiseCount: outcomes.filter((o) => o.verdict === "noise").length,
      },
    );

    process.stderr.write(
      `[memory-consolidation-validation] triage chunk ${chunkIndex + 1}/${args.chunks.length} rich=${outcomes.filter((o) => o.verdict === "rich").length} noise=${outcomes.filter((o) => o.verdict === "noise").length} unavailable=${outcomes.filter((o) => o.verdict === "unavailable").length}\n`,
    );
  }

  return {
    phase: "triage",
    examined,
    rich: outcomes.filter((o) => o.verdict === "rich").length,
    noise: outcomes.filter((o) => o.verdict === "noise").length,
    unavailable: outcomes.filter((o) => o.verdict === "unavailable").length,
    applyWrites: args.applyWrites,
    minScore: args.options.minScore,
    rejectedRoom: args.options.rejectedRoom,
    outcomes,
    errors,
  };
}
