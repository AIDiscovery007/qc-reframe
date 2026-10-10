import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as context from '../bridge/model-context.mjs';
import { readGenerationSettings } from '../bridge/generation.mjs';
import { runCodex } from '../bridge/agent.mjs';

async function fixture(t, config = {}, pages = [{ data: [] }]) {
  const dir = await mkdtemp(join(tmpdir(), 'reframe-generation-context-'));
  const previous = process.env.CODEX_HOME; process.env.CODEX_HOME = dir;
  t.after(async () => { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; await rm(dir, { recursive: true, force: true }); });
  const calls = []; let page = 0;
  const state = { config, account: { type: 'chatgpt', email: 'fixture@example.test' } };
  const request = async method => {
    calls.push(method);
    if (method === 'account/read') return { account: state.account, requiresOpenaiAuth: true };
    if (method === 'config/read') return { config: state.config };
    if (method === 'model/list') return pages[Math.min(page++, pages.length - 1)];
    throw new Error(`unexpected request ${method}`);
  };
  return { dir, state, calls, request, resolve: () => context.readGenerationContext(request, dir) };
}

test('user uses an explicit CLI model without a text verification or directory lookup', async t => {
  // Given a custom CLI model absent from any catalog, When generation is prepared, Then exactly that model/provider/effort is frozen.
  const s = await fixture(t, { model: 'custom-vision', model_provider: 'custom', model_reasoning_effort: 'high' });
  const selected = await s.resolve();
  assert.equal(selected.model, 'custom-vision'); assert.equal(selected.provider, 'custom'); assert.equal(selected.reasoningEffort, 'high');
  assert.equal(selected.codexGeneration, true); assert.ok(selected.accountKey);
  assert.deepEqual(s.calls, ['account/read', 'config/read']);
});

test('user without an explicit CLI model uses only the unique declared default across all pages', async t => {
  // Given a paginated directory, When one default exists, Then it wins over the first entry and supplies the default effort.
  const s = await fixture(t, {}, [{ data: [{ model: 'first' }], nextCursor: 'next' }, { data: [{ model: 'default', isDefault: true, defaultReasoningEffort: 'low' }] }]);
  const selected = await s.resolve(); assert.equal(selected.model, 'default'); assert.equal(selected.reasoningEffort, 'low');
  assert.equal(s.calls.filter(m => m === 'model/list').length, 2);
});

for (const [label, config, pages] of [
  ['no default', {}, [{ data: [{ model: 'first' }] }]],
  ['ambiguous defaults', {}, [{ data: [{ model: 'a', isDefault: true }, { model: 'b', isDefault: true }] }]],
  ['invalid explicit model', { model: ' ' }, [{ data: [{ model: 'default', isDefault: true }] }]],
  ['repeated cursor', {}, [{ data: [], nextCursor: 'same' }]],
]) test(`user receives a clear error instead of an arbitrary model when ${label}`, async t => {
  // Given unresolved CLI configuration, When generation is prepared, Then it fails with a Codex recovery target without inference.
  const s = await fixture(t, config, pages);
  await assert.rejects(s.resolve(), error => /Codex 内置生图/.test(error.message) && error.recovery === 'cli');
  assert.ok(!s.calls.includes('turn/start'));
});

test('user queued generation keeps its model but rejects changed account or provider context', async t => {
  // Given an accepted snapshot, When CLI model changes, Then its model remains; When account/provider changes, Then execution is rejected.
  const s = await fixture(t, { model: 'original', model_reasoning_effort: 'high' });
  const selected = await s.resolve(); s.state.config.model = 'later';
  await context.assertModelContext(s.request, s.dir, selected);
  assert.equal(selected.model, 'original'); assert.equal(selected.reasoningEffort, 'high');
  s.state.account = { type: 'chatgpt', email: 'changed@example.test' };
  await assert.rejects(context.assertModelContext(s.request, s.dir, selected), { modelContextChanged: true });
  s.state.account = { type: 'chatgpt', email: 'fixture@example.test' }; s.state.config.model_provider = 'changed';
  await assert.rejects(context.assertModelContext(s.request, s.dir, selected), { modelContextChanged: true });
});

test('user must still log in for built-in generation', async t => {
  // Given missing required authentication, When resolving an image task, Then no default model is substituted and recovery points to Codex.
  const s = await fixture(t, { model: 'configured' }); s.state.account = null;
  await assert.rejects(s.resolve(), error => /Codex 内置生图.*登录/.test(error.message) && !/验证|刷新模型/.test(error.message) && error.recovery === 'cli');
});

test('user queued generation cannot inherit a newly configured effort when its snapshot had no explicit effort', async t => {
  // Given CLI/model defaults supplied no effort, When a later global effort appears, Then execution rejects drift instead of silently adopting it.
  const s = await fixture(t, { model: 'custom' }), selected = await s.resolve();
  await context.assertModelContext(s.request, s.dir, selected);
  s.state.config.model_reasoning_effort = 'high';
  await assert.rejects(context.assertModelContext(s.request, s.dir, selected), { modelContextChanged: true });
});

