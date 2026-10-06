import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, type ParseError } from "jsonc-parser";
import { parse as parseYaml } from "yaml";
import { asObject } from "./cli-options.ts";
import { ompCompletionText, ompUnexpectedTools, WorkerFailure } from "./omp-completion.ts";
import { opencodeCompletionText } from "./opencode-completion.ts";
import { resolveMapperBudget } from "./worker-model.mjs";

export type RawRunner = { kind: "omp" | "opencode"; bin: string };
export type RawInvocation = {
  runner: RawRunner; modelArg: string; prompt: string; system?: string; timeoutMs: number;
  workerAttempt?: number; env: NodeJS.ProcessEnv;
};

/** Isolate configuration discovery; catalog providers retain normal OpenCode authentication. */
export function prepareRawWorker(args: RawInvocation, root: string): { argv: string[]; env: NodeJS.ProcessEnv } {
  const realHome = args.env.HOME || homedir();
  const env: NodeJS.ProcessEnv = { ...args.env };
  const modelArg = args.modelArg.replace(",", "/");
  const separator = modelArg.indexOf("/");
  const providerID = modelArg.slice(0, separator), modelID = modelArg.slice(separator + 1);
  if (separator <= 0 || !modelID || modelID.includes("#")) {
    const error = new WorkerFailure("process");
    error.message = "Configure consolidation.mapperModel as <provider>/<model>, or invoke from a session with an active model (variants are unsupported)";
    throw error;
  }
  env.ESHEPHERD_WORKER_MODEL = modelArg;
  if (args.runner.kind === "omp") {
    Object.assign(env, { HOME: root, XDG_CONFIG_HOME: join(root, "config"),
      XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state") });
    const agent = join(root, "agent"); mkdirSync(agent, { recursive: true, mode: 0o700 });
    const source = join(args.env.PI_CODING_AGENT_DIR || join(realHome, ".omp", "agent"), "models.yml");
    const configurationError = () => {
      const error = new WorkerFailure("process");
      error.message = "Configure the selected provider/model in OMP models.yml using openai-completions and positive contextWindow/maxTokens limits";
      return error;
    };
    if (!existsSync(source)) throw configurationError();
    let original: Record<string, unknown>;
    try { original = asObject(parseYaml(readFileSync(source, "utf8"))); } catch { throw configurationError(); }
    const provider = asObject(asObject(original.providers)[providerID]);
    const models = Array.isArray(provider.models) ? provider.models.map(asObject) : [];
    const model = models.find(item => item.id === modelID);
    if (!model || (model.api || provider.api) !== "openai-completions") throw configurationError();
    try { resolveMapperBudget(model.maxTokens, model.contextWindow, env.ESHEPHERD_MAPPER_OUTPUT_TOKENS); }
    catch { throw configurationError(); }
    // Same provider, model ID, endpoint, credentials and limits; only this worker's stream adapter changes.
    const scopedProvider = { ...provider, models: [model] };
    writeFileSync(join(agent, "models.yml"), JSON.stringify({ providers: { [providerID]: scopedProvider } }), { mode: 0o600 });
    writeFileSync(join(agent, "config.yml"), "retry:\n  enabled: false\n  maxRetries: 0\n", { mode: 0o600 });
    env.PI_CODING_AGENT_DIR = agent;
    delete env.PI_CONFIG_FILES; delete env.PI_CONFIG_DIR; delete env.PI_PROFILE; delete env.OMP_PROFILE;
    // No MCP/config/extensions/agents/rules from the real HOME or project are present.
    const argv = ["-p", args.prompt, "--model", modelArg, "--no-session", "--no-title", "--no-extensions", "--no-tools",
      "--no-skills", "--no-rules", "--no-lsp", "--no-pty", "--mode", "json", "--extension",
      fileURLToPath(new URL("./omp-mapper-runtime.mjs", import.meta.url))];
    if (args.system) { const path = join(root, "system.md"); writeFileSync(path, args.system, { mode: 0o600 }); argv.push("--append-system-prompt=" + path); }
    return { argv, env };
  }
  const configDir = args.env.OPENCODE_CONFIG_DIR || join(args.env.XDG_CONFIG_HOME || join(realHome, ".config"), "opencode");
  const source = args.env.ESHEPHERD_WORKER_OPENCODE_CONFIG || args.env.OPENCODE_CONFIG ||
    [join(configDir, "opencode.jsonc"), join(configDir, "opencode.json")].find(existsSync);
  const errors: ParseError[] = [];
  const config = source ? asObject(parse(readFileSync(source, "utf8"), errors, { allowTrailingComma: true })) : {};
  if (errors.length) throw new WorkerFailure("process");
  // Explicit custom providers retain their model-only, private-HOME route.
  const provider = asObject(asObject(config.providers)[providerID]);
  const model = asObject(asObject(provider.models)[modelID]);
  const explicitProvider = Object.keys(provider).length > 0;
  if (explicitProvider && !Object.keys(model).length) throw new WorkerFailure("process");
  if (explicitProvider) {
    Object.assign(env, { HOME: root, XDG_CONFIG_HOME: join(root, "config"),
      XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state") });
    env.OPENCODE_DISABLE_MODELS_FETCH = "true";
    env.OPENCODE_DB = ":memory:";
  } else {
    // Let OpenCode resolve catalog providers and existing database-backed login normally.
    env.HOME = realHome;
    delete env.OPENCODE_DISABLE_MODELS_FETCH;
    delete env.OPENCODE_TEST_HOME;
  }
  const privateConfig = join(root, "config", "opencode"); mkdirSync(privateConfig, { recursive: true, mode: 0o700 });
  const runtime = fileURLToPath(new URL("./opencode-mapper-runtime.mjs", import.meta.url));
  const plugin = join(root, "runtime-plugin"); mkdirSync(plugin, { mode: 0o700 });
  writeFileSync(join(plugin, "package.json"), JSON.stringify({ name: "eshepherd-raw-worker", type: "module", exports: "./index.mjs" }));
  writeFileSync(join(plugin, "index.mjs"), "export { default } from " + JSON.stringify(runtime) + ";\n");
  const permissions = [{ action: "*", resource: "*", effect: "deny" }];
  writeFileSync(join(privateConfig, "opencode.json"), JSON.stringify({ model: modelArg, default_agent: "raw-worker",
    ...(explicitProvider ? { providers: { [providerID]: { ...provider, models: { [modelID]: model } } } } : {}),
    agents: { "raw-worker": { mode: "primary", system: args.system || "Use only the caller's supplied source.", permissions } },
    permissions, plugins: [plugin], mcp: { servers: {} }, lsp: false, formatter: false, snapshots: false,
    compaction: { auto: false }, warming: false, update: "disable" }), { mode: 0o600 });
  env.OPENCODE_CONFIG_DIR = privateConfig;
  env.OPENCODE_CONFIG_PROJECT_DISABLE = "true";
  env.OPENCODE_DISABLE_AUTOUPDATE = "true";
  env.OPENCODE_FILEWATCHER_DISABLE = "true";
  delete env.OPENCODE_CONFIG; delete env.OPENCODE_CONFIG_CONTENT; delete env.OPENCODE_CLI_CONFIG_CONTENT;
  delete env.OPENCODE_SERVER; delete env.OPENCODE_SERVER_URL;
  delete env.OPENCODE_SESSION_ID; delete env.OPENCODE_SERVER_PASSWORD; delete env.OPENCODE_SERVER_USERNAME;
  return { argv: ["run", args.prompt, "--standalone", "--format", "json", "--model", modelArg, "--agent", "raw-worker", "--title", "Raw text worker",
    "--print-logs", "--log-level", "error"], env };
}

/** One inference attempt. All adapter failures are typed; the shared scheduler owns bounded retries. */
export function runRawWorker(args: RawInvocation): string {
  const root = mkdtempSync(join(tmpdir(), "eshepherd-raw-worker-"));
  const emit = (record: Record<string, unknown>) => process.stderr.write("[eshepherd-mapper-runtime] " + JSON.stringify({ runner: args.runner.kind, ...record, attempt: args.workerAttempt }) + "\n");
  try {
    const { argv, env } = prepareRawWorker(args, root);
    const started = Date.now();
    const launcher = "/usr/bin/setsid";
    if (process.platform !== "linux" || !existsSync(launcher)) throw new WorkerFailure("process");
    const result = spawnSync(launcher, [args.runner.bin, ...argv], { cwd: root, env, encoding: "utf8", timeout: args.timeoutMs,
      killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    // spawnSync signals only the leader on timeout. Signal only this newly owned process group.
    if (result.error && result.pid) { try { process.kill(-result.pid, "SIGKILL"); } catch {} }
    let unexpected = false, isolationFailed = false, isolated = false, requested = false;
    let configurationReason: string | undefined;
    let observedFailure: WorkerFailure | undefined;
    const completions: Array<{ finish: string; usage: Record<string, number> }> = [];
    for (const line of (result.stderr || "").split("\n")) {
      if (!line.startsWith("[eshepherd-mapper-runtime] ")) continue;
      const record = asObject(JSON.parse(line.slice("[eshepherd-mapper-runtime] ".length)));
      emit(record);
      if (record.event === "unexpected-tool") unexpected = true;
      if (record.event === "isolation-failure") {
        isolationFailed = true;
        if (typeof record.reason === "string" && /^(mapper-|unsupported-request-budget|model-metadata-unavailable)/.test(record.reason)) configurationReason = record.reason;
      }
      if (record.event === "tool-isolation" && record.activeTools === 0 && record.requestTools === 0) isolated = true;
      if (record.event === "request") {
        try {
          requested = record.provider + "/" + record.model === env.ESHEPHERD_WORKER_MODEL &&
            record.budget === resolveMapperBudget(record.outputLimit, record.contextWindow, env.ESHEPHERD_MAPPER_OUTPUT_TOKENS);
        } catch { requested = false; }
      }
      if (record.event === "worker-failure" && ["empty", "length", "error"].includes(String(record.category))) {
        observedFailure = new WorkerFailure(record.category as "empty" | "length" | "error", true, String(record.finish));
      }
      if (record.event === "provider-completion" && typeof record.finish === "string") {
        const usage: Record<string, number> = {};
        for (const [key, value] of Object.entries(asObject(record.usage))) if (typeof value === "number" && Number.isFinite(value)) usage[key] = value;
        completions.push({ finish: record.finish, usage });
      }
    }
    emit({ event: "process", status: result.status, signal: result.signal, durationMs: Date.now() - started,
      timeoutMs: args.timeoutMs, stdoutPresent: Boolean(result.stdout), stdoutBytes: Buffer.byteLength(result.stdout || "") });
    if (args.runner.kind === "omp" && ompUnexpectedTools(result.stdout || "", emit)) unexpected = true;
    if (unexpected) throw new WorkerFailure("tool-use", false, "toolUse");
    if (isolationFailed) {
      const error = new WorkerFailure("process", false, configurationReason);
      if (configurationReason) error.message = "worker-configuration: " + configurationReason;
      throw error;
    }
    if (observedFailure) throw observedFailure;
    if (result.error) {
      const code = (result.error as NodeJS.ErrnoException).code;
      if (code === "ETIMEDOUT") throw new WorkerFailure("timeout", true);
      if (["ECONNRESET", "ECONNREFUSED", "EPIPE"].includes(code || "")) throw new WorkerFailure("transport", true);
      throw new WorkerFailure("process");
    }
    if (!isolated || !requested) throw new WorkerFailure("process");
    if (!result.stdout?.trim() && result.status === 0) throw new WorkerFailure("empty", true);
    if (completions.length > 1) throw new WorkerFailure("invalid-stream");
    const text = args.runner.kind === "omp" ? ompCompletionText(result.stdout || "", emit) : opencodeCompletionText(result.stdout || "", emit, completions[0]);
    if (result.status !== 0) throw new WorkerFailure("process");
    if (!text.trim()) throw new WorkerFailure("empty", true, "stop");
    return text;
  } finally { rmSync(root, { recursive: true, force: true }); }
}
