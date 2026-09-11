/**
 * Stage the packaged assets into the omp extension root, translating the
 * frontmatter the two harnesses do not share.
 *
 * omp discovers a package's `commands/`, `agents/` and `skills/` only from a
 * directory extension root — `discovery/omp-extension-roots.ts`: "Paths that do
 * not resolve to a directory are silently dropped — file entrypoints have no
 * package sub-tree to scan." The root cannot be the repo root either, because
 * the `index.ts` there is the OpenCode plugin entry, so omp would load the wrong
 * module and register none of the tools.
 *
 * So the root is `src/surface/omp/`, and the assets are staged into it. They are
 * generated and gitignored; the canonical copies stay at the repo root where
 * OpenCode's asset loader and package.json `files` already expect them. Re-run
 * this after editing any command, agent or skill.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OMP_ROOT = join(ROOT, "src", "surface", "omp");

/** Minimal reader for the flat scalar keys these assets use; block values stay in the body. */
function splitFrontmatter(markdown: string): { fields: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(markdown);
  if (!match) return { fields: {}, body: markdown };

  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!pair) continue; // nested/list lines belong to the previous key; none are needed here
    fields[pair[1]] = pair[2].trim().replace(/^["']|["']$/g, "");
  }
  return { fields, body: markdown.slice(match[0].length) };
}

/**
 * omp requires `name`, and its `tools` is an array of exact names rather than
 * OpenCode's glob map. A map handed to omp restricts nothing, so it is dropped
 * rather than mistranslated — the agent gets omp's default tool surface.
 */
export function translateAgent(name: string, markdown: string): string {
  const { fields, body } = splitFrontmatter(markdown);
  const description = fields.description || `Electric Shepherd ${name} agent`;
  return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n${body.trimStart()}`;
}

/**
 * omp reads only `description` from a command, so OpenCode's `agent:` routing
 * would silently vanish. omp has no in-session agent switch — agents are `task`
 * subagents — so the routing is re-expressed as an instruction in the body.
 */
export function translateCommand(markdown: string): string {
  const { fields, body } = splitFrontmatter(markdown);
  const agent = fields.agent || "";
  const delegation = agent
    ? `Delegate this entire request to the \`${agent}\` agent using the \`task\` tool, then report its result.\n\n`
    : "";
  return `---\ndescription: ${JSON.stringify(fields.description || "")}\n---\n${delegation}${body.trimStart()}`;
}

/**
 * OpenCode injects `instructions/` as absolute paths on `config.instructions`,
 * which applies them to every agent in the session. omp's equivalent is a rule:
 * `alwaysApply` with no `agents` filter is the same always-on scope.
 */
export function translateInstruction(name: string, markdown: string): string {
  const { fields, body } = splitFrontmatter(markdown);
  const description = fields.description || `Electric Shepherd ${name}`;
  return `---\ndescription: ${JSON.stringify(description)}\nalwaysApply: true\n---\n${body.trimStart()}`;
}

function stageMarkdownDir(name: string, translate: (content: string, file: string) => string, target = name): boolean {
  const source = join(ROOT, name);
  if (!existsSync(source)) return false;

  const targetDir = join(OMP_ROOT, target);
  rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(targetDir, { recursive: true });

  let count = 0;
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (!entry.isFile() || extname(entry.name) !== ".md") continue;
    const content = readFileSync(join(source, entry.name), "utf8");
    writeFileSync(join(targetDir, entry.name), translate(content, entry.name), "utf8");
    count += 1;
  }
  process.stdout.write(`[omp-assets] staged ${name}/ -> ${target}/ (${count} translated)\n`);
  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  let staged = 0;
  if (stageMarkdownDir("agents", (content, file) => translateAgent(basename(file, ".md"), content))) staged += 1;
  if (stageMarkdownDir("commands", (content) => translateCommand(content))) staged += 1;
  if (stageMarkdownDir("instructions", (content, file) => translateInstruction(basename(file, ".md"), content), "rules")) {
    staged += 1;
  }

  // Skills need no translation: omp reads the same SKILL.md frontmatter shape.
  const skillsSource = join(ROOT, "skills");
  if (existsSync(skillsSource)) {
    const skillsTarget = join(OMP_ROOT, "skills");
    rmSync(skillsTarget, { recursive: true, force: true });
    cpSync(skillsSource, skillsTarget, { recursive: true });
    process.stdout.write("[omp-assets] staged skills/ (copied)\n");
    staged += 1;
  }

  if (staged === 0) {
    process.stderr.write("[omp-assets] nothing staged: no commands/, agents/ or skills/ at the repo root\n");
    process.exit(1);
  }
  process.stdout.write(`[omp-assets] extension root ready: ${OMP_ROOT}\n`);
}
