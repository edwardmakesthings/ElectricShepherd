import type { BatchResultRow } from "./substrate.ts";
import { normalizeDryRunArg, summarizeFailures } from "./substrate.ts";

export type CallTool = (name: string, payload: Record<string, unknown>) => Promise<unknown>;

export type ToolOperationArgs = {
  dry_run?: boolean;
  dryRun?: boolean;
  approved?: boolean;
};

export function normalizeDryRun(args: ToolOperationArgs): boolean {
  return normalizeDryRunArg(args);
}

export function requireApproval(args: ToolOperationArgs): { approved: boolean; reason?: string } {
  const approved = args.approved === true;
  if (approved) return { approved: true };
  return {
    approved: false,
    reason: "Apply requires explicit operator approval. Re-run with approved:true and dry_run:false.",
  };
}

type CheckpointItem = {
  wing: string;
  room: string;
  content: string;
  source_file?: string;
  added_by?: string;
  desc?: string;
};

type CheckpointRequest = {
  items: CheckpointItem[];
  dedup_threshold?: number;
  added_by?: string;
  diary?: {
    agent_name?: string;
    entry?: string;
    topic?: string;
    wing?: string;
  };
};

export type CheckpointWriteResult = {
  ok: boolean;
  tool: "checkpoint";
  attempted: number;
  filed: number;
  failed: number;
  dry_run: boolean;
  failure_summary?: string;
  failure_kinds?: Record<string, number>;
  error?: string;
  raw?: Record<string, unknown>;
};

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asRows(value: unknown): BatchResultRow[] {
  const root = asObject(value);
  const pools = [
    ...(Array.isArray(root.results) ? root.results : []),
    ...(Array.isArray(root.items) ? root.items : []),
    ...(Array.isArray(root.drawers) ? root.drawers : []),
    ...(Array.isArray(root.nodes) ? root.nodes : []),
    ...(Array.isArray(value) ? value : []),
  ];
  return pools.map((row) => asObject(row) as BatchResultRow);
}

function countFiledRows(rows: BatchResultRow[]): number {
  let filed = 0;
  for (const row of rows) {
    if (row?.ok === false) continue;
    filed += 1;
  }
  return filed;
}

export async function runCheckpointWrite(
  call: CallTool,
  args: CheckpointRequest,
  options: { dry_run: boolean },
): Promise<CheckpointWriteResult> {
  const dryRun = options.dry_run;
  const attempted = Array.isArray(args.items) ? args.items.length : 0;

  if (dryRun) {
    return {
      ok: true,
      tool: "checkpoint",
      attempted,
      filed: 0,
      failed: 0,
      dry_run: true,
    };
  }

  try {
    const payload: Record<string, unknown> = {
      items: args.items,
    };
    if (typeof args.dedup_threshold === "number") payload.dedup_threshold = args.dedup_threshold;
    if (typeof args.added_by === "string" && args.added_by.trim()) payload.added_by = args.added_by.trim();
    if (args.diary) payload.diary = args.diary;

    const raw = asObject(await call("checkpoint", payload));
    const rows = asRows(raw);
    const topError = String(raw.error || "").trim();
    const failedRows = rows.filter((row) => row && row.ok === false);
    const filed = rows.length > 0 ? countFiledRows(rows) : attempted - (topError ? attempted : 0);
    const failed = rows.length > 0 ? failedRows.length : (topError ? attempted : 0);

    if (failed > 0 || topError) {
      const summary = summarizeFailures(rows, topError, "checkpoint failed");
      return {
        ok: false,
        tool: "checkpoint",
        attempted,
        filed: Math.max(0, filed),
        failed,
        dry_run: false,
        failure_summary: summary.failure_summary,
        failure_kinds: summary.failure_kinds,
        error: topError || summary.failure_summary,
        raw,
      };
    }

    return {
      ok: true,
      tool: "checkpoint",
      attempted,
      filed: Math.max(0, filed),
      failed: 0,
      dry_run: false,
      raw,
    };
  } catch (err) {
    return {
      ok: false,
      tool: "checkpoint",
      attempted,
      filed: 0,
      failed: attempted,
      dry_run: false,
      error: String(err),
    };
  }
}
