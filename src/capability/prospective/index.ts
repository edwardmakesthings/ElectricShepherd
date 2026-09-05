/**
 * Prospective memory capability (spec §3.2, Rung 3).
 *
 * Owns: reminders and their triggers — `triggers-on`, `es-reminder-status`,
 * `expires-at`. Reminders are PUSHED by circumstance, not pulled by query: the
 * only consumer is the mem-core render, which is already directory-scoped.
 *
 * Binding rule (spec §3.1): this module never calls the substrate directly. The
 * pure matching + rendering half lives in adapter/prospective.ts (no MCP, no fs —
 * that is what makes "reminder present in an in-glob render, absent in an
 * out-of-glob render" a unit test). The write/read/fail legs below are explicit
 * functions over an injected MemgraphClient so the layer-shaped suite can drive
 * them with a fake callTool.
 */

import type { MemgraphClient } from "../../core/memgraph.ts";
import {
  classifyCondition,
  globMatch,
  matchReminder,
  matchRemindersForScope,
  renderPendingLines,
  REMINDER_EXPIRES_AT_PREDICATE,
  REMINDER_SATISFIED_AT_PREDICATE,
  REMINDER_STATUS_PREDICATE,
  REMINDERS_ROOM,
  TRIGGERS_ON_PREDICATE,
  type ConditionKind,
  type ReminderFact,
  type ReminderMatch,
  type ReminderStatus,
  type ScopeDescriptor,
} from "./prospective.ts";

export {
  classifyCondition,
  globMatch,
  matchReminder,
  matchRemindersForScope,
  renderPendingLines,
  REMINDER_EXPIRES_AT_PREDICATE,
  REMINDER_SATISFIED_AT_PREDICATE,
  REMINDER_STATUS_PREDICATE,
  REMINDERS_ROOM,
  TRIGGERS_ON_PREDICATE,
  type ConditionKind,
  type ReminderFact,
  type ReminderMatch,
  type ReminderStatus,
  type ScopeDescriptor,
};

/**
 * WRITE contract (Rung 3 §6.3 question 1): a reminder is one drawer in the
 * project wing's `reminders` room plus its trigger edges — every condition as a
 * `triggers-on` object, the status as `es-reminder-status`, and the expiry as
 * `es-reminder-expires-at`. HARD RULE ("no expiry, no reminder"): expires_at is
 * required and must parse as a date; a create without it is rejected before any
 * substrate write. Returns the exact set of writes performed (or proposed in
 * dry-run) so the test can assert the edges exist.
 */
export type ReminderWritePlan = {
  drawer: { wing: string; room: string; content: string };
  edges: Array<{ subject: string; predicate: string; object: string }>;
};

export function planReminderWrite(args: {
  wing: string;
  what: string;
  conditions: string[];
  status?: ReminderStatus;
  expires_at: string;
  drawer_id?: string;
}): ReminderWritePlan {
  const expiresMs = Date.parse(String(args.expires_at || ""));
  if (!Number.isFinite(expiresMs)) {
    throw new Error("prospective write rejected: expires_at is required and must parse as a date (no expiry, no reminder)");
  }
  const conditions = (args.conditions || []).map((c) => String(c || "").trim()).filter(Boolean);
  if (conditions.length === 0) {
    throw new Error("prospective write rejected: at least one triggers-on condition is required");
  }
  const drawerId = args.drawer_id || `(new ${REMINDERS_ROOM} drawer)`;
  return {
    drawer: { wing: args.wing, room: REMINDERS_ROOM, content: String(args.what || "").trim() },
    edges: [
      ...conditions.map((condition) => ({ subject: drawerId, predicate: TRIGGERS_ON_PREDICATE, object: condition })),
      { subject: drawerId, predicate: REMINDER_STATUS_PREDICATE, object: args.status || "active" },
      { subject: drawerId, predicate: REMINDER_EXPIRES_AT_PREDICATE, object: String(args.expires_at) },
    ],
  };
}

/**
 * READ contract (Rung 3 §6.3 question 2): a reminder is consumed when it fires
 * for the current scope — matchRemindersForScope returns it and renderPendingLines
 * puts it in the mem-core `[pending]` block. Expired and non-active reminders are
 * dropped at match time, so "present in this render, absent from that one" is a
 * property of (conditions, scope descriptor), assertable without a substrate.
 */
export function readPendingForScope(
  reminders: ReminderFact[],
  scope: ScopeDescriptor,
  now: Date = new Date(),
): { matches: ReminderMatch[]; lines: string[] } {
  const matches = matchRemindersForScope(reminders, scope, now);
  return { matches, lines: renderPendingLines(matches, 5) };
}

/**
 * FAIL contract (Rung 3 §6.3 question 3): a substrate error while reading the
 * reminders room must degrade to "no pending section" — never throw into the
 * render, and never be silently mistaken for "reminders exist but none fire".
 * The MemgraphClient boundary normalizes failures; this wrapper catches them at
 * the read edge and returns an explicit { ok: false } so the caller can log a
 * named reason instead of rendering an empty block.
 */
export async function readRemindersSafe(
  client: Pick<MemgraphClient, "listReminders">,
  wing: string,
  room = REMINDERS_ROOM,
): Promise<{ ok: true; reminders: ReminderFact[] } | { ok: false; kind: string; detail: string }> {
  try {
    const rows = await client.listReminders({ wing, room });
    return {
      ok: true,
      reminders: (rows || []).map((row) => ({
        drawer_id: String(row.drawer_id || ""),
        what: String(row.what || ""),
        conditions: Array.isArray(row.conditions) ? row.conditions.map(String) : [],
        status: (String(row.status || "") as ReminderStatus),
        expires_at: row.expires_at,
        satisfied_at: row.satisfied_at,
      })),
    };
  } catch (err) {
    // Named degradation: the render drops the pending section and the operator
    // sees WHY (transport/protocol detail), not a silent empty block.
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, kind: "read-failed", detail };
  }
}
