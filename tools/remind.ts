/**
 * Phase 8 (unified memory): prospective memory — the reminder lifecycle tool.
 *
 * One drawer per reminder in the project wing's `reminders` room, with edges:
 *   - `triggers-on`            object = condition value (path/glob, topic keyword, or wing/room)
 *   - `es-reminder-status`     object = active | satisfied | expired
 *   - `es-reminder-expires-at` object = ISO date/time
 *   - `es-reminder-satisfied-at` object = ISO date/time (when closed as satisfied)
 *
 * Actions: create | update | close | list.
 *   - create: files the drawer + edges. HARD RULE ("no expiry, no reminder", spec L109):
 *     expires_at is REQUIRED and must parse as a date — rejected otherwise.
 *   - update: changes what / expires_at on ONE explicit reminder drawer id. No
 *     wing/room/scope write mode exists — broad writes are structurally impossible.
 *   - close: sets status satisfied (with es-reminder-satisfied-at) or expired on
 *     ONE explicit reminder drawer id. Default target is `satisfied`; pass
 *     `status: "expired"` to retire a stale one.
 *   - list: bounded read of the reminders room with per-drawer edge fetch
 *     (concurrency 8, failures degrade to empty facts — never aborts).
 *
 * Dry-run by default — the first call makes NO add_drawer/kg_add; it echoes the
 * exact drawer + edges that would be written. Pass dry_run:false to apply.
 * Per-step failures are counted and never abort the rest (relocate_memory pattern).
 */

import { tool } from "@opencode-ai/plugin";
import { asObject, asText, createPalaceClient } from "../adapter/palace-tools.ts";
import {
  REMINDER_EXPIRES_AT_PREDICATE,
  REMINDER_SATISFIED_AT_PREDICATE,
  REMINDER_STATUS_PREDICATE,
  REMINDERS_ROOM,
  TRIGGERS_ON_PREDICATE,
} from "../adapter/prospective.ts";
import { applyRuntimeConfigToEnv, loadRuntimeConfig } from "../adapter/runtime-config.ts";
import { loadRuntimeEnv } from "../scripts/runtime-env.ts";

declare const process: {
  env: Record<string, string | undefined>;
};

export type CallTool = (name: string, payload: Record<string, unknown>) => Promise<unknown>;

export type RemindAction = "create" | "update" | "close";

export type RemindStepStatus = "proposed" | "done" | "failed" | "skipped";

export type RemindReport = {
  ok: boolean;
  action: RemindAction;
  dry_run: boolean;
  wing?: string;
  room?: string;
  drawer_id?: string;
  steps: Array<{ op: string; status: RemindStepStatus; detail?: string; error?: string }>;
  counts: { proposed: number; done: number; failed: number };
  error?: string;
  next_step?: string;
};

export type ReminderListItem = {
  drawer_id: string;
  what: string;
  status: string;
  conditions: string[];
  expires_at?: string;
  satisfied_at?: string;
  filed_at?: string;
};

export type RemindListReport = {
  ok: boolean;
  wing: string;
  room: string;
  total: number;
  reminders: ReminderListItem[];
  errors: string[];
};

function parseISODate(value: unknown): Date | null {
  const text = asText(value).trim();
  if (!text) return null;
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms);
}

