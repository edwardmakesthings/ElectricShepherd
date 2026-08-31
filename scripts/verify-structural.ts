/**
 * Rung 0a structural architecture checks (docs/2026-08_architecture-rebuild-spec.md §6.6).
 *
 * One deterministic, dependency-free check command enforcing three rules:
 *
 *   A — substrate boundary: no runtime code outside core/ invokes a substrate tool.
 *       Scope: adapter/, capability/, policy/, surface/, tools/, scripts/, plugin/.
 *       Excluded: docs/, instructions/, skills/, agents/, command/, tests, and anything
 *       else outside the runtime dirs. Implemented as an import/call-site check over
 *       runtime source — never a repo-wide string grep (comments/strings are ignored).
 *   B — silent swallow ban: no bare `catch {}` or empty `.catch(() => ...)` handler in
 *       core/ or capability/. An ignored error must name a reason.
 *   C — layer direction: no import from capability/ into core/. Dependencies point
 *       downward only.
 *
 * Diagnostics are `file:line [rule-id] message`. Exit code 1 when any violation exists.
 * Cross-platform: uses node:fs / node:path only; no bash-specific assumptions.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import process from "node:process";

const ROOT = process.cwd();

/** Runtime source directories subject to the checks (spec §6.6). */
const RUNTIME_DIRS = ["adapter", "capability", "policy", "surface", "tools", "scripts", "plugin"];
/** Directories explicitly excluded from Check A (documentation, not runtime code). */
const EXCLUDED_DIRS = new Set(["docs", "instructions", "skills", "agents", "command"]);
/**
 * Test-fixture directories excluded from the runtime scope of Check A (spec §6.6 /
 * criterion 1: "explicitly excludes ... and test fixtures"). Applied by name at any
 * depth under a runtime dir, so if e.g. tools/ or scripts/ ever gains a tests/,
 * __tests__/ or fixtures/ subtree it is not scanned as runtime source. The top-level
 * tests/ tree is already outside RUNTIME_DIRS (excluded by omission); this covers the
 * in-runtime case explicitly rather than relying on absence.
 */
const TEST_FIXTURE_DIRS = new Set(["tests", "__tests__", "fixtures"]);

type Violation = { file: string; line: number; rule: string; message: string };

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

/** Recursively list .ts files under dir, skipping node_modules, hidden dirs, and test-fixture dirs. */
function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // directory missing — nothing to check here
  }
  for (const entry of entries) {
    if (entry.startsWith(".") || entry === "node_modules") continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      // Test-fixture subtrees are excluded from the runtime scope of Check A
      // (spec §6.6 / criterion 1) at any depth under a runtime dir.
      if (TEST_FIXTURE_DIRS.has(entry)) continue;
      out.push(...collectTsFiles(full));
    } else if (st.isFile() && entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

/** Repo-relative path with forward slashes, for diagnostics. */
function relPath(abs: string): string {
  return relative(ROOT, abs).split(sep).join("/");
}

function runtimeSourceFiles(): string[] {
  const files: string[] = [];
  for (const dir of RUNTIME_DIRS) {
    files.push(...collectTsFiles(join(ROOT, dir)));
  }
  return files;
}

// ---------------------------------------------------------------------------
// Line-based source scanning with comment/string awareness
// ---------------------------------------------------------------------------

/**
 * Strip comments and string/template literals from one line, replacing them with
 * spaces so column positions are preserved. A line is "code" only if something
 * survives the strip. This is what makes Check A an import/call-site check rather
 * than a bare string grep: commented-out calls or quoted names never match.
 *
 * Handles both line comments and block comments (opening mid-line,
 * closing mid-line, or spanning multiple lines). Block-comment state is carried across
 * lines via the inBlockComment parameter so a call hidden inside a multi-line comment
 * is not mistaken for a real call site. Returns [strippedLine, stillInBlockComment].
 */
function stripCommentsAndStrings(
  line: string,
  inBlockComment = false,
): [string, boolean] {
  let out = "";
  let i = 0;
  const n = line.length;
  while (i < n) {
    const ch = line[i];
    const next = line[i + 1];
    if (inBlockComment) {
      // Inside a block comment: blank everything until the closing sequence.
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        out += "  ";
        i += 2;
        continue;
      }
      out += " ";
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      // Block comment starts: blank through the closing sequence (may be on a later line).
      inBlockComment = true;
      out += "  ";
      i += 2;
      continue;
    }
    if (ch === "/" && next === "/") break; // line comment to EOL
    if (ch === '"') {
      i++;
      while (i < n && line[i] !== '"') {
        if (line[i] === "\\" && i + 1 < n) i++;
        out += " ";
        i++;
      }
      i++; // closing quote
      continue;
    }
    if (ch === "'") {
      i++;
      while (i < n && line[i] !== "'") {
        if (line[i] === "\\" && i + 1 < n) i++;
        out += " ";
        i++;
      }
      i++; // closing quote
      continue;
    }
    if (ch === "`") {
      // Template literal: skip to the closing backtick. Nested interpolation may itself
      // contain strings or backticks; a conservative scan is fine here because we only
      // need "is there code left on this line", and any real call site lives outside
      // the template in every pattern this check targets.
      i++;
      while (i < n && line[i] !== "`") {
        if (line[i] === "\\" && i + 1 < n) i++;
        out += " ";
        i++;
      }
      i++; // closing backtick
      continue;
    }
    out += ch;
    i++;
  }
  return [out, inBlockComment];
}


