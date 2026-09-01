// @ts-nocheck

export function createHookHeadHandlers(deps: any) {
  const {
    cfgBool,
    loadPackagedAssets,
    mergeWithoutOverride,
    loadInstructionPaths,
    dedupeAppendInstructions,
    onMessageUpdated,
    onSessionIdle,
    onSessionCompacted,
    onSessionStarted,
  } = deps

  return {
    config: async (config: any) => {
      // Safety default: destructive drawer deletion must prompt for approval.
      const permission = config?.permission
      if (typeof permission === "string") {
        config.permission = {
          "*": permission,
          delete_drawers: "ask",
          move_drawers: "ask",
        }
      } else {
        const currentPermission = permission && typeof permission === "object" ? permission : {}
        if (!Object.prototype.hasOwnProperty.call(currentPermission, "delete_drawers")) {
          currentPermission.delete_drawers = "ask"
        }
        if (!Object.prototype.hasOwnProperty.call(currentPermission, "move_drawers")) {
          currentPermission.move_drawers = "ask"
        }
        config.permission = currentPermission
      }

      // Make the bundled agents and slash commands load like the rest of the
      // plugin. OpenCode only auto-discovers agents/ and command/ folders when a
      // repo is the active project, which never happens for an installed plugin.
      // Reading the markdown files here and injecting them into the resolved
      // config means they load in any consumer project — while each agent and
      // command stays in its own standalone file. User-defined entries win.
      try {
        const { agents, commands } = loadPackagedAssets()
        config.agent = mergeWithoutOverride(agents, config.agent)
        config.command = mergeWithoutOverride(commands, config.command)
        let injectedInstructions = 0
        // Instructions (agent discipline) are part of the plugin's behavior,
        // so inject their absolute paths too. Opt out with
        // ESHEPHERD_INJECT_INSTRUCTIONS=false.
        if (cfgBool("assets.injectInstructions", true)) {
          const instructionPaths = loadInstructionPaths()
          config.instructions = dedupeAppendInstructions(config.instructions, instructionPaths)
          injectedInstructions = instructionPaths.length
        }
        console.log(
          `[turn-guard] config hook injected ${Object.keys(agents).length} agents, ` +
            `${Object.keys(commands).length} commands, ${injectedInstructions} instructions`,
        )
      } catch (err) {
        console.log(`[turn-guard] config hook asset injection failed: ${String(err)}`)
      }
    },
    event: async ({ event }: any) => {
      if (!event?.type) return
      if (event.type === "message.updated") {
        await onMessageUpdated(event)
        return
      }
      if (event.type === "session.idle") {
        await onSessionIdle(event)
        return
      }
      if (event.type === "session.compacted") {
        await onSessionCompacted(event)
        return
      }
      if (event.type === "session.started" || event.type === "session.created") {
        await onSessionStarted(event)
      }
    },
  }
}
