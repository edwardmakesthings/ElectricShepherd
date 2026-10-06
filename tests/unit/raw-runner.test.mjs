import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { opencodeCompletionText } from '../../src/scripts/memory-pipeline/opencode-completion.ts';
import { prepareRawWorker } from '../../src/scripts/memory-pipeline/raw-runner.ts';
import mapperRuntime from '../../src/scripts/memory-pipeline/omp-mapper-runtime.mjs';
import opencodeRuntime from '../../src/scripts/memory-pipeline/opencode-mapper-runtime.mjs';

process.env.ESHEPHERD_WORKER_MODEL = 'custom/fixture-model';
delete process.env.ESHEPHERD_MAPPER_OUTPUT_TOKENS;

const text = '\n### Unfamiliar title\nA substantive plain-text finding with optional Markdown and no bookkeeping fields.\n';
const event = reason => JSON.stringify({type:'text',part:{text}})+'\n'+JSON.stringify({type:'step_finish',part:{reason,tokens:{input:5,output:12,reasoning:3,cache:{read:0,write:0},total:17}}});
test('OpenCode authoritative raw completion preserves text and rejects length/error/tools/invalid streams',()=>{
  assert.equal(opencodeCompletionText(event('stop'),()=>{}),text);
  for(const reason of ['length','error'])assert.throws(()=>opencodeCompletionText(event(reason),()=>{}),e=>e.category===reason && e.retryable);
  assert.throws(()=>opencodeCompletionText(event('tool-calls'),()=>{}),e=>e.category==='tool-use'&&!e.retryable);
  assert.throws(()=>opencodeCompletionText(event('stop')+'\n'+JSON.stringify({type:'tool_use',part:{type:'tool'}}),()=>{}),e=>e.category==='tool-use');
  assert.throws(()=>opencodeCompletionText('prose',()=>{}),e=>e.category==='invalid-stream');
  assert.throws(()=>opencodeCompletionText(JSON.stringify({type:'text',part:{text}}),()=>{}),e=>e.category==='invalid-stream');
});

test('OMP exact fatal predicates distinguish missing API, disable failure, activation drift and wire contract failures',async()=>{
  for(const [reason,phase,override,payload] of [
    ['missing-isolation-api','session_start',{setActiveTools:undefined},{}],
    ['disable-api-error','session_start',{setActiveTools:async()=>{throw Error('not-logged-secret');}},{}],
    ['get-active-api-error','before_agent_start',{getActiveTools:()=>{throw Error('not-logged-secret');}},{}],
    ['active-tools-after-disable','session_start',{getActiveTools:()=>['mcp-fixture']},{}],
    ['active-tools','before_provider_request',{getActiveTools:()=>['mcp-fixture']},{max_tokens:8192}],
    ['wire-tools','before_provider_request',{}, {max_tokens:8192,tools:[{}]}],
    ['invalid-wire-tools','before_provider_request',{}, {max_tokens:8192,tools:'invalid'}],
    ['mapper-budget-unknown-wire-field','before_provider_request',{}, {noBudget:1}],
  ]){
    const handlers={},records=[];let exits=0;
    const original=process.stderr.write;process.stderr.write=line=>{records.push(JSON.parse(line.slice('[eshepherd-mapper-runtime] '.length)));return true;};
    try{
      mapperRuntime({on:(name,fn)=>handlers[name]=fn,setActiveTools:async()=>{},getActiveTools:()=>[],...override},()=>exits++);
      await handlers[phase]({payload},{model:{provider:'custom',id:'fixture-model',api:'openai-completions',contextWindow:8192,maxTokens:2048}});
    }finally{process.stderr.write=original;}
    assert.equal(exits,1);const fatal=records.find(r=>r.event==='isolation-failure');assert.equal(fatal.reason,reason);assert.equal(fatal.phase,phase);
    assert.ok(!JSON.stringify(records).includes('not-logged-secret'));
  }
});

