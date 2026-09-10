/**
 * OpenCode binding for harness-neutral tool definitions.
 *
 * Wraps an `EsToolDefinition` (src/tools/contract.ts) into the shape OpenCode's
 * `tool()` expects: schema fields built from `tool.schema`, and `cwd` resolved
 * from OpenCode's context.
 */

import { tool } from "@opencode-ai/plugin";
import type { EsToolDefinition, SchemaBuilder } from "../../tools/contract.ts";

export function toOpenCodeTool(definition: EsToolDefinition) {
  // The harness boundary is the only place the two schema vocabularies meet:
  // `tool.schema` is structurally a SchemaBuilder, and the nodes it returns are
  // the zod types `tool()` wants back.
  const args = definition.args(tool.schema as unknown as SchemaBuilder) as Record<string, never>;

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
