import fs from 'node:fs';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { syncBuiltinESMExports } from 'node:module';
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
async function setup(t, magpieInspector = async () => ({ version: "test", models: [{ id: "fixture/image" }] })) {
  const dir = await mkdtemp(join(tmpdir(), 'reframe-image-bridge-'));
  const skillPath = join(dir, 'SKILL.md'); await writeFile(skillPath, 'name: alchemy');
  const reverse = [], generation = [], codex = [], invalidated = [];
  const store = { busy: false, selectedModel: 'text-model', selection: () => ({ model: 'text-model' }), invalidate: async (...args) => invalidated.push(args), close() {} };
  const options = { magpieInspector, dataDir: dir, skillPath, generationSkillPath: join(dir, 'absent.md'), models: store, piModels: store,
    cli: { busy: false, status: async () => ({}), close() {} },
    compatibility: { snapshot: () => ({}), getCompatibility: async () => ({ features: { generation: { status: 'unsupported', message: 'Codex unavailable' } } }) },
    agent: args => new Promise((resolve, reject) => { reverse.push({ args, resolve, reject }); args.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }); }),
    apiGenerator: args => new Promise((resolve, reject) => { generation.push({ args, resolve, reject }); args.signal.addEventListener('abort', () => reject(new Error('API 已取消')), { once: true }); }),
    generator: async args => { codex.push(args); return decodeImage(image); } };
  let app = await createBridge(options);
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const request = async (path, body, signal) => { const response = await fetch(`http://127.0.0.1:${app.server.address().port}${path}`, { signal, method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: response.status, body: await response.json() }; };
  t.after(async () => { for (const item of reverse) item.reject(new Error('cleanup')); for (const item of generation) item.reject(new Error('cleanup')); await wait(async () => !(await request('/health')).body.active); app.server.closeAllConnections(); await new Promise(r => app.server.close(r)); await rm(dir, { recursive: true, force: true }); });
  return { dir, reverse, generation, codex, invalidated, request, restart: async () => {
    await wait(async () => !(await request('/health')).body.active);
    app.server.closeAllConnections(); await new Promise(r => app.server.close(r));
    await new Promise(r => setTimeout(r, 50));
    app = await createBridge(options); app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  } };
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

const magpie = { provider: 'magpie', baseUrl: 'http://127.0.0.1:3425', model: 'fixture/image' };
test('user using Magpie needs no provider key and freezes a manual request with default size and output metadata', async t => {
  // Given a keyless Magpie source, When a manual request finishes after settings change, Then its original source and output metadata remain.
  const s = await setup(t);
  assert.equal((await s.request('/image-models', { baseUrl: magpie.baseUrl })).body.models[0].id, magpie.model);
  assert.equal((await s.request('/image-settings', magpie)).status, 200);
  assert.equal((await s.request('/health')).body.generationReady, true);
  const task = await s.request('/jobs', { image, mode: 'recreate' });
  await wait(() => s.reverse.length); s.reverse[0].resolve(result);
  await wait(async () => !(await s.request('/health')).body.active);
  assert.equal((await s.request(`/jobs/${task.body.id}/generations`, { language: 'en' })).status, 202);
  await wait(() => s.generation.length);
  await s.request('/image-settings', settings);
  assert.equal(s.generation[0].args.settings.provider, 'magpie');
  assert.equal(s.generation[0].args.settings.apiKey, undefined);
  assert.equal(s.generation[0].args.aspectRatio, undefined);
  s.generation[0].resolve({ ...decodeImage(image), gatewayReportedModel: 'resolved/image', outputSize: { width: 1, height: 1 } });
  await wait(async () => !(await s.request('/health')).body.active);
  const saved = (await s.request(`/jobs/${task.body.id}`)).body.generations[0];
  assert.equal(saved.status, 'completed'); assert.equal(saved.provider, 'magpie');
  assert.equal(saved.model, magpie.model); assert.equal(saved.sizeMode, 'gateway-default');
  assert.equal(saved.gatewayReportedModel, 'resolved/image'); assert.deepEqual(saved.outputSize, { width: 1, height: 1 });
  assert.equal(s.codex.length, 0);
});
test('user rejects incompatible Magpie dimensions before catalog or model calls', async t => {
  // Given invalid dimensions or aspectRatio, When starting manual, automatic or batch generation, Then no model or catalog is called.
  let inspected = 0;
  const s = await setup(t, async () => { inspected++; throw new Error('must not inspect'); }); await s.request('/image-settings', magpie);
  const project = (await s.request('/projects', { image })).body;
  const task = await s.request('/jobs', { image, mode: 'recreate' });
  await wait(() => s.reverse.length); s.reverse[0].resolve(result); await wait(async () => !(await s.request('/health')).body.active);
  for (const size of [{ aspectRatio: { width: 1, height: 1 } }, { imageSize: null }, { imageSize: { width: 0, height: 20 } }, { imageSize: { width: 10000, height: 4001 } }]) {
    assert.equal((await s.request(`/jobs/${task.body.id}/generations`, { language: 'en', ...size })).status, 400);
    assert.equal((await s.request('/jobs', { image, mode: 'recreate', generation: { language: 'en', ...size } })).status, 400);
    assert.equal((await s.request('/batches', { requestId: 'invalid-size', language: 'en', projects: [{ projectId: project.id, inputRevision: project.inputRevision }], ...size })).status, 400);
  }
  assert.equal(inspected, 0); assert.equal(s.reverse.length, 1); assert.equal(s.generation.length, 0);
  await s.request('/image-settings', settings);
  assert.equal((await s.request(`/jobs/${task.body.id}/generations`, { language: 'en', imageSize: { width: 640, height: 480 } })).status, 400);
});
test('user using Magpie refuses models absent from the image catalog without fallback', async t => {
  // Given a removed model, When generation is requested, Then the user receives a recoverable refusal without fallback.
  const s = await setup(t, async () => ({ version: 'test', models: [] })); await s.request('/image-settings', magpie);
  const task = await s.request('/jobs', { image, mode: 'recreate' });
  await wait(() => s.reverse.length); s.reverse[0].resolve(result); await wait(async () => !(await s.request('/health')).body.active);
  assert.equal((await s.request(`/jobs/${task.body.id}/generations`, { language: 'en' })).status, 409);
  assert.equal(s.generation.length, 0); assert.equal(s.codex.length, 0);
});

test('user disconnects while Magpie catalog is pending without starting generation', async t => {
  // Given a pending catalog check, When the submission disconnects, Then its cancellation prevents generation.
  let inspecting;
  const s = await setup(t, ({ signal }) => new Promise((resolve, reject) => {
    inspecting = { signal, resolve }; signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { status: 499 })), { once: true });
  }));
  await s.request('/image-settings', magpie);
  const task = await s.request('/jobs', { image, mode: 'recreate' });
  await wait(() => s.reverse.length); s.reverse[0].resolve(result); await wait(async () => !(await s.request('/health')).body.active);
  const controller = new AbortController();
  const submission = s.request(`/jobs/${task.body.id}/generations`, { language: 'en' }, controller.signal).catch(error => error);
  await wait(() => inspecting); controller.abort(); await submission;
  await wait(() => inspecting.signal.aborted);
  assert.equal(s.generation.length, 0); assert.equal(s.codex.length, 0);
  assert.equal((await s.request(`/jobs/${task.body.id}`)).body.generations?.length || 0, 0);
});
test('user cancels Magpie or receives a provider failure without losing the prompt or retrying elsewhere', async t => {
  // Given a completed prompt, When generation is cancelled or fails, Then terminal state persists and another model is never started.
  const s = await setup(t); await s.request('/image-settings', magpie);
  const task = await s.request('/jobs', { image, mode: 'recreate' });
  await wait(() => s.reverse.length); s.reverse[0].resolve(result); await wait(async () => !(await s.request('/health')).body.active);
  const started = await s.request(`/jobs/${task.body.id}/generations`, { language: 'en' }); await wait(() => s.generation.length);
  const id = started.body.generations[0].id;
  await s.request(`/jobs/${task.body.id}/generations/${id}/cancel`, {}); await wait(async () => !(await s.request('/health')).body.active);
  assert.equal(s.generation[0].args.signal.aborted, true);
  assert.equal((await s.request(`/jobs/${task.body.id}`)).body.generations[0].status, 'cancelled');
  await s.request(`/jobs/${task.body.id}/generations`, { language: 'en' }); await wait(() => s.generation.length === 2);
  s.generation[1].reject(new Error('gateway failed')); await wait(async () => !(await s.request('/health')).body.active);
  const job = (await s.request(`/jobs/${task.body.id}`)).body;
  assert.equal(job.status, 'completed'); assert.deepEqual(job.result, result); assert.equal(job.generations[1].status, 'failed');
  assert.equal(s.generation.length, 2); assert.equal(s.codex.length, 0);
});