test('catalog OpenCode providers keep normal authentication without copying ambient configuration', t=>{
  const home=mkdtempSync(join(tmpdir(),'es-catalog-auth-'));t.after(()=>rmSync(home,{recursive:true,force:true}));
  const config=join(home,'.config','opencode');mkdirSync(config,{recursive:true});
  const modelArg='opencode-go/deepseek-v4.1-flash';
  for(const configured of [false,true]){
    if(configured)writeFileSync(join(config,'opencode.jsonc'),JSON.stringify({plugins:['forbidden-plugin'],
      mcp:{servers:{forbidden:{type:'local',command:['/nonexistent']}}},providers:{unrelated:{models:{other:{}}}}}));
    const root=join(home,configured?'configured':'no-config');mkdirSync(root);
    const original={HOME:home,XDG_CONFIG_HOME:join(home,'.config'),XDG_DATA_HOME:join(home,'data'),
      XDG_CACHE_HOME:join(home,'cache'),XDG_STATE_HOME:join(home,'state'),OPENCODE_DB:join(home,'normal.db'),
      OPENCODE_CONFIG_CONTENT:'ambient-policy',OPENCODE_CLI_CONFIG_CONTENT:'ambient-cli',
      OPENCODE_SERVER_URL:'http://shared-server',OPENCODE_SESSION_ID:'ambient-session',
      OPENCODE_TEST_HOME:'ambient-home',OPENCODE_DISABLE_MODELS_FETCH:'true'};
    const plan=prepareRawWorker({runner:{kind:'opencode',bin:'opencode'},modelArg,prompt:'fixture',env:original,timeoutMs:20000},root);
    for(const key of ['HOME','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME','XDG_STATE_HOME','OPENCODE_DB'])assert.equal(plan.env[key],original[key]);
    for(const key of ['OPENCODE_CONFIG_CONTENT','OPENCODE_CLI_CONFIG_CONTENT','OPENCODE_SERVER_URL','OPENCODE_SESSION_ID',
      'OPENCODE_TEST_HOME','OPENCODE_DISABLE_MODELS_FETCH'])assert.equal(plan.env[key],undefined);
    assert.equal(plan.env.OPENCODE_CONFIG_PROJECT_DISABLE,'true');assert.ok(plan.argv.includes('--standalone'));
    const privateConfig=JSON.parse(readFileSync(join(plan.env.OPENCODE_CONFIG_DIR,'opencode.json'),'utf8'));
    assert.equal(privateConfig.model,modelArg);assert.equal(privateConfig.providers,undefined);
    assert.deepEqual(privateConfig.mcp,{servers:{}});assert.equal(privateConfig.plugins.length,1);
    assert.equal(privateConfig.plugins[0],join(root,'runtime-plugin'));
    assert.deepEqual(privateConfig.permissions,[{action:'*',resource:'*',effect:'deny'}]);
    assert.equal(privateConfig.compaction.auto,false);assert.equal(privateConfig.warming,false);
    assert.ok(!JSON.stringify(privateConfig).includes('forbidden'));
    assert.equal(original.OPENCODE_CONFIG_CONTENT,'ambient-policy');
  }
});

test('explicit OpenCode custom providers still reject missing models and malformed configuration', t=>{
  const home=mkdtempSync(join(tmpdir(),'es-custom-provider-'));t.after(()=>rmSync(home,{recursive:true,force:true}));
  const config=join(home,'opencode.jsonc');
  const invocation={runner:{kind:'opencode',bin:'opencode'},modelArg:'custom/missing',prompt:'fixture',
    env:{HOME:home,ESHEPHERD_WORKER_OPENCODE_CONFIG:config},timeoutMs:20000};
  writeFileSync(config,JSON.stringify({providers:{custom:{models:{present:{name:'present'}}}}}));
  assert.throws(()=>prepareRawWorker(invocation,home),e=>e.category==='process');
  writeFileSync(config,'{ malformed');
  assert.throws(()=>prepareRawWorker({...invocation,modelArg:'opencode-go/deepseek-v4.1-flash'},home),e=>e.category==='process');
});

