/**
 * Phase 9 (unified memory): negative knowledge — what was ruled out.
 *
 * Dead ends are "tried and failed" or "considered and rejected" approaches. The
 * spec's main risk: an UNLABELLED dead end reads as a suggestion ("we tried X"
 * looks like advice unless it carries the outcome clause). So this module owns
 * the label contract in one place — write-time validation (a line without its
 * outcome clause is incomplete and must not be filed) and render-time markers
 * (the hard `[RULED OUT ...]` prefix, never optional).
 *
 * Storage contract (approved Phase 9 design): a dead end is a SYNTHESIS with
 * negative polarity — `es-source-type: synthesis`, never a fourth source type.
 * The negative axis is the `rules-out` KG edge:
 *   - subject = the dead-end drawer id
 *   - predicate = "rules-out" (new, spec-mandated; not lineage — it must never
 *     count toward height or feed getLineageSources/getLineageDerivatives)
 *   - object = the ruled-out statement text (the topic/approach). Free-text by
 *     design: the statement is what retrieval matches on and renders, and a
 *     free-text object keeps the write path to plain kg_add calls.
 * Polarity is two-valued and ordered: "tried-failed" (strong evidence) vs
 * "considered-rejected" (weaker). The value rides on the same edge as a second
 * `rules-out` fact with object = the polarity token, so readers can distinguish
 * without a new predicate.
 */

export const RULES_OUT_PREDICATE = "rules-out";

export const DEAD_END_POLARITIES = ["tried-failed", "considered-rejected"] as const;
export type DeadEndPolarity = (typeof DEAD_END_POLARITIES)[number];

/** Default cap for the bounded [dead-ends] mem-core block. */
export const DEFAULT_DEAD_ENDS_CAP = 3;

/** The hard render marker — an unlabelled dead end must never reach output. */
export const RULED_OUT_MARKER = "[RULED OUT";

export type DeadEndLine = {
  /** What was tried (the topic/approach). */
  tried: string;
  /** What happened — the outcome clause. Required; a line without it is incomplete. */
  outcome: string;
  /** Why it was abandoned. */
  because: string;
  /** "tried-failed" (strong) vs "considered-rejected" (weaker evidence). */
  polarity: DeadEndPolarity;
};

export type ParsedDeadEndLine = {
  line: string;
  parsed: DeadEndLine | null;
  error?: string;
};

/** Parse one DEAD_ENDS line. Tolerant of casing and of a missing `because:` field
 * (the reason may live in the outcome clause), but strict about the two halves
 * that make the label enforceable: what was tried, and what happened. */
export function parseDeadEndLine(raw: string): ParsedDeadEndLine {
  const line = String(raw || "").replace(/^[-*\s]+/, "").trim();
  if (!line) return { line: "", parsed: null, error: "empty" };

  // \bpol(?:arity|ar)? — NOT \bpol(?:ar)?[ty]? (that degrades to "p:" and matches
  // inside the word "polarity:"). See the because-value cut below for the same fix.
  const polarityMatch = /\bpol(?:arity|ar)?\s*:\s*(tried-failed|considered-rejected)\b/i.exec(line);
  const polarity: DeadEndPolarity = (polarityMatch?.[1]?.toLowerCase() as DeadEndPolarity) || "tried-failed";

  // Split into pipe-delimited fields; the last field is the outcome clause ONLY if
  // it is not a `because:`/`pol...:` tag. The tried text may itself contain pipes,
  // so split from the right on known tags first.
  // Same rule as for outcome: the `because` value ends where the next known tag
  // (`pol...:`) begins — a greedy (.+)$ would swallow it.
  const becauseTag = /\bbecause\s*:\s*/i.exec(line);
  let becauseMatch: RegExpExecArray | null = null;
  if (becauseTag) {
    const valueStart = becauseTag.index + becauseTag[0].length;
    let valueEnd = line.length;
    // The "polarity" tag must be matched as a whole word: with (?:ar) and [ty]? both
    // optional the pattern degrades to "p:" and matches inside "polarity:".
    const polTag = /\bpol(?:arity|ar)?\s*:/i.exec(line.slice(valueStart));
    if (polTag) valueEnd = Math.min(valueEnd, valueStart + polTag.index);
    becauseMatch = [line.slice(becauseTag.index, valueEnd)] as RegExpExecArray;
  }
  // Locate the outcome tag, then cut its value at the first subsequent known tag
  // (`because:` or `pol...:`) — a greedy (.+)$ would swallow those tags into the
  // outcome field. A plain indexOf + slice is easier to reason about than a
  // lookahead regex and handles the pipe-delimited mapper shape directly.
  // \b is essential: without it the pattern matches the "o:" inside "polarity:" and
  // the whole tail gets misread as the outcome clause.
  const outcomeTag = /\boutcome\s*:\s*/i.exec(line);

  let tried = line;
  let outcome = "";
  let because = "";

  if (outcomeTag) {
    const valueStart = outcomeTag.index + outcomeTag[0].length;
    let valueEnd = line.length;
    for (const tag of [/\bbecause\s*:/i, /\bpol(?:ar)?[ty]?\s*:/i]) {
      const m = tag.exec(line.slice(valueStart));
      if (m) valueEnd = Math.min(valueEnd, valueStart + m.index);
    }
    tried = line.slice(0, outcomeTag.index).trim();
    outcome = line.slice(valueStart, valueEnd).replace(/[|\s]+$/g, "").replace(/^[\s|]+/g, "").trim();
  } else {
    // No explicit `outcome:` tag — the whole remainder after the last "—" is the
    // outcome clause (the spec's worked example shape: "<tried> — <what happened>").
    const dashIndex = line.lastIndexOf(" — ");
    if (dashIndex > 0) {
      tried = line.slice(0, dashIndex).trim();
      outcome = line.slice(dashIndex + 3).trim();
    } else {
      return { line, parsed: null, error: "missing outcome clause" };
    }
  }

  if (becauseMatch) because = String(becauseMatch[0]).replace(/\bbecause\s*:\s*/i, "").replace(/[|\s]+$/g, "").replace(/^[\s|]+/g, "").trim();

  tried = tried
    .replace(/\bpol(?:arity|ar)?\s*:\s*(tried-failed|considered-rejected)\b/i, "")
    .replace(/[|\s]+$/g, "")
    .replace(/^[\s|]+/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!tried || !outcome) return { line, parsed: null, error: "missing tried or outcome" };

  return {
    line,
    parsed: { tried, outcome, because, polarity },
  };
}

