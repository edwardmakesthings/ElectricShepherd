/**
 * Isolated MemPalace test-room fixture for ElectricShepherd integration tests.
 *
 * WHY THIS EXISTS
 * ---------------
 * ElectricShepherd's adapters (memgraph client, retrieval expansion, synthesis
 * consolidation) can only be meaningfully exercised against a real MemPalace
 * MCP endpoint. We do NOT want those tests to touch live user wings/rooms, and
 * MemPalace's own dedup/search behavior is already covered by MemPalace's
 * Python suite — so this fixture gives each test run a *dedicated, disposable
 * room* inside the configured palace and a precise teardown.
 *
 * ISOLATION + TEARDOWN STRATEGY
 * -----------------------------
 * Rather than spinning up a whole separate palace (impractical to start/stop
 * around a JS test run), every fixture seeds into a dedicated wing
 * (`eshepherd-test` by default) and a unique per-run room. Every drawer also
 * carries a shared `source_file` marker (`eshepherd-test://fixture/<runId>`)
 * for traceability.
 *
 * Teardown deletes each seeded drawer by the `drawer_id` returned at insert
 * time via `delete_drawer`. We intentionally do NOT rely on bulk
 * `delete_by_source`: MCP gateways commonly restrict that tool per key/team,
 * whereas single-drawer deletion is part of the normal write surface. Tracking
 * ids keeps teardown working through a restricted gateway and keeps the blast
 * radius to exactly the rows this run created.
 *
 * The fixture is intentionally cheap to create and tear down once per test
 * file (via before/after hooks) rather than per test, so a suite can share one
 * room instead of thrashing create/delete on every assertion.
 *
 * CONNECTION
 * ----------
 * Env discovery mirrors the runtime scripts (ESHEPHERD_ENV_FILE -> repo
 * .env/.env.local -> ../docker/.env) by reusing `loadRuntimeEnv`, then runtime
 * behavior is applied from `.electric-shepherd/config.jsonc` via
 * `loadRuntimeConfig`. If no MCP URL is configured the fixture reports
 * `available: false` with a reason so callers can skip gracefully instead of
 * hard-failing.
 */

import { readFileSync, readdirSync } from "node:fs";

import { createMemgraphClient } from "../../adapter/memgraph.ts";
import { MCPHttpClient, resolveMCPHeadersFromEnv } from "../../adapter/mcp-http-client.ts";
import { applyRuntimeConfigToEnv, loadRuntimeConfig } from "../../adapter/runtime-config.ts";
import { loadRuntimeEnv } from "../../scripts/runtime-env.ts";

const DEFAULT_WING = "eshepherd-test";
const DEFAULT_ADDED_BY = "electric-shepherd-test-fixture";

function loadFixtureConfig() {
  const anchorUrl = new URL("../../scripts/_fixture-env-anchor.ts", import.meta.url).href;
  loadRuntimeEnv({ scriptUrl: anchorUrl, env: process.env });
  const runtimeConfig = loadRuntimeConfig({
    cwd: process.cwd(),
    env: process.env,
  });
  applyRuntimeConfigToEnv(process.env, runtimeConfig);
  return runtimeConfig;
}

/** True when the integration suite is explicitly enabled. */
export function isIntegrationEnabled() {
  loadFixtureConfig();
  return process.env.ESHEPHERD_TEST_INTEGRATION === "1";
}

/**
 * Loud local skip banner (P0-5).
 *
 * Each endpoint-gated integration test file calls this once at module load when
 * its gate is closed. The count is computed, not hardcoded: it scans the
 * integration directory for `{ skip:` gates and reports how many consumption
 * tests will NOT run in this invocation. Local runs must stay exit 0 — an
 * offline developer is not a defect — but the skip must be impossible to miss.
 */
export function reportSkippedIntegrationTests() {
  let count = 0;
  try {
    const dir = new URL("../integration/", import.meta.url);
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".test.mjs")) continue;
      const src = readFileSync(new URL(entry, dir), "utf8");
      count += (src.match(/\{\s*skip:\s*!/g) || []).length;
    }
  } catch {
    // Directory unreadable: fall back to the known gate count so the banner
    // still names a number rather than going silent.
    count = 6;
  }
  const bar = "=".repeat(78);
  const lines = [
    "",
    bar,
    `  WARNING: ${count} integration (read-path/consumption) tests SKIPPED in this run.`,
    "  The MemPalace integration gate is CLOSED — none of these executed:",
    "",
    "    - quickstart retrieval expansion returns expected envelope",
    "    - quickstart consolidation and cadence return expected envelopes",
    "    - source drawers consolidate into a derived drawer that is then discoverable",
    `    - ${Math.max(0, count - 3)} more (dedup gate, room fixture blast radius, retrieval envelope)`,
    "",
    '  Why: ESHEPHERD_TEST_INTEGRATION is not set to "1" and/or MEMPALACE_MCP_URL',
    "       is not configured. This is expected offline — the suite still exits 0.",
    "  To run them:",
    "      export ESHEPHERD_TEST_INTEGRATION=1  (plus a reachable MEMPALACE_MCP_URL)",
    "      npm run test:integration",
    bar,
    "",
  ];
  console.error(lines.join("\n"));
}