for (const imageSize of [undefined, { width: 1337, height: 911 }]) test(`user runs Magpie ordered multi-image generation with ${imageSize ? 'explicit pixels' : 'auto size'}`, async t => {
  // Given a text-only catalog entry and saved ordered subjects, When generating, Then references remain attached and requested/output sizes remain separate.
  const s = await setup(t, async () => ({ models: [{ id: magpie.model, inputImages: false }] })); await s.request('/image-settings', magpie);
  const task = await s.request('/jobs', { image, mode: 'multi-reenact', referenceIndex: 1, reenact: { basePrompt: 'cat', subjects: [{ id: 'a', subjectImage: image, role: '人物', detail: '红帽' }, { id: 'b', subjectImage: image, role: '场景', detail: '树木' }] } });
  assert.equal(task.status, 202); await wait(() => s.reverse.length); s.reverse[0].resolve(result); await wait(async () => !(await s.request('/health')).body.active);
  const started = await s.request(`/jobs/${task.body.id}/generations`, { language: 'en', ...(imageSize ? { imageSize } : {}) }); assert.equal(started.status, 202);
  await wait(() => s.generation.length);
  assert.equal(s.generation[0].args.referenceIndex, 1); assert.ok(s.generation[0].args.imagePath);
  assert.equal(s.generation[0].args.subjectImagePaths.length, 2); assert.deepEqual(s.generation[0].args.subjects.map(item => item.id), ['a', 'b']);
  assert.deepEqual(s.generation[0].args.imageSize, imageSize); assert.equal(s.generation[0].args.aspectRatio, undefined);
  s.generation[0].resolve({ ...decodeImage(image), outputSize: { width: 1, height: 1 } }); await wait(async () => !(await s.request('/health')).body.active);
  const saved = (await s.request(`/jobs/${task.body.id}`)).body.generations[0];
  assert.equal(saved.sizeMode, imageSize ? 'explicit' : 'gateway-default'); assert.deepEqual(saved.imageSize, imageSize); assert.deepEqual(saved.outputSize, { width: 1, height: 1 });
});

