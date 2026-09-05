/**
 * Shared internals contract for the MemgraphClient method-group modules
 * (capability/episodic modules + memgraph-drawers / memgraph-capability).
 *
 * Criterion 2 decomposition: MemgraphClient's method bodies live in those
 * modules as plain functions; each takes a `MemgraphInternals` context built
 * once by the class (see adapter/memgraph.ts) binding its private transport
 * helpers. Behavior is unchanged — every call still routes through the same
 * invoke / call / kgQuery / degrade paths as before the split.
 */

import type { SubstrateResult } from "./mcp-http-client.ts";
import type { JsonMap, MemgraphToolMap } from "./memgraph-structure.ts";

export type KGQueryArgs = {
  entity: string;
  as_of?: string;
  direction?: "incoming" | "outgoing" | "both";
  predicate?: string;
  recurse?: boolean;
  max_depth?: number;
};

export interface MemgraphInternals {
  invoke(name: keyof MemgraphToolMap | string, args: JsonMap | undefined): Promise<SubstrateResult<JsonMap>>;
  call(name: keyof MemgraphToolMap, args?: JsonMap): Promise<JsonMap>;
  kgQuery(args: KGQueryArgs): Promise<JsonMap>;
  kgQueryIgnoringFailure(args: KGQueryArgs, reason: string): Promise<JsonMap>;
  callIgnoringFailure(name: keyof MemgraphToolMap, args: JsonMap | undefined, reason: string): Promise<JsonMap>;
}
