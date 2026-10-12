import { resolve } from "node:path"
import { findMemcoreWorkspaceRoot } from "../../capability/memcore/mem-core-loader.ts"
import { resolveMemcorePath } from "../../capability/memcore/mem-core-provenance.ts"
import { clipText } from "../turn-guard-helpers.ts"

/**
 * OpenCode v2 delivery for resident memory (mem-core).
 *
 * v1 re-injected mem-core as a user prompt on idle/start/compaction, which cost
 * an extra model turn, needed cooldown bookkeeping, and kept `opencode run`
 * from ever settling. v2's session `context` hook runs before every agent model
 * request, so the current mem-core simply rides along in the system prompt: it
 * is present from the first request and survives compaction without any
 * trigger. Loads are cached per scope and revalidated when the cache expires.
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
  /** Age after which a request waits for scope revalidation. */
  ttlMs?: number
  now?: () => number
}

interface CacheEntry {
  text: string
  loadedAt: number
  refreshing?: Promise<string>
}

/**
 * Revalidate expired entries before delivery; empty or failed loads cannot reuse old text.
 */
export function createMemcoreCache(options: MemcoreCacheOptions) {
  const ttlMs = options.ttlMs ?? 60_000
  const now = options.now ?? Date.now
  const entries = new Map<string, CacheEntry>()

  const refresh = (scopeDir: string, key: string): Promise<string> => {
    const existing = entries.get(key)
    if (existing?.refreshing) return existing.refreshing
    const refreshing = options
      .load(scopeDir)
      .then((markdown) => buildMemcoreSystemText(scopeDir, markdown, options.maxChars))
      .catch((error) => {
        console.error(`[turn-guard] v2 mem-core load failed for ${scopeDir}:`, error)
        return ""
      })
      .then((text) => {
        entries.set(key, { text, loadedAt: now() })
        return text
      })
    entries.set(key, { text: existing?.text ?? "", loadedAt: existing?.loadedAt ?? 0, refreshing })
    return refreshing
  }

  return {
    async get(scopeDir: string): Promise<string> {
      const scope = resolveMemcorePath(scopeDir)
      const key = `${findMemcoreWorkspaceRoot(scope)}\0${scope}`
      const entry = entries.get(key)
      if (!entry || (entry.loadedAt === 0 && entry.refreshing)) return entry?.refreshing ?? refresh(scope, key)
      if (now() - entry.loadedAt >= ttlMs) return refresh(scope, key)
      return entry.text
    },
  }
}

interface MemcoreContextHookContext {
  session: {
    get(input: { sessionID: string }): Promise<{ location?: { directory?: string }; data?: { location?: { directory?: string } } }>
    hook(
      name: "context",
      callback: (event: { sessionID: string; system: Array<{ type: "text"; text: string }> }) => Promise<void> | void,
    ): Promise<unknown>
  }
}

/** Resolve the current session project before every request; never borrow the plugin location. */
export async function registerMemcoreContext(
  ctx: MemcoreContextHookContext,
  options: { cache: ReturnType<typeof createMemcoreCache>; scopeDirOverride?: string; fallbackDir: string },
): Promise<void> {
  const resolveScope = async (sessionID: string): Promise<string | undefined> => {
    try {
      const result = await ctx.session.get({ sessionID })
      const directory = (result.data ?? result).location?.directory
      if (!directory) return undefined
      const scope = resolveMemcorePath(directory)
      if (options.scopeDirOverride) {
        const override = resolveMemcorePath(resolve(options.fallbackDir, options.scopeDirOverride))
        if (findMemcoreWorkspaceRoot(override) === findMemcoreWorkspaceRoot(scope)) return override
      }
      return scope
    } catch (error) {
      console.warn("[turn-guard] v2 mem-core session scope unavailable; omitting memory:", error)
      return undefined
    }
  }

  await ctx.session.hook("context", async (event) => {
    const scope = await resolveScope(event.sessionID)
    if (!scope) return
    const text = await options.cache.get(scope)
    if (text) event.system.push({ type: "text", text })
  })
}
