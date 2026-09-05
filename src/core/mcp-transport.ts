/**
 * Streamable-HTTP MCP transport for the MemPalace substrate (spec §4.1).
 *
 * This is the ONLY file in the runtime that speaks raw JSON-RPC to a MemPalace
 * MCP endpoint over HTTP. It moved here from adapter/mcp-http-client.ts as part
 * of Rung 3 so that the transport construction lives inside core/ — every
 * non-core caller (tools/, scripts/, plugin/) reaches the substrate exclusively
 * through `createSubstrateClient` in core/substrate-client.ts, which is the only
 * place outside this file that may construct an MCPHttpClient.
 *
 * The client speaks the 2025-03-26 MCP protocol: it performs the
 * `initialize` + `notifications/initialized` handshake, threads the
 * `Mcp-Session-Id` header returned by the server through subsequent calls,
 * and unwraps tool results from either a plain JSON body or a
 * `text/event-stream` (`data:` line) body.
 */

import type { JsonMap } from "./memgraph.ts";
import type { CoreFailureKind } from "./substrate.ts";

type MCPMessage = {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
};

type MCPResponse = {
  jsonrpc: "2.0";
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
};

/**
 * Failure kinds for substrate calls (spec §4.1). `stale-library` is the
 * first-class outcome for a server refusing work because its library is stale;
 * it is never retried and never swallowed.
 */
export type SubstrateFailureKind = CoreFailureKind;

/**
 * Discriminated outcome for a substrate call. Success carries the parsed value;
 * failure carries an explicit kind + operator-visible detail so callers can
 * branch instead of treating an error as an empty result.
 */
export type SubstrateResult<T> =
  | { ok: true; value: T }
  | { ok: false; kind: SubstrateFailureKind; detail: string };

export class SubstrateError extends Error {
  readonly kind: SubstrateFailureKind;
  constructor(kind: SubstrateFailureKind, detail: string) {
    super(detail);
    this.name = "SubstrateError";
    this.kind = kind;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failureDetail(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}

function classifyPostError(err: unknown): SubstrateFailureKind {
  const detail = failureDetail(err);
  if (err instanceof SubstrateError) return err.kind;
  if (/MCP HTTP 404\b|not found/i.test(detail)) return "not-found";
  if (err instanceof TypeError) return "transport";
  if (/timeout|timed out|network|fetch failed|abort|socket|econn|enotfound/i.test(detail)) {
    return "transport";
  }
  return "protocol";
}

function classifyJSONRPCError(name: string, error: { code: number; message: string; data?: unknown }): { kind: SubstrateFailureKind; detail: string } {
  const actionRequired = isPlainObject(error.data) && typeof error.data.action_required === "string"
    ? error.data.action_required
    : "";
  const detail = actionRequired
    ? `Tool call failed (${name}): ${error.message} (action_required: "${actionRequired}")`
    : `Tool call failed (${name}): ${error.message}`;
  if (error.code === -32005) return { kind: "stale-library", detail };
  if (actionRequired === "restart_mcp_server") {
    return { kind: "stale-library", detail };
  }
  if (/not found|no such tool/i.test(error.message)) return { kind: "not-found", detail };
  return { kind: "protocol", detail };
}

export type MCPHttpClientOptions = {
  /** Identifies this client to the server in the `initialize` handshake. */
  clientName?: string;
  clientVersion?: string;
  /** Maximum time in milliseconds to wait for a single request before aborting. */
  requestTimeoutMs?: number;
  /** Retries for transient transport failures (timeout/network). */
  maxRetries?: number;
  /** Base backoff in milliseconds between retries. */
  retryBackoffMs?: number;
  /** Maximum backoff cap in milliseconds between retries. */
  retryMaxBackoffMs?: number;
};

export class MCPHttpClient {
  private readonly url: string;
  private sessionId: string | null;
  private idCounter: number;
  private readonly staticHeaders: Record<string, string>;
  private readonly clientName: string;
  private readonly clientVersion: string;
  private readonly requestTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBackoffMs: number;
  private readonly retryMaxBackoffMs: number;

  constructor(
    url: string,
    staticHeaders: Record<string, string> = {},
    options: MCPHttpClientOptions = {}
  ) {
    this.url = url;
    this.sessionId = null;
    this.idCounter = 0;
    this.staticHeaders = staticHeaders;
    this.clientName = options.clientName || "electric-shepherd";
    this.clientVersion = options.clientVersion || "0.1.0";
    this.requestTimeoutMs = Number(options.requestTimeoutMs ?? 600000);
    this.maxRetries = Math.max(0, Math.floor(Number(options.maxRetries ?? 2)));
    this.retryBackoffMs = Math.max(1, Math.floor(Number(options.retryBackoffMs ?? 800)));
    this.retryMaxBackoffMs = Math.max(this.retryBackoffMs, Math.floor(Number(options.retryMaxBackoffMs ?? 8000)));
  }

  private nextID(): number {
    this.idCounter += 1;
    return this.idCounter;
  }

  private parseResponsePayload(raw: string): MCPResponse {
    const trimmed = raw.trim();
    if (!trimmed) {
      throw new Error("Empty MCP response");
    }
    if (trimmed.startsWith("{")) {
      return JSON.parse(trimmed) as MCPResponse;
    }

    // Streamable HTTP responses arrive as Server-Sent Events; the JSON-RPC
    // payload is the last `data:` line in the stream.
    let lastData: string | null = null;
    const lines = trimmed.split(/\r?\n/);
    for (const line of lines) {
      const clean = line.trim();
      if (clean.startsWith("data:")) {
        lastData = clean.slice(5).trim();
      }
    }
    if (!lastData) {
      throw new Error(`Unable to parse MCP response: ${trimmed.slice(0, 200)}`);
    }
    return JSON.parse(lastData) as MCPResponse;
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private shouldRetryError(err: unknown): boolean {
    const maybe = err as { name?: unknown; message?: unknown };
    const name = typeof maybe?.name === "string" ? maybe.name : "";
    if (name === "AbortError") return true;

    if (err instanceof TypeError) return true;

    const message = typeof maybe?.message === "string" ? maybe.message : "";
    return /timeout|timed out|network|fetch failed/i.test(message);
  }

  private async post(payload: MCPMessage): Promise<MCPResponse> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...this.staticHeaders,
    };
    if (this.sessionId) {
      headers["Mcp-Session-Id"] = this.sessionId;
    }

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);

      try {
        const response = await fetch(this.url, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        const sessionHeader = response.headers.get("Mcp-Session-Id");
        if (sessionHeader) {
          this.sessionId = sessionHeader;
        }

        const text = await response.text();
        if (!response.ok) {
          throw new Error(`MCP HTTP ${response.status}: ${text.slice(0, 300)}`);
        }
        return this.parseResponsePayload(text);
      } catch (err) {
        if (attempt >= this.maxRetries || !this.shouldRetryError(err)) {
          throw err;
        }
        const jitterMs = Math.floor(Math.random() * 120);
        const backoffMs = Math.min(this.retryBackoffMs * 2 ** attempt + jitterMs, this.retryMaxBackoffMs);
        await this.sleep(backoffMs);
      } finally {
        clearTimeout(timeout);
      }
    }

    throw new Error("MCP request retry loop exhausted");

  }

