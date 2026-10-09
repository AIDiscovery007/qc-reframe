import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createBridge, decodeImage } from '../bridge/server.mjs';
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=';
const result = { title: 'batch', promptZh: '一只猫', promptEn: 'A cat', negativePrompt: '', observations: [], uncertainties: [] };
const waitFor = async fn => { for (let i = 0; i < 300; i++) { const value = await fn(); if (value) return value; await new Promise(r => setTimeout(r, 10)); } assert.fail('timed out'); };
async function setup(t, immediate = false) {
  const dir = await mkdtemp(join(tmpdir(), 'reframe-batches-')), skillPath = join(dir, 'SKILL.md');
  await writeFile(skillPath, 'test');
  const reverse = [], generation = [];
  const hold = calls => args => new Promise((resolve, reject) => { calls.push({ args, resolve, reject }); args.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }); });
  const models = { busy: false, selectedModel: 'test', selection: () => ({ model: 'test', reasoningEffort: 'low' }), invalidate: async () => {}, close() {} };
  const options = { dataDir: dir, skillPath, generationSkillPath: skillPath, agent: immediate ? async () => { reverse.push({}); return result; } : hold(reverse), generator: immediate ? async () => { generation.push({}); return decodeImage(image); } : hold(generation), models, compatibility: { getCompatibility: async () => ({}), snapshot: () => ({}) } };
  let app = await createBridge(options);
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const request = async (path, body) => { const res = await fetch(`http://127.0.0.1:${app.server.address().port}${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: res.status, body: await res.json() }; };
  t.after(async () => { app.server.closeAllConnections(); await new Promise(r => app.server.close(r)); await new Promise(r => setTimeout(r, 50)); await rm(dir, { recursive: true, force: true }); });
  const projects = [];
  for (let i = 0; i < 4; i++) { const p = await request('/projects', { image: i ? `data:image/jpeg;base64,${Buffer.from([255,216,255,i]).toString('base64')}` : image }); assert.equal(p.status, 200); projects.push({ projectId: p.body.id, inputRevision: p.body.inputRevision }); }
  return { request, reverse, generation, projects, dir, restart: async () => {
    app.server.closeAllConnections(); await new Promise(r => app.server.close(r)); await new Promise(r => setTimeout(r, 50));
    app = await createBridge(options); app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  } };
}
test('batch holds two whole-flow slots, freezes queued inputs and supports idempotent partial admission', async t => {
  const { request, reverse, generation, projects } = await setup(t);
  const preview = await request('/batches/preview', { projects }); assert.equal(preview.status, 200); assert.equal(preview.body.items.filter(x => x.eligible).length, 4);
  const payload = { requestId: 'test-request', projects: [...projects.slice(0,3), { ...projects[3], inputRevision: 99 }], language: 'en' };
  const submitted = await request('/batches', payload); assert.equal(submitted.status, 202); assert.equal(submitted.body.items[3].status, 'rejected');
  await waitFor(() => reverse.length === 2);
  assert.equal((await request('/batches', payload)).body.id, submitted.body.id);
  assert.equal((await request('/batches', { ...payload, language: 'zh' })).status, 409);
  assert.equal((await request('/projects/delete', { ids: [projects[2].projectId] })).status, 409);
  assert.equal((await request('/models/verify', { model: 'other' })).status, 409);
  const edit = await request(`/projects/${projects[2].projectId}/input`, { expectedRevision: projects[2].inputRevision, mode: 'recreate', instruction: 'later edit' }); assert.equal(edit.status, 200);
  reverse[0].resolve(result); await waitFor(() => generation.length === 1); assert.equal(reverse.length, 2);
  generation[0].resolve(decodeImage(image)); await waitFor(() => reverse.length === 3);
  assert.notEqual(reverse[2].args.instruction, 'later edit');
  assert.equal(reverse[2].args.modelSettings.model, 'test');
  const current = (await request(`/projects/${projects[2].projectId}/reference`)).body;
  assert.equal(current.inputRevision, edit.body.inputRevision);
  assert.deepEqual(current.inputVersions, edit.body.inputVersions);
  assert.equal(current.inputs.recreate.instruction, 'later edit');
  const stopped = await request(`/batches/${submitted.body.id}/cancel`, { projectId: projects[2].projectId }); assert.equal(stopped.status, 200);
  assert.equal(reverse[2].args.signal.aborted, true);
  reverse[1].resolve(result); await waitFor(() => generation.length === 2); generation[1].resolve(decodeImage(image));
  await waitFor(async () => (await request('/batches')).body[0].items.every(x => ['completed','cancelled','rejected'].includes(x.status)));
});
test('stop remaining cancels queued items without cancelling running flow and skips busy projects', async t => {
  const { request, reverse, projects } = await setup(t);
  const payload = { requestId: 'stop-request', projects, language: 'zh' };
  const submitted = await request('/batches', payload); assert.equal(submitted.status, 202); await waitFor(() => reverse.length === 2);
  const other = await request('/batches', { ...payload, requestId: 'other-request' }); assert.ok(other.body.items.every(x => x.status === 'rejected'));
  const stopped = await request(`/batches/${submitted.body.id}/cancel`, {}); assert.equal(stopped.status, 200);
  assert.equal(stopped.body.items.filter(x => x.status === 'cancelled').length, 2); assert.ok(reverse.every(x => !x.args.signal.aborted));
  assert.equal((await request('/batches', payload)).body.items.filter(x => x.status === 'cancelled').length, 2);
});
test('separate batches share capacity, manual work delays dispatch, and queued projects remain visibly busy', async t => {
  const { request, reverse, generation, projects } = await setup(t);
  const manual = await request('/jobs', { image, mode: 'recreate', projectId: projects[0].projectId }); assert.equal(manual.status, 202);
  const first = await request('/batches', { requestId: 'first', projects: projects.slice(1,3), language: 'zh' }); assert.equal(first.status, 202);
  const second = await request('/batches', { requestId: 'second', projects: projects.slice(3), language: 'zh' }); assert.equal(second.status, 202);
  await waitFor(() => reverse.length === 2); assert.equal((await request(`/projects/${projects[3].projectId}`)).body.busy, true);
  await request('/projects/visibility', { ids: [projects[3].projectId], hidden: true });
  assert.equal((await request('/batches')).body.some(batch => batch.id === second.body.id), false);
  assert.equal((await request('/batches?includeHidden=true')).body.some(batch => batch.id === second.body.id), true);
  const health = (await request('/health')).body; assert.equal(health.active, 4); assert.equal(health.visibleActive, 3);
  reverse[0].resolve(result); await waitFor(() => reverse.length === 3);
  reverse[1].resolve(result); reverse[2].resolve(result); await waitFor(() => generation.length === 2);
  assert.equal(reverse.length, 3);
  generation[0].resolve(decodeImage(image)); await waitFor(() => reverse.length === 4);
});
test('restart interrupts both running and queued batch items without replaying the idempotent request', async t => {
  const { request, reverse, projects, restart, dir } = await setup(t);
  const payload = { requestId: 'restart', projects, language: 'zh', aspectRatio: { width: 3, height: 4 } };
  const submitted = await request('/batches', payload); assert.equal(submitted.status, 202); await waitFor(() => reverse.length === 2);
  await restart();
  const resumed = await request('/batches', payload); assert.equal(resumed.body.id, submitted.body.id);
  assert.ok(resumed.body.items.every(item => item.status === 'failed')); assert.equal(reverse.length, 2);
  const saved = JSON.parse(await readFile(join(dir, 'records', 'batches.json'), 'utf8'));
  assert.ok(saved[0].items.every(item => item.status === 'failed'));
});
test('admission write failure starts no tasks and permits retry after storage recovers', async t => {
  const { request, reverse, projects, dir } = await setup(t);
  const path = join(dir, 'records', 'batches.json'); await mkdir(path);
  const payload = { requestId: 'disk-failure', projects, language: 'zh' };
  assert.equal((await request('/batches', payload)).status, 500); assert.equal(reverse.length, 0);
  await rm(path, { recursive: true }); assert.equal((await request('/batches', payload)).status, 202); await waitFor(() => reverse.length === 2);
});
test('queued snapshot remains referenced during idle collection after input replacement', async t => {
  const { createImageStore } = await import('../bridge/images.mjs');
  const { request, reverse, projects, dir } = await setup(t);
  const original = (await request(`/projects/${projects[2].projectId}/reference`)).body.image;
  const submitted = await request('/batches', { requestId: 'assets', projects, language: 'zh' }); assert.equal(submitted.status, 202); await waitFor(() => reverse.length === 2);
  await request(`/projects/${projects[2].projectId}/input`, { expectedRevision: 0, mode: 'recreate', instruction: 'new', image });
  const saved = JSON.parse(await readFile(join(dir, 'records', 'batches.json'), 'utf8'));
  const asset = saved[0].items[2].snapshot.imageAsset;
  const images = await createImageStore(dir, join(dir, 'records'));
  await images.collect(saved.flatMap(batch => batch.items.filter(item => ['queued','running'].includes(item.status)).map(item => item.snapshot.imageAsset)));
  assert.deepEqual(await images.read(asset), decodeImage(original).bytes);
});
test('a closed client is unnecessary for dispatch or automatic continuation even when phases finish immediately', async t => {
  const { request, reverse, generation, projects } = await setup(t, true);
  assert.equal((await request('/batches', { requestId: 'no-poll', projects, language: 'zh' })).status, 202);
  await waitFor(() => generation.length === 4);
  assert.equal(reverse.length, 4);
  await waitFor(async () => (await request('/batches')).body[0].items.every(item => item.status === 'completed'));
});
test('project deletion erases batch snapshots while retaining an opaque idempotency tombstone across restart', async t => {
  const { request, reverse, projects, dir, restart } = await setup(t, true);
  const edited = await request(`/projects/${projects[0].projectId}/input`, { expectedRevision: 0, mode: 'recreate', instruction: 'private-deleted-instruction' });
  const payload = { requestId: 'deleted-request', projects: [{ ...projects[0], inputRevision: edited.body.inputRevision }, ...projects.slice(1)], language: 'zh' };
  const submitted = await request('/batches', payload); assert.equal(submitted.status, 202);
  await waitFor(async () => (await request('/batches')).body[0].items.every(item => item.status === 'completed'));
  const path = join(dir, 'records', 'batches.json'), before = JSON.parse(await readFile(path, 'utf8'));
  assert.equal((await request('/projects/delete', { ids: [projects[0].projectId] })).status, 200);
  const raw = await readFile(path, 'utf8'), after = JSON.parse(raw);
  assert.equal(after[0].items.length, 3);
  assert.deepEqual(after[0].items, before[0].items.slice(1));
  for (const value of [projects[0].projectId, 'private-deleted-instruction', before[0].items[0].snapshot.imageAsset]) assert.equal(raw.includes(value), false);
  assert.match(after[0].requestHash, /^[a-f0-9]{64}$/); assert.equal(after[0].request, undefined);
  assert.equal((await request('/batches', payload)).body.items.length, 3);
  assert.equal((await request('/batches', { ...payload, language: 'en' })).status, 409);
  await restart(); assert.equal((await request('/batches', payload)).body.items.length, 3); assert.equal(reverse.length, 4);
  assert.equal((await request('/projects/delete', { ids: projects.slice(1).map(item => item.projectId) })).status, 200);
  const tombstone = (await request('/batches', payload)).body; assert.equal(tombstone.id, submitted.body.id); assert.deepEqual(tombstone.items, []);
  assert.deepEqual((await request('/batches')).body, []);
  await request('/projects', { image });
  assert.deepEqual((await request('/batches', payload)).body.items, []); assert.equal(reverse.length, 4);
});
test('failure to persist the project deletion journal preserves batch history and project records', async t => {
  const { request, projects, dir } = await setup(t, true);
  await request('/batches', { requestId: 'journal-failure', projects, language: 'zh' });
  await waitFor(async () => (await request('/batches')).body[0].items.every(item => item.status === 'completed'));
  const path = join(dir, 'records', 'batches.json'), before = await readFile(path, 'utf8');
  await mkdir(join(dir, 'records', '.project-deletion.json.tmp'));
  assert.equal((await request('/projects/delete', { ids: [projects[0].projectId] })).status, 500);
  assert.equal(await readFile(path, 'utf8'), before);
  assert.equal((await request(`/projects/${projects[0].projectId}/reference`)).status, 200);
});
test('batch cleanup failure retains the deletion journal and files, and restart completes the same transaction', async t => {
  const { default: fs } = await import('node:fs');
  const { syncBuiltinESMExports } = await import('node:module');
  const { request, reverse, projects, dir, restart } = await setup(t, true);
  const payload = { requestId: 'cleanup-failure', projects, language: 'zh' };
  await request('/batches', payload);
  await waitFor(async () => (await request('/batches')).body[0].items.every(item => item.status === 'completed'));
  const path = join(dir, 'records', 'batches.json'), before = await readFile(path, 'utf8'), rename = fs.promises.rename;
  fs.promises.rename = async (from, to) => { if (to === path) throw new Error('batch cleanup disk failure'); return rename(from, to); };
  syncBuiltinESMExports();
  try {
    assert.equal((await request('/projects/delete', { ids: [projects[0].projectId] })).status, 500);
    assert.equal(await readFile(path, 'utf8'), before);
    assert.ok(JSON.parse(await readFile(join(dir, 'records', '.project-deletion.json'), 'utf8')).includes(`project-${projects[0].projectId}.json`));
    assert.equal((await request(`/projects/${projects[0].projectId}/reference`)).status, 200);
  } finally { fs.promises.rename = rename; syncBuiltinESMExports(); }
  await restart();
  assert.equal((await request(`/projects/${projects[0].projectId}/reference`)).status, 404);
  const raw = await readFile(path, 'utf8'); assert.equal(raw.includes(projects[0].projectId), false);
  assert.equal((await request('/batches', payload)).body.items.length, 3); assert.equal(reverse.length, 4);
  await assert.rejects(readFile(join(dir, 'records', '.project-deletion.json')), { code: 'ENOENT' });
});
test('interruption after batch cleanup leaves the original deletion journal recoverable without restoring deleted snapshots', async t => {
  const { default: fs } = await import('node:fs');
  const { syncBuiltinESMExports } = await import('node:module');
  const { request, projects, dir, restart } = await setup(t, true);
  const payload = { requestId: 'file-delete-failure', projects, language: 'zh' };
  await request('/batches', payload);
  await waitFor(async () => (await request('/batches')).body[0].items.every(item => item.status === 'completed'));
  const projectPath = join(dir, 'records', `project-${projects[0].projectId}.json`), rmFile = fs.promises.rm;
  fs.promises.rm = async (path, options) => { if (path === projectPath) throw new Error('project deletion interrupted'); return rmFile(path, options); };
  syncBuiltinESMExports();
  try {
    assert.equal((await request('/projects/delete', { ids: [projects[0].projectId] })).status, 500);
    assert.equal((await readFile(join(dir, 'records', 'batches.json'), 'utf8')).includes(projects[0].projectId), false);
    assert.equal((await request('/batches')).body[0].items.length, 3);
    assert.ok(await readFile(join(dir, 'records', '.project-deletion.json'), 'utf8'));
    assert.ok(await readFile(projectPath, 'utf8'));
  } finally { fs.promises.rm = rmFile; syncBuiltinESMExports(); }
  await restart();
  assert.equal((await request(`/projects/${projects[0].projectId}`)).status, 404);
  assert.equal((await request('/batches', payload)).body.items.length, 3);
});
test('reverse and generation failures release whole-flow slots, continue the queue and preserve a successful prompt', async t => {
  const { request, reverse, generation, projects } = await setup(t);
  const submitted = await request('/batches', { requestId: 'phase-failures', projects, language: 'zh' }); assert.equal(submitted.status, 202);
  await waitFor(() => reverse.length === 2);
  reverse[0].reject(new Error('reverse failure'));
  await waitFor(() => reverse.length === 3);
  reverse[1].resolve(result); await waitFor(() => generation.length === 1);
  generation[0].reject(new Error('generation failure'));
  await waitFor(() => reverse.length === 4);
  reverse[2].resolve(result); reverse[3].resolve(result); await waitFor(() => generation.length === 3);
  generation[1].resolve(decodeImage(image)); generation[2].resolve(decodeImage(image));
  const batch = await waitFor(async () => {
    const batch = (await request('/batches')).body[0];
    return batch.items.every(item => ['failed', 'completed'].includes(item.status)) && batch;
  });
  assert.deepEqual(batch.items.map(item => item.status), ['failed', 'failed', 'completed', 'completed']);
  assert.equal(batch.items[0].error, 'reverse failure'); assert.equal(batch.items[1].error, 'generation failure');
  const reverseFailed = (await request(`/jobs/${batch.items[0].jobId}`)).body;
  assert.equal(reverseFailed.generations, undefined);
  const imageFailed = (await request(`/jobs/${batch.items[1].jobId}`)).body;
  assert.equal(imageFailed.status, 'completed'); assert.deepEqual(imageFailed.result, result);
  assert.equal(imageFailed.generations[0].status, 'failed');
  assert.equal((await request('/health')).body.active, 0);
});
for (const cancel of [false, true]) test(`a running batch item without a job can ${cancel ? 'be cancelled' : 'terminate'} after both pre-job input reading and failure persistence break`, async t => {
  const { default: fs } = await import('node:fs');
  const { syncBuiltinESMExports } = await import('node:module');
  const { request, reverse, generation, projects, dir } = await setup(t, true);
  const asset = (await request(`/projects/${projects[0].projectId}`)).body.imageAsset;
  const batchPath = join(dir, 'records', 'batches.json'), imagePath = join(dir, 'images', asset);
  const originalRead = fs.promises.readFile, originalRename = fs.promises.rename, failedWrite = Promise.withResolvers();
  let armed = false, readsFailed = 0, writesFailed = 0;
  fs.promises.readFile = async (path, ...args) => {
    if (armed && path === imagePath) { readsFailed++; throw Object.assign(new Error('pre-job input read failed'), { code: 'EIO' }); }
    return originalRead(path, ...args);
  };
  fs.promises.rename = async (from, to) => {
    const batch = to === batchPath ? JSON.parse(await originalRead(from, 'utf8'))[0] : undefined;
    if (armed && batch?.items[0].status === 'failed') { writesFailed++; failedWrite.resolve(); throw new Error('failed batch state write failed'); }
    await originalRename(from, to);
    if (batch?.items[0].status === 'running') armed = true;
  };
  syncBuiltinESMExports();
  const payload = { requestId: `missing-job-${cancel}`, projects, language: 'zh' };
  let submitted;
  try {
    submitted = await request('/batches', payload); assert.equal(submitted.status, 202);
    await failedWrite.promise;
    const saved = JSON.parse(await originalRead(batchPath, 'utf8'))[0];
    assert.equal(saved.items[0].status, 'running'); assert.ok(readsFailed && writesFailed);
    await assert.rejects(originalRead(join(dir, 'records', `${saved.items[0].jobId}.json`)), { code: 'ENOENT' });
    assert.equal(reverse.length, 0);
  } finally { fs.promises.readFile = originalRead; fs.promises.rename = originalRename; syncBuiltinESMExports(); }
  if (cancel) {
    const stopped = await request(`/batches/${submitted.body.id}/cancel`, { projectId: projects[0].projectId });
    assert.equal(stopped.body.items[0].status, 'cancelled');
  } else await request('/batches');
  await waitFor(() => reverse.length === 3 && generation.length === 3);
  const batch = await waitFor(async () => {
    const batch = (await request('/batches')).body[0];
    return batch.items.slice(1).every(item => item.status === 'completed') && batch;
  });
  assert.equal(batch.items[0].status, cancel ? 'cancelled' : 'failed');
  assert.equal(batch.items[0].jobId, undefined);
  assert.equal((await request(`/projects/${projects[0].projectId}`)).body.busy, false);
  assert.equal((await request('/batches', payload)).body.items[0].status, cancel ? 'cancelled' : 'failed');
  assert.equal(reverse.length, 3); assert.equal((await request('/health')).body.active, 0);
});