async function rpcFixture(t) {
  const s = await fixture(t), path = join(s.dir, 'state.json'), log = join(s.dir, 'calls.jsonl'), binary = join(s.dir, 'codex');
  const previous = process.env.CODEX_BIN; process.env.CODEX_BIN = binary;
  t.after(() => { if (previous === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = previous; });
  const state = { config: { model: 'cli-model', model_reasoning_effort: 'high' }, account: { type: 'chatgpt', email: 'fixture@example.test' }, capable: true };
  const save = () => writeFile(path, JSON.stringify(state)); await save();
  await writeFile(binary, `#!/usr/bin/env node
const fs=require('node:fs'), send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);fs.appendFileSync(${JSON.stringify(log)},line+'\\n'); if(m.id===undefined)return;
 const s=JSON.parse(fs.readFileSync(${JSON.stringify(path)}));let result={};
 if(m.method==='account/read')result={account:s.account,requiresOpenaiAuth:true};
 if(m.method==='config/read')result={config:s.config};
 if(m.method==='model/list'){if(s.hang)return;result={data:[{model:'default',isDefault:true}]};}
 if(m.method==='modelProvider/capabilities/read')result={imageGeneration:s.capable};
 if(m.method==='thread/start'){
  if(s.unavailable){send({id:m.id,error:{code:-1,message:'model not available'}});return;}
  result={thread:{id:'image'},model:s.substitute||m.params.model,modelProvider:m.params.modelProvider};
 }
 send({id:m.id,result});
 if(m.method==='turn/start'){send({method:'item/completed',params:{threadId:'image',item:{type:'agentMessage',text:'OK'}}});send({method:'turn/completed',params:{threadId:'image',turn:{status:'completed'}}});}
});
`, { mode: 0o700 });
  const calls = async () => (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse);
  return { ...s, state, save, calls, resolve: signal => readGenerationSettings({ cwd: s.dir, signal }) };
}

test('user generates through the actual RPC transport using the accepted CLI snapshot without a text probe', async t => {
  // Given an accepted config, When CLI model/effort changes, Then thread/turn still receive the old snapshot and preparation has no inference.
  const s = await rpcFixture(t); const modelSettings = await s.resolve();
  assert.ok(!(await s.calls()).some(m => ['thread/start', 'turn/start'].includes(m.method)));
  s.state.config.model = 'later'; s.state.config.model_reasoning_effort = 'low'; await s.save();
  await runCodex({ cwd: s.dir, input: [], generation: true, modelSettings });
  const calls = await s.calls(), start = calls.find(m => m.method === 'thread/start').params, turn = calls.find(m => m.method === 'turn/start').params;
  assert.equal(start.model, 'cli-model'); assert.equal(start.config.model_reasoning_effort, 'high');
  assert.equal(turn.model, 'cli-model'); assert.equal(turn.effort, 'high');
  assert.equal(calls.filter(m => m.method === 'turn/start').length, 1);
});

for (const failure of ['account', 'provider', 'capability', 'model', 'substitution']) test(`user gets Codex recovery with no image turn after ${failure} failure`, async t => {
  // Given a frozen image context, When its authorization/capability/model fails, Then the task stops without falling back or requesting text verification.
  const s = await rpcFixture(t), modelSettings = await s.resolve();
  if (failure === 'account') s.state.account = { type: 'chatgpt', email: 'other@example.test' };
  if (failure === 'provider') s.state.config.model_provider = 'other';
  if (failure === 'capability') s.state.capable = false;
  if (failure === 'model') s.state.unavailable = true;
  if (failure === 'substitution') s.state.substitute = 'unexpected';
  await s.save();
  await assert.rejects(runCodex({ cwd: s.dir, input: [], generation: true, modelSettings }), error => /Codex 内置生图/.test(error.message) && !/验证|刷新模型/.test(error.message) && error.recovery === 'cli');
  assert.ok(!(await s.calls()).some(m => m.method === 'turn/start'));
});

test('user cancels CLI context resolution before any inference begins', { timeout: 10_000 }, async t => {
  // Given a pending default directory, When its submission aborts, Then the RPC child stops without starting an image turn.
  const s = await rpcFixture(t); s.state.config = {}; s.state.hang = true; await s.save();
  const controller = new AbortController(), running = s.resolve(controller.signal);
  t.after(() => controller.abort());
  const rejected = assert.rejects(running, /取消/);
  while (!(await s.calls()).some(m => m.method === 'model/list')) {
    t.signal.throwIfAborted();
    await new Promise(r => setTimeout(r, 10));
  }
  assert.ok((await s.calls()).some(m => m.method === 'model/list')); controller.abort(); await rejected;
  assert.ok(!(await s.calls()).some(m => m.method === 'turn/start'));
});
