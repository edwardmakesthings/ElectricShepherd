/**
 * Packaged-asset loader for the Electric Shepherd plugin.
 *
 * OpenCode only auto-discovers `agents/` and `command/` folders when a repo is
 * the active *project* (git/cwd root). Electric Shepherd is a plugin that gets
 * installed into other projects, so folder discovery never fires for it. To
 * make the bundled agents and slash commands load like the rest of the plugin,
 * the plugin's `config` hook reads these markdown files at startup and injects
 * them into the resolved OpenCode config (`config.agent` / `config.command`).
 *
 * This keeps each agent/command as its own standalone markdown file (the source
 * of truth) while still loading automatically in any consumer project — no
 * manual copying into `.opencode/`, no inlining into `opencode.json`.
 *
 * The frontmatter parser intentionally supports only the shape these files use:
 * top-level scalars plus a single level of nested maps (e.g. `permission:`).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

export type AssetRecord = Record<string, any>

/**
 * Split a markdown document into its YAML frontmatter block and body. Tolerates
 * a leading BOM and CRLF line endings. Returns an empty frontmatter string when
 * the document has no `--- ... ---` header.
 */
export function splitFrontmatter(raw: string): { frontmatter: string; body: string } {
  const text = (raw || "").replace(/^\uFEFF/, "")
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!match) return { frontmatter: "", body: text.trim() }
  return { frontmatter: match[1], body: match[2].trim() }
}

/** Coerce a scalar frontmatter value into a boolean, number, or unquoted string. */
function coerceScalar(value: string): any {
  const v = value.trim()
  if (v === "") return ""
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1)
  }
  if (v === "true") return true
  if (v === "false") return false
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v)
  return v
}

/**
 * Parse a frontmatter block into an object. Top-level `key: value` pairs become
 * scalars; a top-level `key:` with no value starts a nested map whose 2-space
 * indented children are collected until the next top-level key.
 */
export function parseFrontmatter(frontmatter: string): AssetRecord {
  const out: AssetRecord = {}
  let currentMap: AssetRecord | null = null
  for (const rawLine of (frontmatter || "").split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trim().startsWith("#")) continue
    const indent = rawLine.length - rawLine.trimStart().length
    const line = rawLine.trim()
    const sep = line.indexOf(":")
    if (sep === -1) continue
    const key = line.slice(0, sep).trim()
    const value = line.slice(sep + 1).trim()
    if (indent === 0) {
      if (value === "") {
        currentMap = {}
        out[key] = currentMap
      } else {
        out[key] = coerceScalar(value)
        currentMap = null
      }
    } else if (currentMap) {
      currentMap[key] = coerceScalar(value)
    }
  }
  return out
}

/**
 * Load every `*.md` file in `dir` as a keyed definition. The file name (without
 * extension) becomes the key; frontmatter fields are merged with the body under
 * `bodyField` (`prompt` for agents, `template` for commands).
 */
function loadMarkdownDefinitions(dir: string, bodyField: "prompt" | "template"): AssetRecord {
  const definitions: AssetRecord = {}
  if (!existsSync(dir)) return definitions
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".md")) continue
    const name = file.slice(0, -3)
    const raw = readFileSync(join(dir, file), "utf8")
    const { frontmatter, body } = splitFrontmatter(raw)
    definitions[name] = { ...parseFrontmatter(frontmatter), [bodyField]: body }
  }
  return definitions
}

/** Load agent definitions (`prompt` body) from a directory of markdown files. */
export function loadAgentDefinitions(dir: string): AssetRecord {
  return loadMarkdownDefinitions(dir, "prompt")
}

/** Load command definitions (`template` body) from a directory of markdown files. */
export function loadCommandDefinitions(dir: string): AssetRecord {
  return loadMarkdownDefinitions(dir, "template")
}

/**
 * Resolve the installed package root (one level above this `adapter/` file),
 * regardless of the consumer project's working directory.
 */
export function packagedAssetRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..")
}

/**
 * Load the plugin's bundled agents and commands from the package directory.
 * Pass an explicit `root` in tests; defaults to the installed package root.
 */
export function loadPackagedAssets(root: string = packagedAssetRoot()): {
  agents: AssetRecord
  commands: AssetRecord
} {
  return {
    agents: loadAgentDefinitions(join(root, "agents")),
    commands: loadCommandDefinitions(join(root, "command")),
  }
}

/**
 * Resolve absolute paths to the plugin's bundled instruction files that exist on
 * disk. Absolute paths are required so they resolve regardless of the consumer
 * project's working directory. `names` defaults to the canonical rule files.
 */
export function loadInstructionPaths(
  root: string = packagedAssetRoot(),
  names: string[] = ["agent-discipline.md", "memory-blocks.md"],
): string[] {
  const dir = join(root, "instructions")
  const paths: string[] = []
  for (const name of names) {
    const full = join(dir, name)
    if (existsSync(full)) paths.push(full)
  }
  return paths
}

/**
 * Append bundled instruction paths to an existing instructions array without
 * duplicating entries that are already present.
 */
export function dedupeAppendInstructions(
  existing: string[] | undefined,
  additions: string[],
): string[] {
  const out = Array.isArray(existing) ? [...existing] : []
  for (const path of additions) {
    if (!out.includes(path)) out.push(path)
  }
  return out
}

/**
 * Merge bundled definitions into an existing config map without clobbering
 * user-defined entries: bundled provides defaults, any key already present in
 * the user's config wins entirely.
 */
export function mergeWithoutOverride(bundled: AssetRecord, existing: AssetRecord | undefined): AssetRecord {
  return { ...bundled, ...(existing || {}) }
}
