import test from 'node:test';
import assert from 'node:assert/strict';
import { createGenerationOutputs } from '../bridge/generation-output.mjs';

test('user retries saving a generated image after disk failure without generating again', async () => {
  // Given paid output, When storage fails and later recovers, Then the original bytes are saved once without another generation.
  let fail = true, writes = 0;
  const output = { bytes: Buffer.from('original'), extension: 'png', outputSize: { width: 7, height: 9 } };
  const images = { put: async value => { writes++; assert.equal(value, output); if (fail) throw new Error('private/path'); return 'asset'; } };
  const store = createGenerationOutputs(images), generation = { id: 'generation', status: 'running', provider: 'magpie' };
  store.remember(generation, output);
  await assert.rejects(store.write(generation), /未能保存/);
  assert.equal(generation.resultSavePending, true);
  assert.equal(store.has(generation), true);
  fail = false;
  await store.retry({ generations: [generation] }, generation, async () => {});
  assert.equal(writes, 2);
  assert.equal(generation.status, 'completed');
  assert.equal(generation.imageAsset, 'asset');
  assert.deepEqual(generation.outputSize, { width: 7, height: 9 });
  assert.equal(generation.resultSavePending, undefined);
  assert.equal(store.has(generation), false);
});

test('user keeps a recoverable result when retrying its record save also fails', async () => {
  // Given retained output, When the task record still cannot commit, Then failure and the same recovery remain visible.
  const store = createGenerationOutputs({ put: async () => 'asset' });
  const generation = { id: 'generation', status: 'failed' };
  store.remember(generation, { bytes: Buffer.from('image'), extension: 'png' });
  store.markPending(generation);
  await assert.rejects(store.retry({}, generation, async () => { throw new Error('secret directory'); }), /未能保存/);
  assert.equal(generation.status, 'failed');
  assert.equal(generation.resultSavePending, true);
  assert.equal(store.has(generation), true);
  assert.ok(!generation.error.includes('secret'));
});

test('user can retry an already stored image record after restarting the service', async () => {
  // Given a persisted failure with an asset, When recovery has no memory buffer, Then it validates and saves the existing asset.
  const store = createGenerationOutputs({ read: async asset => { assert.equal(asset, 'asset'); return Buffer.from('image'); } });
  const generation = { id: 'generation', status: 'failed', imageAsset: 'asset', extension: 'png', resultSavePending: true };
  let writes = 0;
  await store.retry({}, generation, async () => { writes++; });
  assert.equal(writes, 1);
  assert.equal(generation.status, 'completed');
  const missing = { id: 'missing', status: 'failed', resultSavePending: true };
  await assert.rejects(store.retry({}, missing, async () => assert.fail('must not save missing output')), /已不在内存/);
  assert.equal(missing.resultSavePending, true);
});

