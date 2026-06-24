import assert from "node:assert/strict";
import test from "node:test";

import { MCPHttpClient } from "../../adapter/mcp-http-client.ts";

test("mcp client attaches an abort signal to outbound requests", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    calls.push({ input, init });
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  };

  try {
    const client = new MCPHttpClient("https://example.test/mcp", {}, { requestTimeoutMs: 2000 });
    await client.initialize();

    assert.equal(calls.length, 2);
    assert.ok(calls[0].init?.signal instanceof AbortSignal);
    assert.ok(calls[1].init?.signal instanceof AbortSignal);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
