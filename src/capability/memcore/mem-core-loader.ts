import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { loadRuntimeConfig } from "../../core/runtime-config.ts";
import { hasMemcoreProvenance, isMemcorePathWithin, MEMCORE_PROVENANCE_PREFIX, resolveMemcorePath } from "./mem-core-provenance.ts";

export type MemcoreSourceType = "direct" | "store";

export type LoadedMemcoreFile = {
  path: string;
  sourceType: MemcoreSourceType;
  scopeDirectory: string;
  scopeDepth: number;
  bytes: number;
  content: string;
};

export type MemcoreLoadOptions = {
  startDir: string;
  workspaceRoot?: string;
  directFileName?: string;
  storeRoots?: string[];
  maxScopes?: number;
  expectedWing?: string;
};

export type MemcoreLoadResult = {
  startDir: string;
  workspaceRoot: string;
  loadedFiles: LoadedMemcoreFile[];
  skippedFiles: Array<{ path: string; reason: string }>;
  mergedMarkdown: string;
};

function normalizePath(path: string): string {
  return resolveMemcorePath(path);
}

function looksLikeWorkspaceRoot(path: string): boolean {
  return existsSync(join(path, "package.json")) || existsSync(join(path, ".git"));
}

export function findMemcoreWorkspaceRoot(startDir: string): string {
  let current = normalizePath(startDir);
  while (true) {
    if (looksLikeWorkspaceRoot(current)) return current;
    const parent = dirname(current);
    if (parent === current) return normalizePath(startDir);
    current = parent;
  }
}

function buildScopeDirectories(workspaceRoot: string, startDir: string, maxScopes: number): string[] {
  const root = normalizePath(workspaceRoot);
  const start = normalizePath(startDir);

  const scopes: string[] = [];
  let current = start;
  while (true) {
    scopes.push(current);
    if (current === root) break;

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  scopes.reverse();
  return maxScopes > 0 ? scopes.slice(-maxScopes) : scopes;
}

function toAbsoluteStoreRoot(workspaceRoot: string, root: string): string {
  return isAbsolute(root) ? normalizePath(root) : normalizePath(join(workspaceRoot, root));
}

function loadIfExists(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  return readFileSync(path, "utf8");
}

/** Compose project-local notes and verified renders from broad to narrow scope. */
export function loadMemcoreForDirectory(options: MemcoreLoadOptions): MemcoreLoadResult {
  const startDir = normalizePath(options.startDir);
  const workspaceRoot = normalizePath(options.workspaceRoot || findMemcoreWorkspaceRoot(startDir));
  if (workspaceRoot !== findMemcoreWorkspaceRoot(startDir)) throw new Error("Mem-core workspace does not match the scope project");
  const wing = options.expectedWing ?? String(loadRuntimeConfig({ cwd: workspaceRoot, env: process.env }).valuesByPath.memory?.projectWing || "");
  const directFileName = options.directFileName || "memory.md";
  const storeRoots = (options.storeRoots && options.storeRoots.length > 0
    ? options.storeRoots
    : [".electric-shepherd/memory"]
  ).map((root) => toAbsoluteStoreRoot(workspaceRoot, root));
  const maxScopes = Math.max(0, Number(options.maxScopes ?? 0));

  const scopeDirs = buildScopeDirectories(workspaceRoot, startDir, maxScopes);
  const loadedFiles: LoadedMemcoreFile[] = [];
  const skippedFiles: MemcoreLoadResult["skippedFiles"] = [];
  const seen = new Set<string>();

  for (let i = 0; i < scopeDirs.length; i += 1) {
    const scopeDir = scopeDirs[i];
    const relScope = relative(workspaceRoot, scopeDir);
    if (!isMemcorePathWithin(workspaceRoot, scopeDir)) {
      continue;
    }

    const directCandidate = normalizePath(join(scopeDir, directFileName));
    const directContent = loadIfExists(directCandidate);
    const identity = { workspaceRoot, scopeDirectory: scopeDir, wing };
    const directHeader = directContent?.trimStart();
    const directGenerated = directHeader?.startsWith(MEMCORE_PROVENANCE_PREFIX) || directHeader?.startsWith("# Labeled memory blocks (always in context)");
    const directEligible = isMemcorePathWithin(workspaceRoot, directCandidate) &&
      (!directGenerated || (typeof directContent === "string" && hasMemcoreProvenance(directContent, identity)));
    if (directContent?.trim() && !directEligible) skippedFiles.push({ path: directCandidate, reason: "foreign or unverified project provenance" });
    if (directContent?.trim() && directEligible && !seen.has(directCandidate)) {
      seen.add(directCandidate);
      loadedFiles.push({
        path: directCandidate,
        sourceType: "direct",
        scopeDirectory: scopeDir,
        scopeDepth: i,
        bytes: directContent.length,
        content: directContent,
      });
    }

    for (const storeRoot of storeRoots) {
      const scopedStoreDir = relScope ? join(storeRoot, relScope) : storeRoot;
      const storeCandidate = normalizePath(join(scopedStoreDir, "memory.md"));
      const storeContent = loadIfExists(storeCandidate);
      if (!storeContent?.trim() || seen.has(storeCandidate)) {
        continue;
      }

      if (!hasMemcoreProvenance(storeContent, identity)) {
        skippedFiles.push({ path: storeCandidate, reason: "foreign or unverified project provenance" });
        continue;
      }
      seen.add(storeCandidate);
      loadedFiles.push({
        path: storeCandidate,
        sourceType: "store",
        scopeDirectory: scopeDir,
        scopeDepth: i,
        bytes: storeContent.length,
        content: storeContent,
      });
    }
  }

  const mergedMarkdown = loadedFiles
    .map(
      (file) =>
        `<!-- mem-core source: ${file.sourceType} scope=${file.scopeDirectory} path=${file.path} -->\n${file.content.trim()}`,
    )
    .join("\n\n");

  return {
    startDir,
    workspaceRoot,
    loadedFiles,
    skippedFiles,
    mergedMarkdown,
  };
}