  private async postResult(payload: MCPMessage): Promise<SubstrateResult<MCPResponse>> {
    try {
      const response = await this.post(payload);
      return { ok: true, value: response };
    } catch (err) {
      const kind = classifyPostError(err);
      return { ok: false, kind, detail: failureDetail(err) };
    }
  }

  async initialize(): Promise<void> {
    const init: MCPMessage = {
      jsonrpc: "2.0",
      id: this.nextID(),
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: this.clientName, version: this.clientVersion },
      },
    };
    const initResult = await this.postResult(init);
    if (initResult.ok === false) {
      throw new SubstrateError(initResult.kind, `MCP initialize failed: ${initResult.detail}`);
    }
    if (initResult.value.error) {
      const classified = classifyJSONRPCError("initialize", initResult.value.error);
      throw new SubstrateError(classified.kind, classified.detail);
    }

    const notify: MCPMessage = {
      jsonrpc: "2.0",
      id: this.nextID(),
      method: "notifications/initialized",
      params: {},
    };
    const notifyResult = await this.postResult(notify);
    if (notifyResult.ok === false) {
      // Explicit best-effort ignore: some servers reject notification RPC-style
      // responses; the initialize handshake has already succeeded, so log and continue.
      console.warn(
        `[mcp-http-client] notifications/initialized rejected (ignored by design): ${notifyResult.detail}`
      );
      return;
    }
    if (notifyResult.value.error) {
      const classified = classifyJSONRPCError("notifications/initialized", notifyResult.value.error);
      console.warn(
        `[mcp-http-client] notifications/initialized returned protocol error (ignored by design): ${classified.detail}`
      );
    }
  }

  async callToolResult<T = JsonMap>(name: string, args?: JsonMap): Promise<SubstrateResult<T>> {
    const payload: MCPMessage = {
      jsonrpc: "2.0",
      id: this.nextID(),
      method: "tools/call",
      params: { name, arguments: args || {} },
    };

    const responseResult = await this.postResult(payload);
    if (responseResult.ok === false) {
      return { ok: false, kind: responseResult.kind, detail: `Tool call failed (${name}): ${responseResult.detail}` };
    }

    const response = responseResult.value;
    if (response.error) {
      const classified = classifyJSONRPCError(name, response.error);
      return { ok: false, kind: classified.kind, detail: classified.detail };
    }

    const result = isPlainObject(response.result) ? response.result : {};
    const content = Array.isArray(result.content) ? (result.content as unknown[]) : [];

    // MCP reports tool-execution failures (e.g. a gateway denying a tool for
    // this key) as `isError: true` on an otherwise-2xx result, with the
    // message carried in the text parts. Surface these as explicit protocol
    // failures so callers can't silently treat a denied/failed call as valid.
    if (result.isError === true) {
      const detail = content
        .map((item) =>
          isPlainObject(item) && item.type === "text" && typeof item.text === "string" ? item.text : ""
        )
        .join(" ")
        .trim();
      return { ok: false, kind: "protocol", detail: `Tool call failed (${name}): ${detail || "unknown tool error"}` };
    }

    // MemPalace tools generally return JSON in text parts. A text part that is
    // not valid JSON is an explicit protocol failure, not a silent fallthrough.
    let sawText = false;
    for (const item of content) {
      if (!isPlainObject(item) || item.type !== "text" || typeof item.text !== "string") continue;
      sawText = true;
      try {
        const parsed: unknown = JSON.parse(item.text);
        if (!isPlainObject(parsed)) {
          return { ok: false, kind: "protocol", detail: `Tool call (${name}) returned non-object JSON` };
        }
        return { ok: true, value: parsed as T };
      } catch (err) {
        return {
          ok: false,
          kind: "protocol",
          detail: `Tool call (${name}) returned invalid JSON text: ${failureDetail(err)}`,
        };
      }
    }

    if (sawText) {
      return { ok: false, kind: "protocol", detail: `Tool call (${name}) returned no valid JSON text part` };
    }

    // No text parts: pass the raw result object through as a JsonMap.
    return { ok: true, value: result as T };
  }

  async callTool(name: string, args?: JsonMap): Promise<JsonMap> {
    const result = await this.callToolResult<JsonMap>(name, args);
    if (result.ok === false) {
      throw new SubstrateError(result.kind, result.detail);
    }
    return result.value;
  }
}

