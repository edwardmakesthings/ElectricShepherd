/**
 * Copy the packaged agents into the OpenCode global config `agents/` dir.
 *
 * OpenCode v2 appends the global permission rules to every agent a plugin
 * registers through `ctx.agent.transform`, after the agent's own rules, so a
 * global deny (e.g. `file-reader_*`) overrides the agent's allow. Agents loaded
 * from config `agents/*.md` get their own rules appended after the globals, so
 * they keep their intended permissions. The plugin registration stays as the
 * fallback; it skips ids that already exist. Re-run after editing any agent.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SOURCE = join(ROOT, "agents");
const TARGET = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode", "agents");
/** Records which files this script owns, so a removed agent is cleaned up without touching user agents. */
const MANIFEST = join(TARGET, ".electric-shepherd-agents.json");

const names = readdirSync(SOURCE).filter((f) => f.endsWith(".md")).sort();
mkdirSync(TARGET, { recursive: true });

const previous: string[] = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, "utf8")) : [];
for (const stale of previous.filter((f) => !names.includes(f))) {
  rmSync(join(TARGET, stale), { force: true });
  console.log(`removed ${stale}`);
}
for (const name of names) copyFileSync(join(SOURCE, name), join(TARGET, name));
writeFileSync(MANIFEST, JSON.stringify(names, null, 2) + "\n");
console.log(`synced ${names.length} agents to ${TARGET}; run \`opencode service restart\` to load them`);
