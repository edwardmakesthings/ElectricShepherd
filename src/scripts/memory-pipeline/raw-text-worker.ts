import { WorkerFailure } from "./omp-completion.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";

export const MAX_WORKER_ATTEMPTS = 2;
export type WorkerAttempt = { attempt: number; timeoutMs: number };
export type AttemptRecord = { attempt: number; outcome: "accepted" | "rejected"; category?: string; finish?: string };
export type WorkerPolicy = { deadlineMs?: number; timeoutMs?: number };
export function requireWorkerDeadline(deadlineMs: number): void {
  if (!Number.isFinite(deadlineMs) || Date.now() >= deadlineMs) throw new WorkerFailure("deadline");
}

/** Deterministic substance floor, not an accuracy or task-invention detector. Text is never rewritten. */
export function admitDrawerText(text: string): string {
  if (typeof text !== "string" || !text.trim()) throw new WorkerFailure("empty", true);
  if ((text.match(/[\p{L}\p{N}]/gu) || []).length < 40) throw new WorkerFailure("insubstantial");
  return text;
}

/** Inference only. Callers MUST NOT wrap a palace write with this helper. */
export async function requestDrawerText(args: WorkerPolicy & {
  invoke: (attempt: WorkerAttempt) => Promise<string>;
  records: AttemptRecord[];
  auditDirectory?: string;
  operationId?: string;
}): Promise<string> {
  const deadline = args.deadlineMs ?? Date.now() + 30 * 60_000;
  const timeout = args.timeoutMs ?? 900_000;
  for (let attempt = 1; attempt <= MAX_WORKER_ATTEMPTS; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0 || !Number.isFinite(remaining)) {
      args.records.push({ attempt, outcome: "rejected", category: "deadline" });
      audit();
      throw new WorkerFailure("deadline");
    }
    let response: string | undefined;
    try {
      response = await args.invoke({ attempt, timeoutMs: Math.min(timeout, remaining) });
      if (Date.now() >= deadline) throw new WorkerFailure("deadline");
      const text = admitDrawerText(response);
      args.records.push({ attempt, outcome: "accepted" });
      audit();
      return text;
    } catch (error) {
      const failure = error instanceof WorkerFailure ? error : undefined;
      args.records.push({ attempt, outcome: "rejected", category: failure?.category ?? "unclassified", finish: failure?.finish });
      audit(response);
      if (!failure?.retryable || !["transport", "timeout", "empty", "length", "error"].includes(failure.category) || attempt === MAX_WORKER_ATTEMPTS) throw error;
    }
    function audit(rejected?: string) {
      if (!args.auditDirectory) return;
      mkdirSync(args.auditDirectory, { recursive: true, mode: 0o700 });
      // Rejected bytes may contain credentials. Keep only size/hash, never raw error messages or thinking.
      const rejection = rejected === undefined ? undefined : { bytes: Buffer.byteLength(rejected), hash: createHash("sha256").update(rejected).digest("hex") };
      writeFileSync(join(args.auditDirectory, (args.operationId || "worker") + "." + randomUUID() + ".json"),
        JSON.stringify({ operationId: args.operationId, ...args.records.at(-1), rejection }), { flag: "wx", mode: 0o600 });
    }
  }
  throw new WorkerFailure("deadline");
}
