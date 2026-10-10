import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createBridge, decodeImage } from '../bridge/server.mjs';
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=';
const result = { title: 'test', promptZh: '一只猫', promptEn: 'A cat', negativePrompt: '', observations: [], uncertainties: [] };
const wait = async fn => { for (let i = 0; i < 200; i++) { const value = await fn(); if (value) return value; await new Promise(r => setTimeout(r, 10)); } assert.fail('timeout'); };
async function setup(t, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'reframe-agent-bridge-'));
  const skillPath = join(dir, 'SKILL.md'); await writeFile(skillPath, 'name: alchemy');
  const reverse = [], generation = [], features = [], invalidated = [];
  const modelStore = (provider, model) => ({ busy: false, selectedModel: model, selection: () => ({ provider, model, reasoningEffort: 'high' }), list: async () => ({ selected: model }), refresh: async () => ({ selected: model }), invalidate: async (...args) => invalidated.push(args), close() {} });
  const models = modelStore('openai', 'codex-model'), piModels = modelStore('pi-provider', 'pi-model');
  const context = { provider: 'openai', model: 'codex-model', reasoningEffort: 'high', accountKey: 'fixture', codexGeneration: true };
  let unsupported = false, piUpdates = 0;
  const options = { dataDir: dir, skillPath, generationSkillPath: skillPath, models, piModels,
    generationContext: async () => ({ ...context }),
    cli: { busy: false, status: async () => ({}), close() {} },
    piCli: { busy: false, status: async () => ({}), update: async () => { piUpdates++; return {}; }, close() {} },
    compatibility: { snapshot: () => ({}), getCompatibility: async () => { features.push('codex'); return unsupported ? { features: { reverse: { status: 'unsupported', message: 'Codex reverse unavailable' } } } : {}; } },
    agent: args => new Promise((resolve, reject) => { reverse.push({ args, resolve, reject }); args.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }); }),
    generator: async args => { generation.push(args); return decodeImage(image); }, ...overrides };
  let app = await createBridge(options);
  const listen = async () => { app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening'); }; await listen();
  const request = async (path, body, signal) => { const response = await fetch(`http://127.0.0.1:${app.server.address().port}${path}`, { signal, method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: response.status, body: await response.json() }; };
  const close = async () => { app.server.closeAllConnections(); await new Promise(r => app.server.close(r)); await new Promise(r => setTimeout(r, 30)); };
  t.after(async () => { await close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, reverse, generation, models, piModels, context, invalidated, request, piUpdates: () => piUpdates, unsupported: () => { unsupported = true; }, restart: async () => { await close(); app = await createBridge(options); await listen(); } };
}

test('user runs Pi reverse with frozen settings and independent Codex auto generation', async t => {
  // Given Pi selected, When the two-stage task is submitted, Then both configurations are frozen separately.
  const s = await setup(t);
  assert.equal((await s.request('/agents/select', { agent: 'pi' })).status, 200);
  s.unsupported();
  assert.equal((await s.request('/models?agent=pi')).body.selected, 'pi-model');
  const task = await s.request('/jobs', { image, mode: 'recreate', generation: { language: 'en' } });
  assert.equal(task.status, 202);
  await wait(() => s.reverse.length);
  assert.deepEqual(s.reverse[0].args.modelSettings, { agent: 'pi', provider: 'pi-provider', model: 'pi-model', reasoningEffort: 'high' });
  assert.equal((await s.request('/agents/select', { agent: 'codex' })).status, 409);
  assert.equal((await s.request('/cli/update?agent=pi', {})).status, 409);
  assert.equal(s.piUpdates(), 0, 'running Pi keeps its installation until the task finishes');
  s.models.selection = () => ({ model: 'changed-codex' });
  s.context.model = 'changed-cli-model';
  s.piModels.selection = () => ({ model: 'changed-pi' });
  s.reverse[0].resolve(result);
  await wait(async () => !(await s.request('/health')).body.active);
  assert.equal((await s.request('/cli/update?agent=pi', {})).status, 202);
  assert.equal(s.piUpdates(), 1);
  assert.equal(s.generation[0].modelSettings.model, 'codex-model');
  const saved = (await s.request(`/jobs/${task.body.id}`)).body;
  assert.equal(saved.agent, 'pi'); assert.equal(saved.provider, 'pi-provider'); assert.equal(saved.model, 'pi-model');
  assert.equal(saved.generations[0].model, 'codex-model');
  await s.restart(); assert.equal((await s.request('/agents')).body.selected, 'pi');
});

test('user cancels Pi reverse without starting generation or silently falling back', async t => {
  // Given a running Pi task, When cancelled, Then Pi receives abort and generation never starts.
  const s = await setup(t); await s.request('/agents/select', { agent: 'pi' });
  const task = await s.request('/jobs', { image, mode: 'recreate', generation: { language: 'zh' } });
  await wait(() => s.reverse.length);
  await s.request(`/jobs/${task.body.id}/cancel`, {});
  await wait(async () => !(await s.request('/health')).body.active);
  assert.equal(s.reverse[0].args.signal.aborted, true); assert.equal(s.generation.length, 0);
  assert.equal((await s.request(`/jobs/${task.body.id}`)).body.status, 'cancelled');
  const failure = await s.request('/jobs', { image, mode: 'recreate' });
  await wait(() => s.reverse.length === 2); s.reverse[1].reject(new Error('Pi CLI missing'));
  await wait(async () => !(await s.request('/health')).body.active);
  assert.equal((await s.request(`/jobs/${failure.body.id}`)).body.status, 'failed');
  assert.equal(s.reverse.length, 2);
});

test('user queued batch keeps Pi and Codex snapshots after current settings change', async t => {
  // Given more jobs than flow slots, When settings change externally, Then queued work retains both snapshots.
  const s = await setup(t); await s.request('/agents/select', { agent: 'pi' });
  const projects = [];
  for (let i = 0; i < 3; i++) {
    const p = await s.request('/projects', { image: `data:image/jpeg;base64,${Buffer.from([255,216,255,i]).toString('base64')}` });
    projects.push({ projectId: p.body.id, inputRevision: p.body.inputRevision });
  }
  const batch = await s.request('/batches', { requestId: 'pi-batch', projects, language: 'en' });
  assert.equal(batch.status, 202); await wait(() => s.reverse.length === 2);
  s.models.selection = () => ({ model: 'changed-codex' }); s.piModels.selection = () => ({ model: 'changed-pi' });
  s.context.model = 'changed-cli-model';
  s.reverse[0].resolve(result); s.reverse[1].resolve(result);
  await wait(() => s.reverse.length === 3);
  assert.equal(s.reverse[2].args.modelSettings.agent, 'pi'); assert.equal(s.reverse[2].args.modelSettings.model, 'pi-model');
  s.reverse[2].resolve(result); await wait(async () => !(await s.request('/health')).body.active);
  assert.ok(s.generation.every(args => args.modelSettings.model === 'codex-model'));
  const saved = JSON.parse(await readFile(join(s.dir, 'records/batches.json')));
  assert.equal(saved[0].modelSettings.agent, 'pi'); assert.equal(saved[0].generationModelSettings.model, 'codex-model');
});

test('user with only Pi verified can submit manual and automatic Codex generation without text model validation', async t => {
  // Given no Codex text selection, When Pi completes prompts, Then both image paths use independent CLI snapshots.
  const s = await setup(t); await s.request('/agents/select', { agent: 'pi' });
  s.models.selectedModel = null;
  s.models.selection = () => { throw Object.assign(new Error('文字模型未验证'), { status: 409 }); };
  const health = (await s.request('/health')).body;
  const manual = await s.request('/jobs', { image, mode: 'recreate' });
  await wait(() => s.reverse.length); s.reverse[0].resolve(result);
  await wait(async () => !(await s.request('/health')).body.active);
  assert.equal((await s.request(`/jobs/${manual.body.id}/generations`, { language: 'en' })).status, 202);
  await wait(async () => !(await s.request('/health')).body.active);
  const auto = await s.request('/jobs', { image, mode: 'recreate', generation: { language: 'en' } });
  assert.equal(auto.status, 202); await wait(() => s.reverse.length === 2); s.reverse[1].resolve(result);
  await wait(async () => !(await s.request('/health')).body.active);
  assert.equal(health.generationReady, true); assert.equal(health.generationModel, null);
  assert.equal(s.generation.length, 2);
  assert.ok(s.generation.every(args => args.modelSettings.codexGeneration && args.modelSettings.model === 'codex-model'));
});

test('user image failure does not revoke the independently verified reverse model', async t => {
  // Given a valid reverse selection, When an image execution fails, Then its prompt and reverse trust remain intact with no fallback.
  let calls = 0;
  const s = await setup(t, { generator: async () => { calls++; throw Object.assign(new Error('Codex 内置生图：执行模型不可用'), { modelUnavailable: true, recovery: 'cli' }); } });
  const task = await s.request('/jobs', { image, mode: 'recreate', generation: { language: 'en' } });
  await wait(() => s.reverse.length); s.reverse[0].resolve(result);
  await wait(async () => !(await s.request('/health')).body.active);
  const job = (await s.request(`/jobs/${task.body.id}`)).body;
  assert.equal(job.status, 'completed'); assert.equal(job.generations[0].status, 'failed'); assert.equal(job.generations[0].recovery, 'cli');
  assert.deepEqual(s.invalidated, []); assert.equal(s.models.selectedModel, 'codex-model'); assert.equal(calls, 1);
});

for (const kind of ['manual', 'automatic', 'batch']) test(`user disconnects during ${kind} image context lookup without starting a task`, async t => {
  // Given a pending read-only CLI lookup, When the submitting connection closes, Then late context cannot start reverse or image work.
  let pending;
  const s = await setup(t, { generationContext: ({ signal }) => new Promise(resolve => { pending = { signal, resolve }; }) });
  await s.request('/agents/select', { agent: 'pi' });
  let path = '/jobs', body = { image, mode: 'recreate', generation: { language: 'en' } };
  if (kind === 'manual') {
    const job = await s.request('/jobs', { image, mode: 'recreate' });
    await wait(() => s.reverse.length); s.reverse[0].resolve(result);
    await wait(async () => !(await s.request('/health')).body.active);
    path = `/jobs/${job.body.id}/generations`; body = { language: 'en' };
  }
  if (kind === 'batch') {
    const p = (await s.request('/projects', { image })).body;
    path = '/batches'; body = { requestId: 'aborted-context', projects: [{ projectId: p.id, inputRevision: p.inputRevision }], language: 'en' };
  }
  const controller = new AbortController(), running = s.request(path, body, controller.signal);
  const rejected = assert.rejects(running, { name: 'AbortError' });
  await wait(() => pending); controller.abort(); await rejected; await wait(() => pending.signal.aborted);
  pending.resolve({ ...s.context });
  // This mutation waits behind the setup lock, proving the rejected preparation has settled.
  assert.equal((await s.request('/agents/select', { agent: 'pi' })).status, 200);
  assert.equal(s.reverse.length, kind === 'manual' ? 1 : 0); assert.equal(s.generation.length, 0);
  assert.equal((await s.request('/health')).body.active, 0);
  if (kind === 'batch') assert.deepEqual((await s.request('/batches')).body, []);
});
