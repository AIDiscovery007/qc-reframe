import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const app = await readFile(new URL('../entrypoints/popup/App.tsx', import.meta.url), 'utf8');
const tree = ts.createSourceFile('App.tsx', app, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ['applyGenerationHealth', 'saveImageSettings'], declarations = {};
function visit(node) {
  if (ts.isVariableDeclaration(node) && names.includes(node.name.getText(tree))) declarations[node.name.getText(tree)] = node.initializer.getText(tree);
  ts.forEachChild(node, visit);
}
visit(tree);
const deferred = () => Promise.withResolvers();
const health = provider => ({ generationProvider: provider, generationReady: provider !== 'unavailable' });
function fixture(provider = 'codex') {
  const requests = [], reads = [], state = { magpie: provider === 'magpie', ready: true, pending: false, error: '', settingsRevision: 0 };
  const sync = { current: { saving: false } }, exports = {};
  for (const name of names) assert.ok(declarations[name], `${name} must synchronize the production App`);
  const source = names.map(name => `const ${name} = ${declarations[name]};`).join('\n') + '\nObject.assign(exports,{applyGenerationHealth,saveImageSettings});';
  runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
    exports, generationSettingsSync: sync,
    setGenerationModel: value => { state.generationModel = value; },
    setMagpie: value => { state.magpie = value; }, setGenerationReady: value => { state.ready = value; },
    setGenerationSettingsPending: value => { state.pending = value; }, setError: value => { state.error = value; },
    setGenerationSettingsError: value => { state.error = value; }, setImageSettingsRevision: update => { state.settingsRevision = update(state.settingsRevision); },
    request: message => { const d = deferred(); requests.push({ ...d, message }); return d.promise; },
    query: path => { assert.equal(path, '/health'); const d = deferred(); reads.push(d); return d.promise; },
  });
  return { ...exports, requests, reads, state, sync };
}
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
for (const [from, to] of [['codex', 'magpie'], ['magpie', 'codex']]) test(`user saves ${from} to ${to} and can submit only after fresh channel readiness arrives`, async () => {
  // Given old ready configuration, When saving, Then submissions stay blocked through the fresh health read and use the new channel immediately afterward.
  const f = fixture(from), saving = f.saveImageSettings({ provider: to });
  assert.equal(f.state.pending, true); assert.equal(f.state.ready, false);
  f.requests[0].resolve({ provider: to }); await tick();
  assert.equal(f.state.settingsRevision, 1, 'a remounted settings panel must reread the committed configuration');
  assert.equal(f.reads.length, 1); assert.equal(f.state.pending, true); assert.equal(f.state.ready, false);
  f.reads[0].resolve(health(to)); await saving;
  assert.equal(f.state.pending, false); assert.equal(f.state.ready, true); assert.equal(f.state.magpie, to === 'magpie');
});

test('user channel cannot roll back when a health poll started before or during saving arrives late', async () => {
  const f = fixture(), before = f.sync.current, saving = f.saveImageSettings({ provider: 'magpie' }), during = f.sync.current;
  assert.equal(f.applyGenerationHealth(health('codex'), before), false);
  assert.equal(f.applyGenerationHealth(health('codex'), during), false);
  f.requests[0].resolve({ provider: 'magpie' }); await tick(); f.reads[0].resolve(health('magpie')); await saving;
  assert.equal(f.applyGenerationHealth(health('codex'), before), false);
  assert.equal(f.applyGenerationHealth(health('codex'), during), false);
  assert.equal(f.state.magpie, true); assert.equal(f.state.ready, true);
});

test('user rapid saves retain the latest channel when the earlier refresh finishes last', async () => {
  const f = fixture(), first = f.saveImageSettings({ provider: 'magpie' });
  f.requests[0].resolve({ provider: 'magpie' }); await tick();
  const second = f.saveImageSettings({ provider: 'codex' });
  f.requests[1].resolve({ provider: 'codex' }); await tick();
  f.reads[1].resolve(health('codex')); await second;
  f.reads[0].resolve(health('magpie')); await first;
  assert.equal(f.state.magpie, false); assert.equal(f.state.ready, true); assert.equal(f.state.pending, false);
});

test('user remains unable to generate after a refresh failure until a fresh health response recovers', async () => {
  const f = fixture(), saving = f.saveImageSettings({ provider: 'magpie' });
  f.requests[0].resolve({ provider: 'magpie' }); await tick(); f.reads[0].reject(new Error('offline')); await saving;
  assert.equal(f.state.ready, false); assert.ok(f.state.error);
  f.applyGenerationHealth(health('magpie'), f.sync.current);
  assert.equal(f.state.ready, true); assert.equal(f.state.pending, false); assert.equal(f.state.error, '');
});

test('user failed settings write preserves its error and refreshes the still-active provider', async () => {
  const f = fixture(), saving = f.saveImageSettings({ provider: 'magpie' });
  const rejected = assert.rejects(saving, /write failed/);
  f.requests[0].reject(new Error('write failed')); await tick(); f.reads[0].resolve(health('codex')); await rejected;
  assert.equal(f.state.magpie, false); assert.equal(f.state.ready, true); assert.equal(f.state.pending, false);
});


test('user size profile follows only the accepted image-model health snapshot', async () => {
  // Given a prior health poll, When a model save refreshes health, Then stale polls and the reverse-model fallback cannot select the size profile.
  const f = fixture(), before = f.sync.current, saving = f.saveImageSettings({ provider: 'magpie' });
  f.requests[0].resolve({ provider: 'magpie' }); await tick();
  f.reads[0].resolve({ ...health('magpie'), generationModel: 'gpt-image-2', model: 'reverse-model' }); await saving;
  assert.equal(f.state.generationModel, 'gpt-image-2');
  f.applyGenerationHealth({ ...health('magpie'), generationModel: 'gemini-3-pro-image' }, before);
  assert.equal(f.state.generationModel, 'gpt-image-2');
  f.applyGenerationHealth({ ...health('magpie'), model: 'reverse-model' }, f.sync.current);
  assert.equal(f.state.generationModel, undefined);
});

test('user concurrent bottom and settings saves cannot overwrite each other in the same tick', async () => {
  // Given a save has started, When another control saves before it commits, Then only the original write reaches the service.
  const f = fixture('magpie'), first = f.saveImageSettings({ provider: 'magpie', model: 'old-to-new' });
  const second = f.saveImageSettings({ provider: 'magpie', model: 'conflicting' });
  const outcome = second.then(() => 'resolved', error => error.message);
  await tick();
  const writes = f.requests.length;
  f.requests[0].resolve({ provider: 'magpie' }); await tick();
  // Clean up both writes on the old implementation so the failure does not leave promises pending.
  if (f.requests[1]) { f.requests[1].resolve({ provider: 'magpie' }); await tick(); }
  for (const read of f.reads) read.resolve(health('magpie'));
  await Promise.allSettled([first, second]);
  assert.equal(writes, 1, 'a synchronous global saving guard must reject reentry');
  assert.match(await outcome, /保存|稍候/);
});
