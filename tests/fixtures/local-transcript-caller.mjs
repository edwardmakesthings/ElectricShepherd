import { mock } from 'node:test';
import { writeFileSync } from 'node:fs';
const calls = [];
const root = new URL('../../src/', import.meta.url);
async function replace(path, overrides) {
  const url = new URL(path, root), original = await import(url);
  mock.module(url, { namedExports: { ...original, ...overrides } });
}
const forbidden = () => { throw Error('forbidden-local-route-side-effect'); };
globalThis.fetch = forbidden;
await replace('core/substrate-client.ts', { createSubstrateClient: forbidden });
await replace('core/memgraph.ts', { createMemgraphClient: forbidden });
await replace('scripts/consolidation-lock.ts', { acquireConsolidationLock: forbidden });
await replace('scripts/memory-pipeline/coordination.ts', {
  tryAcquireNativeConsolidationLease: forbidden, discoverLiveMCPConfig: forbidden,
});
await replace('scripts/memory-pipeline/memcore-render.ts', { renderAndApplyMemcore: forbidden });
await replace('scripts/memory-pipeline/subagent.ts', {
  resolveSubagentRunner: () => ({ kind: 'opencode', bin: 'offline-simulated-model' }),
  runSubagent: async args => {
    calls.push({ prompt: args.prompt, modelArg: args.modelArg, mapperRuntime: args.mapperRuntime, captureEnabled: process.env.ESHEPHERD_SOURCE_CAPTURE_ENABLED });
    if (process.env.LOCAL_TEST_CHANGE_DURING_RUN === '1') writeFileSync(process.argv[process.argv.indexOf('--local-transcript-file') + 1], '{}');
    return 'The viewer change was validated, but the later insertion problem remains unresolved.';
  },
});
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = text => {
  const output = JSON.parse(text);
  write(JSON.stringify({ ...output, simulatedModelCalls: calls }) + '\n');
  return true;
};
await import('../../src/scripts/run-memory-consolidation-and-validation.ts');
