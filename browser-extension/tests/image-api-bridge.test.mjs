import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createBridge, decodeImage } from '../bridge/server.mjs';
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=';
const result = { title: 'test', promptZh: '一只猫', promptEn: 'A cat', negativePrompt: 'blur', observations: [], uncertainties: [] };
const settings = { provider: 'openai', baseUrl: 'https://images.example/v1', model: 'image-model', apiKey: 'private-fixture-key' };
const wait = async fn => { for (let i = 0; i < 300; i++) { const value = await fn(); if (value) return value; await new Promise(r => setTimeout(r, 10)); } assert.fail('timeout'); };
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'reframe-image-bridge-'));
  const skillPath = join(dir, 'SKILL.md'); await writeFile(skillPath, 'name: alchemy');
  const reverse = [], generation = [], codex = [], invalidated = [];
  const store = { busy: false, selectedModel: 'text-model', selection: () => ({ model: 'text-model' }), invalidate: async (...args) => invalidated.push(args), close() {} };
  const app = await createBridge({ dataDir: dir, skillPath, generationSkillPath: join(dir, 'absent.md'), models: store, piModels: store,
    cli: { busy: false, status: async () => ({}), close() {} },
    compatibility: { snapshot: () => ({}), getCompatibility: async () => ({ features: { generation: { status: 'unsupported', message: 'Codex unavailable' } } }) },
    agent: args => new Promise((resolve, reject) => { reverse.push({ args, resolve, reject }); args.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }); }),
    apiGenerator: args => new Promise((resolve, reject) => { generation.push({ args, resolve, reject }); args.signal.addEventListener('abort', () => reject(new Error('API 已取消')), { once: true }); }),
    generator: async args => { codex.push(args); return decodeImage(image); } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const request = async (path, body) => { const response = await fetch(`http://127.0.0.1:${app.server.address().port}${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: response.status, body: await response.json() }; };
  t.after(async () => { for (const item of reverse) item.reject(new Error('cleanup')); for (const item of generation) item.reject(new Error('cleanup')); await wait(async () => !(await request('/health')).body.active); app.server.closeAllConnections(); await new Promise(r => app.server.close(r)); await rm(dir, { recursive: true, force: true }); });
  return { dir, reverse, generation, codex, invalidated, request };
}

test('user configures API generation without exposing credentials or requiring Codex image support', async t => {
  // Given legacy settings, When an API is configured, Then only redacted settings return and API generation works without imagegen.
  const s = await setup(t);
  assert.equal((await s.request('/image-settings')).body.provider, 'codex');
  const saved = await s.request('/image-settings', settings);
  assert.equal(saved.status, 200); assert.equal(saved.body.configs.openai.hasApiKey, true);
  assert.ok(!JSON.stringify(saved).includes(settings.apiKey));
  const task = await s.request('/jobs', { image, mode: 'recreate' });
  await wait(() => s.reverse.length); s.reverse[0].resolve(result);
  await wait(async () => !(await s.request('/health')).body.active);
  assert.equal((await s.request(`/jobs/${task.body.id}/generations`, { language: 'en', aspectRatio: { width: 3, height: 2 } })).status, 202);
  await wait(() => s.generation.length);
  assert.equal(s.generation[0].args.settings.apiKey, settings.apiKey);
  assert.equal(s.generation[0].args.imagePath, undefined);
  assert.deepEqual(s.generation[0].args.aspectRatio, { width: 3, height: 2 });
  s.generation[0].resolve(decodeImage(image));
  await wait(async () => !(await s.request('/health')).body.active);
  const job = (await s.request(`/jobs/${task.body.id}`)).body;
  assert.equal(job.generations[0].status, 'completed'); assert.equal(job.generations[0].provider, 'openai');
  assert.equal(job.generations[0].model, settings.model); assert.ok(!JSON.stringify(job).includes(settings.apiKey));
  assert.equal(s.codex.length, 0);
});

test('user changes API settings during reverse while automatic generation retains its accepted snapshot', async t => {
  // Given an accepted flow, When endpoint/key/model changes, Then its generation uses the old complete snapshot.
  const s = await setup(t); await s.request('/image-settings', settings);
  const task = await s.request('/jobs', { image, mode: 'recreate', generation: { language: 'en' } });
  assert.equal(task.status, 202); await wait(() => s.reverse.length);
  assert.equal((await s.request('/image-settings', { ...settings, baseUrl: 'https://new.example/v1', apiKey: 'new-key', model: 'new-image' })).status, 200);
  s.reverse[0].resolve(result); await wait(() => s.generation.length);
  assert.equal(s.generation[0].args.settings.baseUrl, settings.baseUrl);
  assert.equal(s.generation[0].args.settings.apiKey, settings.apiKey);
  assert.equal(s.generation[0].args.settings.model, settings.model);
  const pending = (await s.request(`/jobs/${task.body.id}`)).body;
  await s.request(`/jobs/${task.body.id}/generations/${pending.generations[0].id}/cancel`, {});
  await wait(async () => !(await s.request('/health')).body.active);
  assert.equal(s.generation[0].args.signal.aborted, true);
  assert.equal((await s.request(`/jobs/${task.body.id}`)).body.generations[0].status, 'cancelled');
  assert.equal(s.invalidated.length, 0);
});

test('user queued API batch freezes credentials in memory without persisting them in batch records', async t => {
  // Given more projects than slots, When settings change, Then even queued items retain the accepted API and no task file stores its key.
  const s = await setup(t); await s.request('/image-settings', settings);
  const projects = [];
  for (let i = 0; i < 3; i++) {
    const p = await s.request('/projects', { image: `data:image/jpeg;base64,${Buffer.from([255,216,255,i]).toString('base64')}` });
    projects.push({ projectId: p.body.id, inputRevision: p.body.inputRevision });
  }
  const batch = await s.request('/batches', { requestId: 'image-batch', projects, language: 'en' });
  assert.equal(batch.status, 202); await wait(() => s.reverse.length === 2);
  assert.ok(!(await readFile(join(s.dir, 'records/batches.json'), 'utf8')).includes(settings.apiKey));
  await s.request('/image-settings', { provider: 'gemini', baseUrl: 'https://gemini.example/v1beta', apiKey: 'new-key', model: 'new-model' });
  const retry = await s.request('/batches', { requestId: 'image-batch', projects, language: 'en' });
  assert.equal(retry.body.id, batch.body.id);
  for (let i = 0; i < 3; i++) {
    await wait(() => s.reverse.length > i); s.reverse[i].resolve(result);
    await wait(() => s.generation.length > i); s.generation[i].resolve(decodeImage(image));
  }
  await wait(async () => !(await s.request('/health')).body.active);
  assert.ok(s.generation.every(({ args }) => args.settings.apiKey === settings.apiKey && args.settings.baseUrl === settings.baseUrl));
  assert.ok(!JSON.stringify((await s.request('/batches')).body).includes(settings.apiKey));
  assert.ok(!(await readFile(join(s.dir, 'records/batches.json'), 'utf8')).includes(settings.apiKey));
});

test('user cancels reverse or encounters API failure without starting another paid request', async t => {
  // Given a flow, When reverse is cancelled, Then no API starts; When API fails, Then prompt remains and Codex is never tried.
  const s = await setup(t); await s.request('/image-settings', settings);
  const task = await s.request('/jobs', { image, mode: 'recreate', generation: { language: 'en' } });
  await wait(() => s.reverse.length); await s.request(`/jobs/${task.body.id}/cancel`, {});
  await wait(async () => !(await s.request('/health')).body.active); assert.equal(s.generation.length, 0);
  const next = await s.request('/jobs', { image, mode: 'recreate', generation: { language: 'en' } });
  await wait(() => s.reverse.length === 2); s.reverse[1].resolve(result);
  await wait(() => s.generation.length); s.generation[0].reject(new Error('生图 API 认证失败'));
  await wait(async () => !(await s.request('/health')).body.active);
  const saved = (await s.request(`/jobs/${next.body.id}`)).body;
  assert.equal(saved.status, 'completed'); assert.equal(saved.generations[0].status, 'failed');
  assert.equal(s.generation.length, 1); assert.equal(s.codex.length, 0);
});

test('user cancels queued API batch items and a later batch uses the newly saved channel', async t => {
  // Given a full queue, When its waiting items are cancelled and settings change, Then no cancelled item calls the API and a new batch uses its own snapshot.
  const s = await setup(t); await s.request('/image-settings', settings);
  const projects = [];
  for (let i = 0; i < 3; i++) {
    const p = await s.request('/projects', { image: `data:image/jpeg;base64,${Buffer.from([255,216,255,i]).toString('base64')}` });
    projects.push({ projectId: p.body.id, inputRevision: p.body.inputRevision });
  }
  const batch = await s.request('/batches', { requestId: 'cancel-api-batch', projects, language: 'en' });
  await wait(() => s.reverse.length === 2);
  const cancelled = await s.request(`/batches/${batch.body.id}/cancel`, {});
  assert.equal(cancelled.body.items[2].status, 'cancelled');
  await s.request('/image-settings', { provider: 'gemini', model: 'new-model', apiKey: 'new-fixture-key' });
  s.reverse.forEach(item => item.resolve(result));
  await wait(() => s.generation.length === 2); s.generation.forEach(item => item.resolve(decodeImage(image)));
  await wait(async () => !(await s.request('/health')).body.active);
  assert.equal(s.reverse.length, 2); assert.equal(s.generation.length, 2);
  const next = await s.request('/batches', { requestId: 'new-api-batch', projects: [projects[2]], language: 'en' });
  assert.equal(next.status, 202); await wait(() => s.reverse.length === 3); s.reverse[2].resolve(result);
  await wait(() => s.generation.length === 3);
  assert.equal(s.generation[2].args.settings.imageProvider, 'gemini');
  assert.equal(s.generation[2].args.settings.apiKey, 'new-fixture-key');
  s.generation[2].resolve(decodeImage(image));
});
