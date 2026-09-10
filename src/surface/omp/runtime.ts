/**
 * Shared runtime plumbing for the omp drivers.
 *
 * Every driver needs the same three things before it can decide anything: the
 * resolved Electric Shepherd environment (env files then config file), a way to
 * read the resulting flat string map as typed values, and the mem-core block.
 * They live here rather than in whichever driver happened to need them first.
 */

import { loadMemcoreForDirectory } from "../../capability/memcore/mem-core-loader.ts";
import { applyRuntimeConfigToEnv, getRuntimeConfigEnvMap, loadRuntimeConfig } from "../../core/runtime-config.ts";
import { loadRuntimeEnv } from "../../scripts/runtime-env.ts";
import type { OmpExtensionApi } from "./api.ts";

export type EsEnv = Record<string, string | undefined>;

export const MEMCORE_HEADING = "## Mem-core: durable state for this project";

/**
 * Resolve the Electric Shepherd environment, lowest precedence first:
 * spec defaults, then env (process + .env files), then the config file's
 * EXPLICIT values. Defaults must not outrank a real env var, which is why they
 * only fill blanks — `getRuntimeConfigEnvMap` alone cannot tell a configured
 * value from a defaulted one.
 */
export function resolveEnv(cwd: string, scriptUrl: string): EsEnv {
  const env: EsEnv = { ...process.env };
  loadRuntimeEnv({ scriptUrl, env, cwd });

  const config = loadRuntimeConfig({ cwd, env });
  for (const [key, value] of Object.entries(getRuntimeConfigEnvMap(config))) {
    if (env[key] === undefined) env[key] = value;
  }
  applyRuntimeConfigToEnv(env, config);
  return env;
}

export function isTrue(value: string | undefined): boolean {
  return String(value ?? "").trim().toLowerCase() === "true";
}

export function toNumber(value: string | undefined, fallback: number): number {
  // `Number("")` is 0 and finite, so an unset key would otherwise read as zero —
  // which silently disables timeouts and budgets instead of using their default.
  const raw = String(value ?? "").trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function toList(value: string | undefined): string[] {
  return String(value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function log(pi: OmpExtensionApi, message: string): void {
  if (pi.logger) pi.logger.warn(`[electric-shepherd] ${message}`);
  else console.warn(`[electric-shepherd] ${message}`);
}

/** Scoped memory.md files, broad scope to narrow, capped at the configured budget. */
export function buildMemcoreBlock(env: EsEnv, cwd: string): string | undefined {
  const loaded = loadMemcoreForDirectory({
    startDir: cwd,
    directFileName: env.ESHEPHERD_MEMCORE_DIRECT_FILE,
    storeRoots: toList(env.ESHEPHERD_MEMCORE_STORE_ROOTS),
    maxScopes: toNumber(env.ESHEPHERD_MEMCORE_MAX_SCOPES, 6),
  });
  const merged = loaded.mergedMarkdown.trim();
  if (!merged) return undefined;

  const maxChars = toNumber(env.ESHEPHERD_MEMCORE_MAX_CHARS, 12000);
  const body = merged.length > maxChars ? `${merged.slice(0, maxChars)}\n\n[truncated]` : merged;
  return `${MEMCORE_HEADING}\n\n${body}`;
}
