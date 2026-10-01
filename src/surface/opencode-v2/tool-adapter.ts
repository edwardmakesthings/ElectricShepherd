import type { JsonSchema } from "effect"
import type { EsToolDefinition, SchemaBuilder, SchemaNode } from "../../tools/contract.ts"

type JsonObjectSchema = JsonSchema.JsonSchema & {
  type: "object"
  properties: Record<string, JsonSchema.JsonSchema>
  required?: string[]
}

class JsonSchemaNode implements SchemaNode {
  readonly schema: JsonSchema.JsonSchema
  readonly isOptional: boolean

  constructor(schema: JsonSchema.JsonSchema, isOptional: boolean = false) {
    this.schema = schema
    this.isOptional = isOptional
  }

  optional(): SchemaNode {
    return new JsonSchemaNode(this.schema, true)
  }

  describe(description: string): SchemaNode {
    return new JsonSchemaNode({ ...this.schema, description }, this.isOptional)
  }

  default(value: unknown): SchemaNode {
    return new JsonSchemaNode({ ...this.schema, default: value }, this.isOptional)
  }
}

const jsonSchemaBuilder: SchemaBuilder = {
  string() {
    return new JsonSchemaNode({ type: "string" })
  },
  number() {
    return new JsonSchemaNode({ type: "number" })
  },
  boolean() {
    return new JsonSchemaNode({ type: "boolean" })
  },
  array(item) {
    const node = item as JsonSchemaNode
    return new JsonSchemaNode({
      type: "array",
      items: node.schema,
    })
  },
  object(shape) {
    return new JsonSchemaNode(toObjectSchema(shape))
  },
  enum(values) {
    return new JsonSchemaNode({
      type: "string",
      enum: [...values],
    })
  },
}

function toObjectSchema(shape: Record<string, SchemaNode>): JsonObjectSchema {
  const properties: Record<string, JsonSchema.JsonSchema> = {}
  const required: string[] = []

  for (const [name, value] of Object.entries(shape)) {
    const node = value as JsonSchemaNode
    properties[name] = node.schema
    if (!node.isOptional) required.push(name)
  }

  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
  }
}

/**
 * Stop waiting as soon as the session stops the call. Most tools cannot cancel
 * their MemPalace request mid-flight, so it finishes (or times out) in the
 * background, but the session no longer hangs on it.
 */
export function abortable<T>(run: Promise<T>, signal: AbortSignal | undefined, name: string): Promise<T> {
  if (!signal) return run
  if (signal.aborted) return Promise.reject(new Error(`${name} was cancelled`))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error(`${name} was cancelled`))
    signal.addEventListener("abort", onAbort, { once: true })
    run.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value) },
      (error) => { signal.removeEventListener("abort", onAbort); reject(error) },
    )
  })
}

export function toOpenCodeV2Tool(
  definition: EsToolDefinition,
  cwdResolver: (context: { sessionID: string }) => string,
) {
  const shape = definition.args(jsonSchemaBuilder)
  return {
    name: definition.name,
    description: definition.description,
    input: toObjectSchema(shape),
    async execute(callArgs: unknown, context: { sessionID: string; signal?: AbortSignal }) {
      const run = definition.execute(callArgs as Record<string, unknown>, {
        cwd: cwdResolver(context),
        sessionID: context.sessionID,
        signal: context.signal,
      })
      return { content: await abortable(run, context.signal, definition.name) }
    },
  }
}
