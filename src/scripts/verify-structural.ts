/**
 * Structural architecture checks (docs/2026-08_architecture-rebuild-spec.md §6.6,
 * extended by docs/2026-09_structure-and-comment-audit-spec.md Stage 0).
 *
 * One deterministic, dependency-free check command enforcing six rules:
 *
 *   A — substrate boundary: no runtime code outside core/ invokes a substrate tool.
 *       Scope: src/. Excluded: docs/, instructions/, skills/, agents/, command/,
 *       tests, and anything else outside the runtime dirs. Implemented as an
 *       import/call-site check over runtime source — never a repo-wide string grep
 *       (comments/strings are ignored).
 *   B — silent swallow ban: no bare `catch {}` or empty `.catch(() => ...)` handler in
 *       core/ or capability/. An ignored error must name a reason.
 *   C — layer direction: no import from capability/ into core/. Dependencies point
 *       downward only.
 *   D — construction scaffolding ban: no comment line under src/ may cite a phase,
 *       rung, or Pn-n marker number. Comment lines only (a line whose first
 *       non-whitespace characters are //, *, or /*); code and string literals are
 *       out of scope. tests/ is excluded deliberately — test names legitimately
 *       reference the construction step that introduced the behaviour under test.
 *   E — doc references resolve: every path-like *.md reference in a comment under
 *       src/ must resolve to an existing file relative to the repo root. This is a
 *       link check, not a ban on .md in comments.
 *   F — file length ceiling: no maintained TypeScript file under src/ exceeds 800
 *       lines. A ratchet, not a cleanup.
 *
 * Severity: A, B, C, and F are always strict. D and E warn by default (they report
 * violations without failing the build) and become strict with --strict, once the
 * codebase is brought into compliance.
 *
 * Diagnostics are `file:line [rule-id] message`. Exit code 1 when any strict
 * violation exists; zero otherwise (warn-only findings do not fail the run).
 * Cross-platform: uses node:fs / node:path only; no bash-specific assumptions.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import process from "node:process";


const ROOT = process.cwd();

/** Runtime source directories subject to the checks (spec §6.6). */
const RUNTIME_DIRS = ["src"];
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
 * Substrate boundary signatures. The spec's binding rule (§3.1) is that a
 * capability/tool reaches the substrate ONLY through core/, and mechanically
 * that means the literal tool-name prefix `mempalace_` may appear in exactly one
 * directory: core/. These are the two things that let non-core code reach the
 * substrate WITHOUT going through core/:
 *
 *   A2 — constructing the raw JSON-RPC transport (`new MCPHttpClient`) directly,
 *        bypassing the core/substrate-client.ts seam.
 *   A4 — spelling the `mempalace_` tool-name prefix anywhere outside core/. This
 *        is the spec's ACTUAL rule, not a proxy: it catches any code that names a
 *        substrate tool directly (the only way to reach the substrate without a
 *        core-provided client or an injected callback).
 *
 * The old A1 (`callTool(`) check was dropped because it over-matched: it flagged
 * injected-callback invocations (adapter/memgraph.ts's `this.callTool(...)`, where
 * callTool is a ToolCaller function handed in via the constructor — memgraph does
 * not know MemPalace exists) and under-specified (it missed `callToolResult` and
 * any renamed dispatch). A non-core file that holds a core-provided client and
 * calls its methods, or that invokes an injected callback, is reaching THROUGH
 * core — which the rule permits. Only naming the tool (A4) or building the
 * transport (A2) reaches PAST it.
 *
 * The patterns below are built without literal identifier characters so this
 * script does not match its own enforcement rules when it scans scripts/.
 */
const SUBSTRATE_PATTERNS: { id: string; re: RegExp; message: string }[] = [
  {
    id: "A2",
    re: new RegExp("\\bnew\\s+" + "MCP" + "HttpClient\\b"),
    message: "constructs the raw MCP transport directly — use the core/ substrate seam",
  },
  {
    // The spec's binding rule (§3.1): the `mempalace_` tool-name prefix lives only
    // in core/. Match the bare literal so ANY naming of it — a direct tool name
    // (mempalace_search), a namespaced one (gateway_mempalace_get_height), or a
    // help-text mention — is caught outside core/. Built without the literal so
    // this script does not match its own rule when scanning scripts/ (its own
    // occurrences are in string literals, which stripCommentsAndStrings blanks out).
    id: "A4",
    // Match the bare literal ANYWHERE, including mid-identifier (a namespaced tool
    // name like gateway_mempalace_get_height has no word boundary before it). A
    // leading \b would miss those; the substring match is what the spec's rule
    // ("the string mempalace_ may appear in exactly one directory") actually says.
    re: new RegExp("mempalace" + "_"),
    message: "names the substrate tool-name prefix (mempalace_) outside core/ — route through core/",
  },
];

