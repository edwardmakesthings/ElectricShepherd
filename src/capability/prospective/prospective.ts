/**
 * Phase 8 (unified memory): prospective memory — "remember to do X when Y".
 *
 * Reminders are PUSHED by circumstance, not pulled by query: the only consumer is
 * the mem-core render, which is already directory-scoped. This module is the pure
 * matching + rendering half of that consumer: given a set of reminder facts and a
 * scope descriptor (the directory scopes being rendered, plus wing/room/query), it
 * returns the reminders that fire for this render — expired and non-active ones
 * dropped at match time ("drop expired ones at render time", spec L116).
 *
 * Pure on purpose: no MCP, no fs. That is what makes the spec's PROVE step
 * (reminder present in an in-glob render, absent in an out-of-glob render) a unit
 * test instead of an integration ritual, and keeps the render path from ever
 * throwing on a KG read failure — the caller degrades to "no pending section".
 *
 * Storage contract (approved Phase 8 design): one drawer per reminder in the
 * project wing's `reminders` room. Edges on the drawer id:
 *   - `triggers-on`            object = condition value (path/glob, topic keyword, or wing/room)
 *   - `es-reminder-status`     object = active | satisfied | expired
 *   - `es-reminder-expires-at` object = ISO date/time
 *   - `es-reminder-satisfied-at` object = ISO date/time (set when closed as satisfied)
 *
 * The condition KIND is not stored as a separate field; it is classified from the
 * value itself (classifyCondition). That keeps the write path to plain kg_add
 * calls and makes matching a pure function of (value, scope descriptor).
 */

export const TRIGGERS_ON_PREDICATE = "triggers-on";
export const REMINDER_STATUS_PREDICATE = "es-reminder-status";
export const REMINDER_EXPIRES_AT_PREDICATE = "es-reminder-expires-at";
export const REMINDER_SATISFIED_AT_PREDICATE = "es-reminder-satisfied-at";

export const REMINDER_STATUSES = ["active", "satisfied", "expired"] as const;
export type ReminderStatus = (typeof REMINDER_STATUSES)[number];

/** Room (in the project wing) where reminder drawers live. */
export const REMINDERS_ROOM = "reminders";

export type ConditionKind = "path" | "scope" | "topic";

export type ReminderFact = {
  drawer_id: string;
  /** The reminder text (drawer content). */
  what: string;
  /** All triggers-on condition values for this reminder. */
  conditions: string[];
  status: ReminderStatus;
  /** ISO date/time the reminder expires at (always present — no expiry, no reminder). */
  expires_at?: string;
  satisfied_at?: string;
};

export type ScopeDescriptor = {
  /** Workspace-relative scope paths, broad to narrow ("" = workspace root). */
  relScopes: string[];
  wing?: string;
  room?: string;
  query?: string;
};

export type ReminderMatch = {
  reminder: ReminderFact;
  /** Which condition fired and how. */
  via: Array<{ condition: string; kind: ConditionKind }>;
};

/**
 * Classify a triggers-on value into one of the three spec kinds.
 *
 * - path/glob: contains a path separator or glob metacharacter (`*`, `?`, `[`).
 * - scope: exactly two non-empty `/`-separated segments with no glob chars —
 *   read as `<wing>/<room>` (MemPalace scope, not directory scope).
 * - topic: anything else — a keyword matched against the render's query/room.
 */
