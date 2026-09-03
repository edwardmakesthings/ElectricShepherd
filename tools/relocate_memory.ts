import { tool } from "@opencode-ai/plugin";
import {
  asObject,
  asText,
  createPalaceClient,
  drawerContentFrom,
  previewEnds,
  sliceVerbatimBetween,
  verifyVerbatimExcerpt,
} from "../adapter/palace-tools.ts";
import { normalizeDryRunArg } from "../core/substrate.ts";
import { applyRuntimeConfigToEnv, loadRuntimeConfig } from "../adapter/runtime-config.ts";
import { loadRuntimeEnv } from "../scripts/runtime-env.ts";

declare const process: {
  env: Record<string, string | undefined>;
};

export default tool({
  description:
    "Re-file memory into a different wing/room. mode=move relocates a whole drawer (update_drawer). mode=excerpt lifts a verbatim passage out of a drawer (an aside about another project, say) into the correct wing/room as a NEW drawer, leaving the source untouched, and records an excerpted-from lineage edge. Defaults to dry_run.",
  args: {
    drawer_id: tool.schema.string().describe("Source drawer ID."),
    target_wing: tool.schema.string().describe("Destination wing."),
    target_room: tool.schema.string().describe("Destination room."),
    mode: tool.schema
      .enum(["move", "excerpt"])
      .optional()
      .describe("move = relocate the whole drawer; excerpt = copy a verbatim passage out (default move)."),
    excerpt: tool.schema
      .string()
      .optional()
      .describe("Verbatim passage to lift, for mode=excerpt. Must appear exactly in the source drawer."),
    excerpt_start: tool.schema
      .string()
      .optional()
      .describe("First line/phrase of the passage. Use with excerpt_end instead of excerpt to avoid carrying long text."),
    excerpt_end: tool.schema
      .string()
      .optional()
      .describe("Last line/phrase of the passage. The tool slices verbatim between the anchors."),
    dry_run: tool.schema.boolean().optional().describe("Preview without writing (default true)."),
    link_predicate: tool.schema
      .string()
      .optional()
      .describe("KG predicate linking the new drawer to its source (default excerpted-from)."),
    added_by: tool.schema.string().optional().describe("Attribution for the new drawer (default electric-shepherd-relocate)."),
    tool_prefix: tool.schema.string().optional().describe("MCP tool prefix override."),
  },
  async execute(args, context) {
    const cwd = context.worktree || context.directory;
    loadRuntimeEnv({ scriptUrl: import.meta.url, env: process.env, cwd });
    const runtimeConfig = loadRuntimeConfig({ cwd, env: process.env });
    applyRuntimeConfigToEnv(process.env, runtimeConfig);

    const drawerID = String(args.drawer_id || "").trim();
    const targetWing = String(args.target_wing || "").trim();
    const targetRoom = String(args.target_room || "").trim();
    const mode = args.mode === "excerpt" ? "excerpt" : "move";
    const dryRun = normalizeDryRunArg(args);

    if (!drawerID) throw new Error("relocate_memory: drawer_id is required");
    if (!targetWing || !targetRoom) throw new Error("relocate_memory: target_wing and target_room are required");
    const hasAnchors = Boolean(String(args.excerpt_start || "").trim() && String(args.excerpt_end || "").trim());
    if (mode === "excerpt" && !String(args.excerpt || "").trim() && !hasAnchors) {
      throw new Error("relocate_memory: mode=excerpt needs either excerpt, or excerpt_start plus excerpt_end");
    }

    const { client, prefix } = await createPalaceClient({
      env: process.env,
      clientName: "electric-shepherd-relocate-memory",
      toolPrefix: args.tool_prefix,
    });
    const call = async (name: string, payload: Record<string, unknown>) =>
      client.callTool(`${prefix}${name}`, payload);

    const source = asObject(await call("get_drawer", { drawer_id: drawerID }));
    if (asText(source.error)) {
      return json({ ok: false, drawer_id: drawerID, error: asText(source.error) });
    }

    const sourceMeta = asObject(source.metadata);
    const from = {
      wing: asText(source.wing || sourceMeta.wing),
      room: asText(source.room || sourceMeta.room),
    };

    if (mode === "move") {
      if (from.wing === targetWing && from.room === targetRoom) {
        return json({ ok: true, mode, drawer_id: drawerID, skipped: "already-in-target-scope", from });
      }
      if (dryRun) {
        return json({
          ok: true,
          mode,
          dry_run: true,
          drawer_id: drawerID,
          from,
          to: { wing: targetWing, room: targetRoom },
          next_step: "Re-run with dry_run:false to apply the move.",
        });
      }

      const updated = asObject(await call("update_drawer", { drawer_id: drawerID, wing: targetWing, room: targetRoom }));
      if (asText(updated.error)) {
        return json({ ok: false, mode, drawer_id: drawerID, error: asText(updated.error) });
      }
      return json({
        ok: true,
        mode,
        dry_run: false,
        drawer_id: drawerID,
        from,
        to: { wing: targetWing, room: targetRoom },
      });
    }

    const sourceContent = drawerContentFrom(source);
    let excerpt = String(args.excerpt || "");
    let resolvedVia = "literal";

    if (hasAnchors) {
      const sliced = sliceVerbatimBetween(sourceContent, args.excerpt_start, args.excerpt_end);
      if (!sliced.ok) {
        return json({
          ok: false,
          mode,
          drawer_id: drawerID,
          error: `anchor slice failed: ${sliced.reason}`,
          hint: "Anchors must be copied exactly from the drawer. Use export_drawer + drawer-digest to recover the true first/last lines.",
        });
      }
      excerpt = sliced.text || "";
      resolvedVia = "anchors";
    }

    const verbatim = verifyVerbatimExcerpt(sourceContent, excerpt);
    if (!verbatim.ok) {
      return json({
        ok: false,
        mode,
        drawer_id: drawerID,
        error: `excerpt rejected: ${verbatim.reason}`,
        hint: "Copy the passage exactly as stored, or pass excerpt_start/excerpt_end. Relocation never paraphrases.",
      });
    }

    const excerptPreview = previewEnds(excerpt, 400, 200);

    if (dryRun) {
      return json({
        ok: true,
        mode,
        dry_run: true,
        drawer_id: drawerID,
        from,
        to: { wing: targetWing, room: targetRoom },
        resolved_via: resolvedVia,
        excerpt_characters: excerpt.length,
        excerpt_preview_head: excerptPreview.head,
        excerpt_preview_tail: excerptPreview.tail,
        verbatim_verified: true,
        next_step: "Show this preview to the user; re-run with dry_run:false only after they approve.",
      });
    }

    const created = asObject(
      await call("add_drawer", {
        wing: targetWing,
        room: targetRoom,
        content: excerpt,
        source_file: `relocated-from:${drawerID}`,
        added_by: String(args.added_by || "electric-shepherd-relocate"),
      }),
    );
    const newDrawerID = asText(created.drawer_id || created.id);
    if (!newDrawerID) {
      return json({ ok: false, mode, drawer_id: drawerID, error: "add_drawer returned no drawer_id", raw: created });
    }

    const predicate = String(args.link_predicate || "excerpted-from").trim() || "excerpted-from";
    let lineage: Record<string, unknown> = { ok: true, predicate };
    try {
      await call("kg_add", { subject: newDrawerID, predicate, object: drawerID, source_drawer_id: newDrawerID });
    } catch (err) {
      lineage = { ok: false, predicate, error: String(err) };
    }

    return json({
      ok: true,
      mode,
      dry_run: false,
      source_drawer_id: drawerID,
      new_drawer_id: newDrawerID,
      from,
      to: { wing: targetWing, room: targetRoom },
      resolved_via: resolvedVia,
      excerpt_characters: excerpt.length,
      duplicate: Boolean(created.is_duplicate),
      lineage,
      note: "Source drawer left untouched; the excerpt is an additional verbatim copy in its proper scope.",
    });
  },
});

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
