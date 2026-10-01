import { readFileSync } from "node:fs"
import { loadPackagedAssets, type AssetRecord } from "../asset-loader.ts"

/**
 * OpenCode v2 replacement for the v1 `config` hook asset injection.
 *
 * V2 has no mutable global config object: the migration guide maps `config` to
 * transforms on the owning domains. Bundled commands go through
 * `ctx.command.transform` and bundled agents through `ctx.agent.transform`, so
 * they are found wherever the plugin loads, with nothing copied into a config
 * folder. Entries the user already defines (same name) win, as in v1.
 */

const VALID_EFFECTS = new Set(["allow", "deny", "ask"])
const VALID_MODES = new Set(["subagent", "primary", "all"])

// v1 permission/tool keys whose v2 action name differs.
const ACTION_ALIASES: Record<string, string> = {
  bash: "shell",
  task: "subagent",
  webfetch: "browser",
  write: "edit",
}

export interface V2Permission {
  action: string
  resource: string
  effect: "allow" | "deny" | "ask"
}

export interface V2AgentFields {
  system?: string
  description?: string
  mode?: "subagent" | "primary" | "all"
  hidden?: boolean
  steps?: number
  color?: string
  model?: { providerID: string; id: string }
  body: Record<string, unknown>
  permissions: V2Permission[]
}

/** Translate a v1-style agent definition (parsed markdown) into v2 Agent.Info fields. */
export function translateAgent(def: AssetRecord): V2AgentFields {
  const out: V2AgentFields = { body: {}, permissions: [] }

  if (typeof def.prompt === "string" && def.prompt) out.system = def.prompt
  if (typeof def.description === "string") out.description = def.description
  if (typeof def.mode === "string" && VALID_MODES.has(def.mode)) out.mode = def.mode as V2AgentFields["mode"]
  if (typeof def.hidden === "boolean") out.hidden = def.hidden
  if (Number.isInteger(def.steps)) out.steps = def.steps
  if (typeof def.color === "string") out.color = def.color

  if (typeof def.model === "string") {
    const slash = def.model.indexOf("/")
    if (slash > 0) {
      out.model = { providerID: def.model.slice(0, slash), id: def.model.slice(slash + 1).split("#")[0] }
    }
  }

  if (typeof def.temperature === "number") out.body.temperature = def.temperature
  if (typeof def.top_p === "number") out.body.top_p = def.top_p

  const permission = def.permission
  if (permission && typeof permission === "object") {
    for (const [key, value] of Object.entries(permission as AssetRecord)) {
      const action = ACTION_ALIASES[key] ?? key
      if (typeof value === "string" && VALID_EFFECTS.has(value)) {
        out.permissions.push({ action, resource: "*", effect: value as V2Permission["effect"] })
      } else if (value && typeof value === "object") {
        for (const [resource, effect] of Object.entries(value as AssetRecord)) {
          if (typeof effect === "string" && VALID_EFFECTS.has(effect)) {
            out.permissions.push({ action, resource, effect: effect as V2Permission["effect"] })
          }
        }
      }
    }
  }

  const tools = def.tools
  if (tools && typeof tools === "object") {
    for (const [key, enabled] of Object.entries(tools as AssetRecord)) {
      if (typeof enabled !== "boolean") continue
      out.permissions.push({
        action: ACTION_ALIASES[key] ?? key,
        resource: "*",
        effect: enabled ? "allow" : "deny",
      })
    }
  }

  return out
}

/** Split an argument string on whitespace, honoring single/double quotes. */
export function parseArguments(raw: string): string[] {
  const args: string[] = []
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g
  for (let match = pattern.exec(raw); match; match = pattern.exec(raw)) {
    args.push(match[1] ?? match[2] ?? match[3])
  }
  return args
}

/**
 * Expand `$ARGUMENTS` and positional `$1..$n` placeholders like a native v2
 * command. The highest-numbered placeholder consumes everything after it, and
 * a template with no placeholder gets non-empty arguments appended.
 */
export function expandTemplate(template: string, rawArgs: string): string {
  const args = parseArguments(rawArgs)
  const positions = [...template.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]))
  const highest = positions.length ? Math.max(...positions) : 0
  const hasPlaceholder = template.includes("$ARGUMENTS") || positions.length > 0

  let text = template.replaceAll("$ARGUMENTS", rawArgs)
  text = text.replace(/\$(\d+)/g, (_match, digits: string) => {
    const index = Number(digits)
    if (index === highest) return args.slice(index - 1).join(" ")
    return args[index - 1] ?? ""
  })

  if (!hasPlaceholder && rawArgs.trim()) text = `${text}\n\n${rawArgs}`
  return text
}

interface AssetContext {
  agent: {
    transform(callback: (editor: any) => void): Promise<unknown>
  }
  command: {
    list(): Promise<{ data?: ReadonlyArray<{ name: string }> } | ReadonlyArray<{ name: string }>>
    transform(callback: (editor: any) => void): Promise<unknown>
  }
  session: {
    prompt(input: any): Promise<unknown>
    switchAgent(input: any): Promise<unknown>
  }
}

async function existingCommandNames(ctx: AssetContext): Promise<Set<string>> {
  try {
    const listed = await ctx.command.list()
    const entries: ReadonlyArray<{ name: string }> = "data" in listed ? (listed.data ?? []) : (listed as ReadonlyArray<{ name: string }>)
    return new Set(entries.map((command) => command.name))
  } catch {
    return new Set()
  }
}

