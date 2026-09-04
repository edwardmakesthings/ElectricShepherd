import type { Plugin } from "@opencode-ai/plugin"
import SessionPolicyPlugin from "./plugin/session-policy.ts"

export const plugin: Plugin = async (input) => {
  return SessionPolicyPlugin(input)
}

export default plugin
