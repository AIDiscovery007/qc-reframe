import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createBridge } from '../bridge/server.mjs';

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'reframe-agent-cli-'));
  const calls = [];
  const manager = agent => ({ busy: false, close() {},
    status: async () => ({ agent, installed: true, version: agent === 'pi' ? '0.84.2' : '0.162.0', executable: `/${agent}`, source: 'npm' }),
    check: async () => { calls.push(`${agent}:check`); return { agent }; },
    update: async () => { calls.push(`${agent}:update`); return { agent }; },
    install: async () => { calls.push(`${agent}:install`); return { agent }; },
  });
  const cli = manager('codex'), piCli = manager('pi');
  const store = () => ({ busy: false, close() {}, selection: () => ({ model: 'kept' }), list: async () => ({}), start: async () => ({}), refresh: async () => ({}) });
  const models = store(), piModels = store();
  let probes = 0;
  const app = await createBridge({ dataDir: dir, cli, piCli, models, piModels,
    compatibility: { snapshot: () => ({}), getCompatibility: async () => { probes++; return {}; } } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(async () => { app.server.closeAllConnections(); await new Promise(r => app.server.close(r)); await rm(dir, { recursive: true, force: true }); });
  const request = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  return { request, calls, cli, piCli, models, piModels, probes: () => probes };
}

test('user manages Pi without checking Codex or changing reverse and generation selections', async t => {
  // Given independent selections, When Pi management is requested, Then only Pi is called and selections persist.
  const s = await setup(t);
  await s.request('/agents/select', { agent: 'pi' });
  const generation = (await s.request('/image-settings')).body;
  const info = await s.request('/cli/status?agent=pi');
  assert.equal(info.body.executable, '/pi'); assert.equal(info.body.compatibility, undefined);
  assert.equal((await s.request('/cli/check?agent=pi', {})).status, 200);
  assert.equal((await s.request('/cli/install?agent=pi', {})).status, 202);
  assert.equal((await s.request('/cli/update?agent=pi', {})).status, 202);
  assert.deepEqual(s.calls, ['pi:check', 'pi:install', 'pi:update']); assert.equal(s.probes(), 0);
  assert.equal((await s.request('/cli/status')).body.executable, '/codex');
  assert.equal((await s.request('/agents')).body.selected, 'pi');
  assert.deepEqual((await s.request('/image-settings')).body, generation);
});

test('user cannot pass arbitrary CLI targets or commands to management endpoints', async t => {
  // Given authenticated access, When a malformed target or command is submitted, Then no manager is invoked.
  const s = await setup(t);
  for (const query of ['?agent=other', '?agent=', '?agent=pi&agent=codex', '?path=/tmp/pi']) {
    assert.equal((await s.request(`/cli/status${query}`)).status, 400);
    for (const action of ['check', 'update', 'install']) assert.equal((await s.request(`/cli/${action}${query}`, {})).status, 400);
  }
  for (const body of [{ command: 'shell' }, { agent: 'pi' }, [], null])
    assert.equal((await s.request('/cli/install?agent=pi', body)).status, 400);
  assert.deepEqual(s.calls, []);
});

test('user cannot install or update either CLI while a model or another CLI is busy', async t => {
  // Given a busy model or CLI, When a conflicting operation arrives, Then neither manager performs a mutation.
  const s = await setup(t);
  for (const owner of [s.models, s.piModels, s.cli, s.piCli]) {
    owner.busy = true;
    for (const agent of ['codex', 'pi']) for (const action of ['install', 'update'])
      assert.equal((await s.request(`/cli/${action}?agent=${agent}`, {})).status, 409);
    owner.busy = false;
  }
  s.piCli.busy = true;
  for (const agent of ['codex', 'pi']) {
    assert.equal((await s.request(`/models?agent=${agent}`)).status, 409);
    assert.equal((await s.request(`/models/verify?agent=${agent}`, { model: 'test' })).status, 409);
  }
  assert.equal((await s.request('/agents/select', { agent: 'pi' })).status, 409);
  assert.deepEqual(s.calls, []);
});

test('user retries after failed install startup without a leaked global CLI lock', async t => {
  // Given installation startup fails, When retried, Then the lock has been released and the next operation succeeds.
  const s = await setup(t);
  s.piCli.install = async () => { throw new Error('installation unavailable'); };
  assert.equal((await s.request('/cli/install?agent=pi', {})).status, 500);
  assert.equal((await s.request('/cli/update', {})).status, 202);
  assert.deepEqual(s.calls, ['codex:update']);
});

test('user cannot start inference while Pi installation is still discovering its source', async t => {
  // Given installation has not yet acquired its manager lock, When inference arrives, Then the bridge startup lock rejects it.
  const s = await setup(t), entered = Promise.withResolvers(), release = Promise.withResolvers();
  s.piCli.install = async () => { entered.resolve(); await release.promise; return { agent: 'pi' }; };
  const installing = s.request('/cli/install?agent=pi', {});
  await entered.promise;
  try {
    for (const agent of ['codex', 'pi']) assert.equal((await s.request(`/models?agent=${agent}`)).status, 409);
    assert.equal((await s.request('/jobs', {})).status, 409);
    assert.equal((await s.request('/models/verify', { model: 'test' })).status, 409);
  } finally { release.resolve(); }
  assert.equal((await installing).status, 202);
  assert.equal((await s.request('/models?agent=pi')).status, 200);
});
