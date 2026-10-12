import assert from "node:assert/strict";
import test from "node:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";

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

test("createMemcoreCache loads once per scope and awaits expired scope revalidation", async () => {
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
  assert.match(await cache.get("/p"), /mem 2$/, "expired text is not served while refreshing");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(loads.length, 2);
  assert.match(await cache.get("/p"), /mem 2$/);

  await cache.get("/other");
  assert.deepEqual(loads, ["/p", "/p", "/other"]);
});

test("createMemcoreCache omits the last good text when a refresh fails", async () => {
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
  assert.equal(await cache.get("/p"), "");
  assert.equal(await cache.get("/p"), "");
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
  assert.deepEqual(sessionLookups, ["s1", "s1"], "session scope is checked on every request");

  const empty = { sessionID: "empty", system: [] };
  await hook(empty);
  assert.deepEqual(empty.system, []);
});

test("registerMemcoreContext does not fall back to configured or plugin memory when the session is unavailable", async () => {
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
  assert.deepEqual(scopes, []);
});

test("a moved session uses its new project, ignores foreign overrides, and can become empty", async () => {
  let directory = "/project-a", hook;
  const scopes = [];
  await registerMemcoreContext({ session: {
    get: async () => ({ data: { location: { directory } } }),
    hook: async (_name, callback) => { hook = callback; },
  } }, { cache: { get: async (scope) => { scopes.push(scope); return scope === "/project-b" ? "" : "PROJECT A MEMORY"; } },
    scopeDirOverride: "/foreign-project", fallbackDir: "/plugin-install" });
  const first = { sessionID: "moving", system: [] }; await hook(first);
  assert.match(first.system[0].text, /PROJECT A MEMORY/);
  directory = "/project-b";
  const second = { sessionID: "moving", system: [] }; await hook(second);
  assert.deepEqual(second.system, []);
  assert.deepEqual(scopes, ["/project-a", "/project-b"]);
  directory = undefined;
  await hook({ sessionID: "moving", system: [] });
  assert.equal(scopes.length, 2, "missing directory never uses the old project");
});

test("a configured override works only within the actual session project", async (t) => {
  mkdirSync("/tmp/opencode", { recursive: true });
  const root = mkdtempSync("/tmp/opencode/eshepherd-context-");
  copyFileSync(new URL("../../package.json", import.meta.url), join(root, "package.json"));
  const sub = join(root, "src"); mkdirSync(sub);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let hook; const scopes = [];
  await registerMemcoreContext({ session: {
    get: async () => ({ location: { directory: root } }), hook: async (_name, callback) => { hook = callback; },
  } }, { cache: { get: async (scope) => { scopes.push(scope); return ""; } }, scopeDirOverride: "src", fallbackDir: root });
  await hook({ sessionID: "own", system: [] });
  assert.deepEqual(scopes, [sub]);
});

test("concurrent expired requests wait for an empty refresh instead of reinjecting old text", async () => {
  let clock = 1, release;
  const cache = createMemcoreCache({ load: async () => clock === 1 ? "OLD" : await new Promise((resolve) => { release = resolve; }),
    now: () => clock, ttlMs: 10, maxChars: 10000 });
  assert.match(await cache.get("/project"), /OLD$/);
  clock = 20;
  const first = cache.get("/project"), second = cache.get("/project");
  release("");
  assert.deepEqual(await Promise.all([first, second]), ["", ""]);
});

test("cache identity changes when a symlink is repointed or the scope becomes a new project", async (t) => {
  const base = mkdtempSync("/tmp/opencode/eshepherd-cache-project-");
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const a = join(base, "a"), b = join(base, "b"), alias = join(base, "alias");
  for (const root of [a, b]) { mkdirSync(root); copyFileSync(new URL("../../package.json", import.meta.url), join(root, "package.json")); }
  symlinkSync(a, alias);
  const loads = [];
  const cache = createMemcoreCache({ load: async (scope) => { loads.push(scope); return scope; }, maxChars: 10000 });
  assert.ok((await cache.get(alias)).endsWith(a));
  unlinkSync(alias); symlinkSync(b, alias);
  assert.ok((await cache.get(alias)).endsWith(b), "an unexpired cache cannot keep serving project A through the alias");
  const nested = join(b, "nested"); mkdirSync(nested);
  await cache.get(nested);
  copyFileSync(new URL("../../package.json", import.meta.url), join(nested, "package.json"));
  await cache.get(nested);
  assert.deepEqual(loads, [a, b, nested, nested], "a changed workspace root invalidates the old scope cache");
});
