import { tool } from "@opencode-ai/plugin";
import {
  asObject,
  asText,
  createPalaceClient,
  drawerContentFrom,
  previewEnds,
  scratchFileNameFor,
} from "../core/palace-tools.ts";
import { applyRuntimeConfigToEnv, loadRuntimeConfig } from "../core/runtime-config.ts";
import { loadRuntimeEnv } from "../scripts/runtime-env.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

declare const process: {
  env: Record<string, string | undefined>;
};

export default tool({
  description:
    "Fetch a drawer from MemPalace and write its full verbatim content to a local file, returning ONLY metadata and short head/tail previews. Use this instead of get_drawer for large drawers (raw session transcripts especially): the file can then be summarized by a cheap subagent (drawer-digest) without spending the orchestrator's context window on raw content.",
  args: {
    drawer_id: tool.schema.string().describe("Drawer ID to export."),
    out_dir: tool.schema
      .string()
      .optional()
      .describe("Directory for the export, relative to the project root (default .electric-shepherd/scratch)."),
    head_chars: tool.schema.number().optional().describe("Characters of head preview to return (default 600)."),
    tail_chars: tool.schema.number().optional().describe("Characters of tail preview to return (default 300)."),
    tool_prefix: tool.schema.string().optional().describe("MCP tool prefix override."),
  },
  async execute(args, context) {
    const cwd = context.worktree || context.directory;
    loadRuntimeEnv({ scriptUrl: import.meta.url, env: process.env, cwd });
    const runtimeConfig = loadRuntimeConfig({ cwd, env: process.env });
    applyRuntimeConfigToEnv(process.env, runtimeConfig);

    const drawerID = String(args.drawer_id || "").trim();
    if (!drawerID) throw new Error("export_drawer: drawer_id is required");

    const headChars = clampNumber(args.head_chars, 600, 0, 4000);
    const tailChars = clampNumber(args.tail_chars, 300, 0, 4000);

    const projectRoot = resolve(cwd);
    const outDir = resolve(projectRoot, String(args.out_dir || ".electric-shepherd/scratch"));
    // Keep exports inside the project so a crafted out_dir cannot write elsewhere.
    const relativeOut = relative(projectRoot, outDir);
    if (relativeOut.startsWith("..") || resolve(projectRoot, relativeOut) !== outDir) {
      throw new Error("export_drawer: out_dir must stay inside the project root");
    }

    const { client, prefix } = await createPalaceClient({
      env: process.env,
      clientName: "electric-shepherd-export-drawer",
      toolPrefix: args.tool_prefix,
    });

    const response = await client.callTool(`${prefix}get_drawer`, { drawer_id: drawerID });
    const payload = asObject(response);
    const content = drawerContentFrom(payload);
    if (!content) {
      return JSON.stringify({ ok: false, drawer_id: drawerID, error: "drawer returned no content" }, null, 2);
    }

    const meta = asObject(payload.metadata);
    const stamp = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
    const filePath = resolve(outDir, scratchFileNameFor(drawerID, stamp));

    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content, "utf8");

    const preview = previewEnds(content, headChars, tailChars);
    const bytes = new TextEncoder().encode(content).length;

    return JSON.stringify(
      {
        ok: true,
        drawer_id: drawerID,
        wing: asText(payload.wing || meta.wing),
        room: asText(payload.room || meta.room),
        filed_at: asText(meta.filed_at),
        source_file: asText(meta.source_file),
        file_path: filePath,
        relative_path: relative(projectRoot, filePath),
        bytes,
        characters: content.length,
        lines: content.split(/\r?\n/).length,
        preview_head: preview.head,
        preview_tail: preview.tail,
        truncated_preview: preview.truncated,
        next_step:
          "Dispatch the drawer-digest subagent with this file_path to get a dense summary; do not read the whole file into this context.",
      },
      null,
      2,
    );
  },
});

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}
