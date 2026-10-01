/**
 * OpenCode binding for harness-neutral tool definitions.
 *
 * Wraps an `EsToolDefinition` (src/tools/contract.ts) into the shape OpenCode
 * v1 `tool()` expects.
 */

import type { EsToolDefinition, SchemaBuilder } from "../../tools/contract.ts";

type OpenCodeV1ToolFactory = (spec: {
  description: string
  args: Record<string, never>
  execute: (callArgs: unknown, context: { worktree?: string; directory?: string; sessionID?: string }) => Promise<unknown>
}) => unknown

type OpenCodeV1ToolFactoryWithSchema = OpenCodeV1ToolFactory & { schema: SchemaBuilder }

let openCodeV1ToolFactoryPromise: Promise<OpenCodeV1ToolFactory> | null = null

async function resolveOpenCodeV1ToolFactory(): Promise<OpenCodeV1ToolFactory> {
  if (!openCodeV1ToolFactoryPromise) {
    const legacyPluginSpecifier = "@opencode-ai/plugin"
    openCodeV1ToolFactoryPromise = import(legacyPluginSpecifier)
      .then((module) => {
        const factory = module?.tool
        if (typeof factory !== "function") {
          throw new Error("`@opencode-ai/plugin` does not export a `tool()` factory.")
        }
        return factory as OpenCodeV1ToolFactory
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(
          `OpenCode v1 compatibility requires '@opencode-ai/plugin' at runtime. Install it to use the v1 plugin surface. Original error: ${message}`,
        )
      })
  }
  return openCodeV1ToolFactoryPromise
}

export async function toOpenCodeToolV1(definition: EsToolDefinition) {
  const tool = await resolveOpenCodeV1ToolFactory()
  const toolWithSchema = tool as OpenCodeV1ToolFactoryWithSchema

  // The harness boundary is the only place the two schema vocabularies meet:
  // `tool.schema` is structurally a SchemaBuilder, and the nodes it returns are
  // the zod types `tool()` wants back.
  const args = definition.args(toolWithSchema.schema) as Record<string, never>;

  return tool({
    description: definition.description,
    args,
    async execute(callArgs, context) {
      return definition.execute(callArgs, {
        cwd: context.worktree || context.directory,
        sessionID: context.sessionID,
      });
    },
  });
}