function makeRunId() {
  const stamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${rand}`;
}

/**
 * Create an isolated MemPalace test room.
 *
 * @param {object} [options]
 * @param {string} [options.wing]        Wing to seed into (default `eshepherd-test`).
 * @param {string} [options.roomPrefix]  Prefix for the unique per-run room name.
 * @param {string} [options.addedBy]     `added_by` attribution for seeded entries.
 * @param {string} [options.clientName]  MCP client identity for the handshake.
 * @returns {Promise<object>} fixture handle (see properties below) or
 *   `{ available: false, reason }` when no MCP endpoint is configured.
 */
export async function createTestRoom(options = {}) {
  // Resolve env the same way the runtime scripts do. The anchor URL points at
  // the scripts dir so `loadRuntimeEnv` computes the ElectricShepherd repo root
  // correctly regardless of where this helper lives.
  const runtimeConfig = loadFixtureConfig();

  const mcpURL = String(runtimeConfig.valuesByPath.mcp?.url || "").trim();
  if (!mcpURL) {
    return {
      available: false,
      reason: "mcp.url is not configured; cannot create a test room.",
    };
  }

  const wing = options.wing || DEFAULT_WING;
  const roomPrefix = options.roomPrefix || "fixture";
  const runId = makeRunId();
  const room = `${roomPrefix}-${runId}`;
  const sourceTag = `eshepherd-test://fixture/${runId}`;
  const addedBy = options.addedBy || DEFAULT_ADDED_BY;
  const toolPrefix = String(runtimeConfig.valuesByPath.mcp?.toolPrefix || "").trim() || "mempalace_";

  const headers = resolveMCPHeadersFromEnv(process.env);
  const mcp = new MCPHttpClient(mcpURL, headers, {
    clientName: options.clientName || "electric-shepherd-test-fixture",
  });
  await mcp.initialize();

  const callTool = (name, args) => mcp.callTool(name, args);
  const client = createMemgraphClient({ callTool, toolPrefix });

  // Track every drawer id we create so teardown can remove exactly those rows
  // via the (gateway-permitted) single-drawer delete path.
  const createdDrawerIds = [];

  /** Seed a drawer into the isolated room and remember its id for teardown. */
  const addDrawer = async (content, extra = {}) => {
    const res = await client.addDrawer({
      wing,
      room,
      content,
      source_file: sourceTag,
      added_by: addedBy,
      ...extra,
    });
    const id = res && typeof res === "object" ? res.drawer_id : undefined;
    if (typeof id === "string" && id) {
      createdDrawerIds.push(id);
    }
    return res;
  };

  /** Search scoped to the isolated wing/room by default. */
  const search = (query, limit = 5) => client.search(query, limit, wing, room);

  /**
   * Register an externally-created drawer/node id (e.g. a synthesis node made
   * by `runSynthesisConsolidation`) so it is removed during teardown alongside
   * the drawers seeded via `addDrawer`. Returns the id for convenience.
   */
  const track = (id) => {
    if (typeof id === "string" && id) {
      createdDrawerIds.push(id);
    }
    return id;
  };

  /**
   * Remove every drawer this fixture created, by id. Idempotent and safe to
   * call from an `after` hook even if some inserts failed.
   *
   * @returns {Promise<{ success: boolean, deleted: number, errors: string[] }>}
   */
  const teardown = async () => {
    const errors = [];
    let deleted = 0;
    // Drain the list so a second teardown call is a no-op.
    const ids = createdDrawerIds.splice(0, createdDrawerIds.length);
    for (const id of ids) {
      try {
        const res = await callTool(`${toolPrefix}delete_drawer`, { drawer_id: id });
        const removed = Array.isArray(res?.deleted_ids) ? res.deleted_ids.length : 1;
        deleted += removed;
      } catch (err) {
        errors.push(String(err));
      }
    }
    return { success: errors.length === 0, deleted, errors };
  };

  return {
    available: true,
    wing,
    room,
    runId,
    sourceTag,
    toolPrefix,
    mcp,
    client,
    callTool,
    addDrawer,
    track,
    search,
    teardown,
  };
}
