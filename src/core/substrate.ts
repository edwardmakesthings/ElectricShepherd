import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type ErrorKind = "not_found" | "permission_denied" | "network" | "unknown";

export type CoreFailureKind = ErrorKind | "transport" | "protocol" | "stale-library" | "not-found";

export type BatchResultRow = {
  drawer_id?: string;
  ok?: boolean;
  error?: string;
  error_kind?: string;
  [key: string]: unknown;
};

type DrawerListing = {
  drawer_id?: string;
};

export function normalizeOptional(value: unknown): string {
  return String(value || "").trim();
}

export function normalizeWingList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  for (const value of values) {
    const wing = normalizeOptional(value);
    if (wing) seen.add(wing);
  }
  return [...seen];
}

export function normalizeIDs(ids: unknown): string[] {
  if (!Array.isArray(ids)) return [];
  return ids
    .map((value) => String(value || "").trim())
    .filter(Boolean);
}

export function normalizeDryRunArg(args: { dry_run?: boolean; dryRun?: boolean }): boolean {
  if (typeof args.dry_run === "boolean") return args.dry_run;
  if (typeof args.dryRun === "boolean") return args.dryRun;
  return true;
}

export function parseIDsFromFile(path: string, cwd: string): string[] {
  const absolute = resolve(cwd, path);
  const raw = readFileSync(absolute, "utf8").trim();
  if (!raw) return [];
  if (raw.startsWith("[")) {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) throw new Error(`ids file is not a JSON array: ${path}`);
    return parsed.map((v) => String(v || "").trim()).filter(Boolean);
  }
  return raw
    .split(/[\r\n,]+/)
    .map((s: string) => s.trim())
    .filter(Boolean);
}

export function classifyErrorKind(error: string): ErrorKind {
  const text = String(error || "").toLowerCase();
  if (!text) return "unknown";
  if (
    text.includes("not found") ||
    text.includes("does not exist") ||
    text.includes("missing") ||
    text.includes("no such")
  ) {
    return "not_found";
  }
  if (
    text.includes("forbidden") ||
    text.includes("permission") ||
    text.includes("denied") ||
    text.includes("unauthorized") ||
    text.includes("not authorized")
  ) {
    return "permission_denied";
  }
  if (
    text.includes("econnrefused") ||
    text.includes("econnreset") ||
    text.includes("enotfound") ||
    text.includes("fetch failed") ||
    text.includes("network") ||
    text.includes("timeout")
  ) {
    return "network";
  }
  return "unknown";
}

export function summarizeFailures(rows: BatchResultRow[], topLevelError = "", fallback = "operation failed"): {
  failure_summary: string;
  hint?: string;
  failure_kinds: Record<string, number>;
} {
  const failedRows = rows.filter((row) => row && row.ok === false);
  const kinds: Record<string, number> = {};
  const topError = String(topLevelError || "").trim();

  for (const row of failedRows) {
    const kind = String(row.error_kind || classifyErrorKind(String(row.error || "")) || "unknown");
    kinds[kind] = (kinds[kind] || 0) + 1;
  }

  if (topError) {
    const topKind = classifyErrorKind(topError);
    kinds[topKind] = (kinds[topKind] || 0) + 1;
  }

  const preview = failedRows.slice(0, 3).map((row) => {
    const id = String(row.drawer_id || "(unknown)");
    const kind = String(row.error_kind || classifyErrorKind(String(row.error || "")) || "unknown");
    const err = String(row.error || "unknown error");
    return `${id}: ${kind} - ${err}`;
  });

  const extra = failedRows.length > 3 ? ` (+${failedRows.length - 3} more)` : "";
  const failureSummary = failedRows.length > 0 ? preview.join("; ") + extra : (topError || fallback);
  let hint = "";
  if ((kinds.not_found || 0) > 0) {
    hint = "One or more drawer IDs were not found in the target MemPalace.";
  } else if ((kinds.permission_denied || 0) > 0) {
    hint = "Write operation was denied by policy or permissions on the selected MCP endpoint.";
  } else if ((kinds.network || 0) > 0) {
    hint = "The request could not reach the MCP endpoint reliably.";
  }

  return {
    failure_summary: failureSummary,
    hint: hint || undefined,
    failure_kinds: kinds,
  };
}

export async function runDrawerBatch<T extends BatchResultRow>(
  drawerIDs: string[],
  failFast: boolean,
  worker: (drawerID: string) => Promise<T>,
): Promise<{ results: T[]; failed: number }> {
  const results: T[] = [];
  let failed = 0;

  for (const drawerID of drawerIDs) {
    try {
      const row = await worker(drawerID);
      results.push(row);
      if (row && row.ok === false) {
        failed += 1;
        if (failFast) break;
      }
    } catch (err) {
      failed += 1;
      results.push({
        drawer_id: drawerID,
        ok: false,
        error: String(err),
        error_kind: classifyErrorKind(String(err)),
      } as T);
      if (failFast) break;
    }
  }

  return { results, failed };
}

export async function collectDrawerIDsByScope(
  listToolCall: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>,
  sourceWing: string,
  sourceRoom: string,
  options: { maxIDs?: number } = {},
): Promise<string[]> {
  const maxIDs = typeof options.maxIDs === "number" && Number.isFinite(options.maxIDs)
    ? Math.max(0, Math.floor(options.maxIDs))
    : undefined;
  if (maxIDs === 0) return [];

  const ids = new Set<string>();
  let offset = 0;
  const limit = 100;
  while (true) {
    const payload: Record<string, unknown> = { wing: sourceWing, limit, offset };
    if (sourceRoom) payload.room = sourceRoom;
    const listed = (await listToolCall(payload)) as {
      drawers?: DrawerListing[];
      error?: string;
    };
    if (listed && listed.error) {
      throw new Error(`list_drawers failed: ${String(listed.error)}`);
    }
    const rows = Array.isArray(listed?.drawers) ? listed.drawers : [];
    for (const row of rows) {
      const drawerID = normalizeOptional(row?.drawer_id);
      if (!drawerID) continue;
      ids.add(drawerID);
      if (typeof maxIDs === "number" && ids.size >= maxIDs) {
        return [...ids];
      }
    }
    if (rows.length < limit) break;
    offset += rows.length;
  }
  return [...ids];
}

export function resolveMemPalaceMCPUrl(
  env: Record<string, string | undefined>,
  directOverrideVar: string,
  defaultMcpUrl: string,
): string {
  const envUrl = (env.MEMPALACE_MCP_URL || "").trim();
  const isGateway = /\/toolset\//.test(envUrl) || /:4000\//.test(envUrl);
  return (
    (env[directOverrideVar] || "").trim() ||
    (envUrl && !isGateway ? envUrl : defaultMcpUrl)
  );
}
