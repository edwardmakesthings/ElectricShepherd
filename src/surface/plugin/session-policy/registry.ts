import { ES_TOOLS } from "../../../tools/index.ts"
import { toOpenCodeTool } from "../../opencode/tool-adapter.ts"

/** Name -> OpenCode-bound tool. Keys come from each definition's own `name`. */
export function createToolRegistry(): Record<string, ReturnType<typeof toOpenCodeTool>> {
  return Object.fromEntries(ES_TOOLS.map((definition) => [definition.name, toOpenCodeTool(definition)]))
}
