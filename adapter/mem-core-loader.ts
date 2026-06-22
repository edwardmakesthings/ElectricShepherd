// @ts-expect-error loader package does not include node typings
import { existsSync, readFileSync } from "node:fs";
// @ts-expect-error loader package does not include node typings
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

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
};

export type MemcoreLoadResult = {
  startDir: string;
  workspaceRoot: string;
  loadedFiles: LoadedMemcoreFile[];
  mergedMarkdown: string;
};

function normalizePath(path: string): string {
  return resolve(path);
}

function looksLikeWorkspaceRoot(path: string): boolean {
  return existsSync(join(path, "package.json")) || existsSync(join(path, ".git"));
}

function findWorkspaceRoot(startDir: string): string {
  let current = normalizePath(startDir);
  while (true) {
    if (looksLikeWorkspaceRoot(current)) return current;
    const parent = dirname(current);
    if (parent === current) return current;
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

/**
 * Resolve memory files from broad scope to narrow scope and merge them in that order.
 *
 * Scope order:
 * 1) direct files in each directory: <scope>/memory.md
 * 2) store-root files in each directory scope: <store-root>/<relative-scope>/memory.md
 */
export function loadMemcoreForDirectory(options: MemcoreLoadOptions): MemcoreLoadResult {
  const startDir = normalizePath(options.startDir);
  const workspaceRoot = normalizePath(options.workspaceRoot || findWorkspaceRoot(startDir));
  const directFileName = options.directFileName || "memory.md";
  const storeRoots = (options.storeRoots && options.storeRoots.length > 0
    ? options.storeRoots
    : ["eshepherd/memory", "memory"]
  ).map((root) => toAbsoluteStoreRoot(workspaceRoot, root));
  const maxScopes = Math.max(0, Number(options.maxScopes ?? 0));

  const scopeDirs = buildScopeDirectories(workspaceRoot, startDir, maxScopes);
  const loadedFiles: LoadedMemcoreFile[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < scopeDirs.length; i += 1) {
    const scopeDir = scopeDirs[i];
    const relScope = relative(workspaceRoot, scopeDir);
    if (relScope.startsWith("..")) {
      continue;
    }

    const directCandidate = normalizePath(join(scopeDir, directFileName));
    const directContent = loadIfExists(directCandidate);
    if (directContent !== undefined && !seen.has(directCandidate)) {
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
      if (storeContent === undefined || seen.has(storeCandidate)) {
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
    mergedMarkdown,
  };
}