async function durableStore(t) {
  const { mkdtemp, mkdir, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { createImageStore } = await import('../bridge/images.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'reframe-output-recovery-'));
  const options = { directory: join(dir, 'generation-outputs'), recordsDir: join(dir, 'records') };
  await mkdir(options.recordsDir);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const images = await createImageStore(dir, options.recordsDir);
  const store = createGenerationOutputs(images, options);
  await store.recover(new Map(), async () => {});
  return { images, store, options };
}
const jobId = '11111111-1111-4111-8111-111111111111', generationId = '22222222-2222-4222-8222-222222222222';

test('user retains disk output across restart when every final task write failed', async t => {
  // Given durable image bytes but an old running task record, When restarted, Then the independent association restores a save-only result before collection.
  const { images, store, options } = await durableStore(t);
  const generation = { id: generationId, status: 'running', provider: 'magpie' };
  const output = { bytes: Buffer.from('paid-output'), extension: 'png', outputSize: { width: 7, height: 9 }, revisedPrompt: 'revised' };
  store.remember(generation, output);
  await store.write(generation, jobId);
  const old = { id: jobId, generations: [{ id: generationId, status: 'failed', provider: 'magpie' }] };
  const recovered = createGenerationOutputs(images, options);
  await recovered.recover(new Map([[jobId, old]]), async job => { assert.equal(job.generations[0].resultSavePending, true); });
  assert.equal(old.generations[0].imageAsset, generation.imageAsset);
  assert.deepEqual(old.generations[0].outputSize, output.outputSize);
  assert.equal(old.generations[0].revisedPrompt, 'revised');
  await images.collect(recovered.assets);
  assert.deepEqual(await images.read(old.generations[0].imageAsset), output.bytes);
  await recovered.retry(old, old.generations[0], async () => {});
  assert.equal(old.generations[0].status, 'completed');
  assert.deepEqual(recovered.assets, []);
});

for (const corruption of ['malformed', 'invalid-reference']) test(`user keeps output untouched when its recovery association is ${corruption}`, async t => {
  // Given damaged recovery metadata, When starting, Then recovery fails closed without deleting its bytes or overwriting the damaged evidence.
  const { readFile, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { images, store, options } = await durableStore(t);
  const generation = { id: generationId, status: 'running' }, output = { bytes: Buffer.from('retain'), extension: 'png' };
  store.remember(generation, output); await store.write(generation, jobId);
  const path = join(options.directory, `${generationId}.json`);
  const broken = corruption === 'malformed' ? '{broken' : JSON.stringify({ ...JSON.parse(await readFile(path, 'utf8')), imageAsset: '../private' });
  await writeFile(path, broken);
  const recovered = createGenerationOutputs(images, options);
  await assert.rejects(recovered.recover(new Map([[jobId, { id: jobId, generations: [generation] }]]), async () => {}), /恢复记录/);
  assert.equal(await readFile(path, 'utf8'), broken);
  assert.deepEqual(await images.read(generation.imageAsset), output.bytes);
});

for (const status of ['completed', 'cancelled', 'deleted']) test(`user ${status} output no longer retains a recovery association`, async t => {
  // Given a durable association, When the user finishes, cancels or deletes its task, Then the stale association cannot resurrect it after restart.
  const { readdir } = await import('node:fs/promises');
  const { store, options } = await durableStore(t);
  const generation = { id: generationId, status: 'running' };
  store.remember(generation, { bytes: Buffer.from('output'), extension: 'png' }); await store.write(generation, jobId);
  if (status === 'deleted') await store.prune(new Map());
  else { generation.status = status; await store.settled(generation); }
  assert.deepEqual(await readdir(options.directory), []);
  assert.deepEqual(store.assets, []);
});

test('user output is not written without its durable association', async t => {
  // Given an unavailable journal directory, When output is saved, Then no unassociated image is written and the buffer remains retryable.
  const { rm, writeFile } = await import('node:fs/promises');
  const { images, options } = await durableStore(t);
  await rm(options.directory, { recursive: true }); await writeFile(options.directory, 'blocked');
  let puts = 0;
  const store = createGenerationOutputs({ ...images, put: async () => { puts++; } }, options);
  const generation = { id: generationId, status: 'running' };
  store.remember(generation, { bytes: Buffer.from('paid'), extension: 'png' });
  await assert.rejects(store.write(generation, jobId), /未能保存/);
  assert.equal(puts, 0);
  assert.equal(store.has(generation), true);
});

test('user keeps output when its task record is damaged instead of deleted', async t => {
  // Given a task skipped by the loader, When its journal is recovered, Then existence of the damaged record prevents orphan cleanup.
  const { writeFile, readdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { images, store, options } = await durableStore(t);
  const generation = { id: generationId, status: 'running' };
  store.remember(generation, { bytes: Buffer.from('paid'), extension: 'png' }); await store.write(generation, jobId);
  await writeFile(join(options.recordsDir, `${jobId}.json`), '{broken');
  const recovered = createGenerationOutputs(images, options);
  await assert.rejects(recovered.recover(new Map(), async () => {}), /恢复记录/);
  assert.deepEqual(await readdir(options.directory), [`${generationId}.json`]);
  assert.equal((await images.read(generation.imageAsset)).toString(), 'paid');
});

test('user can restart after association commits but image write never completes', async t => {
  // Given an association with no image bytes, When restarted, Then it leaves the interrupted task failed without offering an impossible save.
  const { images, options } = await durableStore(t);
  const store = createGenerationOutputs({ ...images, put: async () => { throw new Error('disk full'); } }, options);
  const generation = { id: generationId, status: 'running' };
  store.remember(generation, { bytes: Buffer.from('paid'), extension: 'png' });
  await assert.rejects(store.write(generation, jobId));
  const old = { id: jobId, generations: [{ id: generationId, status: 'failed' }] };
  const recovered = createGenerationOutputs(images, options);
  await recovered.recover(new Map([[jobId, old]]), async () => assert.fail('no output to save'));
  assert.deepEqual(recovered.assets, []);
  assert.equal(old.generations[0].resultSavePending, undefined);
});