function isTruthyFlag(value: string | undefined): boolean {
  const v = (value || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * Pure core for create/update/close. Exported for unit testing with a fake
 * transport, mirroring runOutcomeRecord / runConcernProposal.
 */
export async function runRemind(args: {
  call: CallTool;
  action: string;
  wing?: string;
  room?: string;
  /** create: the reminder text. update: new text (optional). */
  what?: string;
  /** create: the triggers-on condition value. */
  condition?: string;
  /** create/update: ISO date/time. REQUIRED for create. */
  expiresAt?: string;
  /** close: "satisfied" (default) or "expired". */
  status?: string;
  /** update/close: explicit reminder drawer id. */
  drawerId?: string;
  addedBy?: string;
  dryRun?: boolean;
  now?: () => Date;
}): Promise<RemindReport> {
  const action = String(args.action || "").trim().toLowerCase();
  if (action !== "create" && action !== "update" && action !== "close") {
    throw new Error(`remind: invalid action "${args.action}" — must be create | update | close`);
  }

  const wing = asText(args.wing).trim();
  if (!wing) throw new Error("remind: wing is required (the project wing the reminder belongs to)");
  const room = asText(args.room).trim() || REMINDERS_ROOM;
  const dryRun = args.dryRun !== false;
  const nowIso = (args.now ?? (() => new Date()))().toISOString();

  if (action === "create") {
    const what = asText(args.what).trim();
    const condition = asText(args.condition).trim();
    if (!what) throw new Error("remind: create requires `what` (the reminder text)");
    if (!condition) throw new Error("remind: create requires `condition` (a path/glob, topic keyword, or wing/room)");

    // Hard rule — "no expiry, no reminder" (spec L109). Enforced at write time;
    // the render drops expired ones again at read time. Both gates exist.
    const expiresDate = parseISODate(args.expiresAt);
    if (!expiresDate) {
      throw new Error(
        "remind: create requires a valid ISO `expires_at` — no expiry, no reminder (a reminder that fires forever becomes noise in every prompt)",
      );
    }

    const steps: RemindReport["steps"] = [
      { op: `add_drawer ${wing}/${room}`, status: "proposed", detail: what },
      { op: "kg_add triggers-on", status: "proposed", detail: condition },
      { op: "kg_add es-reminder-status", status: "proposed", detail: "active" },
      { op: `kg_add ${REMINDER_EXPIRES_AT_PREDICATE}`, status: "proposed", detail: expiresDate.toISOString() },
    ];

    if (dryRun) {
      return {
        ok: true,
        action,
        dry_run: true,
        wing,
        room,
        steps,
        counts: { proposed: steps.length, done: 0, failed: 0 },
        next_step: "Show this preview to the operator; re-run with dry_run:false only after their explicit confirmation.",
      };
    }

    // APPLY. The drawer id is not known until add_drawer returns, so edges are
    // written sequentially after it. Each step is best-effort and counted.
    let drawerId = "";
    try {
      const created = asObject(await args.call("add_drawer", {
        wing,
        room,
        content: what,
        source_file: `remind:${condition}`,
        added_by: asText(args.addedBy).trim() || "electric-shepherd-remind",
      }));
      drawerId = asText(created.drawer_id || created.id).trim();
      if (!drawerId) throw new Error("add_drawer returned no drawer_id");
      steps[0].status = "done";
      steps[0].detail = `${what} -> ${drawerId}`;
    } catch (err) {
      steps[0].status = "failed";
      steps[0].error = String(err);
    }

    if (drawerId) {
      const edgePayloads: Array<{ op: string; index: number; payload: Record<string, unknown> }> = [
        { op: "kg_add triggers-on", index: 1, payload: { subject: drawerId, predicate: TRIGGERS_ON_PREDICATE, object: condition, source_drawer_id: drawerId } },
        { op: "kg_add es-reminder-status", index: 2, payload: { subject: drawerId, predicate: REMINDER_STATUS_PREDICATE, object: "active", valid_from: nowIso, source_drawer_id: drawerId } },
        { op: `kg_add ${REMINDER_EXPIRES_AT_PREDICATE}`, index: 3, payload: { subject: drawerId, predicate: REMINDER_EXPIRES_AT_PREDICATE, object: expiresDate.toISOString(), valid_from: nowIso, source_drawer_id: drawerId } },
      ];
      for (const edge of edgePayloads) {
        try {
          await args.call("kg_add", edge.payload);
          steps[edge.index].status = "done";
        } catch (err) {
          steps[edge.index].status = "failed";
          steps[edge.index].error = String(err);
        }
      }
    } else {
      // Drawer never landed — the edges have no subject; mark them skipped.
      for (let i = 1; i < steps.length; i += 1) steps[i].status = "skipped";
    }

    const counts = summarize(steps);
    const report: RemindReport = { ok: counts.failed === 0, action, dry_run: false, wing, room, drawer_id: drawerId || undefined, steps, counts };
    if (counts.failed > 0) {
      report.next_step = `Re-run create with the same args to retry ${counts.failed} failed step(s); identical content maps to a deterministic drawer ID, so re-running is safe.`;
    }
    return report;
  }

  // update / close — explicit drawer id only. No broad write mode exists.
  const drawerId = asText(args.drawerId).trim();
  if (!drawerId) {
    throw new Error(`remind: ${action} requires an explicit `drawer_id` — there is no wing/room/scope write mode; pick the reminder from /reminders first`);
  }

  if (action === "update") {
    const what = asText(args.what).trim();
    const expiresDate = args.expiresAt !== undefined ? parseISODate(args.expiresAt) : null;
    if (!what && !expiresDate) {
      throw new Error("remind: update requires `what` and/or a valid ISO `expires_at`");
    }

    const steps: RemindReport["steps"] = [];
    if (what) steps.push({ op: "update_drawer content", status: "proposed", detail: what });
    if (expiresDate) {
      steps.push({ op: `kg_add ${REMINDER_EXPIRES_AT_PREDICATE}`, status: "proposed", detail: expiresDate.toISOString() });
    }

    if (dryRun) {
      return {
        ok: true,
        action,
        dry_run: true,
        wing,
        room,
        drawer_id: drawerId,
        steps,
        counts: { proposed: steps.length, done: 0, failed: 0 },
        next_step: "Show this preview to the operator; re-run with dry_run:false only after their explicit confirmation.",
      };
    }

    if (what) {
      try {
        await args.call("update_drawer", { drawer_id: drawerId, content: what });
        steps[0].status = "done";
      } catch (err) {
        steps[0].status = "failed";
        steps[0].error = String(err);
      }
    }
    if (expiresDate) {
      const index = what ? 1 : 0;
      try {
        await args.call("kg_add", {
          subject: drawerId,
          predicate: REMINDER_EXPIRES_AT_PREDICATE,
          object: expiresDate.toISOString(),
          valid_from: nowIso,
          source_drawer_id: drawerId,
        });
        steps[index].status = "done";
      } catch (err) {
        steps[index].status = "failed";
        steps[index].error = String(err);
      }
    }

    const counts = summarize(steps);
    const report: RemindReport = { ok: counts.failed === 0, action, dry_run: false, wing, room, drawer_id: drawerId, steps, counts };
    if (counts.failed > 0) report.next_step = `Re-run update with the same args to retry ${counts.failed} failed step(s).`;
    return report;
  }

  // close
  const status = String(args.status || "satisfied").trim().toLowerCase();
  if (status !== "satisfied" && status !== "expired") {
    throw new Error(`remind: close status must be satisfied | expired, got "${args.status}"`);
  }

  const steps: RemindReport["steps"] = [
    { op: `kg_add ${REMINDER_STATUS_PREDICATE}`, status: "proposed", detail: status },
  ];
  if (status === "satisfied") {
    steps.push({ op: `kg_add ${REMINDER_SATISFIED_AT_PREDICATE}`, status: "proposed", detail: nowIso });
  }

  if (dryRun) {
    return {
      ok: true,
      action,
      dry_run: true,
      wing,
      room,
      drawer_id: drawerId,
      steps,
      counts: { proposed: steps.length, done: 0, failed: 0 },
      next_step: "Show this preview to the operator; re-run with dry_run:false only after their explicit confirmation.",
    };
  }

  try {
    await args.call("kg_add", {
      subject: drawerId,
      predicate: REMINDER_STATUS_PREDICATE,
      object: status,
      valid_from: nowIso,
      source_drawer_id: drawerId,
    });
    steps[0].status = "done";
  } catch (err) {
    steps[0].status = "failed";
    steps[0].error = String(err);
  }
  if (status === "satisfied") {
    try {
      await args.call("kg_add", {
        subject: drawerId,
        predicate: REMINDER_SATISFIED_AT_PREDICATE,
        object: nowIso,
        valid_from: nowIso,
        source_drawer_id: drawerId,
      });
      steps[1].status = "done";
    } catch (err) {
      steps[1].status = "failed";
      steps[1].error = String(err);
    }
  }

  const counts = summarize(steps);
  const report: RemindReport = { ok: counts.failed === 0, action, dry_run: false, wing, room, drawer_id: drawerId, steps, counts };
  if (counts.failed > 0) report.next_step = `Re-run close with the same args to retry ${counts.failed} failed step(s).`;
  return report;
}

function summarize(steps: RemindReport["steps"]): { proposed: number; done: number; failed: number } {
  const counts = { proposed: steps.length, done: 0, failed: 0 };
  for (const step of steps) {
    if (step.status === "done") counts.done += 1;
    else if (step.status === "failed") counts.failed += 1;
  }
  return counts;
}

/**
 * Pure core for listing: bounded page of the reminders room + per-drawer edge
 * fetch with concurrency 8. Read failures degrade to empty facts per drawer —
 * the list still returns what it could read, never throws on a flaky KG.
 */
export async function runRemindList(args: {
  call: CallTool;
  wing: string;
  room?: string;
  limit?: number;
  /** Filter: only reminders with this status (active | satisfied | expired). */
  status?: string;
  /** Filter: only reminders whose condition contains this substring. */
  conditionContains?: string;
}): Promise<RemindListReport> {
  const wing = asText(args.wing).trim();
  if (!wing) throw new Error("remind list: wing is required");
  const room = asText(args.room).trim() || REMINDERS_ROOM;
  const limit = Math.max(1, Math.min(50, Number(args.limit) || 20));

  let listed: unknown;
  try {
    listed = await args.call("list_drawers", { wing, room, limit, offset: 0 });
  } catch (err) {
    return { ok: false, wing, room, total: 0, reminders: [], errors: [String(err)] };
  }

  const root = asObject(listed);
  const rows = (Array.isArray(root.drawers) ? root.drawers : Array.isArray(root.results) ? root.results : []) as Array<Record<string, unknown>>;
  const drawers = rows.slice(0, limit).map((row) => {
    const meta = asObject(row.metadata);
    return {
      drawer_id: asText(row.drawer_id || row.node_id || row.id).trim(),
      what: asText(row.content || row.text || meta.content).trim(),
      filed_at: asText(row.filed_at || row.created_at || meta.created_at).trim() || undefined,
    };
  }).filter((row) => row.drawer_id);

  const statusFilter = (asText(args.status).trim().toLowerCase() || "").replace(/^es-reminder-status:\s*/, "");
  const conditionFilter = asText(args.conditionContains).trim().toLowerCase();

  // Bounded concurrency fan-out for per-drawer edges (8 — the validated level).
  const out: ReminderListItem[] = [];
  const errors: string[] = [];
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < drawers.length) {
      const index = cursor;
      cursor += 1;
      const drawer = drawers[index];
      const item: ReminderListItem = { drawer_id: drawer.drawer_id, what: drawer.what, status: "unknown", conditions: [], filed_at: drawer.filed_at };
      try {
        const result = asObject(await args.call("kg_query", { entity: drawer.drawer_id, direction: "outgoing" }));
        const facts = (Array.isArray(result.facts) ? result.facts : []) as Array<Record<string, unknown>>;
        for (const fact of facts) {
          if (fact.current === false) continue;
          const predicate = asText(fact.predicate).trim();
          const object = asText(fact.object).trim();
          if (!object) continue;
          if (predicate === TRIGGERS_ON_PREDICATE) item.conditions.push(object);
          else if (predicate === REMINDER_STATUS_PREDICATE) item.status = object.toLowerCase();
          else if (predicate === REMINDER_EXPIRES_AT_PREDICATE) item.expires_at = object;
          else if (predicate === REMINDER_SATISFIED_AT_PREDICATE) item.satisfied_at = object;
        }
      } catch (err) {
        errors.push(`${drawer.drawer_id}: ${String(err)}`);
      }
      if (statusFilter && item.status !== statusFilter) continue;
      if (conditionFilter && !item.conditions.some((c) => c.toLowerCase().includes(conditionFilter))) continue;
      out.push(item);
    }
  };
  const slots = Math.max(1, Math.min(8, drawers.length));
  await Promise.all(Array.from({ length: slots }, () => worker()));

  return { ok: true, wing, room, total: out.length, reminders: out, errors };
}

