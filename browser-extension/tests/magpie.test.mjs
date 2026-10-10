import test from 'node:test';
import assert from 'node:assert/strict';
import { magpieBaseUrl, inspectMagpie } from '../bridge/magpie.mjs';

const json = value => new Response(JSON.stringify(value));
const model = { id: 'source/image-model', kind: 'image', display_name: 'Image model', modalities: { input: ['text'], output: ['image'] } };

test('user connects a local Magpie root or v1 URL without admitting remote or secret-bearing addresses', () => {
  // Given a local gateway, When normalizing, Then v1 occurs once and other hosts/paths are rejected.
  for (const url of ['http://127.0.0.1:3425', 'http://127.0.0.1:3425/v1/']) assert.equal(magpieBaseUrl(url), 'http://127.0.0.1:3425/v1');
  for (const url of ['https://remote.example', 'http://localhost.remote/v1', 'http://user:secret@localhost/v1', 'http://localhost/v1?key=secret', 'http://localhost/images', 'file:///tmp/gateway']) assert.throws(() => magpieBaseUrl(url), /本机 Magpie/);
});

test('user refreshes image models without generating images or exposing gateway metadata', async () => {
  // Given a mixed directory, When connecting, Then only image-output models and safe fields return after two GETs.
  const requests = [];
  const result = await inspectMagpie({ baseUrl: 'http://localhost:3425', fetchImpl: async (url, init) => {
    requests.push({ url, init });
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, 'Bearer magpie-reframe');
    return url.endsWith('/api/hello') ? json({ name: 'magpie', version: '0.1.1153', secret: 'private' }) : json({ data: [
      { ...model, private: 'private' }, { id: 'source/vision', modalities: { input: ['image'], output: ['text'] } },
      { ...model, id: 'bare-name' }, { ...model, id: 'source/chat', modalities: { output: ['text'] } },
    ] });
  } });
  assert.equal(requests.length, 2); assert.equal(requests[1].init.headers['X-Magpie-Drawers'], '1');
  assert.deepEqual(result, { version: '0.1.1153', models: [{ id: model.id, name: model.display_name, inputImages: false }] });
  assert.ok(!JSON.stringify(result).includes('private'));
});

test('user sees safe failures for offline, wrong service, oversized and malformed directories', async () => {
  // Given failed or untrusted responses, When connecting, Then no raw response or credential escapes.
  for (const fetchImpl of [
    async () => { throw new Error('private-account secret'); }, async () => json({ name: 'other', version: '0.1' }),
    async () => new Response('private-account secret', { status: 401 }),
    async () => new Response('private-account secret', { headers: { 'content-length': String(3 * 1024 * 1024) } }),
    async () => new Response('private-account secret'),
    async url => url.endsWith('/api/hello') ? json({ name: 'magpie', version: '0.1' }) : json({ data: {} }),
  ]) await assert.rejects(inspectMagpie({ baseUrl: 'http://localhost:3425', fetchImpl }), error => {
    assert.match(error.message, /Magpie/); assert.doesNotMatch(error.message, /private|secret/); return true;
  });
});

test('user cancels a pending connection or reaches its deadline without starting the next request', async () => {
  // Given a pending hello, When cancelled/timed out, Then directory access never starts.
  for (const cancel of [true, false]) {
    const controller = new AbortController(); let count = 0;
    await assert.rejects(inspectMagpie({ baseUrl: 'http://localhost:3425', signal: controller.signal, timeoutMs: 10,
      fetchImpl: async (_, { signal }) => { count++; if (cancel) { controller.abort(); signal.throwIfAborted(); }
        return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('private')), { once: true })); },
    }), cancel ? { name: 'AbortError' } : /超时/);
    assert.equal(count, 1);
  }
});
