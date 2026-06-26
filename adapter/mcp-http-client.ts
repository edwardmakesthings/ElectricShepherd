/**
 * Reusable Streamable-HTTP MCP transport for MemPalace.
 *
 * This is the single source of truth for talking to a MemPalace MCP endpoint
 * over HTTP from ElectricShepherd's runtime scripts and its test fixtures.
 * Both `run-policy-cycle.ts` and `run-memory-consolidation-and-validation.ts`
 * previously carried byte-identical copies of this client plus the
 * env-to-headers resolver; centralizing them here keeps auth handling and
 * SSE/JSON response parsing consistent across every caller.
 *
 * The client speaks the 2025-03-26 MCP protocol: it performs the
 * `initialize` + `notifications/initialized` handshake, threads the
 * `Mcp-Session-Id` header returned by the server through subsequent calls,
 * and unwraps tool results from either a plain JSON body or a
 * `text/event-stream` (`data:` line) body.
 */

import type { JsonMap } from "./memgraph.ts";

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

export type MCPHttpClientOptions = {
  /** Identifies this client to the server in the `initialize` handshake. */
  clientName?: string;
  clientVersion?: string;
  /** Maximum time in milliseconds to wait for a single request before aborting. */
  requestTimeoutMs?: number;
};

export class MCPHttpClient {
  private readonly url: string;
  private sessionId: string | null;
  private idCounter: number;
  private readonly staticHeaders: Record<string, string>;
  private readonly clientName: string;
  private readonly clientVersion: string;
  private readonly requestTimeoutMs: number;

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

  private async post(payload: MCPMessage): Promise<MCPResponse> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...this.staticHeaders,
    };
    if (this.sessionId) {
      headers["Mcp-Session-Id"] = this.sessionId;
    }

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
    } finally {
      clearTimeout(timeout);
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
    const response = await this.post(init);
    if (response.error) {
      throw new Error(`MCP initialize failed: ${response.error.message}`);
    }

    const notify: MCPMessage = {
      jsonrpc: "2.0",
      id: this.nextID(),
      method: "notifications/initialized",
      params: {},
    };
    await this.post(notify).catch(() => {
      // Some servers reject notification RPC-style responses; safe to ignore.
    });
  }

  async callTool(name: string, args?: JsonMap): Promise<JsonMap> {
    const payload: MCPMessage = {
      jsonrpc: "2.0",
      id: this.nextID(),
      method: "tools/call",
      params: { name, arguments: args || {} },
    };

    const response = await this.post(payload);
    if (response.error) {
      throw new Error(`Tool call failed (${name}): ${response.error.message}`);
    }

    const result = response.result || {};
    const content = (result.content || []) as Array<Record<string, unknown>>;

    // MCP reports tool-execution failures (e.g. a gateway denying a tool for
    // this key) as `isError: true` on an otherwise-2xx result, with the
    // message carried in the text parts. Surface these as thrown errors so
    // callers can't silently treat a denied/failed call as a valid envelope.
    if (result.isError === true) {
      const detail = content
        .map((item) =>
          item.type === "text" && typeof item.text === "string" ? item.text : ""
        )
        .join(" ")
        .trim();
      throw new Error(`Tool call failed (${name}): ${detail || "unknown tool error"}`);
    }

    // MemPalace tools generally return JSON in text parts.
    for (const item of content) {
      if (item.type === "text" && typeof item.text === "string") {
        try {
          return JSON.parse(item.text) as JsonMap;
        } catch {
          // Not JSON text; continue searching or fall through to the envelope.
        }
      }
    }

    // Fallback: pass the raw result object through as a JsonMap.
    return result as JsonMap;
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
    } catch {
      // Ignore malformed override headers and keep known-safe defaults.
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
