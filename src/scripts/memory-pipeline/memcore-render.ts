/**
 * Mem-core markdown rendering + path resolution for the consolidation pipeline.
 * Extracted from run-memory-consolidation-and-validation.ts (criterion 2).
 */
import { existsSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import type { SynthesisConsolidationResult } from "../../capability/episodic/synthesis-consolidation.ts";
import type { ValidationMergeReviewResult } from "../../policy/validation-merge-review.ts";
import type { AuditorEnvelope } from "./subagent.ts";
import { asObject, asArray, asString } from "./cli-options.ts";
import { parseDeadEndDrawerContent, renderDeadEndsBlock } from "../../capability/negative/dead-ends.ts";

export function findWorkspaceRoot(startDir: string): string {
  let current = resolve(startDir);
  while (true) {
    if (existsSync(`${current}/package.json`) || existsSync(`${current}/.git`)) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

export function resolveMemcoreFilePath(args: {
  explicitFilePath?: string;
  explicitBaseDir?: string;
  scopeDir?: string;
}): string {
  if (args.explicitFilePath) {
    return resolve(args.explicitFilePath);
  }

  const configured = args.explicitBaseDir ? resolve(args.explicitBaseDir) : undefined;
  const candidates = [configured, resolve(".electric-shepherd/memory")].filter(Boolean) as string[];
  const existing = candidates.find((dir) => existsSync(dir));
  const base = existing || resolve(".electric-shepherd/memory");
  const scopeDir = resolve(args.scopeDir || process.cwd());
  const workspaceRoot = findWorkspaceRoot(scopeDir);
  const relScope = relative(workspaceRoot, scopeDir);
  if (!relScope || relScope === ".") {
    return resolve(base, "memory.md");
  }
  if (relScope.startsWith("..")) {
    return resolve(base, "memory.md");
  }
  return resolve(base, relScope, "memory.md");
}

export function pointerBullets(values: string[], formatter: (value: string) => string, max = 40): string[] {
  const unique = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  if (unique.length === 0) return ["- (none)"];
  const out = unique.slice(0, max).map((value) => `- ${formatter(value)}`);
  if (unique.length > max) out.push(`- ... (${unique.length - max} more)`);
  return out;
}

export function pointerDescription(value: string | undefined, fallback: string): string {
  const text = asString(value).replace(/\s+/g, " ").trim();
  if (!text) return fallback;
  if (looksLikeToolOutputFragment(text)) return fallback;
  return text.length > 100 ? `${text.slice(0, 97)}...` : text;
}

export function normalizeSummaryLine(value: string): string {
  return asString(value).replace(/\s+/g, " ").trim();
}

export function looksLikeToolOutputFragment(text: string): boolean {
  const line = normalizeSummaryLine(text);
  if (!line) return true;
  if (/^"(?:output|text)"\s*:/.test(line)) return true;
  if (/^\{\s*"(?:info|output|drawers|messages|tool|time)"\s*:/.test(line)) return true;
  if (/^\{b\[\d+:\d+\]\}/.test(line)) return true;
  if (/\b(nudge\s+\d+\/\d+\s+this\s+session)\b/i.test(line)) return true;
  if (line.includes('"id":"prt_') || line.includes('"sessionID":"ses_')) return true;
  if ((line.includes('\\n') || line.includes('\\"')) && line.includes("{") && line.includes("}")) return true;
  return false;
}

export function factBullets(values: string[], max: number): string[] {
  const unique = [
    ...new Set(
      values
        .map((value) => normalizeSummaryLine(value))
        .filter(Boolean)
        .filter((value) => !looksLikeToolOutputFragment(value)),
    ),
  ];
  if (unique.length === 0) return ["- (none)"];
  const out = unique.slice(0, max).map((value) => `- ${value.length > 200 ? `${value.slice(0, 197)}...` : value}`);
  if (unique.length > max) out.push(`- ... (${unique.length - max} more; see pointers below)`);
  return out;
}

type MemgraphClientLike = {
  listScopedDerivedDrawers(args: Record<string, unknown>): Promise<unknown>;
};

export async function fetchHighHeightFacts(
  client: MemgraphClientLike,
  args: { wing: string; room: string; minHeight?: number; limit?: number },
): Promise<string[]> {
  const minHeight = Math.max(0, Number(args.minHeight) || 2);
  const limit = Math.max(1, Number(args.limit) || 8);
  try {
    const result = await client.listScopedDerivedDrawers({
      scope_wing: args.wing,
      scope_room: args.room,
      limit: 200,
    });
    const nodes = asArray((result as Record<string, unknown>).nodes) as Array<Record<string, unknown>>;
    const ranked = nodes
      .map((node) => ({
        text: normalizeSummaryLine(asString(node.desc || node.content)),
        height: Number(node.height) || 0,
        connectionDegree: Number(node.connection_degree) || 0,
        retrievalCount: Number(node.retrieval_count) || 0,
      }))
      .filter((node) => node.text && node.height >= minHeight && !looksLikeToolOutputFragment(node.text))
      .sort((a, b) => b.height - a.height || b.connectionDegree - a.connectionDegree || b.retrievalCount - a.retrievalCount);
    return [...new Set(ranked.map((node) => node.text))].slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * Exported (not just module-local) so the [pending] block's cap/disable behavior
 * is unit-testable without running the whole pipeline — the render is on the hot
 * path of every prompt, and "every new mem-core render addition must be capped"
 * (spec L232-233) needs a test that pins the bound.
 */
export function buildMemcoreMarkdown(args: {
  query: string;
  consolidation: SynthesisConsolidationResult;
  validation: ValidationMergeReviewResult;
  auditor?: AuditorEnvelope;
  sourceDescriptions?: Record<string, string>;
  includeFacts?: boolean;
  includePointers?: boolean;
  maxFactsPerSection?: number;
  highHeightFacts?: string[];
  pendingReminderLines?: string[];
  includePending?: boolean;
  deadEndLines?: string[];
  includeDeadEnds?: boolean;
  maxDeadEnds?: number;
}): string {
  const includeFacts = args.includeFacts !== false;
  const includePointers = args.includePointers !== false;
  const maxFacts = Math.max(1, Number(args.maxFactsPerSection) || 8);
  const runId = asString(args.consolidation.runId).trim();
  const runPointer = runId ? `.electric-shepherd/journal/${runId}.jsonl` : "(none)";
  const draftTitle = pointerDescription(args.consolidation.consolidationDraft.title, "latest synthesis");
  const sourceDescriptions = args.sourceDescriptions || {};
  const verdictByNode = new Map(args.validation.downwardValidation.map((item) => [item.nodeId, item.verdict]));
  const createdNodePointers = args.consolidation.createdNodeId ? [args.consolidation.createdNodeId] : [];
  const sourceDrawerPointers = args.consolidation.sourceDrawerIds || [];
  const validationNodePointers = args.validation.downwardValidation.map((item) => item.nodeId);
  const escalationNodePointers = args.validation.escalations.nodeIds || [];
  const mergePairPointers = args.validation.escalations.mergePairs.map(
    (pair) => `${pair.sourceNodeId} -> ${pair.canonicalNodeId} (score=${Number(pair.score).toFixed(3)})`,
  );
  const auditorPointer = args.auditor ? `available in run trace (via=${args.auditor.via})` : "(not-run)";

  const highHeightFacts = args.highHeightFacts || [];
  const projectStateFacts = highHeightFacts.length > 0 ? highHeightFacts : args.consolidation.consolidationDraft.durableFacts || [];

  const lines: string[] = ["# Labeled memory blocks (always in context)", ""];

  if (includeFacts) {
    lines.push(
      "Facts below are resident: use them directly, no retrieval call needed.",
      "",
      "## [project-state]",
      `- Latest synthesis: ${draftTitle}`,
      ...factBullets(projectStateFacts, maxFacts),
      "",
      "## [active-conventions]",
      ...factBullets(args.consolidation.consolidationDraft.decisions || [], maxFacts),
      "",
      "## [open-items]",
      ...factBullets(args.consolidation.consolidationDraft.openItems || [], maxFacts),
      "",
    );

    if (args.includePending !== false && Array.isArray(args.pendingReminderLines) && args.pendingReminderLines.length > 0) {
      lines.push(...args.pendingReminderLines, "");
    }

    if (args.includeDeadEnds !== false && Array.isArray(args.deadEndLines) && args.deadEndLines.length > 0) {
      const maxDeadEnds = Math.max(0, Number(args.maxDeadEnds) || 3);
      const block = renderDeadEndsBlock(args.deadEndLines, maxDeadEnds);
      if (block.length > 0) lines.push(...block, "");
    }
  }

  if (includePointers) {
    lines.push(
      "Pointer index: open with `get_drawer` only when a description matches the current task.",
      "",
      "## [pointers]",
      `- Consolidation run log: ${runPointer}`,
      "- Latest synthesis:",
      ...pointerBullets(createdNodePointers, (id) => `node_id:${id} — ${draftTitle}`),
      "- Source transcripts consolidated in the latest run:",
      ...pointerBullets(sourceDrawerPointers, (id) => `drawer_id:${id} — ${pointerDescription(sourceDescriptions[id], "source transcript")}`),
      "- Synthesis nodes reviewed by validation:",
      ...pointerBullets(validationNodePointers, (id) => `node_id:${id} — validation ${verdictByNode.get(id) ?? "reviewed"}`),
      "- Nodes escalated for human review:",
      ...pointerBullets(escalationNodePointers, (id) => `node_id:${id} — needs review`),
      "- Merge pairs escalated:",
      ...pointerBullets(mergePairPointers, (entry) => entry),
      "",
      "## [auditor-findings]",
      `- Auditor review: ${auditorPointer}`,
    );
  }

  return lines.join("\n");
}


type ReminderRow = {
  drawer_id?: string;
  what?: string;
  status?: string;
  conditions?: string[];
  expires_at?: string;
  satisfied_at?: string;
};

type MemgraphClientForMemcore = {
  listReminders?(args: Record<string, unknown>): Promise<ReminderRow[]>;
  listScopedDerivedDrawers?(args: Record<string, unknown>): Promise<unknown>;
  getRulesOut?(nodeId: string): Promise<{ statements: string[]; polarities: string[] }>;
  getDrawer?(args: Record<string, unknown>): Promise<unknown>;
};

export async function fetchPendingReminderLines(args: {
  client: MemgraphClientForMemcore;
  wing: string;
  room: string;
  query: string;
  scopeDir?: string;
  maxPending: number;
}): Promise<string[]> {
  if (args.maxPending <= 0 || typeof args.client.listReminders !== "function") return [];
  try {
    const scopeDir = resolve(args.scopeDir || process.cwd());
    const workspaceRoot = findWorkspaceRoot(scopeDir);
    const relScope = relative(workspaceRoot, scopeDir);
    const relScopes: string[] = [];
    let current = relScope;
    while (true) {
      relScopes.push(current === "." ? "" : current);
      if (!current || current === ".") break;
      const parent = dirname(current);
      if (parent === current || parent === ".") break;
      current = parent;
    }
    const reminders = await args.client.listReminders!({
      wing: args.wing,
      limit: Math.min(50, Math.max(args.maxPending * 3, 12)),
    });
    const { matchRemindersForScope, renderPendingLines } = await import("../../capability/prospective/prospective.ts");
    // listReminders returns loose rows; shape them into ReminderFact so the matcher's
    // status gate (active-only) sees a closed value. Unknown statuses degrade to
    // "active" — same default as before this extraction.
    const matches = matchRemindersForScope(
      reminders.map((reminder): import("../../capability/prospective/prospective.ts").ReminderFact => ({
        drawer_id: String(reminder.drawer_id || ""),
        what: String(reminder.what || ""),
        conditions: Array.isArray(reminder.conditions) ? reminder.conditions.map(String) : [],
        status: (String(reminder.status || "active").trim().toLowerCase() || "active") as import("../../capability/prospective/prospective.ts").ReminderStatus,
        ...(reminder.expires_at !== undefined ? { expires_at: String(reminder.expires_at) } : {}),
        ...(reminder.satisfied_at !== undefined ? { satisfied_at: String(reminder.satisfied_at) } : {}),
      })),
      {
        relScopes,
        wing: args.wing,
        room: args.room,
        query: args.query,
      },
    );
    return renderPendingLines(matches, args.maxPending);
  } catch (err) {
    process.stderr.write(`[memory-consolidation-validation] pending-reminder fetch failed: ${String(err)}\n`);
    return [];
  }
}

export async function fetchDeadEndLines(args: {
  client: MemgraphClientForMemcore;
  wing: string;
  room: string;
  draftDeadEnds: string[];
  maxDeadEnds: number;
}): Promise<string[]> {
  let deadEndLines: string[] = [...args.draftDeadEnds];
  if (deadEndLines.length > 0 || args.maxDeadEnds <= 0) return deadEndLines.slice(0, args.maxDeadEnds * 3);
  if (typeof args.client.listScopedDerivedDrawers !== "function" || typeof args.client.getRulesOut !== "function") {
    return [];
  }
  try {
    const scopeResult = await args.client.listScopedDerivedDrawers!({
      scope_wing: args.wing,
      scope_room: args.room,
      limit: Math.min(50, args.maxDeadEnds * 3),
    });
    const nodes = asArray((scopeResult as Record<string, unknown>).nodes) as Array<Record<string, unknown>>;
    for (const node of nodes) {
      if (deadEndLines.length >= args.maxDeadEnds) break;
      const nodeId = asString(node.node_id || node.drawer_id || node.id).trim();
      if (!nodeId) continue;
      const rulesOut = await args.client.getRulesOut!(nodeId).catch(() => ({ statements: [] as string[], polarities: [] as string[] }));
      if (rulesOut.statements.length === 0) continue;
      const drawer = await args.client.getDrawer?.({ drawer_id: nodeId }).catch(() => ({}));
      const content = asString((drawer as Record<string, unknown>).content || (drawer as Record<string, unknown>).text).trim();
      const lines = parseDeadEndDrawerContent(content);
      for (const line of lines) {
        if (deadEndLines.length >= args.maxDeadEnds * 3) break;
        deadEndLines.push(line);
      }
    }
    return deadEndLines;
  } catch (err) {
    process.stderr.write(`[memory-consolidation-validation] dead-end fetch failed: ${String(err)}\n`);
    return [];
  }
}
