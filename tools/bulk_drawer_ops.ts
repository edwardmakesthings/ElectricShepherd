// Compatibility shim: shared bulk-drawer primitives now live in core/substrate.ts.
export type { ErrorKind, BatchResultRow } from "../core/substrate.ts";
export {
  normalizeOptional,
  normalizeWingList,
  normalizeIDs,
  parseIDsFromFile,
  classifyErrorKind,
  summarizeFailures,
  runDrawerBatch,
  collectDrawerIDsByScope,
  resolveMemPalaceMCPUrl,
} from "../core/substrate.ts";
