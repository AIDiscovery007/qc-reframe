import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createModelStore, readModelCatalog, verifyModel } from '../bridge/models.mjs';
import { runCodex } from '../bridge/agent.mjs';
import { createBridge } from '../bridge/server.mjs';
import { modelError } from '../bridge/model-context.mjs';

const catalog = { accountKey: 'account-a', provider: 'openai', accountLabel: 'ChatGPT · test', models: [
  { model: 'model-a', label: 'A', isDefault: true, reasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] },
  { model: 'model-b', label: 'B', isDefault: false, reasoningEffort: 'medium' },
] };
async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), 'alchemy-model-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function settled(store) {
  for (let i = 0; i < 100 && store.busy; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(store.busy, false);
  return store.list();
}

test('catalog is not proof of access; only completed verification is saved and survives restart', async t => {
  const dataDir = await directory(t);
  let release;
  const store = await createModelStore({ dataDir, readCatalog: async () => catalog, verify: () => new Promise(r => { release = r; }) });
  assert.throws(() => store.selection(), /选择模型/);
  assert.ok((await store.list()).models.every(m => m.status === 'unverified'));
  await assert.rejects(store.start('unknown'), /当前列表/);
  const pending = await store.start('model-a');
  assert.equal(pending.verification.status, 'running');
  assert.equal(pending.selected, null);
  await assert.rejects(store.start('model-b'), /正在验证/);
  release();
  const done = await settled(store);
  assert.equal(done.selected, 'model-a');
  assert.equal(done.models[0].status, 'verified');
  assert.equal(store.selection().reasoningEffort, 'low');
  const restored = await createModelStore({ dataDir, readCatalog: async () => catalog });
  assert.equal((await restored.list()).selected, 'model-a');
});

test('failed verification preserves the last working model; transient failures do not mark an entitlement denial', async t => {
  const dataDir = await directory(t);
  let failure;
  const store = await createModelStore({ dataDir, readCatalog: async () => catalog, verify: async () => { if (failure) throw failure; } });
  await store.start('model-a'); await settled(store);
  failure = modelError(new Error("The 'model-b' model is not supported when using Codex with a ChatGPT account."), 'model-b');
  await store.start('model-b');
  let state = await settled(store);
  assert.equal(state.selected, 'model-a');
  assert.equal(state.models[1].status, 'unavailable');
  assert.match(state.verification.error, /选择其他模型/);
  failure = new Error('Network offline');
  await store.start('model-a'); state = await settled(store);
  assert.equal(state.selected, 'model-a');
  assert.equal(state.models[0].status, 'verified');
});

test('account changes, disappearing models and real inference denials invalidate saved choices durably', async t => {
  const dataDir = await directory(t);
  let next = catalog;
  const store = await createModelStore({ dataDir, readCatalog: async () => next, verify: async () => {} });
  await store.start('model-a'); await settled(store);
  next = { ...catalog, accountKey: 'account-b' };
  assert.equal((await store.refresh()).selected, null);
  assert.throws(() => store.selection(), /选择模型/);
  assert.equal(JSON.parse(await readFile(join(dataDir, 'model-settings.json'))), null);
  await store.start('model-a'); await settled(store);
  const selection = store.selection();
  await store.invalidate(selection, Object.assign(new Error('denied'), { modelUnavailable: true }));
  assert.throws(() => store.selection(), /选择模型/);
  await store.start('model-b'); await settled(store);
  next = { ...next, models: [] };
  assert.equal((await store.refresh()).selected, null);
  const restored = await createModelStore({ dataDir, readCatalog: async () => next });
  assert.throws(() => restored.selection(), /选择模型/);
});

