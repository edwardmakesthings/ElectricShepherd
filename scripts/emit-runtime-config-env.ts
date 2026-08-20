import { applyRuntimeConfigToEnv, loadRuntimeConfig } from "../adapter/runtime-config.ts";
import { loadRuntimeEnv } from "./runtime-env.ts";

declare const process: {
  argv: string[];
  cwd: () => string;
  env: Record<string, string | undefined>;
  stdout: { write: (text: string) => void };
  stderr: { write: (text: string) => void };
  exit: (code: number) => never;
};

function getArg(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  if (idx >= 0 && idx + 1 < argv.length) return argv[idx + 1];
  return undefined;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function main(): void {
  loadRuntimeEnv({ scriptUrl: import.meta.url, env: process.env });

  const cwd = getArg(process.argv.slice(2), "--cwd") || process.cwd();
  const runtimeConfig = loadRuntimeConfig({
    cwd,
    env: process.env,
  });
  applyRuntimeConfigToEnv(process.env, runtimeConfig);

  for (const warning of runtimeConfig.warnings) {
    process.stderr.write(`[emit-runtime-config-env] warning: ${warning}\n`);
  }

  const lines = Object.entries(runtimeConfig.valuesByEnvKey).map(([key, value]) => {
    return `export ${key}=${shellQuote(String(value || ""))}`;
  });

  process.stdout.write(lines.join("\n") + "\n");
}

main();