test('user changes Magpie settings during a continuous workflow without changing its frozen input or dimensions', async t => {
  // Given a submitted Magpie flow, When settings change during reverse, Then automatic generation uses the old provider, model, images and pixel dimensions.
  const s = await setup(t); await s.request('/image-settings', magpie);
  const imageSize = { width: 1500, height: 1000 };
  const task = await s.request('/jobs', { image, mode: 'reenact', referenceIndex: 0, reenact: { subjectImage: image, basePrompt: 'cat' }, generation: { language: 'en', imageSize } });
  assert.equal(task.status, 202); assert.equal(task.body.autoGeneration.provider, 'magpie'); assert.deepEqual(task.body.autoGeneration.imageSize, imageSize);
  await wait(() => s.reverse.length); await s.request('/image-settings', settings); s.reverse[0].resolve(result); await wait(() => s.generation.length);
  const args = s.generation[0].args; assert.equal(args.settings.provider, 'magpie'); assert.equal(args.settings.model, magpie.model);
  assert.deepEqual(args.imageSize, imageSize); assert.equal(args.referenceIndex, 0); assert.ok(args.imagePath); assert.ok(args.subjectImagePath);
  s.generation[0].resolve(decodeImage(image)); await wait(async () => !(await s.request('/health')).body.active);
  const job = (await s.request(`/jobs/${task.body.id}`)).body; assert.equal(job.generations.length, 1); assert.equal(job.generations[0].sizeMode, 'explicit');
});

