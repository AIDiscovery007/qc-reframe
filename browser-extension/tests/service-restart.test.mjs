import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { createBridge } from '../bridge/server.mjs';

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'reframe-restart-'));
  const models = { busy: false, close() {} }, cli = { busy: false, close() {} };
  const app = await createBridge({ dataDir: dir, models, cli, allowShutdown: true, ...options });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(async () => { app.server.closeAllConnections(); app.server.close(); await rm(dir, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const headers = { Authorization: `Bearer ${app.token}` };
  return { app, dir, models, cli, url, headers, post: () => fetch(`${url}/restart`, { method: 'POST', headers }) };
}

test('restart preserves authentication and Origin checks, and rejects model/CLI activity', async t => {
  let prepared = 0;
  const f = await fixture(t, { restart: async () => { prepared++; return () => {}; } });
  assert.equal((await fetch(`${f.url}/restart`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`${f.url}/restart`, { method: 'POST', headers: { ...f.headers, Origin: 'https://example.com' } })).status, 403);
  for (const busy of [f.models, f.cli]) {
    busy.busy = true;
    assert.equal((await f.post()).status, 409);
    busy.busy = false;
  }
  assert.equal(prepared, 0);
});

test('non-managed service refuses restart, and preparation failure leaves the original service available', async t => {
  const manual = await fixture(t, { allowShutdown: false, restart: () => assert.fail('must not restart') });
  assert.equal((await manual.post()).status, 409);
  const failed = await fixture(t, { restart: async () => { throw new Error('spawn failed'); } });
  assert.equal((await failed.post()).status, 503);
  assert.equal((await fetch(`${failed.url}/health`, { headers: failed.headers })).status, 200);
});

test('restart serializes duplicate requests, returns identity ticket and commits only after acknowledgement', async t => {
  let finish, args, committed = 0;
  const f = await fixture(t, { restart: input => { args = input; return new Promise(resolve => { finish = () => resolve(() => committed++); }); } });
  const before = await (await fetch(`${f.url}/health`, { headers: f.headers })).json();
  assert.equal(before.canRestart, true);
  const first = f.post();
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  const second = f.post();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(committed, 0);
  finish();
  const result = await first;
  assert.equal(result.status, 202);
  const ticket = await result.json();
  assert.equal(ticket.previousInstanceId, before.instanceId);
  assert.equal(ticket.restartId, args.restartId);
  assert.equal(args.dataDir, f.dir);
  assert.equal(args.port, Number(new URL(f.url).port));
  assert.equal((await second).status, 503);
  assert.equal(committed, 1);
});

test('closing the requester during preparation does not strand a stopping service', async t => {
  let finish, committed = 0;
  const f = await fixture(t, { restart: () => new Promise(resolve => { finish = () => resolve(() => committed++); }) });
  const controller = new AbortController();
  const request = fetch(`${f.url}/restart`, { method: 'POST', headers: f.headers, signal: controller.signal });
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(request, { name: 'AbortError' });
  await new Promise(resolve => setTimeout(resolve, 20));
  finish();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(committed, 1);
  assert.equal(f.app.server.listening, false);
});

const source = await readFile(new URL('../lib/service-restart.ts', import.meta.url), 'utf8');
function polling(clock = Date) {
  const exports = {};
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, Date: clock, setTimeout });
  return exports.waitForServiceRestart;
}
const ticket = { previousInstanceId: 'old', restartId: 'request' };
const ready = { service: 'qc-alchemy', ready: true, instanceId: 'new', restartId: 'request', version: 'same-version' };

test('reconnection requires the acknowledged new instance, not just a responsive same-version service', async () => {
  const responses = [new Error('offline'), { ...ready, instanceId: 'old' }, { ...ready, restartId: 'unrelated' }, { ...ready, ready: false }, ready];
  let calls = 0;
  const result = await polling()(ticket, async () => { const value = responses[calls++]; if (value instanceof Error) throw value; return value; }, new AbortController().signal, 1000, async () => {});
  assert.equal(result, ready); assert.equal(calls, 5);
});

test('reconnection times out with executable recovery guidance and cancels when the UI closes', async () => {
  let now = 0;
  await assert.rejects(polling({ now: () => now++ })(ticket, async () => ({ ...ready, instanceId: 'old' }), new AbortController().signal, 3, async () => {}), /npm run status.*npm start/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(polling()(ticket, () => assert.fail('cancelled UI must not poll'), controller.signal), { name: 'AbortError' });
});
