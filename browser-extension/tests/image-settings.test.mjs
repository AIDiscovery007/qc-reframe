import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createImageSettingsStore } from '../bridge/image-settings.mjs';

async function setup(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'reframe-image-settings-test-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  return { dataDir, path: join(dataDir, 'image-settings.json') };
}

test('user defaults to Codex and sees no API credentials with legacy settings', async t => {
  // Given no API settings, When settings open, Then Codex stays selected without creating a file.
  const options = await setup(t);
  const store = await createImageSettingsStore(options);
  assert.deepEqual(store.selection(), { provider: 'codex' });
  assert.deepEqual(store.view(), { provider: 'codex', configs: {
    magpie: { baseUrl: 'http://127.0.0.1:3425/v1', model: '' },
    openai: { baseUrl: 'https://api.openai.com/v1', model: '', hasApiKey: false },
    gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: '', hasApiKey: false },
  } });
  assert.deepEqual(await readdir(options.dataDir), []);
});

test('user restores each provider separately without exposing keys or changing submitted snapshots', async t => {
  // Given saved provider credentials, When providers switch and settings reopen, Then keys stay private and earlier task snapshots stay unchanged.
  const options = await setup(t);
  const store = await createImageSettingsStore(options);
  const publicView = await store.save({ provider: 'openai', baseUrl: 'https://example.test/custom/v1/', model: 'image-test', apiKey: 'synthetic-openai-key' });
  const snapshot = store.selection();
  assert.equal(JSON.stringify(publicView).includes('synthetic-openai-key'), false);
  publicView.configs.openai.model = 'mutated-view';
  await store.save({ provider: 'gemini', model: 'image-gemini', apiKey: 'synthetic-gemini-key' });
  assert.deepEqual(snapshot, { provider: 'openai', baseUrl: 'https://example.test/custom/v1', model: 'image-test', apiKey: 'synthetic-openai-key' });
  snapshot.apiKey = 'mutated-snapshot';
  await store.save({ provider: 'openai', model: 'image-new', apiKey: '' });
  assert.equal(store.selection().apiKey, 'synthetic-openai-key');
  const restored = await createImageSettingsStore(options);
  assert.deepEqual(restored.view(), store.view());
  await restored.save({ provider: 'gemini' });
  assert.equal(restored.selection().apiKey, 'synthetic-gemini-key');
  assert.equal((await stat(options.path)).mode & 0o777, 0o600);
});

test('user must reenter or explicitly clear credentials when changing destination', async t => {
  // Given a saved key, When the API destination changes, Then saving requires a replacement key or explicit clearing.
  const options = await setup(t);
  const store = await createImageSettingsStore(options);
  await store.save({ provider: 'openai', model: 'image-test', apiKey: 'synthetic-key' });
  const oldBytes = await readFile(options.path, 'utf8');
  for (const apiKey of [undefined, '']) {
    await assert.rejects(store.save({ provider: 'openai', baseUrl: 'https://other.test/v1', ...(apiKey === undefined ? {} : { apiKey }) }), { status: 400 });
  }
  assert.equal(await readFile(options.path, 'utf8'), oldBytes);
  await store.save({ provider: 'openai', baseUrl: 'https://other.test/v1', apiKey: 'synthetic-new-key' });
  assert.equal(store.selection().apiKey, 'synthetic-new-key');
  await store.save({ provider: 'openai', baseUrl: 'https://cleared.test/v1', clearApiKey: true });
  assert.equal(store.view().configs.openai.hasApiKey, false);
  assert.throws(() => store.selection(), { status: 409 });
  await store.save({ provider: 'codex' });
  assert.deepEqual(store.selection(), { provider: 'codex' });
});

test('user can save incomplete API settings but cannot start generation', async t => {
  // Given an incomplete API configuration, When the user saves it and requests generation, Then the draft persists and generation is blocked until complete.
  const store = await createImageSettingsStore(await setup(t));
  await store.save({ provider: 'gemini' });
  assert.throws(() => store.selection(), { status: 409 });
  await store.save({ provider: 'gemini', apiKey: 'synthetic-key' });
  assert.throws(() => store.selection(), { status: 409 });
  await store.save({ provider: 'gemini', model: 'image-test' });
  assert.equal(store.selection().model, 'image-test');
  await store.save({ provider: 'gemini', clearApiKey: true });
  assert.throws(() => store.selection(), { status: 409 });
});

test('user retains saved credentials when a settings request is malformed or ambiguous', async t => {
  // Given saved credentials, When invalid fields are submitted, Then the request fails and the previous file and key remain unchanged.
  const options = await setup(t);
  const store = await createImageSettingsStore(options);
  await store.save({ provider: 'openai', model: 'image-test', apiKey: 'synthetic-key' });
  const oldBytes = await readFile(options.path, 'utf8');
  for (const request of [null, [], 'openai', {}, { provider: 'unknown' }, { provider: 'toString' },
    { provider: 'codex', model: 'ignored' }, { provider: 'openai', extra: true },
    { provider: 'openai', clearApiKey: 'true' }, { provider: 'openai', clearApiKey: true, apiKey: 'synthetic-key' },
    ...['file:///tmp/api', 'http://example.test', 'https://user:pass@example.test', 'https://@example.test', 'https://example.test/?', 'https://example.test/#', 'https://example.test/?key=synthetic-key', 'https://example.test/#hash', 'https://example.test/\npath', 'https://example.test/space path', 'not-a-url', '', null].map(baseUrl => ({ provider: 'openai', baseUrl })),
    ...['bad\nmodel', 'bad\u0000model', 'bad\u0085model', 'x'.repeat(257), 42, null].map(model => ({ provider: 'openai', model })),
    ...['bad\r\nkey', 12, null].map(apiKey => ({ provider: 'openai', apiKey })),
  ]) await assert.rejects(store.save(request), { status: 400 });
  assert.equal(await readFile(options.path, 'utf8'), oldBytes);
  assert.equal(store.selection().apiKey, 'synthetic-key');
});

