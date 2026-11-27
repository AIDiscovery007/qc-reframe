import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentRegistry, LEGACY_AGENT } from '../bridge/agents.mjs';
import { missingAgentCli, setupNotice } from '../lib/agents.ts';

const store = (model, extra = {}) => ({ selectedModel: model, busy: false, selection: () => ({ model }), close() {}, ...extra });
const run = async () => ({ text: '{}' });
const adapters = () => [
  { id: 'codex', label: 'Codex', models: store('codex-model'), cli: { busy: false, close() {} }, run, compatibility: true },
  { id: 'pi', label: 'Pi', models: store('pi-model'), cli: { busy: false, install() {}, close() {} }, run },
];
async function setup(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'reframe-agents-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  return { dataDir, adapters: adapters() };
}

test('user switches reverse Agent and restores it without changing Codex generation settings', async t => {
  // Given legacy settings, When Pi is selected and reopened, Then only reverse selection changes.
  const options = await setup(t);
  const registry = await createAgentRegistry(options);
  assert.equal(registry.view().selected, 'codex');
  const frozen = registry.selection();
  await registry.select('pi');
  assert.deepEqual(registry.selection(), { agent: 'pi', model: 'pi-model' });
  assert.equal(registry.get('codex').models.selection().model, 'codex-model');
  assert.deepEqual(frozen, { agent: 'codex', model: 'codex-model' });
  assert.equal((await createAgentRegistry({ ...options, adapters: adapters() })).view().selected, 'pi');
  await assert.rejects(registry.select('shell'), error => error.status === 400 && /Agent/.test(error.message));
  await assert.rejects(registry.select(undefined), /Agent/);
  assert.equal(registry.view().selected, 'pi');
});

test('user keeps the previous Agent when saving a switch fails', async t => {
  // Given saved Codex, When atomic replacement fails, Then memory and disk retain Codex.
  const options = await setup(t);
  const registry = await createAgentRegistry(options);
  await registry.select('codex');
  await mkdir(join(options.dataDir, 'agent-settings.json.tmp'));
  await assert.rejects(registry.select('pi'));
  assert.equal(registry.view().selected, 'codex');
  assert.equal(JSON.parse(await readFile(join(options.dataDir, 'agent-settings.json'))).selected, 'codex');
});

test('user sees every registered Agent with its own label, model and install capability', async t => {
  // Given a third local Agent adapter, When the catalog is read, Then the UI receives labels from the registry.
  const options = await setup(t);
  options.adapters.push({ id: 'local-cli', label: 'Local CLI', models: store(null), run });
  const registry = await createAgentRegistry(options);
  assert.deepEqual(registry.view(), { selected: 'codex', agents: [
    { id: 'codex', label: 'Codex', model: 'codex-model', installable: false, cli: null },
    { id: 'pi', label: 'Pi', model: 'pi-model', installable: true, cli: null },
    { id: 'local-cli', label: 'Local CLI', model: null, installable: false, cli: null },
  ] });
  await registry.select('local-cli');
  assert.equal(registry.get().label, 'Local CLI');
  assert.equal(registry.get().cli, undefined);
});

test('user history without a frozen Agent keeps the legacy Codex meaning and unknown snapshots fail explicitly', async t => {
  // Given Pi selected, When old or unknown snapshots are resolved, Then no silent fallback to the current Agent happens.
  const options = await setup(t);
  const registry = await createAgentRegistry(options);
  await registry.select('pi');
  assert.equal(LEGACY_AGENT, 'codex');
  assert.equal(registry.frozen({ model: 'old' }).id, 'codex');
  assert.equal(registry.frozen(undefined).id, 'codex');
  assert.equal(registry.frozen({ agent: 'pi' }).id, 'pi');
  assert.throws(() => registry.frozen({ agent: 'removed' }), error => error.status === 400);
});

test('user sees busy state from any Agent and a corrupt selection file is preserved', async t => {
  // Given one busy model store and one busy CLI, Then the registry reports both; a corrupt file is not overwritten.
  const options = await setup(t);
  options.adapters[1].models.busy = true;
  options.adapters[0].cli.busy = true;
  const registry = await createAgentRegistry(options);
  assert.equal(registry.busy, true);
  assert.equal(registry.cliBusy, true);
  await writeFile(join(options.dataDir, 'agent-settings.json'), JSON.stringify({ selected: 'shell' }));
  await assert.rejects(createAgentRegistry({ ...options, adapters: adapters() }), /agent-settings\.json/);
  assert.equal(JSON.parse(await readFile(join(options.dataDir, 'agent-settings.json'))).selected, 'shell');
});

