import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentStore } from '../bridge/agents.mjs';

const models = { selectedModel: 'codex-model', selection: () => ({ model: 'codex-model' }) };
const piModels = { selectedModel: 'pi-model', selection: () => ({ model: 'pi-model' }) };
async function setup(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'reframe-agents-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  return { dataDir, models, piModels };
}

test('user switches reverse Agent and restores it without changing Codex generation settings', async t => {
  // Given legacy settings, When Pi is selected and reopened, Then only reverse selection changes.
  const options = await setup(t);
  const store = await createAgentStore(options);
  assert.equal(store.view().selected, 'codex');
  const frozen = store.selection();
  await store.select('pi');
  assert.deepEqual(store.selection(), { agent: 'pi', model: 'pi-model' });
  assert.equal(store.modelStore('codex').selection().model, 'codex-model');
  assert.deepEqual(frozen, { agent: 'codex', model: 'codex-model' });
  assert.equal((await createAgentStore(options)).view().selected, 'pi');
  await assert.rejects(store.select('shell'), /Agent/);
  await assert.rejects(store.select(undefined), /Agent/);
  assert.equal(store.view().selected, 'pi');
});

test('user keeps the previous Agent when saving a switch fails', async t => {
  // Given saved Codex, When atomic replacement fails, Then memory and disk retain Codex.
  const options = await setup(t);
  const store = await createAgentStore(options);
  await store.select('codex');
  await mkdir(join(options.dataDir, 'agent-settings.json.tmp'));
  await assert.rejects(store.select('pi'));
  assert.equal(store.view().selected, 'codex');
  assert.equal(JSON.parse(await readFile(join(options.dataDir, 'agent-settings.json'))).selected, 'codex');
});
