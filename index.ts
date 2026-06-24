import type { Plugin } from "@opencode-ai/plugin"
import TurnGuard from "./plugin/turn-guard.ts"

export const plugin: Plugin = async (input) => {
  return TurnGuard(input)
}

export default plugin