test('user cannot start the service with invalid or duplicate Agent adapters', async t => {
  // Given malformed adapters, When the registry is created, Then it fails before any request is served.
  const { dataDir } = await setup(t);
  await assert.rejects(createAgentRegistry({ dataDir, adapters: [] }), /适配器/);
  await assert.rejects(createAgentRegistry({ dataDir, adapters: [{ id: 'Bad Id', label: 'x', models: store(null), run }] }), /适配器/);
  await assert.rejects(createAgentRegistry({ dataDir, adapters: [{ id: 'a', label: 'x', models: store(null) }] }), /适配器/);
  await assert.rejects(createAgentRegistry({ dataDir, adapters: [{ id: 'a', label: 'x', models: store(null), run }, { id: 'a', label: 'y', models: store(null), run }] }), /重复/);
});

test('user sees which Agent CLIs are installed after one local detection, and a failed detection stays unknown', async t => {
  // Given Codex missing, Pi installed and a third Agent whose detection fails.
  const options = await setup(t);
  const detected = [];
  const cli = (id, state) => {
    let last = null;
    return { busy: false, close() {}, peek: () => last, detect: async () => {
      detected.push(id);
      if (!state) throw new Error('spawn failed');
      last = { ...state, executable: `/bin/${id}`, latestVersion: '9.9.9', instructions: { message: 'private' } };
      return last;
    } };
  };
  options.adapters[0].cli = cli('codex', { installed: false, version: null, source: 'missing' });
  options.adapters[1].cli = cli('pi', { installed: true, version: '0.84.2', source: 'npm' });
  options.adapters.push({ id: 'local-cli', label: 'Local CLI', models: store(null), run, cli: cli('local-cli') });
  const registry = await createAgentRegistry(options);
  // Before detection nothing is known, so no Agent is reported missing.
  assert.deepEqual(registry.view().agents.map(agent => agent.cli), [null, null, null]);
  // When the catalog is detected.
  const catalog = await registry.detect();
  // Then every CLI was inspected once, only installation facts reach the catalog, and the failure stays unknown.
  assert.deepEqual(detected, ['codex', 'pi', 'local-cli']);
  assert.deepEqual(catalog.agents.map(agent => agent.cli), [
    { installed: false, version: null, source: 'missing' },
    { installed: true, version: '0.84.2', source: 'npm' },
    null,
  ]);
  assert.equal(catalog.selected, 'codex');
  assert.deepEqual(registry.view(), catalog);
});

test('user is offered installed Agents only when the selected Agent CLI is detected missing, and nothing is switched', () => {
  const agent = (id, label, cli) => ({ id, label, model: null, cli });
  const installed = { installed: true, version: '1.0.0', source: 'npm' }, missing = { installed: false, version: null, source: 'missing' };
  const catalog = { selected: 'codex', agents: [agent('codex', 'Codex', missing), agent('pi', 'Pi', null), agent('claude', 'Claude Code', installed)] };
  // Given Codex missing, Pi unknown and Claude Code installed, When the notice is built, Then only Claude Code is offered.
  const found = missingAgentCli(catalog, 'codex');
  assert.deepEqual(found, { agent: 'codex', label: 'Codex', alternatives: ['Claude Code'] });
  assert.deepEqual(setupNotice(found), { text: '未找到 Codex CLI，本机已安装 Claude Code，可在插件模型中切换', action: '切换 Agent', section: 'models' });
  // Given no other installed Agent, Then the missing CLI points to its own management section.
  const alone = missingAgentCli({ selected: 'claude', agents: [agent('codex', 'Codex', missing), agent('claude', 'Claude Code', missing)] }, 'claude');
  assert.deepEqual(setupNotice(alone), { text: '未找到 Claude Code CLI，请先完成安装', action: '检查 Claude Code', section: 'claude-cli' });
  assert.deepEqual(setupNotice({ agent: 'codex', label: 'Codex', alternatives: [] }), { text: '未找到 Codex CLI，请先完成安装', action: '检查 Codex', section: 'cli' });
  assert.equal(setupNotice({ agent: 'local-cli', label: 'Local CLI', alternatives: [] }).section, 'models');
  // Given an installed, undetected or stale selection, or an older service without detection, Then no CLI is claimed missing.
  for (const [value, selected] of [[{ ...catalog, selected: 'claude' }, 'claude'], [{ ...catalog, selected: 'pi' }, 'pi'], [catalog, 'pi'],
    [{ selected: 'codex', agents: [{ id: 'codex', label: 'Codex', model: null }] }, 'codex'], [undefined, 'codex']])
    assert.equal(missingAgentCli(value, selected), undefined);
  assert.deepEqual(setupNotice(undefined), { text: '先为 QC-Reframe 选择并验证模型', action: '选择模型', section: 'models' });
});