test('user can configure loopback HTTP gateways with custom endpoint paths', async t => {
  // Given a local gateway, When its HTTP address is saved, Then generation uses the complete configured endpoint path.
  const store = await createImageSettingsStore(await setup(t));
  for (const baseUrl of ['http://localhost:43199/gateway/v1', 'http://127.0.0.1:43199/v1', 'http://127.1.2.3/v1', 'http://[::1]:43199/v1']) {
    await store.save({ provider: 'openai', baseUrl, model: 'local-image', apiKey: 'synthetic-local-key' });
    assert.equal(store.selection().baseUrl, baseUrl);
  }
});

test('user receives settings in save order without later edits altering a queued request', async t => {
  // Given several overlapping saves, When a submitted request is subsequently edited, Then the original requests persist in order without partial files.
  const options = await setup(t);
  const store = await createImageSettingsStore(options);
  const first = store.save({ provider: 'openai', model: 'first', apiKey: 'synthetic-first-key' });
  const request = { provider: 'gemini', model: 'second', apiKey: 'synthetic-second-key' };
  const second = store.save(request);
  request.model = 'changed-after-submission';
  const third = store.save({ provider: 'openai', model: 'third' });
  await Promise.all([first, second, third]);
  assert.equal(store.selection().model, 'third');
  assert.equal(store.view().configs.gemini.model, 'second');
  assert.deepEqual((await createImageSettingsStore(options)).view(), store.view());
  assert.deepEqual(await readdir(options.dataDir), ['image-settings.json']);
});

test('user retains previous settings after a failed write and can retry saving', async t => {
  // Given saved settings, When atomic replacement fails and storage is restored, Then previous settings survive and a later save succeeds.
  const options = await setup(t);
  const store = await createImageSettingsStore(options);
  await store.save({ provider: 'openai', model: 'original', apiKey: 'synthetic-key' });
  const oldBytes = await readFile(options.path, 'utf8');
  await rename(options.path, options.path + '.backup');
  await mkdir(options.path);
  await assert.rejects(store.save({ provider: 'gemini', model: 'should-not-save', apiKey: 'synthetic-other-key' }));
  await assert.rejects(store.save({ provider: 'magpie', model: 'fixture/image' }));
  assert.equal(store.selection().model, 'original');
  assert.equal(await readFile(options.path + '.backup', 'utf8'), oldBytes);
  assert.deepEqual((await readdir(options.dataDir)).sort(), ['image-settings.json', 'image-settings.json.backup']);
  await rm(options.path, { recursive: true });
  await rename(options.path + '.backup', options.path);
  await store.save({ provider: 'openai', model: 'recovered' });
  assert.equal((await createImageSettingsStore(options)).selection().model, 'recovered');
});

test('user receives a safe error for corrupt settings while the original file is preserved', async t => {
  // Given a corrupt settings file, When settings load, Then loading fails without exposing secrets or changing the original bytes.
  const options = await setup(t);
  const defaults = { openai: { baseUrl: 'https://api.openai.com/v1', model: '', apiKey: '' }, gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: '', apiKey: '' } };
  for (const bytes of ['{ synthetic-secret', 'null', JSON.stringify({ provider: 'openai', configs: {} }), JSON.stringify({ provider: 'openai', configs: defaults, surprise: 'synthetic-secret' }), JSON.stringify({ provider: 'openai', configs: { ...defaults, openai: { ...defaults.openai, apiKey: 42 } } })]) {
    await writeFile(options.path, bytes);
    await assert.rejects(createImageSettingsStore(options), error => /原文件已保留/.test(error.message) && !error.message.includes('synthetic-secret'));
    assert.equal(await readFile(options.path, 'utf8'), bytes);
  }
});

test('user saves Magpie without a supplier key while old settings and readiness remain consistent', async t => {
  // Given direct settings, When switching and reopening, Then no key is moved and incomplete models remain blocked.
  const options = await setup(t), store = await createImageSettingsStore(options);
  await store.save({ provider: 'openai', model: 'legacy-model', apiKey: 'legacy-private-key' });
  await store.save({ provider: 'magpie', baseUrl: 'http://127.0.0.1:3425', model: '' });
  assert.equal(store.ready(), false); assert.throws(() => store.selection(), { status: 409 });
  await store.save({ provider: 'magpie', model: 'source/image-model' });
  assert.equal(store.ready(), true);
  assert.deepEqual(store.selection(), { provider: 'magpie', baseUrl: 'http://127.0.0.1:3425/v1', model: 'source/image-model' });
  assert.equal(store.view().configs.magpie.hasApiKey, undefined);
  const reloaded = await createImageSettingsStore(options);
  assert.deepEqual(reloaded.selection(), store.selection());
  await reloaded.save({ provider: 'openai' }); assert.equal(reloaded.selection().apiKey, 'legacy-private-key');
  for (const patch of [{ apiKey: 'fake-key' }, { clearApiKey: true }, { model: 'bare-model' }, { baseUrl: 'https://remote.example/v1' }])
    await assert.rejects(store.save({ provider: 'magpie', ...patch }), { status: 400 });
});
