import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export type MemcoreProvenance = { workspaceRoot: string; scopeDirectory: string; wing: string };
export const MEMCORE_PROVENANCE_PREFIX = "<!-- electric-shepherd-memcore ";

export function resolveMemcorePath(path: string): string {
  const absolute = resolve(path);
  return existsSync(absolute) ? realpathSync(absolute) : absolute;
}

export function isMemcorePathWithin(root: string, path: string): boolean {
  const rel = relative(resolveMemcorePath(root), resolveMemcorePath(path));
  return rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
}

export function withMemcoreProvenance(markdown: string, identity: MemcoreProvenance): string {
  if (!markdown.trim()) return "";
  const stamp = { version: 1, workspaceRoot: resolveMemcorePath(identity.workspaceRoot),
    scopeDirectory: resolveMemcorePath(identity.scopeDirectory), wing: identity.wing.trim() };
  if (!stamp.wing || !isMemcorePathWithin(stamp.workspaceRoot, stamp.scopeDirectory)) {
    throw new Error("Invalid mem-core project identity");
  }
  return MEMCORE_PROVENANCE_PREFIX + JSON.stringify(stamp) + " -->\n" + markdown;
}

export function hasMemcoreProvenance(markdown: string, expected: MemcoreProvenance): boolean {
  const line = markdown.split("\n", 1)[0].trimEnd();
  if (!line.startsWith(MEMCORE_PROVENANCE_PREFIX) || !line.endsWith(" -->")) return false;
  let stamp: unknown;
  try { stamp = JSON.parse(line.slice(MEMCORE_PROVENANCE_PREFIX.length, -4)); }
  catch { return false; } // Invalid provenance is never eligible for injection.
  if (!stamp || typeof stamp !== "object" || Array.isArray(stamp)) return false;
  const fields = stamp as Record<string, unknown>;
  return fields.version === 1 && fields.workspaceRoot === resolveMemcorePath(expected.workspaceRoot) &&
    fields.scopeDirectory === resolveMemcorePath(expected.scopeDirectory) && fields.wing === expected.wing;
}