/**
 * Build the static auth/override headers for a MemPalace MCP endpoint from the
 * runtime environment. Resolution order (later steps never clobber an
 * already-set header):
 *   1. `MEMPALACE_MCP_HEADERS_JSON` — raw header overrides (wins outright).
 *   2. `MEMPALACE_MCP_BEARER_TOKEN` — sets `Authorization: Bearer <token>`.
 *   3. `MEMPALACE_MCP_API_KEY` — placed on `MEMPALACE_MCP_AUTH_HEADER`
 *      (default `Authorization`) using `MEMPALACE_MCP_AUTH_SCHEME` if given,
 *      else inferring `Bearer` for the Authorization header.
 */
export function resolveMCPHeadersFromEnv(
  env: Record<string, string | undefined>
): Record<string, string> {
  const headers: Record<string, string> = {};

  const hasHeader = (name: string): boolean =>
    Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase());

  const rawHeadersJSON = (env.MEMPALACE_MCP_HEADERS_JSON || "").trim();
  if (rawHeadersJSON) {
    try {
      const parsed = JSON.parse(rawHeadersJSON) as Record<string, unknown>;
      for (const [key, value] of Object.entries(parsed || {})) {
        if (typeof value === "string" && key) {
          headers[key] = value;
        }
      }
    } catch (err) {
      // Named degradation: a malformed MEMPALACE_MCP_HEADERS_JSON override is not
      // fatal — we fall back to the known-safe defaults resolved above. The reason
      // is logged (not swallowed silently) so an operator who set the override can
      // see why it was ignored (spec §4.1: "a caller that wants to ignore an error
      // must say so explicitly and name a reason").
      console.warn(
        `[mcp-transport] ignoring malformed MEMPALACE_MCP_HEADERS_JSON, keeping default headers: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const rawBearerToken = (env.MEMPALACE_MCP_BEARER_TOKEN || "").trim();
  if (rawBearerToken && !hasHeader("Authorization")) {
    headers.Authorization = /^Bearer\s+/i.test(rawBearerToken)
      ? rawBearerToken
      : `Bearer ${rawBearerToken}`;
  }

  const rawAPIKey = (env.MEMPALACE_MCP_API_KEY || "").trim();

  const authHeader = (env.MEMPALACE_MCP_AUTH_HEADER || "Authorization").trim();
  const authScheme = (env.MEMPALACE_MCP_AUTH_SCHEME || "").trim();
  const resolvedHeaderName = authHeader || "Authorization";

  if (rawAPIKey && !hasHeader(resolvedHeaderName)) {
    let authValue = rawAPIKey;
    if (authScheme) {
      authValue = authScheme.toLowerCase() === "none" ? rawAPIKey : `${authScheme} ${rawAPIKey}`;
    } else if (resolvedHeaderName.toLowerCase() === "authorization") {
      authValue = /^[A-Za-z][A-Za-z0-9_-]*\s+/.test(rawAPIKey)
        ? rawAPIKey
        : `Bearer ${rawAPIKey}`;
    }
    headers[resolvedHeaderName] = authValue;
  }

  return headers;
}
