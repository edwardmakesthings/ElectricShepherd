import { loadMemcoreForDirectory } from "../adapter/mem-core-loader.ts";

declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  cwd: () => string;
  stdout: { write: (text: string) => void };
  stderr: { write: (text: string) => void };
  exit: (code: number) => never;
};

function getArg(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index >= 0 && index + 1 < argv.length) return argv[index + 1];
  return undefined;
}

function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

function parseCSV(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function usage(): string {
  return [
    "Usage:",
    "  node scripts/run-mem-core-loader.ts [flags]",
    "",
    "Flags:",
    "  --start-dir <path>            directory to resolve scoped memory for (default: cwd)",
    "  --workspace-root <path>       explicit workspace root (default: auto-detect via package.json/.git)",
    "  --direct-file-name <name>     direct per-directory file name (default: memory.md)",
    "  --store-roots <csv>           scoped store roots (default: eshepherd/memory,memory)",
    "  --max-scopes <n>              max number of scopes from nearest ancestors (default: all)",
    "  --format <json|markdown>      output format (default: json)",
    "  --strict                      exit non-zero if no memory files are found",
  ].join("\n");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (hasFlag(argv, "--help") || hasFlag(argv, "-h")) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const startDir = getArg(argv, "--start-dir") || process.cwd();
  const workspaceRoot = getArg(argv, "--workspace-root");
  const directFileName = getArg(argv, "--direct-file-name") || "memory.md";
  const storeRoots = parseCSV(getArg(argv, "--store-roots"));
  const maxScopes = Number(getArg(argv, "--max-scopes") || "0");
  const format = (getArg(argv, "--format") || "json").toLowerCase();
  const strict = hasFlag(argv, "--strict");

  const result = loadMemcoreForDirectory({
    startDir,
    workspaceRoot,
    directFileName,
    storeRoots,
    maxScopes,
  });

  if (strict && result.loadedFiles.length === 0) {
    process.stderr.write("[mem-core-loader] no scoped memory files were found\n");
    process.exit(2);
  }

  if (format === "markdown") {
    process.stdout.write(`${result.mergedMarkdown}\n`);
    return;
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((err) => {
  process.stderr.write(`[mem-core-loader] ${String(err)}\n`);
  process.exit(1);
});