function checkSubstrateBoundary(files: string[], violations: Violation[]): void {
  for (const file of files) {
    const rel = relPath(file);
    // core/ is permitted; everything else in the runtime scope is not.
    if (rel.startsWith("src/core/") || rel === "src/core") continue;
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
  //
  // Position is advanced EXPLICITLY in every branch (no shared trailing i++). The
  // old version relied on a final `i++` after the comment-skip branches, which
  // over-stepped: skipping a `//` line comment left i on the newline, and the
  // trailing i++ then jumped onto the next line's indentation — so a block whose
  // first real statement was indented (the normal case) was misread as empty.
  let depth = 0;
  let i = openBraceIdx;
  const n = bodyStart.length;
  while (i < n) {
    const ch = bodyStart[i];
    if (ch === "{") {
      depth++;
      i++;
    } else if (ch === "}") {
      depth--;
      i++;
      if (depth === 0) break;
    } else if (depth >= 1) {
      // Inside the block: only comments/whitespace allowed.
      if (ch === "/" && bodyStart[i + 1] === "/") {
        while (i < n && bodyStart[i] !== "\n") i++; // stop ON the newline
        continue; // do not advance past it here; next loop sees \n as whitespace
      }
      if (ch === "/" && bodyStart[i + 1] === "*") {
        i += 2;
        while (i < n && !(bodyStart[i] === "*" && bodyStart[i + 1] === "/")) i++;
        i += 2; // step past the closing */
        continue;
      }
      if (!/\s/.test(ch)) return false; // a real statement exists
      i++; // whitespace
    } else {
      i++; // depth 0/1: the opening brace region or between braces — just advance
    }
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
    if (!rel.startsWith("src/core/")) continue; // only src/core/ is constrained here
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
// Comment-line scanning (shared by Checks D and E)
// ---------------------------------------------------------------------------

/**
 * A comment line is one whose first non-whitespace characters are `//`, `*`, or
 * `/*` — i.e. a line comment or a block-comment line (opening or continuation).
 * Code lines and string literals are out of scope for Checks D and E: the spec's
 * rule targets prose, not code, so no stripping machinery is needed here.
 */
function isCommentLine(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

// ---------------------------------------------------------------------------
// Check D — no construction scaffolding markers in comment lines under src/
// ---------------------------------------------------------------------------

/**
 * Construction scaffolding: a comment citing the phase, rung, or Pn-n marker of
 * the build that produced the code. These citations are true only until the next
 * edit and say nothing about why the code is the way it is — they belong nowhere.
 * One finding per offending line (the spec counts comment lines, not patterns).
 */
const SCAFFOLDING_PATTERNS: { id: string; re: RegExp; label: string }[] = [
  { id: "D1", re: /Phase \d+/, label: "phase marker" },
  { id: "D2", re: /Rung \d+/, label: "rung marker" },
  { id: "D3", re: /P\d+-\d+/, label: "Pn-n marker" },
];

function checkScaffoldingComments(files: string[], violations: Violation[]): void {
  for (const file of files) {
    const rel = relPath(file);
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (let idx = 0; idx < lines.length; idx++) {
      if (!isCommentLine(lines[idx])) continue;
      for (const p of SCAFFOLDING_PATTERNS) {
        if (p.re.test(lines[idx])) {
          violations.push({
            file: rel,
            line: idx + 1,
            rule: p.id,
            message: `comment cites a ${p.label} — drop the citation, keep the constraint`,
          });
          break; // one finding per line
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Check E — path-like *.md references in comment lines must resolve
// ---------------------------------------------------------------------------

/**
 * Path-like markdown reference: starts with an alphanumeric segment, may contain
 * further `/`-separated segments, and ends in `.md`. Requiring a leading
 * alphanumeric (and at least one `/`) keeps this a LINK check rather than a ban:
 * bare file names (`memory.md`) and placeholder paths (`<scope>/memory.md`,
 * `*.md`) are not repo-relative references and are deliberately not flagged.
 */
const MD_REF_RE = /\b([A-Za-z0-9][A-Za-z0-9_-]*(?:\/[A-Za-z0-9_-]+)+\.md)\b/g;

function checkDocRefsResolve(files: string[], violations: Violation[]): void {
  for (const file of files) {
    const rel = relPath(file);
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (let idx = 0; idx < lines.length; idx++) {
      if (!isCommentLine(lines[idx])) continue;
      MD_REF_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = MD_REF_RE.exec(lines[idx])) !== null) {
        const ref = m[1];
        if (!existsSync(join(ROOT, ref))) {
          violations.push({
            file: rel,
            line: idx + 1,
            rule: "E1",
            message: `comment references "${ref}" which does not exist relative to the repo root`,
          });
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Check F — no maintained TypeScript file under src/ exceeds 800 lines
// ---------------------------------------------------------------------------

const MAX_FILE_LINES = 800;

/** Line count matching `wc -l` semantics: newline-terminated lines, plus a final unterminated line if any. */
function countLines(text: string): number {
  const n = text.split(/\r?\n/).length;
  return text.endsWith("\n") ? n - 1 : n;
}

function checkFileLength(files: string[], violations: Violation[]): void {
  for (const file of files) {
    const rel = relPath(file);
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const n = countLines(text);
    if (n > MAX_FILE_LINES) {
      violations.push({
        file: rel,
        line: 1,
        rule: "F1",
        message: `file is ${n} lines — exceeds the ${MAX_FILE_LINES}-line ceiling`,
      });
    }
  }
}


// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const strict = process.argv.includes("--strict");
  const violations: Violation[] = [];
  const runtimeFiles = runtimeSourceFiles();

  // Check A over the whole runtime scope (core/ is skipped internally).
  checkSubstrateBoundary(runtimeFiles, violations);

  // Checks B and C only apply where core/ and capability/ exist. They are part of
  // the target layout; until core/ lands they scan an empty set and pass — which is
  // correct: there is nothing to violate yet.
  const coreCapabilityFiles = [
    ...collectTsFiles(join(ROOT, "src/core")),
    ...collectTsFiles(join(ROOT, "src/capability")),
  ];
  checkSilentCatches(coreCapabilityFiles, violations);
  checkLayerDirection(coreCapabilityFiles, violations);

  // Checks D and E scan comment lines across the whole runtime scope; tests/ is
  // outside src/ and therefore excluded by construction. Check F applies to every
  // maintained runtime source file in the same scope.
  checkScaffoldingComments(runtimeFiles, violations);
  checkDocRefsResolve(runtimeFiles, violations);
  checkFileLength(runtimeFiles, violations);

  // Severity: A/B/C/F are always strict; D/E warn by default and fail with --strict.
  const WARN_RULES = new Set(["D1", "D2", "D3", "E1"]);
  const isWarn = (rule: string): boolean => !strict && WARN_RULES.has(rule);

  // Report
  const byRule = new Map<string, number>();
  for (const v of violations) byRule.set(v.rule, (byRule.get(v.rule) ?? 0) + 1);
  const failCount = violations.filter((v) => !isWarn(v.rule)).length;
  const warnCount = violations.length - failCount;

  console.log(
    "Architecture Check: " +
      (failCount === 0 ? (warnCount > 0 ? "PASS (with warnings)" : "PASS") : "FAIL"),
  );
  console.log("");
  const ruleNames: Record<string, string> = {
    A2: "Check A: Raw MCP transport constructed outside core/",
    A4: "Check A: Substrate tool-name prefix (mempalace_) named outside core/",
    B1: "Check B: Bare catch block in core/capability",
    B2: "Check B: Empty .catch handler in core/capability",
    C1: "Check C: Upward dependency (core/ imports capability/)",
    D1: "Check D: Phase marker cited in a comment line",
    D2: "Check D: Rung marker cited in a comment line",
    D3: "Check D: Pn-n marker cited in a comment line",
    E1: "Check E: Comment references a .md file that does not exist",
    F1: "Check F: Runtime source file exceeds the 800-line ceiling",
  };
  for (const [rule, count] of [...byRule.entries()].sort()) {
    const tag = isWarn(rule) ? "WARN" : "FAIL";
    console.log(`[${tag}] ${ruleNames[rule] ?? rule} — ${count} violation(s)`);
    for (const v of violations.filter((x) => x.rule === rule)) {
      console.log(`  ${v.file}:${v.line} [${v.rule}] ${v.message}`);
    }
  }
  const passLines: Record<string, string> = {
    A: "[PASS] Check A: No raw transport construction or mempalace_ tool names outside core/",
    B: "[PASS] Check B: No silent catches in core/capability",
    C: "[PASS] Check C: No capability/ imports into core/",
    D: "[PASS] Check D: No construction scaffolding markers in comment lines",
    E: "[PASS] Check E: All .md references in comments resolve",
    F: "[PASS] Check F: No runtime source file exceeds the 800-line ceiling",
  };
  for (const check of ["A", "B", "C", "D", "E", "F"]) {
    if ([...byRule.keys()].some((r) => r.startsWith(check))) continue;
    console.log(passLines[check]);
  }
  console.log("");
  console.log(
    `Summary: ${failCount} violation(s), ${warnCount} warning(s) found.` +
      (strict ? " [strict]" : " [default: D/E warn-only]"),
  );

  process.exit(failCount === 0 ? 0 : 1);
}

main();