export default tool({
  description:
    "Phase 8 prospective memory: create/update/close/list reminders (one drawer per reminder in the project wing's `reminders` room, with triggers-on + es-reminder-status/expires-at edges). Reminders render into mem-core under a [pending] block when their trigger matches the current scope. Dry-run by default; pass dry_run:false to apply. No expiry, no reminder: create requires a valid ISO expires_at.",
  args: {
    action: tool.schema.enum(["create", "update", "close", "list"]).describe("Lifecycle action."),
    wing: tool.schema.string().describe("Project wing the reminder belongs to (required)."),
    room: tool.schema.string().optional().describe("Reminder room (default: reminders)."),
    what: tool.schema.string().optional().describe("create: the reminder text. update: new text."),
    condition: tool.schema
      .string()
      .optional()
      .describe("create: triggers-on condition — a path/glob (web/src/**), a topic keyword (prompt caching), or a wing/room scope."),
    expires_at: tool.schema
      .string()
      .optional()
      .describe("ISO date/time. REQUIRED for create (no expiry, no reminder); optional on update."),
    drawer_id: tool.schema
      .string()
      .optional()
      .describe("update/close: the explicit reminder drawer id (from /reminders). No broad write mode exists."),
    status: tool.schema
      .enum(["satisfied", "expired"])
      .optional()
      .describe("close: target status (default satisfied). list: filter by status."),
    limit: tool.schema.number().optional().describe("list: max reminders to return (default 20, max 50)."),
    condition_contains: tool.schema.string().optional().describe("list: only reminders whose condition contains this substring."),
    dry_run: tool.schema.boolean().optional().describe("Preview without writing (default true). Pass false only after explicit operator confirmation."),
    added_by: tool.schema.string().optional().describe("Attribution for created drawers (default electric-shepherd-remind)."),
    tool_prefix: tool.schema.string().optional().describe("MCP tool prefix override."),
  },
  async execute(args, context) {
    const cwd = context.worktree || context.directory;
    loadRuntimeEnv({ scriptUrl: import.meta.url, env: process.env, cwd });
    const runtimeConfig = loadRuntimeConfig({ cwd, env: process.env });
    applyRuntimeConfigToEnv(process.env, runtimeConfig);

    const { client, prefix } = await createPalaceClient({
      env: process.env,
      clientName: "electric-shepherd-remind",
      toolPrefix: args.tool_prefix,
    });
    const call: CallTool = async (name: string, payload: Record<string, unknown>) =>
      client.callTool(`${prefix}${name}`, payload);

    const wing = String(args.wing || runtimeConfig.valuesByPath.memory?.projectWing || "").trim();
    const action = String(args.action || "list").trim().toLowerCase();

    if (action === "list") {
      const report = await runRemindList({
        call,
        wing,
        room: args.room,
        limit: args.limit,
        status: typeof args.status === "string" ? args.status : undefined,
        conditionContains: args.condition_contains,
      });
      return JSON.stringify(report, null, 2);
    }

    const report = await runRemind({
      call,
      action,
      wing,
      room: args.room,
      what: args.what,
      condition: args.condition,
      expiresAt: args.expires_at,
      status: typeof args.status === "string" ? args.status : undefined,
      drawerId: args.drawer_id,
      addedBy: args.added_by,
      dryRun: args.dry_run,
    });
    return JSON.stringify(report, null, 2);
  },
});
