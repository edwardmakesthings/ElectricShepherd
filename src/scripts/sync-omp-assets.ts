/**
 * Stage the packaged assets into the omp extension root.
 *
 * omp discovers a package's `commands/`, `agents/` and `skills/` only from a
 * directory extension root — `discovery/omp-extension-roots.ts`: "Paths that do
 * not resolve to a directory are silently dropped — file entrypoints have no
 * package sub-tree to scan." The root cannot be the repo root either, because
 * the `index.ts` there is the OpenCode plugin entry, so omp would load the wrong
 * module and register none of the tools.
 *
 * So the root is `src/surface/omp/`, and these directories are copied in. They
 * are generated and gitignored; the canonical copies stay at the repo root where
 * OpenCode's asset loader and package.json `files` already expect them. Re-run
 * this after editing any command, agent or skill.
 */

import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OMP_ROOT = join(ROOT, "src", "surface", "omp");
const ASSET_DIRS = ["commands", "agents", "skills"];

let staged = 0;
for (const name of ASSET_DIRS) {
  const source = join(ROOT, name);
  if (!existsSync(source)) continue;
  const target = join(OMP_ROOT, name);
  rmSync(target, { recursive: true, force: true });
  cpSync(source, target, { recursive: true });
  staged += 1;
  process.stdout.write(`[omp-assets] staged ${name}/\n`);
}

if (staged === 0) {
  process.stderr.write("[omp-assets] nothing staged: no commands/, agents/ or skills/ at the repo root\n");
  process.exit(1);
}
process.stdout.write(`[omp-assets] extension root ready: ${OMP_ROOT}\n`);
