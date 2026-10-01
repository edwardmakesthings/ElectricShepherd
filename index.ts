import SessionPolicyPluginV1 from "./src/surface/plugin/session-policy-v1.ts"
import SessionPolicyPluginV2 from "./src/surface/plugin/session-policy-v2.ts"

function useOpenCodeV1Surface(): boolean {
  const raw = String(process.env.ESHEPHERD_OPENCODE_PLUGIN_API ?? "").trim().toLowerCase()
  return raw === "1" || raw === "v1" || raw === "opencode-v1"
}

/**
 * V1 fallback export for OpenCode 1.x environments.
 */
export const plugin = async (input: any) => {
  return SessionPolicyPluginV1({
    ...input,
    disableV1ToolRegistry: false,
  })
}

/**
 * Explicit V2 export (same value as default export).
 */
export const pluginV2 = SessionPolicyPluginV2

/**
 * Default export targets OpenCode 2.x plugin API unless explicitly pinned.
 *
 * Set ESHEPHERD_OPENCODE_PLUGIN_API=v1 (or 1 / opencode-v1) to force the
 * legacy OpenCode 1.x surface.
 */
export default useOpenCodeV1Surface() ? plugin : pluginV2