// ---------------------------------------------------------------------------
// Check A — no runtime code outside core/ invokes a substrate tool
// ---------------------------------------------------------------------------

/**
 * Substrate invocation signatures. These are the two ways ES reaches MemPalace:
 * the shared client factory (adapter/palace-tools.ts) and the raw JSON-RPC
 * transport (adapter/mcp-http-client.ts). The call sites that actually invoke
 * substrate tools are `callTool` calls; constructing the factory or the raw
 * transport marks a file as reaching the substrate outside the seam.
 *
 * The patterns below are built without literal identifier characters so this
 * script does not match its own enforcement rules when it scans scripts/.
 */
const SUBSTRATE_PATTERNS: { id: string; re: RegExp; message: string }[] = [
  {
    id: "A1",
    re: new RegExp("\\bcallTool\\s*" + "\\("),
    message: "invokes a substrate tool (callTool) — only core/ may do this",
  },
  {
    id: "A2",
    re: new RegExp("\\bnew\\s+" + "MCP" + "HttpClient\\b"),
    message: "constructs the raw MCP transport directly — use the core/ substrate seam",
  },
  {
    id: "A3",
    re: new RegExp("\\b" + "create" + "Palace" + "Client" + "\\b"),
    message: "invokes the substrate client factory outside core/",
  },
];