for (const cancelled of [false, true]) test(`user ${cancelled ? 'cancels' : 'fails'} Magpie reverse without starting subsequent image generation`, async t => {
  // Given an accepted continuous flow, When reverse fails or is cancelled, Then the prompt phase ends and no image API starts.
  const s = await setup(t); await s.request('/image-settings', magpie);
  const task = await s.request('/jobs', { image, mode: 'recreate', generation: { language: 'en', imageSize: { width: 640, height: 480 } } }); assert.equal(task.status, 202);
  await wait(() => s.reverse.length);
  if (cancelled) await s.request(`/jobs/${task.body.id}/cancel`, {}); else s.reverse[0].reject(new Error('reverse failed'));
  await wait(async () => !(await s.request('/health')).body.active);
  const job = (await s.request(`/jobs/${task.body.id}`)).body;
  assert.equal(job.autoGeneration.status, cancelled ? 'cancelled' : 'failed'); assert.equal(s.generation.length, 0); assert.equal(s.codex.length, 0);
});

test('user keeps Magpie batch dimensions, per-item inputs and provider frozen while stopping only queued work', async t => {
  // Given four accepted batch items, When inputs/settings change and remaining work stops, Then running flows use submitted snapshots and queued items never call a model.
  const s = await setup(t); await s.request('/image-settings', magpie);
  const projects = [];
  for (let i = 0; i < 4; i++) { const p = (await s.request('/projects', { image: i ? `data:image/jpeg;base64,${Buffer.from([255,216,255,i]).toString('base64')}` : image })).body; projects.push({ projectId: p.id, inputRevision: p.inputRevision }); }
  assert.equal((await s.request('/batches/preview', { projects })).status, 200);
  const imageSize = { width: 1200, height: 800 }, payload = { requestId: 'magpie-batch', projects, language: 'en', imageSize };
  const batch = await s.request('/batches', payload); assert.equal(batch.status, 202); assert.deepEqual(batch.body.imageSize, imageSize); assert.equal(batch.body.provider, 'magpie');
  await wait(() => s.reverse.length === 2); await s.request('/image-settings', settings);
  await s.request(`/projects/${projects[2].projectId}/input`, { expectedRevision: projects[2].inputRevision, mode: 'recreate', instruction: 'later edit' });
  s.reverse[0].resolve(result); await wait(() => s.generation.length === 1); s.generation[0].resolve(decodeImage(image)); await wait(() => s.reverse.length === 3);
  assert.notEqual(s.reverse[2].args.instruction, 'later edit');
  const stopped = await s.request(`/batches/${batch.body.id}/cancel`, {}); assert.equal(stopped.body.items[3].status, 'cancelled');
  s.reverse[1].resolve(result); s.reverse[2].resolve(result); await wait(() => s.generation.length === 3);
  for (const call of s.generation) { assert.equal(call.args.settings.provider, 'magpie'); assert.equal(call.args.settings.model, magpie.model); assert.deepEqual(call.args.imageSize, imageSize); assert.equal(call.args.imagePath, undefined); call.resolve(decodeImage(image)); }
  await wait(async () => !(await s.request('/health')).body.active);
  assert.equal(s.reverse.length, 3); assert.equal(s.generation.length, 3);
  const saved = JSON.parse(await readFile(join(s.dir, 'records/batches.json')))[0]; assert.deepEqual(saved.imageSize, imageSize); assert.equal(saved.generationModelSettings.imageProvider, 'magpie');
});

