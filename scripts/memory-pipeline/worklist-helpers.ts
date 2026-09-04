/**
 * Worklist drawer helpers for the consolidation pipeline.
 * Extracted from run-memory-consolidation-and-validation.ts (criterion 2).
 */
import type { SourceDrawerWorkItem } from "../../adapter/memgraph.ts";
import { asObject, asArray, asString } from "./cli-options.ts";

export function chunkItems<T>(items: T[], size: number): T[][] {
  if (items.length === 0) return [];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

export function parseDrawerPayload(raw: unknown): SourceDrawerWorkItem | null {
  const root = asObject(raw);
  const candidates = [
    asObject(root.drawer),
    asObject(root.result),
    asObject(root.data),
    asObject(asArray(root.drawers)[0]),
    asObject(asArray(root.results)[0]),
    root,
  ];
  const candidate = candidates.find((obj) => Object.keys(obj).length > 0) || {};
  const drawerId = asString(candidate.drawer_id || candidate.node_id || candidate.id).trim();
  if (!drawerId) return null;
  return {
    drawer_id: drawerId,
    wing: asString(candidate.wing || candidate.closet || candidate.namespace).trim() || undefined,
    room: asString(candidate.room).trim() || undefined,
    desc: asString(candidate.desc || candidate.title || candidate.summary).trim() || undefined,
    filed_at: asString(candidate.filed_at || candidate.created_at).trim() || undefined,
    content: asString(candidate.content || candidate.text).trim() || undefined,
  };
}

export function getFamilyDrawerIds(item: SourceDrawerWorkItem): string[] {
  const family = asArray(item.family_drawer_ids)
    .map((value) => asString(value).trim())
    .filter(Boolean);
  if (family.length > 0) return [...new Set(family)];
  return [item.drawer_id];
}

type MemgraphClientLike = {
  getDrawer(args: Record<string, unknown>): Promise<unknown>;
  updateDrawer(args: Record<string, unknown>): Promise<unknown>;
  isSourceDrawerConsolidated(drawerId: string): Promise<boolean>;
};

export async function ensureRawEntriesForChunk(
  client: MemgraphClientLike,
  items: SourceDrawerWorkItem[],
): Promise<{ entries: Array<{ id: string; text: string }>; skipped: Array<{ drawer_id: string; reason: string }> }> {
  const out: Array<{ id: string; text: string }> = [];
  const skipped: Array<{ drawer_id: string; reason: string }> = [];
  const seen = new Set<string>();
  for (const item of items) {
    const familyIds = getFamilyDrawerIds(item);
    for (const drawerId of familyIds) {
      if (seen.has(drawerId)) continue;
      seen.add(drawerId);

      const existing = drawerId === item.drawer_id ? asString(item.content).trim() : "";
      if (existing) {
        out.push({ id: drawerId, text: existing });
        continue;
      }
      try {
        const raw = await client.getDrawer({ drawer_id: drawerId });
        const parsed = parseDrawerPayload(raw);
        const text = asString(parsed?.content).trim();
        if (text) out.push({ id: drawerId, text });
        else skipped.push({ drawer_id: drawerId, reason: "empty-content" });
      } catch {
        skipped.push({ drawer_id: drawerId, reason: "drawer-fetch-failed" });
      }
    }
  }
  return { entries: out, skipped };
}

export async function moveDrawerFamily(
  client: MemgraphClientLike,
  args: {
    item: SourceDrawerWorkItem;
    targetRoom: string;
    targetWing: string;
    applyWrites: boolean;
  },
): Promise<{ moved: string[]; attempted: string[]; errors: Array<{ drawer_id: string; error: string }> }> {
  const attempted = getFamilyDrawerIds(args.item);
  if (!args.applyWrites) return { moved: [], attempted, errors: [] };

  const moved: string[] = [];
  const errors: Array<{ drawer_id: string; error: string }> = [];
  for (const drawerId of attempted) {
    try {
      await client.updateDrawer({
        drawer_id: drawerId,
        wing: (args.item.wing || "").trim() || args.targetWing,
        room: args.targetRoom,
      });
      moved.push(drawerId);
    } catch (err) {
      errors.push({ drawer_id: drawerId, error: String(err) });
    }
  }

  return { moved, attempted, errors };
}

export async function getConsolidatedIdsForFamily(
  client: MemgraphClientLike,
  item: SourceDrawerWorkItem,
): Promise<{ consolidated: string[]; unconsolidated: string[] }> {
  const consolidated: string[] = [];
  const unconsolidated: string[] = [];
  for (const drawerId of getFamilyDrawerIds(item)) {
    try {
      if (await client.isSourceDrawerConsolidated(drawerId)) consolidated.push(drawerId);
      else unconsolidated.push(drawerId);
    } catch {
      unconsolidated.push(drawerId);
    }
  }
  return { consolidated, unconsolidated };
}


export async function postConsolidationMoves(args: {
  client: MemgraphClientLike;
  actionable: SourceDrawerWorkItem[];
  chunkIndex: number;
  totalChunks: number;
  worklistOptions: { processedRoom: string; failedRoom: string };
  targetWing: string;
}): Promise<{ movedToProcessed: Array<{ drawer_id: string; family_drawer_ids: string[]; reason: string }>; movedToFailed: Array<{ drawer_id: string; family_drawer_ids: string[]; reason: string }>; moveErrors: Array<{ drawer_id: string; phase: "processed" | "failed"; error: string }> }> {
  const movedToProcessed: Array<{ drawer_id: string; family_drawer_ids: string[]; reason: string }> = [];
  const movedToFailed: Array<{ drawer_id: string; family_drawer_ids: string[]; reason: string }> = [];
  const moveErrors: Array<{ drawer_id: string; phase: "processed" | "failed"; error: string }> = [];

  for (const item of args.actionable) {
    const consolidated = await getConsolidatedIdsForFamily(args.client, item);
    const targetRoom = consolidated.unconsolidated.length === 0 ? args.worklistOptions.processedRoom : args.worklistOptions.failedRoom;
    const phase = targetRoom === args.worklistOptions.processedRoom ? "processed" : "failed";
    const reason = phase === "processed" ? "edge-verified" : "missing-consolidated-edge";
    const moveResult = await moveDrawerFamily(args.client, {
      item,
      targetRoom,
      targetWing: args.targetWing,
      applyWrites: true,
    });
    if (phase === "processed") {
      movedToProcessed.push({ drawer_id: item.drawer_id, family_drawer_ids: moveResult.attempted, reason });
    } else {
      movedToFailed.push({ drawer_id: item.drawer_id, family_drawer_ids: moveResult.attempted, reason });
    }
    moveErrors.push(
      ...moveResult.errors.map((entry) => ({
        drawer_id: entry.drawer_id,
        phase: phase as "processed" | "failed",
        error: entry.error,
      })),
    );
  }

  process.stderr.write(
    `[memory-consolidation-validation] chunk ${args.chunkIndex + 1}/${args.totalChunks} post-verify moves processed=${movedToProcessed.length} failed=${movedToFailed.length} errors=${moveErrors.length}\n`,
  );

  return { movedToProcessed, movedToFailed, moveErrors };
}


export async function moveAllToFailed(args: {
  client: MemgraphClientLike;
  actionable: SourceDrawerWorkItem[];
  chunkIndex: number;
  totalChunks: number;
  failedRoom: string;
  targetWing: string;
}): Promise<{ movedToFailed: Array<{ drawer_id: string; family_drawer_ids: string[]; reason: string }>; moveErrors: Array<{ drawer_id: string; phase: "processed" | "failed"; error: string }> }> {
  const movedToFailed: Array<{ drawer_id: string; family_drawer_ids: string[]; reason: string }> = [];
  const moveErrors: Array<{ drawer_id: string; phase: "processed" | "failed"; error: string }> = [];

  for (const item of args.actionable) {
    const moveResult = await moveDrawerFamily(args.client, {
      item,
      targetRoom: args.failedRoom,
      targetWing: args.targetWing,
      applyWrites: true,
    });
    movedToFailed.push({ drawer_id: item.drawer_id, family_drawer_ids: moveResult.attempted, reason: "no-created-node" });
    moveErrors.push(
      ...moveResult.errors.map((entry) => ({
        drawer_id: entry.drawer_id,
        phase: "failed" as const,
        error: entry.error,
      })),
    );
  }

  process.stderr.write(
    `[memory-consolidation-validation] chunk ${args.chunkIndex + 1}/${args.totalChunks} moved-to-failed=${args.actionable.length} reason=no-created-node\n`,
  );

  return { movedToFailed, moveErrors };
}


export async function partitionChunk(args: {
  client: MemgraphClientLike;
  chunk: SourceDrawerWorkItem[];
  processedRoom: string;
  targetWing: string;
  applyWrites: boolean;
  moveAlreadyConsolidated: boolean;
}): Promise<{ actionable: SourceDrawerWorkItem[]; movedToProcessed: Array<{ drawer_id: string; family_drawer_ids: string[]; reason: string }>; moveErrors: Array<{ drawer_id: string; phase: "processed" | "failed"; error: string }> }> {
  const actionable: SourceDrawerWorkItem[] = [];
  const movedToProcessed: Array<{ drawer_id: string; family_drawer_ids: string[]; reason: string }> = [];
  const moveErrors: Array<{ drawer_id: string; phase: "processed" | "failed"; error: string }> = [];

  for (const item of args.chunk) {
    const consolidated = await getConsolidatedIdsForFamily(args.client, item);
    if (consolidated.unconsolidated.length === 0) {
      if (args.moveAlreadyConsolidated) {
        const moveResult = await moveDrawerFamily(args.client, {
          item,
          targetRoom: args.processedRoom,
          targetWing: args.targetWing,
          applyWrites: args.applyWrites,
        });
        movedToProcessed.push({
          drawer_id: item.drawer_id,
          family_drawer_ids: moveResult.attempted,
          reason: "already-consolidated",
        });
        moveErrors.push(
          ...moveResult.errors.map((entry) => ({
            drawer_id: entry.drawer_id,
            phase: "processed" as const,
            error: entry.error,
          })),
        );
      }
      continue;
    }
    actionable.push({
      ...item,
      family_drawer_ids: consolidated.unconsolidated,
    });
  }

  return { actionable, movedToProcessed, moveErrors };
}