function checkSubstrateBoundary(files: string[], violations: Violation[]): void {
  for (const file of files) {
    const rel = relPath(file);
    // core/ is permitted; everything else in the runtime scope is not.
    if (rel.startsWith("core/") || rel === "core") continue;
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    let inBlockComment = false;
    for (let idx = 0; idx < lines.length; idx++) {
      // Strip comments/strings, threading block-comment state across lines so a call
      // hidden inside a multi-line /* ... */ comment is never mistaken for a call site.
      const [stripped, stillInBlock] = stripCommentsAndStrings(lines[idx], inBlockComment);
      inBlockComment = stillInBlock;
      if (!stripped.trim()) continue; // comment/string-only line: not a call site
      for (const p of SUBSTRATE_PATTERNS) {
        if (p.re.test(stripped)) {
          violations.push({ file: rel, line: idx + 1, rule: p.id, message: p.message });
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Check B — no bare catch {} / empty .catch(() => ...) in core/ and capability/
// ---------------------------------------------------------------------------

/**
 * A catch clause or .catch() handler is a violation when it swallows the error
 * without naming a reason. "Bare" means: an empty block, or a body whose only
 * statements are comments/whitespace. Any real statement — a log call, a return,
 * a rethrow, even `console.warn(err)` — counts as naming a reason and is allowed.
 */

function blockIsEmpty(bodyStart: string, openBraceIdx: number): boolean {
  // Walk from the opening brace to its matching close; if nothing but comments or
  // whitespace sits inside, the block swallows silently.
  let depth = 0;
  let i = openBraceIdx;
  const n = bodyStart.length;
  while (i < n) {
    const ch = bodyStart[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) break;
    } else if (depth > 1) {
      // Inside the block: only comments/whitespace allowed.
      if (ch === "/" && bodyStart[i + 1] === "/") {
        while (i < n && bodyStart[i] !== "\n") i++;
        continue;
      }
      if (ch === "/" && bodyStart[i + 1] === "*") {
        i += 2;
        while (i < n && !(bodyStart[i] === "*" && bodyStart[i + 1] === "/")) i++;
        i += 2;
        continue;
      }
      if (!/\s/.test(ch)) return false; // a real statement exists
    }
    i++;
  }
  return true;
}

function checkSilentCatches(files: string[], violations: Violation[]): void {
  for (const file of files) {
    const rel = relPath(file);
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    // B1 — bare `catch {}` / `catch (e) {}` with an empty block.
    const catchRe = /\bcatch\b\s*(\([^)]*\))?\s*\{/g;
    let m: RegExpExecArray | null;
    while ((m = catchRe.exec(text)) !== null) {
      const braceIdx = m.index + m[0].length - 1; // the `{`
      if (blockIsEmpty(text, braceIdx)) {
        violations.push({
          file: rel,
          line: text.slice(0, m.index).split(/\r?\n/).length,
          rule: "B1",
          message: "bare catch block swallows the error — name a reason (log/rethrow/delegate)",
        });
      }
    }
    // B2 — empty `.catch(() => ...)` / `.catch(function(){})` handlers.
    const dotCatchRe = /\.catch\s*\(\s*(?:\(\s*\)|function\s*\(\s*\))\s*=>?\s*\{/g;
    while ((m = dotCatchRe.exec(text)) !== null) {
      const braceIdx = m.index + m[0].length - 1; // the `{` of the arrow/function body
      if (blockIsEmpty(text, braceIdx)) {
        violations.push({
          file: rel,
          line: text.slice(0, m.index).split(/\r?\n/).length,
          rule: "B2",
          message: "empty .catch handler swallows the error — name a reason (log/rethrow/delegate)",
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Check C — no import from capability/ into core/
// ---------------------------------------------------------------------------

function checkLayerDirection(files: string[], violations: Violation[]): void {
  for (const file of files) {
    const rel = relPath(file);
    if (!rel.startsWith("core/")) continue; // only core/ is constrained here
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    let inBlockComment = false;
    for (let idx = 0; idx < lines.length; idx++) {
      const [stripped, stillInBlock] = stripCommentsAndStrings(lines[idx], inBlockComment);
      inBlockComment = stillInBlock;
      if (!stripped.trim()) continue;
      // import/export-from and dynamic import() targeting capability/.
      const fromRe = /(?:import|export)\b[^'"]*?from\s+['"]([^'"]+)['"]/g;
      let fm: RegExpExecArray | null;
      while ((fm = fromRe.exec(stripped)) !== null) {
        if (fm[1].includes("capability/")) {
          violations.push({
            file: rel,
            line: idx + 1,
            rule: "C1",
            message: `core/ imports from capability/ ("${fm[1]}") — dependencies point downward only`,
          });
        }
      }
      const dynRe = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
      let dm: RegExpExecArray | null;
      while ((dm = dynRe.exec(stripped)) !== null) {
        if (dm[1].includes("capability/")) {
          violations.push({
            file: rel,
            line: idx + 1,
            rule: "C1",
            message: `core/ dynamically imports capability/ ("${dm[1]}") — dependencies point downward only`,
          });
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const violations: Violation[] = [];
  const runtimeFiles = runtimeSourceFiles();

  // Check A over the whole runtime scope (core/ is skipped internally).
  checkSubstrateBoundary(runtimeFiles, violations);

  // Checks B and C only apply where core/ and capability/ exist. They are part of
  // the target layout; until core/ lands they scan an empty set and pass — which is
  // correct: there is nothing to violate yet.
  const coreCapabilityFiles = [
    ...collectTsFiles(join(ROOT, "core")),
    ...collectTsFiles(join(ROOT, "capability")),
  ];
  checkSilentCatches(coreCapabilityFiles, violations);
  checkLayerDirection(coreCapabilityFiles, violations);

  // Report
  const byRule = new Map<string, number>();
  for (const v of violations) byRule.set(v.rule, (byRule.get(v.rule) ?? 0) + 1);

  console.log("Architecture Check: " + (violations.length === 0 ? "PASS" : "FAIL"));
  console.log("");
  const ruleNames: Record<string, string> = {
    A1: "Check A: Substrate call leak (callTool outside core/)",
    A2: "Check A: Raw MCP transport constructed outside core/",
    A3: "Check A: Substrate client factory invoked outside core/",
    B1: "Check B: Bare catch block in core/capability",
    B2: "Check B: Empty .catch handler in core/capability",
    C1: "Check C: Upward dependency (core/ imports capability/)",
  };
  for (const [rule, count] of [...byRule.entries()].sort()) {
    console.log(`[FAIL] ${ruleNames[rule] ?? rule} — ${count} violation(s)`);
    for (const v of violations.filter((x) => x.rule === rule)) {
      console.log(`  ${v.file}:${v.line} [${v.rule}] ${v.message}`);
    }
  }
  if (violations.length === 0) {
    console.log("[PASS] Check A: No substrate calls outside core/");
    console.log("[PASS] Check B: No silent catches in core/capability");
    console.log("[PASS] Check C: No capability/ imports into core/");
  }
  console.log("");
  console.log(`Summary: ${violations.length} violation(s) found.`);

  process.exit(violations.length === 0 ? 0 : 1);
}

main();