for (const change of ['cancel', 'save failure']) test(`user prevents Magpie image calls when reverse handoff meets ${change}`, async t => {
  // Given a completed reverse awaiting persistence, When cancelled or its save fails, Then no image API begins and the flow retains a terminal state.
  const s = await setup(t); await s.request('/image-settings', magpie);
  const task = await s.request('/jobs', { image, mode: 'recreate', generation: { language: 'en', imageSize: { width: 640, height: 480 } } });
  assert.equal(task.status, 202); await wait(() => s.reverse.length);
  const saving = Promise.withResolvers(), release = Promise.withResolvers(), rename = fs.promises.rename;
  let blocked = false;
  fs.promises.rename = async (source, target) => {
    if (!blocked && target === join(s.dir, 'records', `${task.body.id}.json`)) {
      const pending = JSON.parse(await readFile(source, 'utf8'));
      if (pending.status === 'completed' && pending.autoGeneration?.status === 'pending') {
        blocked = true; saving.resolve(); await release.promise;
        if (change === 'save failure') throw new Error('fixture reverse save failure');
      }
    }
    return rename(source, target);
  };
  syncBuiltinESMExports();
  try {
    s.reverse[0].resolve(result); await saving.promise;
    assert.equal(s.generation.length, 0);
    let cancel;
    if (change === 'cancel') {
      cancel = s.request(`/jobs/${task.body.id}/cancel`, {});
      await wait(async () => (await s.request(`/jobs/${task.body.id}`)).body.autoGeneration.status === 'cancelled');
    }
    release.resolve(); if (cancel) assert.equal((await cancel).status, 200);
    await wait(async () => !(await s.request('/health')).body.active);
    const job = (await s.request(`/jobs/${task.body.id}`)).body;
    assert.equal(job.autoGeneration.status, change === 'cancel' ? 'cancelled' : 'failed');
    assert.equal(s.generation.length, 0); assert.equal(s.codex.length, 0);
  } finally { release.resolve(); fs.promises.rename = rename; syncBuiltinESMExports(); }
});


test('user sees a failed batch item complete after retrying only local image saving', async t => {
  // Given paid batch output with a failed record commit, When local save recovers, Then both records complete without another model request.
  const s = await setup(t); await s.request('/image-settings', settings);
  const project = (await s.request('/projects', { image })).body;
  const batch = await s.request('/batches', { requestId: 'save-recovery-batch', projects: [{ projectId: project.id, inputRevision: project.inputRevision }], language: 'en' });
  assert.equal(batch.status, 202);
  await wait(() => s.reverse.length); s.reverse[0].resolve(result);
  await wait(() => s.generation.length);
  const getItem = async () => (await s.request('/batches')).body.find(value => value.id === batch.body.id).items[0];
  const item = await getItem();
  const rename = fs.promises.rename;
  let failed = false;
  fs.promises.rename = async (source, target) => {
    if (!failed && target === join(s.dir, 'records', `${item.jobId}.json`) && JSON.parse(await readFile(source, 'utf8')).generations?.[0]?.status === 'completed') {
      failed = true; throw new Error('fixture final commit failure');
    }
    return rename(source, target);
  };
  syncBuiltinESMExports();
  try {
    s.generation[0].resolve(decodeImage(image));
    const failedItem = await wait(async () => { const value = await getItem(); return value.status === 'failed' && value; });
    const recovered = await s.request(`/jobs/${item.jobId}/generations/${failedItem.generationId}/save`, {});
    assert.equal(recovered.status, 200);
    assert.equal(recovered.body.generations[0].status, 'completed');
    await wait(async () => (await getItem()).status === 'completed');
    assert.equal((await getItem()).error, undefined);
    const persisted = JSON.parse(await readFile(join(s.dir, 'records/batches.json'), 'utf8'));
    const savedItem = persisted.find(value => value.id === batch.body.id).items[0];
    assert.equal(savedItem.status, 'completed');
    assert.equal(savedItem.error, undefined);
    assert.equal(s.generation.length, 1);
  } finally { fs.promises.rename = rename; syncBuiltinESMExports(); }
});