test('model routes are authenticated, verification blocks inference and shutdown, and selection reaches both pipelines', async t => {
  const dataDir = await directory(t);
  let release;
  const models = await createModelStore({ dataDir, readCatalog: async () => catalog, verify: () => new Promise(r => { release = r; }) });
  const seen = [];
  const skillPath = join(dataDir, 'SKILL.md');
  await writeFile(skillPath, '---\nname: alchemy\n---');
  const app = await createBridge({ dataDir, models, skillPath, generationSkillPath: skillPath, allowShutdown: true,
    agent: async (args) => { seen.push(args.modelSettings); return { title: 'test', promptZh: 'subject', promptEn: 'subject', negativePrompt: '', observations: [], uncertainties: [] }; },
    generator: async (args) => { seen.push(args.modelSettings); return { bytes: Buffer.from('image'), extension: 'png' }; },
  });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(() => { app.server.closeAllConnections(); app.server.close(); });
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const headers = { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' };
  const get = path => fetch(url + path, { headers });
  const post = (path, body = {}) => fetch(url + path, { method: 'POST', headers, body: JSON.stringify(body) });
  const input = { mode: 'recreate', image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=' };
  assert.equal((await fetch(url + '/models')).status, 401);
  assert.equal((await post('/jobs', input)).status, 409);
  const listed = await (await get('/models')).json();
  assert.equal(listed.selected, null);
  assert.ok(!JSON.stringify(listed).includes('accountKey'));
  assert.equal((await post('/models/verify', { model: 'model-a', reasoningEffort: 'ultra' })).status, 400);
  assert.equal((await post('/models/verify', { model: 'model-a', reasoningEffort: 'high' })).status, 202);
  assert.equal((await post('/shutdown')).status, 409);
  assert.equal((await post('/jobs', input)).status, 409);
  release(); await settled(models);
  const job = await (await post('/jobs', input)).json();
  for (let i = 0; i < 100 && (await (await get('/health')).json()).active; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal((await post(`/jobs/${job.id}/generations`, { language: 'zh' })).status, 202);
  for (let i = 0; i < 100 && (await (await get('/health')).json()).active; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(seen.length, 2);
  assert.ok(seen.every(s => s.model === 'model-a' && s.reasoningEffort === 'high'));
  const saved = await (await get(`/jobs/${job.id}`)).json();
  assert.equal(saved.model, 'model-a');
  assert.equal(saved.reasoningEffort, 'high');
  assert.equal(saved.generations[0].model, 'model-a');
  assert.equal(saved.generations[0].reasoningEffort, 'high');
});

test('real RPC transport paginates, filters vision models, overrides model/effort, uses ephemeral probes and rejects changed accounts', async t => {
  const dir = await directory(t);
  const file = join(dir, 'fake-codex');
  const log = join(dir, 'calls.jsonl');
  await writeFile(file, `#!/usr/bin/env node
const fs=require('node:fs'), rl=require('node:readline').createInterface({input:process.stdin});
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
rl.on('line',line=>{const m=JSON.parse(line);fs.appendFileSync(${JSON.stringify(log)},line+'\\n');let result={};
if(m.id===undefined)return;
if(m.method==='account/read')result={account:{type:'chatgpt',email:'test@example.com',planType:'test'},requiresOpenaiAuth:true};
if(m.method==='config/read')result={config:{model:'broken-global',model_provider:'openai',model_reasoning_effort:'ultra'}};
if(m.method==='model/list')result=m.params.cursor?{data:[{model:'vision',displayName:'Vision',defaultReasoningEffort:'low',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}],isDefault:true}],nextCursor:null}:{data:[{model:'text',inputModalities:['text']},{model:'hidden',hidden:true}],nextCursor:'next'};
if(m.method==='thread/start')result={thread:{id:'probe'},model:m.params.model,modelProvider:m.params.modelProvider};
send({id:m.id,result});
if(m.method==='turn/start'){send({method:'item/completed',params:{threadId:'probe',item:{type:'agentMessage',text:'OK'}}});send({method:'turn/completed',params:{threadId:'probe',turn:{status:'completed'}}});}
});
`, { mode: 0o700 });
  const previous = { CODEX_BIN: process.env.CODEX_BIN, CODEX_HOME: process.env.CODEX_HOME };
  process.env.CODEX_BIN = file; process.env.CODEX_HOME = dir;
  t.after(() => { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  const c = await readModelCatalog(dir);
  assert.deepEqual(c.models.map(m => m.model), ['vision']);
  assert.deepEqual(c.models[0].supportedReasoningEfforts.map(o => o.reasoningEffort), ['low', 'high']);
  const selection = { ...c.models[0], reasoningEffort: 'high', accountKey: c.accountKey, provider: c.provider };
  await verifyModel({ cwd: dir, selection });
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map(s => JSON.parse(s));
  const start = calls.find(m => m.method === 'thread/start').params;
  assert.equal(start.model, 'vision');
  assert.equal(start.config.model_reasoning_effort, 'high');
  assert.equal(start.ephemeral, true);
  assert.equal(calls.find(m => m.method === 'turn/start').params.effort, 'high');
  await assert.rejects(runCodex({ cwd: dir, input: [], modelSettings: { ...selection, accountKey: 'changed' } }), /账号、登录或提供方已变化/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runCodex({ cwd: dir, signal: controller.signal, input: [], modelSettings: selection }), /取消/);
});

test('CLI upgrade clears persisted model trust even when refreshing the new catalog fails', async t => {
  const dataDir = await directory(t);
  let fail = false;
  const store = await createModelStore({ dataDir, readCatalog: async () => {
    if (fail) throw new Error('new CLI protocol unavailable');
    return catalog;
  }, verify: async () => {} });
  await store.start('model-a'); await settled(store);
  fail = true;
  await assert.rejects(store.reset(), /protocol unavailable/);
  assert.equal(store.selectedModel, null);
  assert.throws(() => store.selection(), /选择模型/);
  assert.equal(await readFile(join(dataDir, 'model-settings.json'), 'utf8'), 'null');
});


test('custom effort is validated, persisted, restored, and preserved after refresh or failed verification', async t => {
  const dataDir = await directory(t);
  let failure;
  const seen = [];
  const store = await createModelStore({ dataDir, readCatalog: async () => catalog, verify: async ({ selection }) => {
    seen.push(selection); if (failure) throw failure;
  } });
  const listed = await store.list();
  assert.equal(listed.models[0].defaultReasoningEffort, 'low');
  assert.deepEqual(listed.models[0].supportedReasoningEfforts.map(o => o.reasoningEffort), ['low', 'high']);
  for (const effort of ['ultra', '', null, 3, {}]) {
    await assert.rejects(store.start('model-a', effort), { status: 400 });
  }
  assert.equal(seen.length, 0);
  await store.start('model-a', 'high');
  let state = await settled(store);
  assert.equal(state.reasoningEffort, 'high');
  assert.equal(state.verification.reasoningEffort, 'high');
  assert.equal(seen[0].reasoningEffort, 'high');
  assert.equal((await store.refresh()).reasoningEffort, 'high');
  failure = new Error('Network offline');
  await store.start('model-a', 'low');
  state = await settled(store);
  assert.equal(state.verification.status, 'failed');
  assert.equal(state.verification.reasoningEffort, 'low');
  assert.equal(state.reasoningEffort, 'high');
  const restored = await createModelStore({ dataDir, readCatalog: async () => catalog });
  assert.equal((await restored.list()).reasoningEffort, 'high');
  assert.equal(restored.selection().reasoningEffort, 'high');
});

test('legacy catalogs expose only their default effort and old settings stay unchanged', async t => {
  const dataDir = await directory(t);
  const saved = { model: 'model-b', reasoningEffort: 'medium', accountKey: catalog.accountKey, provider: catalog.provider };
  const original = JSON.stringify(saved);
  await writeFile(join(dataDir, 'model-settings.json'), original);
  const store = await createModelStore({ dataDir, readCatalog: async () => catalog, verify: async () => {} });
  const state = await store.list();
  assert.deepEqual(state.models[1].supportedReasoningEfforts, [{ reasoningEffort: 'medium' }]);
  assert.equal(state.reasoningEffort, 'medium');
  await assert.rejects(store.start('model-b', 'high'), { status: 400 });
  assert.equal(await readFile(join(dataDir, 'model-settings.json'), 'utf8'), original);
  await store.start('model-b'); await settled(store);
  assert.equal(store.selection().reasoningEffort, 'medium');
});


test('unsupported effort preserves the same model and original diagnostic; real model denial still invalidates', async t => {
  const dataDir = await directory(t);
  let failure;
  const store = await createModelStore({ dataDir, readCatalog: async () => catalog, verify: async () => {
    if (failure) throw modelError(new Error(failure), 'model-a');
  } });
  await store.start('model-a', 'low'); await settled(store);
  const original = await readFile(join(dataDir, 'model-settings.json'), 'utf8');
  for (const message of [
    "Unsupported reasoning effort 'high' for model 'model-a'",
    "Invalid reasoning_effort 'high': model 'model-a' does not support this value",
    "This model does not support reasoning.effort 'high'",
  ]) {
    failure = message;
    await store.start('model-a', 'high');
    const state = await settled(store);
    assert.equal(state.selected, 'model-a');
    assert.equal(state.reasoningEffort, 'low');
    assert.equal(state.models[0].status, 'verified');
    assert.equal(state.verification.status, 'failed');
    assert.equal(state.verification.error, message);
    assert.equal(await readFile(join(dataDir, 'model-settings.json'), 'utf8'), original);
  }
  failure = "The 'model-a' model is not supported when using Codex with a ChatGPT account.";
  await store.start('model-a', 'high');
  const denied = await settled(store);
  assert.equal(denied.selected, null);
  assert.equal(denied.models[0].status, 'unavailable');
  assert.equal(await readFile(join(dataDir, 'model-settings.json'), 'utf8'), 'null');
});
