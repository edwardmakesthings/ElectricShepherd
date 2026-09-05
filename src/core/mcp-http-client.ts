/**
 * Compatibility shim — the transport moved to core/mcp-transport.ts (Rung 3).
 *
 * The Streamable-HTTP MCP transport for MemPalace now lives in core/ so that
 * transport construction sits inside the substrate boundary (spec §4.1 /
 * Check A: no `new MCPHttpClient` outside core/). This shim re-exports the
 * exact same surface so existing importers keep working unchanged; new code
 * should import from core/mcp-transport.ts (or, for a ready connection,
 * core/substrate-client.ts → createSubstrateClient).
 */

export type { SubstrateFailureKind, SubstrateResult, MCPHttpClientOptions } from "./mcp-transport.ts";
export { SubstrateError, MCPHttpClient, resolveMCPHeadersFromEnv } from "./mcp-transport.ts";
