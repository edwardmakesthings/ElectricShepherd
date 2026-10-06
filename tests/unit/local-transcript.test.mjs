import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLocalTranscriptOptions } from '../../src/scripts/memory-pipeline/cli-options.ts';
import { loadLocalTranscript } from '../../src/scripts/memory-pipeline/source-loading.ts';
import { digest, preprocessTranscript } from '../../src/scripts/memory-pipeline/chunk-extraction.ts';

const source = () => ({ session: { id: 'ses_offline123', title: 'Offline source-loading test', directory: '/project',
  time: { created: '2026-08-18T23:20:32.941Z', updated: '2026-08-21T06:19:30.421Z' } }, messages: [
  { role: 'user', text: '[Loop Guard] omit this runtime instruction', time: { created: '2099-01-01T00:00:00.000Z' } },
  { role: 'user', text: 'Fix the viewer insertion behavior.', time: { created: '2026-08-18T23:20:33.254Z' } },
  { role: 'assistant', text: 'The change was validated; the later insertion problem remains unresolved.',
    time: { created: '2026-08-19T04:22:14.649Z', completed: '2026-08-19T04:50:35.646Z' } },
] });
function setup(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'es-local-source-'));t.after(() => rmSync(cwd,{recursive:true,force:true}));
  const file = join(cwd,'source.json'), checkpoint = join(cwd,'checkpoint');
  writeFileSync(file,JSON.stringify(source()));return {cwd,file,checkpoint};
}
function run({cwd,file,checkpoint}, extra=[], env={}) {
  return spawnSync(process.execPath,['--experimental-strip-types','--experimental-test-module-mocks',
    fileURLToPath(new URL('../fixtures/local-transcript-caller.mjs',import.meta.url)),
    '--local-transcript-file',file,'--checkpoint-dir',checkpoint,...extra], {
    cwd,encoding:'utf8',timeout:30000,env:{...process.env,ESHEPHERD_TEST_INTEGRATION:'0',
      ESHEPHERD_CONSOLIDATION_MAPPER_MODEL:'opencode-go/deepseek-v4.1-flash',...env},
  });
}
function success(args) { const result=run(args);assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout); }
test('local CLI rejects every non-local write, bulk, triage and alternate pipeline mode',()=>{
  const base=['--local-transcript-file','source.json','--checkpoint-dir','checkpoint'];
  assert.deepEqual(parseLocalTranscriptOptions(base),{file:'source.json',checkpointDirectory:'checkpoint'});
  for(const flag of ['--apply','--only-drawer','--reconsolidate','--all','--all-raw','--full-scope','--reprocess-all',
    '--retry-failed-only','--triage-only','--run-cadence','--include-base-pipeline','--apply-merges',
    '--apply-mem-core','--use-live-auditor','--mapper-summaries-file','--no-live-mapper','--calibration-models'])
    assert.throws(()=>parseLocalTranscriptOptions([...base,flag]),/local-transcript-option-conflict/);
  assert.throws(()=>parseLocalTranscriptOptions(['--local-transcript-file']),/missing-value/);
  assert.throws(()=>parseLocalTranscriptOptions(['--local-transcript-file','source']),/requires-checkpoint/);
  assert.throws(()=>parseLocalTranscriptOptions([...base,'--local-transcript-file','other']),/conflict/);
});
test('local file adapter preserves exact bytes, order, source clocks and policy audit',t=>{
  const {file}=setup(t), loaded=loadLocalTranscript(file), raw=readFileSync(file,'utf8');
  assert.equal(loaded.inventory.parentDrawerId,'opencode://session/ses_offline123');
  assert.equal(loaded.inventory.localSource.sha256,digest(raw));
  assert.equal(loaded.inventory.localSource.bytes,Buffer.byteLength(raw));
  assert.match(loaded.inventory.chunks[0].drawerId,/#local-host-fragment-0$/);
  const {derived,audit}=preprocessTranscript([raw],loaded.inventory);
  assert.equal(audit.retainedCount,2);assert.equal(audit.omittedCount,1);assert.equal(audit.omitted[0].kind,'[Loop Guard]');
  assert.deepEqual(audit.rawHashes,[digest(raw)]);assert.deepEqual(audit.derivedHashes,derived.map(digest));
  assert.equal(audit.sourceChronology[0].sessionTime.updated,source().session.time.updated);
  assert.equal(audit.sourceChronology[0].retainedMessageTimeRange.latest,'2026-08-19T04:50:35.646Z');
  assert.ok(derived[0].indexOf('Fix the viewer')<derived[0].indexOf('The change was validated'));
  assert.ok(!derived[0].includes('omit this runtime instruction'));
});
test('actual CLI local draft uses production prompts and provenance with no substrate or mem-core',t=>{
  const args=setup(t), output=success(args);
  assert.deepEqual(output.readOnly,{substrateInitialized:false,palaceReads:0,palaceWrites:0,memCoreApply:false,capture:false});
  assert.equal(output.extraction.extractionComplete,true);assert.equal(output.drafts.length,1);
  const provenance=output.drafts[0].provenance;
  assert.deepEqual(provenance.localSource,output.localSource);
  assert.deepEqual(provenance.sourceChronology,output.extraction.preprocessing.sourceChronology);
  assert.deepEqual(output.drafts[0].sourceDrawerIds,['opencode://session/ses_offline123']);
  assert.ok(provenance.contributingChunkIds.every(id=>id.startsWith('file:')&&id.includes('local-host-fragment')));
  assert.equal(output.simulatedModelCalls.length,2);
  for(const call of output.simulatedModelCalls){assert.match(call.prompt,/Zinsser/);assert.equal(call.mapperRuntime,true);assert.equal(call.modelArg,'opencode-go,deepseek-v4.1-flash');assert.equal(call.captureEnabled,'false');}
  assert.ok(!output.simulatedModelCalls[0].prompt.includes('omit this runtime instruction'));
  assert.deepEqual(readdirSync(args.cwd).sort(),['checkpoint','source.json']);
});
test('changed local content invalidates versioned caches without erasing prior evidence',t=>{
  const args=setup(t), first=success(args), extractionDir=join(args.checkpoint,'extraction');
  const previous=readdirSync(extractionDir).filter(f=>f.endsWith('.json')).map(f=>[f,readFileSync(join(extractionDir,f),'utf8')]);
  assert.equal(success(args).simulatedModelCalls.length,0);
  const changed=source();changed.messages[2].text+=' Later correction.';writeFileSync(args.file,JSON.stringify(changed));
  const second=success(args);assert.equal(second.simulatedModelCalls.length,2);
  assert.notEqual(first.extraction.sourceVersion,second.extraction.sourceVersion);
  assert.notEqual(first.localSource.sha256,second.localSource.sha256);
  for(const [f,content] of previous)assert.equal(readFileSync(join(extractionDir,f),'utf8'),content);
  assert.equal(readdirSync(extractionDir).filter(f=>f.endsWith('.json')).length,2);
});
test('absent, malformed, non-session and invalid-clock local sources fail before any model',t=>{
  const args=setup(t);
  assert.throws(()=>loadLocalTranscript(join(args.cwd,'absent.json')));
  for(const value of ['{ malformed','{}',JSON.stringify({session:{id:'wrong'},messages:[]}),
    JSON.stringify({...source(),messages:[{role:'tool',text:'not conversation'}]}),
    JSON.stringify({...source(),session:{...source().session,time:{created:'not-a-clock'}}})]){
    writeFileSync(args.file,value);assert.throws(()=>loadLocalTranscript(args.file));
    const result=run(args);assert.notEqual(result.status,0);assert.equal(result.stdout,'');
  }
});
test('local source edits during extraction fail closed instead of emitting stale draft',t=>{
  const args=setup(t), result=run(args,[],{LOCAL_TEST_CHANGE_DURING_RUN:'1'});
  assert.notEqual(result.status,0);assert.match(result.stderr,/local-source-changed-during-run/);assert.equal(result.stdout,'');
});
