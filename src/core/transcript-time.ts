/** Original source clocks only; never use capture URIs or filed_at as event time. */
export type TranscriptTime = Partial<Record<"created" | "updated" | "completed" | "streamed" | "idle" | "viewed" | "archived" | "recorded", string>>;
export type SourceChronology = {
  sourceDrawerId: string;
  sessionId?: string;
  sessionTime?: TranscriptTime;
  retainedMessageTimeRange?: { earliest: string; latest: string };
};
const TIME_FIELDS = new Set(["created", "updated", "completed", "streamed", "idle", "viewed", "archived", "recorded"]);

export function sourceISOTime(value: unknown, milliseconds = false): string | undefined {
  let date: Date;
  if (milliseconds) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return;
    date = new Date(value);
  } else {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return;
    const calendar = new Date(value.slice(0, 10) + "T00:00:00.000Z");
    if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== value.slice(0, 10)) return;
    date = new Date(value);
  }
  if (Number.isFinite(date.getTime()) && date.getUTCFullYear() >= 0 && date.getUTCFullYear() <= 9999) return date.toISOString();
}

export function transcriptTime(value: unknown): TranscriptTime | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const time: TranscriptTime = {};
  for (const [key, raw] of Object.entries(value)) {
    const iso = sourceISOTime(raw);
    if (TIME_FIELDS.has(key) && iso) time[key as keyof TranscriptTime] = iso;
  }
  return Object.keys(time).length ? time : undefined;
}

/** Read persisted metadata.desc JSON, not the drawer's filing clock. */
export function persistedSourceChronology(desc: unknown): SourceChronology[] {
  if (typeof desc !== "string") return [];
  let parsed;
  try { parsed = JSON.parse(desc); } catch { return []; }
  if (!Array.isArray(parsed?.sourceChronology)) return [];
  return parsed.sourceChronology.flatMap((row: unknown) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return [];
    const value = row as Record<string, unknown>;
    if (typeof value.sourceDrawerId !== "string" || !value.sourceDrawerId.trim()) return [];
    const result: SourceChronology = { sourceDrawerId: value.sourceDrawerId };
    if (typeof value.sessionId === "string") result.sessionId = value.sessionId;
    const time = transcriptTime(value.sessionTime);
    if (time) result.sessionTime = time;
    const range = value.retainedMessageTimeRange as Record<string, unknown> | undefined;
    const earliest = sourceISOTime(range?.earliest), latest = sourceISOTime(range?.latest);
    if (earliest && latest && earliest <= latest) result.retainedMessageTimeRange = { earliest, latest };
    return [result];
  });
}