export function classifyCondition(value: string): ConditionKind {
  const v = String(value || "").trim();
  if (!v) return "topic";
  if (/[*?\[]/.test(v)) return "path";
  const segments = v.split("/").filter(Boolean);
  // Two segments are ambiguous (`web/src` path vs `wing/room` scope). Keep the
  // classifier deterministic by only treating known room names as scope; all
  // other two-segment values are paths.
  if (segments.length === 2 && !v.endsWith("/") && !v.startsWith("/")) {
    const room = segments[1]?.toLowerCase() || "";
    if (["synthesis", "reference", "skills", "reminders", "diary", "apprenticeship", "planning"].includes(room)) {
      return "scope";
    }
  }
  if (v.includes("/")) return "path";
  // A bare single word with no `.` is ambiguous between a directory name and a
  // keyword; treat it as a path so "web" triggers for everything under web/.
  // Dotted words (`llama.cpp`) stay topics — dots are not path separators.
  return /\./.test(v) ? "topic" : "path";
}

/**
 * Whether a condition value should be treated as a topic keyword even though
 * classifyCondition labeled it `path` (the bare-word ambiguity: "web" could be
 * a directory). Multi-word values with no glob chars are always topics — a
 * phrase like "prompt caching" is never a directory name.
 */
function isTopicPhrase(value: string): boolean {
  const v = String(value || "").trim();
  return !/[*?\[]/.test(v) && !v.includes("/") && /\s/.test(v);
}

/**
 * Minimal glob matcher for the path kind. Supports `*` (within a segment),
 * `**` (across segments), `?` (single char within a segment). No deps — the
 * render path must not pull in a library just to match one glob.
 * Matching is done on forward-slash relative paths; backslashes are normalized.
 */
export function globMatch(relPath: string, pattern: string): boolean {
  const path = String(relPath || "").replace(/\\/g, "/").replace(/^\/+/, "");
  const pat = String(pattern || "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!pat) return false;
  if (!path) return pat === "**" || pat === "";

  // Convert the glob to a regex. `**` crosses segments (and, when trailing with
  // a `/`, also matches the base dir itself: `web/src/**` matches `web/src`).
  let re = "";
  for (let i = 0; i < pat.length; i += 1) {
    const ch = pat[i];
    if (ch === "*") {
      if (pat[i + 1] === "*") {
        re += ".*";
        i += 1;
        if (pat[i + 1] === "/") {
          re += "(?:/|$)";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else if (".+^$(){}|[]\\".includes(ch)) {
      re += `\\${ch}`;
    } else {
      re += ch;
    }
  }

  try {
    const regex = new RegExp(`^${re}$`);
    if (regex.test(path)) return true;
    // A trailing `/**` also matches the base dir itself (`web/src/**` fires for
    // `web/src`), and a plain directory prefix (`web`, `web/src`) fires for the
    // dir itself and everything beneath it.
    if (pat.endsWith("/**") && path === pat.slice(0, -3)) return true;
    return path === pat || path.startsWith(`${pat}/`);
  } catch {
    return false;
  }
}

/**
 * Does a reminder fire for this scope? A reminder fires when ANY of its
 * conditions matches. Expired (now past expires_at) and non-active reminders
 * never fire — that is the render-time expiry drop.
 */
export function matchReminder(reminder: ReminderFact, scope: ScopeDescriptor, now: Date): ReminderMatch | null {
  if (!reminder || !Array.isArray(reminder.conditions)) return null;
  const status = String(reminder.status || "").trim().toLowerCase();
  if (status !== "active") return null;

  const expiresMs = reminder.expires_at ? Date.parse(reminder.expires_at) : NaN;
  if (Number.isFinite(expiresMs) && now.getTime() >= expiresMs) return null;

  const relScopes = (scope.relScopes || [])
    .map((s) => String(s || "").replace(/\\/g, "/").replace(/^\/+/, ""))
    .filter(Boolean);
  const query = String(scope.query || "").trim().toLowerCase();
  const room = String(scope.room || "").trim().toLowerCase();

  const via: Array<{ condition: string; kind: ConditionKind }> = [];
  for (const raw of reminder.conditions) {
    const condition = String(raw || "").trim();
    if (!condition) continue;
    let kind = classifyCondition(condition);
    // A multi-word phrase classified as `path` is really a topic keyword.
    if (kind === "path" && isTopicPhrase(condition)) kind = "topic";
    let hit = false;
    if (kind === "path") {
      // Fire when the glob matches the rendered scope path or any ancestor of it.
      hit = relScopes.some((rel) => globMatch(rel, condition));
    } else if (kind === "scope") {
      const [wing, r] = condition.split("/").map((s) => s.trim().toLowerCase());
      const wingOk = !wing || !scope.wing || wing === String(scope.wing).trim().toLowerCase();
      const roomOk = !r || !room || r === room;
      hit = Boolean(wing && (wingOk && roomOk));
    } else {
      // Topic keyword: substring of the render query or the target room name.
      const needle = condition.toLowerCase();
      const loose = (s: string) => s.replace(/[-_.]/g, " ").replace(/\s+/g, " ").trim();
      hit =
        (query.length > 0 && (query.includes(needle) || loose(query).includes(loose(needle)))) ||
        (room.length > 0 && (room.includes(needle) || loose(room).includes(loose(needle))));
    }
    if (hit) via.push({ condition, kind });
  }

  return via.length > 0 ? { reminder, via } : null;
}

/**
 * Match a batch of reminders against a scope. Deterministic order: input order
 * preserved, so the render cap is stable across runs for the same reminder set.
 */
export function matchRemindersForScope(
  reminders: ReminderFact[],
  scope: ScopeDescriptor,
  now: Date = new Date(),
): ReminderMatch[] {
  const out: ReminderMatch[] = [];
  for (const reminder of reminders || []) {
    const match = matchReminder(reminder, scope, now);
    if (match) out.push(match);
  }
  return out;
}

/**
 * Render the `[pending]` block lines for the mem-core markdown. Hard-capped at
 * `cap` (a handful — deliberately smaller than [open-items]'s cap), one bullet
 * per reminder: the text plus its firing condition and expiry. Returns [] when
 * there is nothing to show, so the caller omits the whole section (no empty
 * block in every prompt).
 */
export function renderPendingLines(matches: ReminderMatch[], cap: number): string[] {
  const limit = Math.max(0, Math.floor(cap));
  if (!Array.isArray(matches) || matches.length === 0 || limit === 0) return [];

  const lines: string[] = ["## [pending]", "Reminders that fire in this scope — act on them when the work lands. Expired reminders are dropped here at render time."];
  let shown = 0;
  for (const match of matches) {
    if (shown >= limit) break;
    const what = String(match.reminder.what || "").replace(/\s+/g, " ").trim() || "(no text)";
    const cond = match.via[0] ? `${match.via[0].kind}:${match.via[0].condition}` : "unscoped";
    const exp = match.reminder.expires_at ? ` — expires ${String(match.reminder.expires_at).slice(0, 10)}` : "";
    lines.push(`- ${what} (trigger ${cond}${exp})`);
    shown += 1;
  }
  if (matches.length > limit) {
    lines.push(`- ... (${matches.length - limit} more pending; see /reminders)`);
  }
  return lines;
}
