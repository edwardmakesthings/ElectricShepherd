/**
 * Harness-neutral tool contract.
 *
 * A tool declares its parameter schema through an *injected* builder rather than
 * importing one, so the same definition binds to OpenCode (`tool.schema`) and to
 * oh-my-pi (`pi.zod`) without `src/tools/` depending on either harness. The
 * bindings live in `src/surface/<harness>/tool-adapter.ts`.
 *
 * Tradeoff: injecting the builder gives up the per-tool argument type inference
 * that `tool({ args })` provided, so `execute` receives a loose args record.
 * Tools already normalize their inputs defensively (`String(args.x || "")`), and
 * a tool that wants real types can declare its own args interface as `A`.
 */

/** The chainable subset of a schema field both harnesses' builders provide. */
export interface SchemaNode {
  optional(): SchemaNode;
  describe(description: string): SchemaNode;
  default(value: unknown): SchemaNode;
}

/** The constructor subset both harnesses' builders provide. */
export interface SchemaBuilder {
  string(): SchemaNode;
  number(): SchemaNode;
  boolean(): SchemaNode;
  array(item: SchemaNode): SchemaNode;
  object(shape: Record<string, SchemaNode>): SchemaNode;
  enum(values: string[]): SchemaNode;
}

/** Everything a tool is allowed to need from its host. */
export interface EsToolContext {
  /** Project root the tool runs against. */
  cwd: string;
  /** Only `capture_transcript` needs this, and only a live session supplies it. */
  sessionID?: string;
}

export interface EsToolDefinition<A = Record<string, any>> {
  name: string;
  description: string;
  args(schema: SchemaBuilder): Record<string, SchemaNode>;
  execute(args: A, context: EsToolContext): Promise<string>;
}

/** Identity helper; exists so definitions get checked at the declaration site. */
export function defineTool<A = Record<string, any>>(
  definition: EsToolDefinition<A>,
): EsToolDefinition<A> {
  return definition;
}