/** Register the bundled commands and agents with the running v2 server. */
export async function registerPackagedAssets(ctx: AssetContext): Promise<{ agents: number; commands: number }> {
  const { agents, commands } = loadPackagedAssets()
  const agentIds = new Set(Object.keys(agents))
  const taken = await existingCommandNames(ctx)
  const commandNames = Object.keys(commands).filter((name) => !taken.has(name))

  const toCommand = (name: string) => {
    const definition = commands[name]
    const template = String(definition.template ?? "")
    const targetAgent = typeof definition.agent === "string" ? definition.agent : undefined
    return {
      name,
      description: typeof definition.description === "string" ? definition.description : undefined,
      execute: async ({ sessionID, prompt, delivery }: { sessionID: string; prompt: any; delivery: string }) => {
        if (targetAgent && agentIds.has(targetAgent)) {
          await ctx.session.switchAgent({ sessionID, agent: targetAgent })
        }
        await ctx.session.prompt({
          ...prompt,
          sessionID,
          text: expandTemplate(template, String(prompt?.text ?? "")),
          delivery,
        })
      },
    }
  }

  await ctx.command.transform((editor) => {
    for (const name of commandNames) {
      try {
        editor.add(toCommand(name))
      } catch (error) {
        console.error(`[turn-guard] v2 command ${name} registration failed:`, error)
      }
    }
  })

  const translated = Object.entries(agents).map(([id, definition]) => [id, translateAgent(definition)] as const)
  await ctx.agent.transform((editor) => {
    for (const [id, fields] of translated) {
      if (editor.get(id)) continue
      try {
        // `update` on an unknown id creates the agent from the v2 defaults.
        editor.update(id, (draft: any) => applyAgentFields(draft, fields))
      } catch (error) {
        console.error(`[turn-guard] v2 agent ${id} registration failed:`, error)
      }
    }
  })

  return { agents: translated.length, commands: commandNames.length }
}

function applyAgentFields(draft: any, fields: V2AgentFields): void {
  if (fields.system !== undefined) draft.system = fields.system
  if (fields.description !== undefined) draft.description = fields.description
  if (fields.mode !== undefined) draft.mode = fields.mode
  if (fields.hidden !== undefined) draft.hidden = fields.hidden
  if (fields.steps !== undefined) draft.steps = fields.steps
  if (fields.color !== undefined) draft.color = fields.color
  if (fields.model !== undefined) draft.model = fields.model
  Object.assign(draft.request.body, fields.body)
  draft.permissions.push(...fields.permissions)
}

/** Concatenate instruction files into one system-prompt block; unreadable files are skipped. */
export function readInstructionText(paths: readonly string[]): string {
  const blocks: string[] = []
  for (const path of paths) {
    try {
      const text = readFileSync(path, "utf8").trim()
      if (text) blocks.push(text)
    } catch (error) {
      console.error(`[turn-guard] v2 could not read instruction ${path}:`, error)
    }
  }
  return blocks.join("\n\n")
}

interface InstructionContext {
  session: {
    hook(name: "context", callback: (event: { system: Array<{ type: "text"; text: string }> }) => void): Promise<unknown>
  }
}

/**
 * V2 does not load `config.instructions`; the documented replacement for
 * plugin-supplied guidance is the session `context` hook, which runs before
 * every agent model request. The text is appended last so the cached prefix
 * of the system prompt stays stable.
 */
export async function registerInstructions(ctx: InstructionContext, paths: readonly string[]): Promise<number> {
  const text = readInstructionText(paths)
  if (!text) return 0
  await ctx.session.hook("context", (event) => {
    event.system.push({ type: "text", text })
  })
  return paths.length
}

const EFFECT_RANK: Record<V2Permission["effect"], number> = { allow: 0, ask: 1, deny: 2 }

interface PermissionDefaultsContext {
  agent: { get(input: { agentID: string }): Promise<any> }
  permission: {
    hook(
      name: "evaluate",
      callback: (event: { agent?: string; action: string; effect: V2Permission["effect"] }) => Promise<void> | void,
    ): Promise<unknown>
  }
}

/**
 * Apply `{ tool: effect }` permission defaults — the v2 form of v1's
 * `config.permission` defaults. An agent transform cannot do this: agents from
 * `opencode.jsonc` are applied after plugin transforms. The evaluate hook sees
 * every agent, and only tightens: a default never loosens a stricter result,
 * and an agent with an explicit rule for the action keeps its own decision.
 */
export async function registerPermissionDefaults(
  ctx: PermissionDefaultsContext,
  defaults: Record<string, V2Permission["effect"]>,
): Promise<void> {
  const active = new Map(Object.entries(defaults).filter(([, effect]) => VALID_EFFECTS.has(effect)))
  if (active.size === 0) return
  await ctx.permission.hook("evaluate", async (event) => {
    const fallback = active.get(event.action)
    if (!fallback || EFFECT_RANK[fallback] <= EFFECT_RANK[event.effect]) return
    if (event.agent) {
      try {
        const result = await ctx.agent.get({ agentID: event.agent })
        const info = result?.data ?? result
        const rules: V2Permission[] = Array.isArray(info?.permissions) ? info.permissions : []
        if (rules.some((rule) => rule.action === event.action)) return
      } catch {
        // Agent lookup failed: fall through and apply the safer default.
      }
    }
    event.effect = fallback
  })
}
