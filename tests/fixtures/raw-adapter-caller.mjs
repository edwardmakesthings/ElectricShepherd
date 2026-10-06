import { runSubagent } from '../../src/scripts/memory-pipeline/subagent.ts';
try {
  const content = runSubagent({ runner: { kind: process.env.FIXTURE_RUNNER, bin: process.env.FIXTURE_BIN, standalone: true },
    modelArg: 'custom/fixture-model', prompt: 'Return only the supplied fixture.', mapperRuntime: true,
    timeoutMs: Number(process.env.FIXTURE_TIMEOUT || 20000), workerAttempt: 1 });
  console.log(JSON.stringify({ content }));
} catch (error) {
  console.log(JSON.stringify({ category: error.category, retryable: error.retryable, finish: error.finish }));
}