test("OMP scopes any configured compatible provider/model, never an author's catalog", t => {
  const home = mkdtempSync(join(tmpdir(), "es-portable-models-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const agent = join(home, ".omp", "agent"); mkdirSync(agent, { recursive: true });
  const source = join(agent, "models.yml");
  for (const [providerID, modelID] of [["custom", "fixture-model"], ["alternate", "org/small-model"]]) {
    const model = { id: modelID, contextWindow: 8192, maxTokens: 2048 };
    const provider = { api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", apiKey: "fixture-secret", models: [model, { id: "unrelated" }] };
    writeFileSync(source, JSON.stringify({ providers: { [providerID]: provider, unrelated: { models: [{ id: "forbidden" }] } } }));
    const root = join(home, providerID); mkdirSync(root);
    const invocation = { runner: { kind: "omp", bin: "omp" }, modelArg: providerID + "/" + modelID,
      prompt: "fixture", env: { HOME: home }, timeoutMs: 20000 };
    const plan = prepareRawWorker(invocation, root);
    const scoped = JSON.parse(readFileSync(join(plan.env.PI_CODING_AGENT_DIR, "models.yml"), "utf8"));
    assert.deepEqual(scoped, { providers: { [providerID]: { ...provider, models: [model] } } });
    assert.equal(plan.env.ESHEPHERD_WORKER_MODEL, invocation.modelArg);
    assert.ok(plan.argv.includes(invocation.modelArg));
    for (const bad of ["missing", "unsupported", "invalid-limits"]) {
      const badModel = { ...model, id: bad, ...(bad === "unsupported" ? { api: "anthropic-messages" } : {}), ...(bad === "invalid-limits" ? { maxTokens: 0 } : {}) };
      writeFileSync(source, JSON.stringify({ providers: { [providerID]: { ...provider, models: bad === "missing" ? [] : [badModel] } } }));
      assert.throws(() => prepareRawWorker({ ...invocation, modelArg: providerID + "/" + bad }, root), e => e.category === "process" && /models.yml/.test(e.message));
    }
  }
});

test('installed OpenCode and OMP raw adapters use isolated model-only configuration and real zero-tool wire requests', {timeout:180000}, async t=>{
  const root=mkdtempSync(join(tmpdir(),'es-raw-adapters-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const agent=join(root,'.omp','agent'),config=join(root,'.config','opencode');mkdirSync(agent,{recursive:true});mkdirSync(config,{recursive:true});
  // These ambient tools/plugins must NOT be discovered by either adapter.
  writeFileSync(join(agent,'mcp.json'),JSON.stringify({mcpServers:{forbidden:{command:'/nonexistent-mcp-fixture'}}}));
  writeFileSync(join(config,'forbidden-plugin.mjs'),'process.stdout.write("UNEXPECTED_PLUGIN_LOADED");throw Error("ambient-plugin");');
  let scenario='stop';const requests=[];
  const sockets=new Set();
  const server=createServer(async(req,res)=>{
    if(!req.url.endsWith('/chat/completions'))return res.writeHead(404).end();
    let body='';for await(const part of req)body+=part;const payload=JSON.parse(body);requests.push({scenario,payload});
    if(scenario==='timeout')return;
    res.writeHead(200,{'content-type':'text/event-stream'});
    const send=v=>res.write('data: '+JSON.stringify(v)+'\n\n');
    const finish=scenario==='length'?'length':scenario==='error'?'error':scenario==='tool'?'tool_calls':'stop';
    const delta=scenario==='tool'?{tool_calls:[{index:0,id:'fixture',type:'function',function:{name:'read',arguments:'{"path":"never-execute"}'}}]}:{content:scenario==='empty'?'':text};
    send({id:'offline',choices:[{index:0,delta,finish_reason:finish}]});
    send({id:'offline',choices:[],usage:{prompt_tokens:5,completion_tokens:12,total_tokens:17,completion_tokens_details:{reasoning_tokens:3}}});
    res.end('data: [DONE]\n\n');
  });
  server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{for(const socket of sockets)socket.destroy();server.close();});
  const baseURL=`http://127.0.0.1:${server.address().port}/v1`;
  writeFileSync(join(agent,'models.yml'),JSON.stringify({providers:{custom:{api:'openai-completions',apiKey:'offline',baseUrl:baseURL,
    models:[{id:'fixture-model',name:'Offline fixture',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:8192,maxTokens:2048}]}}}));
  writeFileSync(join(config,'opencode.jsonc'),JSON.stringify({plugins:[join(config,'forbidden-plugin.mjs')],mcp:{servers:{forbidden:{type:'local',command:['/nonexistent']}}},
    providers:{custom:{package:'@opencode/ai/providers/openai-compatible',settings:{baseURL,apiKey:'offline'},models:{'fixture-model':{name:'Offline fixture',limit:{context:8192,output:2048}}}}}}));
  for(const kind of ['opencode','omp']){
    const bin=join(homedir(),kind==='opencode'?'.opencode/bin/opencode':'.local/bin/omp');if(!existsSync(bin)){t.diagnostic(`${kind} binary unavailable`);continue;}
    const prepared=join(root,kind+'-prepared');mkdirSync(prepared);
    const plan=prepareRawWorker({runner:{kind,bin},modelArg:'custom/fixture-model',prompt:'fixture',env:{HOME:root},timeoutMs:20000},prepared);
    assert.equal(plan.env.HOME,prepared);assert.ok(!existsSync(join(prepared,'agent','mcp.json')));
    for(scenario of ['stop','length','error','empty','tool','timeout']){
      const before=requests.length;
      const output=await new Promise((resolve,reject)=>{
        const child=spawn(process.execPath,['--experimental-strip-types','tests/fixtures/raw-adapter-caller.mjs'],{cwd:process.cwd(),
          env:{PATH:process.env.PATH,HOME:root,FIXTURE_RUNNER:kind,FIXTURE_BIN:bin,FIXTURE_TIMEOUT:scenario==='timeout'?'3000':'20000'},stdio:['ignore','pipe','pipe']});
        let stdout='',stderr='';const timer=setTimeout(()=>child.kill('SIGKILL'),25000);
        child.stdout.on('data',p=>stdout+=p);child.stderr.on('data',p=>stderr+=p);child.on('error',reject);
        child.on('close',status=>{clearTimeout(timer);resolve({status,stdout,stderr});});
      });
      assert.equal(output.status,0,output.stderr);assert.ok(!output.stdout.includes('UNEXPECTED_PLUGIN_LOADED'));
      const result=JSON.parse(output.stdout.trim());
      if(scenario==='stop')assert.equal(result.content,text,output.stderr);
      else assert.equal(result.category,scenario==='tool'?'tool-use':scenario,output.stderr);
      if(scenario==='tool'){assert.equal(result.retryable,false);assert.ok(!output.stderr.includes('never-execute'));}
      if(scenario!=='timeout'){
        assert.equal(requests.length-before,1,`${kind}/${scenario}: no continuation/native retries\n`+output.stderr);
        const p=requests.at(-1).payload;assert.equal(p.max_tokens??p.max_completion_tokens,2048);assert.ok(!p.tools?.length&&!p.functions?.length);
        assert.match(output.stderr,/"activeTools":0,"requestTools":0/);
      }
    }
    t.diagnostic(`${kind}: stop/length/error/empty/tool/timeout verified on installed binary; zero wire tools, 2048 budget, no ambient plugin/MCP.`);
  }
});

test('OpenCode runtime derives budgets from selected metadata and rejects drift/unsupported wire contracts', async () => {
  const originalExit = process.exit, originalWrite = process.stderr.write;
  const logs = [];
  process.exit = () => { throw Error('worker-exited'); };
  process.stderr.write = line => { logs.push(JSON.parse(line.slice('[eshepherd-mapper-runtime] '.length))); return true; };
  try {
    for (const scenario of ['small', 'override', 'drift', 'missing-limits', 'metadata-error', 'unsupported-wire', 'unsupported-api']) {
      const handlers = {}, identity = { providerID: 'custom', id: 'fixture-model' };
      const limits = scenario === 'missing-limits' ? {} : { context: 8192, output: 2048 };
      await opencodeRuntime.setup({
        tool: { transform: async fn => fn({ list: () => [], remove: () => {} }), hook: async () => {} },
        mcp: { transform: async fn => fn({ list: () => [], remove: () => {} }) },
        model: { list: async () => {
          if (scenario === 'metadata-error') throw Error('not-logged-secret');
          return { data: [{ ...identity, limit: limits }] };
        } },
        session: { hook: async (name, fn) => { handlers[name] = fn; } },
      });
      const event = { model: identity, tools: {}, options: {} };
      if (scenario === 'override') process.env.ESHEPHERD_MAPPER_OUTPUT_TOKENS = '1024';
      else delete process.env.ESHEPHERD_MAPPER_OUTPUT_TOKENS;
      if (scenario === 'drift') event.model = { ...identity, id: 'unexpected' };
      if (['drift', 'missing-limits', 'metadata-error'].includes(scenario)) {
        await assert.rejects(handlers.context(event), /worker-exited/);
        continue;
      }
      await handlers.context(event);
      const budget = scenario === 'override' ? 1024 : 2048;
      assert.equal(event.options.maxTokens, budget);
      const payload = scenario === 'unsupported-wire' ? { max_output_tokens: budget } : { max_tokens: budget };
      const request = { kind: 'primary', model: identity, request: new Request('http://fixture/v1/' + (scenario === 'unsupported-api' ? 'messages' : 'chat/completions'), { method: 'POST', body: JSON.stringify(payload) }) };
      if (['unsupported-wire', 'unsupported-api'].includes(scenario)) await assert.rejects(handlers['http.request'](request), /worker-exited/);
      else {
        await handlers['http.request'](request);
        assert.equal(logs.at(-1).budget, budget);
        assert.equal(logs.at(-1).model, identity.id);
      }
    }
    assert.ok(!JSON.stringify(logs).includes('not-logged-secret'));
    for (const reason of ['mapper-selected-model-mismatch', 'mapper-model-limits-required', 'model-metadata-unavailable', 'unsupported-request-budget', 'mapper-budget-unsupported-api']) {
      assert.ok(logs.some(record => record.reason?.startsWith(reason)), reason);
    }
  } finally {
    process.exit = originalExit; process.stderr.write = originalWrite;
    delete process.env.ESHEPHERD_MAPPER_OUTPUT_TOKENS;
  }
});
