/** Resolve modern/legacy physical-parent metadata with the server's key precedence. */
export function logicalParentDrawerId(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const row = metadata as Record<string, unknown>;
  const parent = row.parent_drawer_id || row.parent_entry_id;
  if (!parent) return undefined;
  if (typeof parent !== "string" || !parent.trim()) throw new Error("invalid-logical-parent-metadata");
  return parent;
}