for (const action of ['recover', 'delete']) test(`user can ${action} paid output after every final task commit fails without a second model call`, async t => {
  // Given a distinct paid image and persistent task-record failures, When restarting or deleting, Then recovery preserves only surviving tasks and never calls a model again.
  const s = await setup(t); await s.request('/image-settings', settings);
  const task = await s.request('/jobs', { image, mode: 'recreate', generation: { language: 'en' } });
  await wait(() => s.reverse.length); s.reverse[0].resolve(result); await wait(() => s.generation.length);
  const bytes = await sharp({ create: { width: 2, height: 1, channels: 3, background: '#fe2301' } }).png().toBuffer();
  assert.notDeepEqual(bytes, decodeImage(image).bytes);
  const asset = `${createHash('sha256').update(bytes).digest('hex')}.png`, file = join(s.dir, 'images', asset);
  const record = join(s.dir, 'records', `${task.body.id}.json`), rename = fs.promises.rename;
  let failures = 0;
  fs.promises.rename = async (source, target) => {
    if (target === record) { failures++; throw new Error('fixture persistent task record failure'); }
    return rename(source, target);
  };
  syncBuiltinESMExports();
  try {
    s.generation[0].resolve({ bytes, extension: 'png' });
    await wait(async () => !(await s.request('/health')).body.active);
    assert.ok(failures >= 2, 'both completed and failed-state commits were rejected');
    const disk = JSON.parse(await readFile(record, 'utf8'));
    assert.equal(disk.generations[0].status, 'running'); assert.equal(disk.generations[0].imageAsset, undefined);
    assert.deepEqual(await readFile(file), bytes);
  } finally { fs.promises.rename = rename; syncBuiltinESMExports(); }
  if (action === 'delete') {
    assert.equal((await s.request('/projects/delete', { ids: [task.body.projectId] })).status, 200);
    await s.restart();
    assert.equal((await s.request(`/jobs/${task.body.id}`)).status, 404);
    assert.equal((await s.request(`/projects/${task.body.projectId}`)).status, 404);
    await assert.rejects(readFile(file), { code: 'ENOENT' });
  } else {
    await s.restart();
    const recovered = (await s.request(`/jobs/${task.body.id}`)).body.generations[0];
    assert.equal(recovered.status, 'failed'); assert.equal(recovered.resultSavePending, true); assert.equal(recovered.imageAsset, asset);
    assert.deepEqual(await readFile(file), bytes, 'startup collection preserves paid output');
    const saved = await s.request(`/jobs/${task.body.id}/generations/${recovered.id}/save`, {});
    assert.equal(saved.status, 200); assert.equal(saved.body.generations[0].status, 'completed');
    assert.equal(saved.body.generations[0].resultSavePending, undefined);
    const fetched = await s.request(`/jobs/${task.body.id}/generations/${recovered.id}/image`);
    assert.equal(fetched.status, 200); assert.equal(fetched.body.image, `data:image/png;base64,${bytes.toString('base64')}`);
    await s.restart();
    assert.equal((await s.request(`/jobs/${task.body.id}`)).body.generations[0].status, 'completed');
  }
  assert.equal(s.generation.length, 1); assert.equal(s.reverse.length, 1);
});

test('user cancellation during image persistence remains cancelled after restart despite a paid output association', async t => {
  // Given a returned image waiting for disk rename, When the user cancels, Then restart does not expose a recovery action or restore the cancelled output.
  const s = await setup(t); await s.request('/image-settings', settings);
  const task = await s.request('/jobs', { image, mode: 'recreate', generation: { language: 'en' } });
  await wait(() => s.reverse.length); s.reverse[0].resolve(result); await wait(() => s.generation.length);
  const bytes = await sharp({ create: { width: 3, height: 1, channels: 3, background: '#2311ef' } }).png().toBuffer();
  const asset = `${createHash('sha256').update(bytes).digest('hex')}.png`, file = join(s.dir, 'images', asset);
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), rename = fs.promises.rename;
  fs.promises.rename = async (source, target) => {
    if (target === file) { entered.resolve(); await release.promise; }
    return rename(source, target);
  };
  syncBuiltinESMExports();
  let generationId;
  try {
    s.generation[0].resolve({ bytes, extension: 'png' }); await entered.promise;
    generationId = (await s.request(`/jobs/${task.body.id}`)).body.generations[0].id;
    assert.equal((await s.request(`/jobs/${task.body.id}/generations/${generationId}/cancel`, {})).status, 200);
    release.resolve(); await wait(async () => !(await s.request('/health')).body.active);
  } finally { release.resolve(); fs.promises.rename = rename; syncBuiltinESMExports(); }
  await s.restart();
  const cancelled = (await s.request(`/jobs/${task.body.id}`)).body.generations[0];
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.resultSavePending, undefined); assert.equal(cancelled.imageAsset, undefined);
  assert.equal((await s.request(`/jobs/${task.body.id}/generations/${generationId}/save`, {})).status, 409);
  await assert.rejects(readFile(file), { code: 'ENOENT' });
  assert.equal(s.generation.length, 1); assert.equal(s.reverse.length, 1);
});
