import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

test("write authority conformance: runtime code contains no identity-based consolidation writer gating", async () => {
  const checks = [
    {
      file: path.join(repoRoot, "adapter/runtime-config.ts"),
      banned: [
        "ESHEPHERD_ALLOWED_CONSOLIDATION_WRITERS",
        "consolidation.allowedWriters",
        "ESHEPHERD_CONSOLIDATION_WRITE_GUARD_ENABLED",
        "consolidation.writeGuardEnabled",
      ],
    },
    {
      file: path.join(repoRoot, "plugin/session-policy/checkpoint-handler.ts"),
      banned: ["dreamer-only", "write-authority will reject them from this agent"],
    },
  ];

  for (const check of checks) {
    const content = await readFile(check.file, "utf8");
    for (const banned of check.banned) {
      assert.equal(
        content.includes(banned),
        false,
        `${path.relative(repoRoot, check.file)} must not include identity-gating token: ${banned}`,
      );
    }
  }
});
