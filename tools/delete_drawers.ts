import { tool } from "@opencode-ai/plugin";
// @ts-expect-error plugin runtime does not include node typings in this workspace
import { join } from "node:path";

declare const Bun: {
  spawn: (input: {
    cmd: string[];
    cwd: string;
    stdout: "pipe";
    stderr: "pipe";
  }) => {
    stdout: ReadableStream;
    stderr: ReadableStream;
    exited: Promise<number>;
  };
};

function normalizeIDs(ids: unknown): string[] {
  if (!Array.isArray(ids)) return [];
  return ids
    .map((value) => String(value || "").trim())
    .filter(Boolean);
}

export default tool({
  description:
    "Delete MemPalace drawers by ID using ElectricShepherd's deterministic script runner.",
  args: {
    drawer_ids: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe("Drawer IDs to delete."),
    ids_file: tool.schema
      .string()
      .optional()
      .describe("Path to a file containing drawer IDs (newline/csv/json array)."),
    dry_run: tool.schema
      .boolean()
      .default(false)
      .describe("When true, prints planned deletions without deleting."),
    fail_fast: tool.schema
      .boolean()
      .default(false)
      .describe("When true, stop on first failed delete."),
    tool_prefix: tool.schema
      .string()
      .optional()
      .describe("Optional MCP tool prefix override (example: mygateway_mempalace_)."),
  },
  async execute(args, context) {
    const drawerIDs = normalizeIDs(args.drawer_ids);
    const idsFile = String(args.ids_file || "").trim();
    if (!idsFile && drawerIDs.length === 0) {
      throw new Error("Provide either drawer_ids or ids_file.");
    }

    const cwd = context.worktree || context.directory;
    const scriptPath = join(cwd, "scripts", "delete-drawers.ts");
    const command = ["node", "--experimental-strip-types", scriptPath, "--json"];

    if (args.dry_run) command.push("--dry-run");
    if (args.fail_fast) command.push("--fail-fast");
    if (args.tool_prefix) command.push("--tool-prefix", String(args.tool_prefix));

    if (idsFile) {
      command.push("--ids-file", idsFile);
    } else {
      command.push("--ids", drawerIDs.join(","));
    }

    const proc = Bun.spawn({
      cmd: command,
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      throw new Error(
        `delete_drawers failed (exit ${exitCode})${stderr ? `: ${stderr.trim()}` : ""}`,
      );
    }

    return stdout.trim();
  },
});
