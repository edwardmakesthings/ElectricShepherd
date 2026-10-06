/**
 * Copy the packaged agents into the OpenCode global config `agents/` dir.
 *
 * OpenCode v2 appends the global permission rules to every agent a plugin
 * registers through `ctx.agent.transform`, after the agent's own rules, so a
 * global deny (e.g. `file-reader_*`) overrides the agent's allow. Agents loaded
 * from config `agents/*.md` get their own rules appended after the globals, so
 * they keep their intended permissions. The plugin registration stays as the
 * fallback; it skips ids that already exist. Sync updates only untouched managed
 * files; installed customizations and legacy manifests without hashes are preserved.
 */

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SOURCE = join(ROOT, "agents");
const TARGET = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode", "agents");
/** Update only files whose bytes still match their last installed package version. */
export function syncPackagedAgents(source = SOURCE, target = TARGET): void {
  const manifest = join(target, ".electric-shepherd-agents.json");
  const names = readdirSync(source, { withFileTypes: true }).filter(f => f.isFile() && f.name.endsWith(".md")).map(f => f.name).sort();
  mkdirSync(target, { recursive: true });
  const parsed: unknown = existsSync(manifest) ? JSON.parse(readFileSync(manifest, "utf8")) : {};
  const previous: Record<string, string> = {};
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    for (const [name, hash] of Object.entries(parsed)) {
      if (/^[^/\\]+\.md$/.test(name) && typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash)) previous[name] = hash;
    }
  }
  const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
  for (const [stale, hash] of Object.entries(previous)) {
    const path = join(target, stale);
    if (!names.includes(stale) && existsSync(path) && lstatSync(path).isFile() && digest(path) === hash) {
      rmSync(path);
      console.log(`removed ${stale}`);
    }
  }
  const next: Record<string, string> = {};
  for (const name of names) {
    const src = join(source, name), dst = join(target, name);
    const hash = digest(src);
    let installed: ReturnType<typeof lstatSync> | undefined;
    try { installed = lstatSync(dst); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    if (installed && !installed.isFile()) console.log(`preserved customized ${name}`);
    else if (!installed || (previous[name] && digest(dst) === previous[name])) copyFileSync(src, dst);
    else if (digest(dst) !== hash) console.log(`preserved customized ${name}`);
    next[name] = hash;
  }
  writeFileSync(manifest, JSON.stringify(next, null, 2) + "\n");
  console.log(`synced ${names.length} agents to ${target}; existing customizations preserved`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) syncPackagedAgents();
