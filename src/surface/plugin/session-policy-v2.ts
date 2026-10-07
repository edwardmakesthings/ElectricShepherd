import { Plugin } from "@opencode/plugin"
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import { LoopBlockedError } from "../turn-guard-helpers.ts"
import { registerLoopGuardContext, type LoopGuardControl } from "../opencode-v2/loop-guard-context.ts"
import { ES_TOOLS } from "../../tools/index.ts"
import { registerInstructions, registerPackagedAssets, registerPackagedSkills, registerPermissionDefaults } from "../opencode-v2/assets.ts"
import { registerCompactionArchive } from "../opencode-v2/compaction-archive.ts"
import { createMemcoreCache, registerMemcoreContext } from "../opencode-v2/memcore-context.ts"
import { toOpenCodeV2Tool } from "../opencode-v2/tool-adapter.ts"
import TurnGuardV1 from "./session-policy-v1.ts"
import { createLegacyClientAdapter, toLegacyEvent } from "../opencode-v1/client-adapter.ts"

/**
 * OpenCode v2 plugin surface.
 *
 * This keeps Electric Shepherd's v1 plugin export available as a fallback while
 * making v2 the default runtime target. The v2 surface currently focuses on
 * registering the Electric Shepherd tool suite against the new Plugin API.
 */
const SessionPolicyPluginV2 = Plugin.define({
  id: "electric-shepherd",
  async setup(ctx) {
    if (String(process.env.ESHEPHERD_SUBAGENT_RUN ?? "").trim() === "1") return

    try {
      const registered = await registerPackagedAssets(ctx)
      console.log(`[turn-guard] v2 registered ${registered.agents} agents, ${registered.commands} commands`)
    } catch (error) {
      console.error("[turn-guard] v2 asset registration failed:", error)
    }

    const legacy = await TurnGuardV1({
      client: createLegacyClientAdapter(ctx.session),
      directory: ctx.location.directory,
      disableV1ToolRegistry: true,
      v2Bridge: true,
    })

    // V2 has no global config object, so run the v1 `config` hook against an
    // empty one and port what it produced: instruction paths and the
    // destructive-tool permission defaults. Agents/commands are handled above.
    try {
      const legacyConfig: { instructions?: string[]; permission?: Record<string, unknown> } = {}
      await legacy?.config?.(legacyConfig)
      const defaults = Object.fromEntries(
        Object.entries(legacyConfig.permission ?? {}).filter(([action]) => action !== "*"),
      ) as Record<string, "allow" | "deny" | "ask">
      await registerPermissionDefaults(ctx, defaults)
      const instructionCount = await registerInstructions(ctx, legacyConfig.instructions ?? [])
      console.log(`[turn-guard] v2 instructions: ${instructionCount} file(s) via session context hook`)
    } catch (error) {
      console.error("[turn-guard] v2 config port failed:", error)
    }

    try {
      const offered = await registerPackagedSkills(ctx)
      console.log(`[turn-guard] v2 skills offered: ${offered.join(", ") || "none"} (a same-id skill in your skill directories overrides)`)
    } catch (error) {
      console.error("[turn-guard] v2 skill registration failed:", error)
    }

    const archive = legacy?.compactionArchive
    if (archive?.enabled) {
      try {
        await registerCompactionArchive(ctx, archive.dir)
      } catch (error) {
        console.error("[turn-guard] v2 compaction archive registration failed:", error)
      }
    }

    const memcore = legacy?.memcoreContext
    if (memcore?.enabled) {
      try {
        await registerMemcoreContext(ctx, {
          cache: createMemcoreCache({ load: memcore.load, maxChars: memcore.maxChars }),
          scopeDirOverride: memcore.scopeDirOverride,
          fallbackDir: memcore.fallbackDir,
        })
        console.log("[turn-guard] v2 mem-core: delivered via session context hook")
      } catch (error) {
        console.error("[turn-guard] v2 mem-core registration failed:", error)
      }
    }

    await ctx.tool.transform((editor) => {
      for (const definition of ES_TOOLS) {
        if (editor.get(definition.name)) continue
        editor.add(
          toOpenCodeV2Tool(definition, () => ctx.location.directory),
        )
      }
    })

    const loopGuard = legacy?.loopGuard as LoopGuardControl | undefined
    const loopContext = loopGuard ? await registerLoopGuardContext(ctx, loopGuard) : undefined
    const toolBeforeHook = legacy?.["tool.execute.before"]
    if (typeof toolBeforeHook === "function") {
      await ctx.tool.hook("execute.before", async (input) => {
        const output = { args: input.input as Record<string, unknown> }
        try {
          if (loopContext && !await loopContext.before(input)) return
          await toolBeforeHook(
            {
              tool: input.tool,
              sessionID: input.sessionID,
              messageID: input.messageID,
              agent: input.agent,
              id: input.id,
              args: output.args,
            },
            output,
          )
        } catch (error) {
          if (error instanceof LoopBlockedError) {
            const receipt = loopContext?.reject(input, error) ?? error.message
            throw new ToolError({ message: receipt, metadata: { electricShepherdLoopBlocked: true, paused: error.paused } })
          }
          // V2 execute.before only permits Tool.Error in its failure channel.
          // Convert known legacy guard rejections, not unrelated plugin failures.
          if (error instanceof Error && error.message.startsWith("[Loop Guard]")) {
            throw new ToolError({ message: error.message })
          }
          throw error
        }
        if (output.args && typeof output.args === "object") {
          input.input = output.args as typeof input.input
        }
      })
    }

    let disposed = false
    const eventsController = new AbortController()
    const eventHook = legacy?.event
    if (typeof eventHook === "function") {
      ;(async () => {
        try {
          for await (const event of ctx.event.subscribe({ signal: eventsController.signal })) {
            if (disposed) break
            if (event.type === "session.deleted") loopContext?.forgetSession(event.data.sessionID)
            const legacyEvent = toLegacyEvent(event)
            if (!legacyEvent) continue
            const sessionID = String(legacyEvent.properties?.info?.sessionID ?? legacyEvent.properties?.sessionID ?? "")
            if (!sessionID) continue
            try {
              const session = await ctx.session.get({ sessionID }, { signal: eventsController.signal })
              if (disposed) break
              if (session.location?.directory !== ctx.location.directory) continue
              // Reactive retries/checkpoints must not restart a paused loop.
              if (loopContext?.isPaused(sessionID)) continue
              await eventHook({ event: legacyEvent })
              if (event.type === "session.step.ended") {
                void legacy.shadowJudge?.observe(sessionID, String(legacyEvent.properties?.info?.id ?? ""))
              }
            } catch {
              console.warn("[turn-guard] v2 event unavailable; keeping event bridge active")
            }
          }
        } catch (error) {
          if (!disposed) console.error("[turn-guard] v2 event bridge failed:", error)
        }
      })()
    }
    return () => {
      if (disposed) return
      disposed = true
      eventsController.abort()
      loopContext?.dispose()
      legacy?.dispose?.()
    }
  },
})

export default SessionPolicyPluginV2
