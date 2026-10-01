import { clipText } from "../turn-guard-helpers.ts"

/**
 * OpenCode v2 delivery for resident memory (mem-core).
 *
 * v1 re-injected mem-core as a user prompt on idle/start/compaction, which cost
 * an extra model turn, needed cooldown bookkeeping, and kept `opencode run`
 * from ever settling. v2's session `context` hook runs before every agent model
 * request, so the current mem-core simply rides along in the system prompt: it
 * is present from the first request and survives compaction without any
 * trigger. Loads are cached per scope so a request never waits on the loader
 * more than once per scope.
 */

export const MEMCORE_CONTEXT_HEADING = "## Resident memory (mem-core)"

export function buildMemcoreSystemText(scopeDir: string, markdown: string, maxChars: number): string {
  const body = markdown.trim()
  if (!body) return ""
  const prelude =
    `${MEMCORE_CONTEXT_HEADING}\n` +
    `Currently active resident memory for scope: ${scopeDir}. ` +
    "This is derived render output from derived memory; do not hand-edit mem-core files.\n\n"
  return prelude + clipText(body, Math.max(0, maxChars - prelude.length))
}

export interface MemcoreCacheOptions {
  load: (scopeDir: string) => Promise<string>
  maxChars: number
  /** Age after which a cached scope is refreshed in the background. */
  ttlMs?: number
  now?: () => number
}

interface CacheEntry {
  text: string
  loadedAt: number
  refreshing?: Promise<string>
}

/**
 * Stale-while-revalidate cache: the first request for a scope waits for the
 * loader; later requests get the cached text immediately and trigger a
 * background refresh once it is older than `ttlMs`.
 */
export function createMemcoreCache(options: MemcoreCacheOptions) {
  const ttlMs = options.ttlMs ?? 60_000
  const now = options.now ?? Date.now
  const entries = new Map<string, CacheEntry>()

  const refresh = (scopeDir: string): Promise<string> => {
    const existing = entries.get(scopeDir)
    if (existing?.refreshing) return existing.refreshing
    const refreshing = options
      .load(scopeDir)
      .then((markdown) => buildMemcoreSystemText(scopeDir, markdown, options.maxChars))
      .catch((error) => {
        console.error(`[turn-guard] v2 mem-core load failed for ${scopeDir}:`, error)
        return existing?.text ?? ""
      })
      .then((text) => {
        entries.set(scopeDir, { text, loadedAt: now() })
        return text
      })
    entries.set(scopeDir, { text: existing?.text ?? "", loadedAt: existing?.loadedAt ?? 0, refreshing })
    return refreshing
  }

  return {
    async get(scopeDir: string): Promise<string> {
      const entry = entries.get(scopeDir)
      if (!entry || (entry.loadedAt === 0 && entry.refreshing)) return entry?.refreshing ?? refresh(scopeDir)
      if (now() - entry.loadedAt >= ttlMs) void refresh(scopeDir)
      return entry.text
    },
  }
}

interface MemcoreContextHookContext {
  session: {
    get(input: { sessionID: string }): Promise<any>
    hook(
      name: "context",
      callback: (event: { sessionID: string; system: Array<{ type: "text"; text: string }> }) => Promise<void> | void,
    ): Promise<unknown>
  }
}

/**
 * Register the context hook. The scope is the configured override, else the
 * session's own directory, else the plugin instance's location.
 */
export async function registerMemcoreContext(
  ctx: MemcoreContextHookContext,
  options: { cache: ReturnType<typeof createMemcoreCache>; scopeDirOverride?: string; fallbackDir: string },
): Promise<void> {
  const scopeBySession = new Map<string, string>()

  const resolveScope = async (sessionID: string): Promise<string> => {
    if (options.scopeDirOverride) return options.scopeDirOverride
    const known = scopeBySession.get(sessionID)
    if (known) return known
    let scope = options.fallbackDir
    try {
      const result = await ctx.session.get({ sessionID })
      const info = result?.data ?? result
      if (typeof info?.location?.directory === "string" && info.location.directory) scope = info.location.directory
    } catch {
      // Keep the plugin location as the scope.
    }
    scopeBySession.set(sessionID, scope)
    return scope
  }

  await ctx.session.hook("context", async (event) => {
    const text = await options.cache.get(await resolveScope(event.sessionID))
    if (text) event.system.push({ type: "text", text })
  })
}