/** Validate a batch of DEAD_ENDS lines. Returns the parseable ones and the rejected
 * (incomplete) ones separately — incomplete lines must not be filed. */
export function validateDeadEndLines(lines: string[]): { valid: DeadEndLine[]; invalid: ParsedDeadEndLine[] } {
  const valid: DeadEndLine[] = [];
  const invalid: ParsedDeadEndLine[] = [];
  for (const raw of lines || []) {
    const result = parseDeadEndLine(raw);
    if (result.parsed) valid.push(result.parsed);
    else if (result.line) invalid.push(result);
  }
  return { valid, invalid };
}

/** Render one dead end with its hard marker. The marker is NOT optional — this is
 * the render-time enforcement of "never an unlabelled dead end". */
export function renderDeadEndLine(deadEnd: DeadEndLine): string {
  const tried = String(deadEnd.tried || "").replace(/\s+/g, " ").trim() || "(no text)";
  const outcome = String(deadEnd.outcome || "").replace(/\s+/g, " ").trim();
  const because = String(deadEnd.because || "").replace(/\s+/g, " ").trim();
  const label = deadEnd.polarity === "considered-rejected" ? "considered and rejected" : "tried and failed";
  const parts = [`${RULED_OUT_MARKER} — ${label}] ${tried}`];
  if (outcome) parts.push(`— ${outcome}`);
  if (because) parts.push(`(abandoned: ${because})`);
  return `- ${parts.join(" ")}`;
}

/**
 * Render the `[dead-ends]` block lines for the mem-core markdown. Hard-capped at
 * `cap` (default 3 — deliberately small, same philosophy as [pending]); an empty
 * input returns [] so the caller omits the whole section (no per-prompt tax when
 * nothing was ruled out). Each bullet carries the hard RULED OUT marker.
 */
export function renderDeadEndsBlock(lines: string[], cap?: number): string[] {
  const limit = Math.max(0, Math.floor(cap ?? DEFAULT_DEAD_ENDS_CAP));
  if (!Array.isArray(lines) || lines.length === 0 || limit === 0) return [];

  const { valid } = validateDeadEndLines(lines);
  if (valid.length === 0) return [];

  const out: string[] = [
    "## [dead-ends]",
    "Approaches ruled out for this scope — do NOT re-propose them. Each line carries its outcome.",
  ];
  let shown = 0;
  for (const deadEnd of valid) {
    if (shown >= limit) break;
    out.push(renderDeadEndLine(deadEnd));
    shown += 1;
  }
  if (valid.length > limit) {
    out.push(`- ... (${valid.length - limit} more ruled out)`);
  }
  return out;
}

/**
 * Parse a dead-end drawer's content back into structured lines. The write path
 * stores one line per dead end in the drawer body (the same shape the mapper
 * emits), so the read path is the inverse of validateDeadEndLines. Used by the
 * mem-core render fetch and any future listing.
 */
export function parseDeadEndDrawerContent(content: string): string[] {
  return String(content || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*\s]+/, "").trim())
    .filter((line) => line.length > 0 && !/^#/.test(line));
}
