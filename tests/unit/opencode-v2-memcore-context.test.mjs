import assert from "node:assert/strict";
import test from "node:test";

import {
  MEMCORE_CONTEXT_HEADING,
  buildMemcoreSystemText,
  createMemcoreCache,
  registerMemcoreContext,
} from "../../src/surface/opencode-v2/memcore-context.ts";

test("buildMemcoreSystemText adds the heading and scope, clips to maxChars, and skips empty mem-core", () => {
  const text = buildMemcoreSystemText("/proj", "  remember this  ", 10_000);
  assert.ok(text.startsWith(MEMCORE_CONTEXT_HEADING));
  assert.match(text, /scope: \/proj/);
  assert.ok(text.endsWith("remember this"));
  assert.equal(buildMemcoreSystemText("/proj", "   ", 10_000), "");

  const clipped = buildMemcoreSystemText("/proj", "x".repeat(5_000), 400);
  assert.match(clipped, /truncated by turn-guard/);
});

test("createMemcoreCache loads once per scope and refreshes stale entries in the background", async () => {
  let clock = 0;
  const loads = [];
  const cache = createMemcoreCache({
    load: async (scope) => { loads.push(scope); return `mem ${loads.length}`; },
    maxChars: 10_000,
    ttlMs: 100,
    now: () => clock,
  });

  const [a, b] = await Promise.all([cache.get("/p"), cache.get("/p")]);
  assert.equal(a, b);
  assert.match(a, /mem 1$/);
  assert.deepEqual(loads, ["/p"], "concurrent first requests share one load");

  clock = 50;
  assert.match(await cache.get("/p"), /mem 1$/);
  assert.equal(loads.length, 1, "fresh entry is served from cache");

  clock = 200;
  assert.match(await cache.get("/p"), /mem 1$/, "stale entry is served while refreshing");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(loads.length, 2);
  assert.match(await cache.get("/p"), /mem 2$/);

  await cache.get("/other");
  assert.deepEqual(loads, ["/p", "/p", "/other"]);
});

test("createMemcoreCache keeps the last good text when a refresh fails", async () => {
  let clock = 0;
  let fail = false;
  const cache = createMemcoreCache({
    load: async () => { if (fail) throw new Error("boom"); return "good"; },
    maxChars: 10_000,
    ttlMs: 10,
    now: () => clock,
  });
  assert.match(await cache.get("/p"), /good$/);
  fail = true;
  clock = 100;
  await cache.get("/p");
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(await cache.get("/p"), /good$/);
});

test("registerMemcoreContext appends mem-core for the session's own directory", async () => {
  let hook;
  const sessionLookups = [];
  const loaded = [];
  await registerMemcoreContext(
    {
      session: {
        get: async ({ sessionID }) => { sessionLookups.push(sessionID); return { location: { directory: `/dir/${sessionID}` } }; },
        hook: async (name, cb) => { assert.equal(name, "context"); hook = cb; },
      },
    },
    {
      cache: { get: async (scope) => { loaded.push(scope); return scope === "/dir/empty" ? "" : `mem for ${scope}`; } },
      fallbackDir: "/fallback",
    },
  );

  const event = { sessionID: "s1", system: [{ type: "text", text: "base" }] };
  await hook(event);
  await hook({ sessionID: "s1", system: [] });
  assert.deepEqual(event.system, [{ type: "text", text: "base" }, { type: "text", text: "mem for /dir/s1" }]);
  assert.deepEqual(sessionLookups, ["s1"], "session scope is resolved once");

  const empty = { sessionID: "empty", system: [] };
  await hook(empty);
  assert.deepEqual(empty.system, []);
});

test("registerMemcoreContext honors a configured scope and falls back to the plugin location", async () => {
  const scopes = [];
  const register = async (options, getImpl) => {
    let hook;
    await registerMemcoreContext(
      { session: { get: getImpl, hook: async (_name, cb) => { hook = cb; } } },
      { cache: { get: async (scope) => { scopes.push(scope); return ""; } }, ...options },
    );
    await hook({ sessionID: "s", system: [] });
  };
  await register({ scopeDirOverride: "/forced", fallbackDir: "/fallback" }, async () => { throw new Error("unused"); });
  await register({ fallbackDir: "/fallback" }, async () => { throw new Error("gone"); });
  assert.deepEqual(scopes, ["/forced", "/fallback"]);
});
