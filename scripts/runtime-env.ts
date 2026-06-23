// @ts-expect-error runtime script package does not include node typings
import { existsSync, readFileSync } from "node:fs";
// @ts-expect-error runtime script package does not include node typings
import { dirname, resolve } from "node:path";
// @ts-expect-error runtime script package does not include node typings
import { fileURLToPath } from "node:url";

type RuntimeEnv = Record<string, string | undefined>;

type LoadRuntimeEnvOptions = {
  scriptUrl: string;
  env: RuntimeEnv;
  cwd?: string;
};

type LoadRuntimeEnvResult = {
  loadedFiles: string[];
};

function parseEnvText(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = content.split(/\r?\n/);

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const line = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
    const equalsAt = line.indexOf("=");
    if (equalsAt <= 0) continue;

    const key = line.slice(0, equalsAt).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = line.slice(equalsAt + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value
        .slice(1, -1)
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1);
    }

    out[key] = value;
  }

  return out;
}

function loadEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const content = readFileSync(path, "utf8");
  return parseEnvText(content);
}

export function loadRuntimeEnv(options: LoadRuntimeEnvOptions): LoadRuntimeEnvResult {
  const { scriptUrl, env } = options;
  const runtimeCwd = (globalThis as { process?: { cwd?: () => string } }).process?.cwd?.() || ".";
  const cwd = options.cwd || runtimeCwd;

  const initialKeys = new Set<string>();
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "undefined") {
      initialKeys.add(key);
    }
  }

  const loadedFiles: string[] = [];
  const scriptPath = fileURLToPath(scriptUrl);
  const scriptDir = dirname(scriptPath);
  const repoRoot = resolve(scriptDir, "..");

  const explicitFile = (env.ESHEPHERD_ENV_FILE || "").trim();
  const applyLoadedValues = (values: Record<string, string>): void => {
    for (const [key, value] of Object.entries(values)) {
      if (!initialKeys.has(key)) {
        env[key] = value;
      }
    }
  };

  if (explicitFile) {
    const explicitPath = resolve(cwd, explicitFile);
    if (existsSync(explicitPath)) {
      applyLoadedValues(loadEnvFile(explicitPath));
      loadedFiles.push(explicitPath);
    }
    return { loadedFiles };
  }

  const repoEnv = resolve(repoRoot, ".env");
  const repoEnvLocal = resolve(repoRoot, ".env.local");
  let loadedRepoFile = false;

  if (existsSync(repoEnv)) {
    applyLoadedValues(loadEnvFile(repoEnv));
    loadedFiles.push(repoEnv);
    loadedRepoFile = true;
  }

  if (existsSync(repoEnvLocal)) {
    applyLoadedValues(loadEnvFile(repoEnvLocal));
    loadedFiles.push(repoEnvLocal);
    loadedRepoFile = true;
  }

  // Fallback for monorepo setups that centralize env in a sibling docker directory.
  if (!loadedRepoFile) {
    const dockerEnv = resolve(repoRoot, "..", "docker", ".env");
    if (existsSync(dockerEnv)) {
      applyLoadedValues(loadEnvFile(dockerEnv));
      loadedFiles.push(dockerEnv);
    }
  }

  return { loadedFiles };
}