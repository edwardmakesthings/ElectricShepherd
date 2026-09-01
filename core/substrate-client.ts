/**
 * The substrate client seam (spec §4.1, Rung 3).
 *
 * `createSubstrateClient` is the ONLY place outside core/mcp-transport.ts that
 * may construct an MCPHttpClient and run its initialize handshake. Every
 * runtime caller (tools/, scripts/, plugin/) obtains a substrate connection by
 * calling this factory instead of constructing the transport directly — which
 * is what makes Check A (no `new MCPHttpClient` outside core/) true.
 *
 * The factory returns:
 *   - `client`  — the initialized MCPHttpClient (for raw callTool/callToolResult).
 *   - `prefix`  — the resolved tool-name prefix (e.g. "mempalace_").
 *   - `url`     — the endpoint URL actually used (operator-visible in reports).
 *
 * Endpoint/header resolution is carried over from adapter/palace-tools.ts
 * (`resolvePalaceEndpoint`, `palaceToolPrefix`) so the two construction paths
 * stay byte-identical. Loopback endpoints are unauthenticated by design:
 * sending gateway credentials to a process that never needs them would be a
 * leak, not a feature.
 */

import {
  MCPHttpClient,
  resolveMCPHeadersFromEnv,
  type MCPHttpClientOptions,
  type SubstrateFailureKind,
  type SubstrateResult,
} from "./mcp-transport.ts";

/**
 * The substrate tool-name prefix and default endpoint live HERE — in core/ —
 * because the binding rule (spec §3.1) is that the literal `mempalace_` may
 * appear in exactly one directory: core/. Every other layer names a substrate
 * tool only through these constants or through a core-provided client; it never
 * spells the prefix itself. adapter/runtime-config.ts re-exports them for the
 * config-spec table so existing importers keep working unchanged.
 */
export const SUBSTRATE_TOOL_PREFIX = "mempalace_";
export const SUBSTRATE_DEFAULT_URL = "http://localhost:8093/mcp";

/**
 * Namespaced fallback tool names for the update-drawer path. When the server
 * rejects the prefixed name (not-found / not-allowed), MemgraphClient retries
 * with these gateway-namespaced spellings. They carry the `mempalace_` literal,
 * so they live in core/ per the binding rule; adapter/memgraph.ts imports them.
 */
export const UPDATE_DRAWER_FALLBACK_NAMES = [
  "mempalace-mempalace_update_drawer",
  "dream_mempalace-mempalace_update_drawer",
] as const;

export type PalaceEnv = Record<string, string | undefined>;

export type PalaceEndpoint = {
  url: string;
  headers: Record<string, string>;
};

// The default direct MemPalace server (localhost:8093) is unauthenticated by
// design — sending gateway credentials to a process that never needs them would be
// a leak, not a feature. This mirrors the pre-Rung-3 check exactly (the old code
// tested `url.includes("localhost:8093")`), so loopback setups that DO set a bearer
// token keep working unchanged. A broader "any loopback" test would over-strip and
// break the default-server auth path.
function isDirectLoopbackServer(url: string): boolean {
  return url.includes("localhost:8093");
}

export function resolvePalaceEndpoint(env: PalaceEnv): PalaceEndpoint {
  const url = String(env.MEMPALACE_MCP_URL || "").trim() || SUBSTRATE_DEFAULT_URL;
  return { url, headers: isDirectLoopbackServer(url) ? {} : resolveMCPHeadersFromEnv(env) };
}

export function palaceToolPrefix(env: PalaceEnv, override?: string): string {
  return String(override || env.MEMGRAPH_TOOL_PREFIX || SUBSTRATE_TOOL_PREFIX).trim() || SUBSTRATE_TOOL_PREFIX;
}

export type SubstrateClientOptions = {
  /** Runtime environment used for endpoint + header resolution. */
  env: PalaceEnv;
  /** Identifies this client to the server in the initialize handshake. */
  clientName: string;
  /** Tool-name prefix override (wins over MEMGRAPH_TOOL_PREFIX and the default). */
  toolPrefix?: string;
  /** Optional direct endpoint URL override (e.g. ESHEPHERD_MOVE_MCP_URL already resolved by the caller). */
  urlOverride?: string;
  /**
   * Explicitly-resolved headers that WIN over env/loopback auto-resolution.
   * Callers whose pre-Rung-3 behavior did NOT apply the loopback strip (e.g.
   * turn-guard, which always sent env headers) pass their own resolved headers
   * here so the seam stays byte-identical to the old code path.
   */
  headersOverride?: Record<string, string>;
  requestTimeoutMs?: number;
  maxRetries?: number;
  retryBackoffMs?: number;
  retryMaxBackoffMs?: number;
};

export type SubstrateClient = {
  client: MCPHttpClient;
  prefix: string;
  url: string;
};

/**
 * Construct and initialize a substrate transport. This is the single
 * published construction path — non-core code must not construct MCPHttpClient
 * directly (Check A). Throws a named SubstrateError on handshake failure;
 * callers that want to degrade must catch explicitly and name the reason.
 */
export async function createSubstrateClient(options: SubstrateClientOptions): Promise<SubstrateClient> {
  const endpoint = resolvePalaceEndpoint(options.env);
  const url = String(options.urlOverride || "").trim() || endpoint.url;
  // Headers: an explicit headersOverride wins (callers that pre-resolved their
  // own headers, e.g. turn-guard which never applied the loopback strip).
  // Otherwise resolve from env for the effective URL — the direct loopback server
  // (even reached via override) stays unauthenticated, same rule as resolvePalaceEndpoint.
  const headers =
    options.headersOverride !== undefined
      ? options.headersOverride
      : isDirectLoopbackServer(url)
        ? {}
        : resolveMCPHeadersFromEnv(options.env);
  const transportOptions: MCPHttpClientOptions = {
    clientName: options.clientName,
    requestTimeoutMs: options.requestTimeoutMs,
    maxRetries: options.maxRetries,
    retryBackoffMs: options.retryBackoffMs,
    retryMaxBackoffMs: options.retryMaxBackoffMs,
  };
  const client = new MCPHttpClient(url, headers, transportOptions);
  await client.initialize();
  return {
    client,
    prefix: palaceToolPrefix(options.env, options.toolPrefix),
    url,
  };
}

/**
 * Typed single-tool call wrapper. Returns the discriminated SubstrateResult so
 * callers can branch on ok/kind instead of treating a failure as an empty
 * result (spec §4.1 obligation 1). This is the seam capabilities and tools use
 * for raw calls; MemgraphClient remains the higher-level typed interface over
 * the same callTool boundary.
 */
export async function substrateCall<T>(
  client: MCPHttpClient,
  name: string,
  args?: Record<string, unknown>,
): Promise<SubstrateResult<T>> {
  return client.callToolResult<T>(name, args);
}

/** Re-exported so core/ is the single place that names failure kinds. */
export type { SubstrateFailureKind };
