import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";
import { transcriptTime } from "../../core/transcript-time.ts";
import { digest, MAX_PREPROCESSING_BYTES, preprocessTranscript, type SourceChunkInventory } from "./chunk-extraction.ts";

export type LoadedSource = {
  inventory: SourceChunkInventory;
  readChunk: (index: number) => Promise<string>;
};
export type LocalSourceIdentity = {
  kind: "local-normalized-transcript"; fileURI: string; sha256: string; bytes: number;
  sessionURI: string; fragmentKind: "local-host-fragment";
};

function requireValue(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(reason);
}
function object(value: unknown): Record<string, unknown> {
  requireValue(value && typeof value === "object" && !Array.isArray(value), "invalid-local-transcript-object");
  return value as Record<string, unknown>;
}
function validateTime(value: unknown): void {
  if (value === undefined) return; // Older normalized transcripts may be undated.
  const raw = object(value), parsed = transcriptTime(raw);
  requireValue(parsed && Object.keys(parsed).length === Object.keys(raw).length, "invalid-local-transcript-time");
}

/** Read exact UTF-8 bytes; host fragments are not stored palace chunks. */
export function loadLocalTranscript(file: string): LoadedSource {
  const path = realpathSync(file), bytes = readFileSync(path);
  requireValue(bytes.length > 0 && bytes.length <= MAX_PREPROCESSING_BYTES, "local-transcript-size-limit");
  const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  const parsed = object(JSON.parse(content)), session = object(parsed.session);
  requireValue(Object.keys(parsed).sort().join(",") === "messages,session", "invalid-local-transcript-shape");
  requireValue(typeof session.id === "string" && /^ses_[A-Za-z0-9]+$/.test(session.id) &&
    typeof session.title === "string" && session.title.trim() && typeof session.directory === "string" && session.directory.trim(),
    "invalid-local-session-identity");
  requireValue(Object.keys(session).every(key => ["id", "title", "directory", "time"].includes(key)), "invalid-local-session-fields");
  validateTime(session.time);
  requireValue(Array.isArray(parsed.messages) && parsed.messages.length > 0, "invalid-local-transcript-messages");
  for (const raw of parsed.messages) {
    const message = object(raw);
    requireValue(["user", "assistant"].includes(String(message.role)) && typeof message.text === "string" && message.text.trim() &&
      Object.keys(message).every(key => ["role", "text", "time"].includes(key)), "invalid-local-transcript-message");
    validateTime(message.time);
  }
  const sessionURI = "opencode://session/" + session.id, fileURI = pathToFileURL(path).href;
  const localSource: LocalSourceIdentity = { kind: "local-normalized-transcript", fileURI,
    sha256: digest(content), bytes: bytes.length, sessionURI, fragmentKind: "local-host-fragment" };
  const inventory: SourceChunkInventory = { parentDrawerId: sessionURI, requiredChunkCount: 1,
    chunks: [{ drawerId: fileURI + "#local-host-fragment-0", chunkIndex: 0 }], localSource };
  const prepared = preprocessTranscript([content], inventory);
  requireValue(prepared.audit.retainedCount !== null, "unsupported-local-transcript:" + prepared.audit.fallbackReason);
  return { inventory, readChunk: async index => {
    requireValue(index === 0, "invalid-local-host-fragment-index");
    requireValue(readFileSync(path).equals(bytes), "local-source-changed-during-run");
    return content;
  } };
}
