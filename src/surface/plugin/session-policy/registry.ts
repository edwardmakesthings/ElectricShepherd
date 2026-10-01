import { ES_TOOLS } from "../../../tools/index.ts"
import { toOpenCodeToolV1 } from "../../opencode-v1/tool-adapter.ts"

/** Name -> OpenCode-bound tool. Keys come from each definition's own `name`. */
export async function createToolRegistryV1(): Promise<Record<string, unknown>> {
  const entries = await Promise.all(
    ES_TOOLS.map(async (definition) => [definition.name, await toOpenCodeToolV1(definition)] as const),
  )
  return Object.fromEntries(entries)
}
