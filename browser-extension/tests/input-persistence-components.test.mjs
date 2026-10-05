import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const sources = await Promise.all(['workspace/CanvasWorkspace', 'popup/QuickWorkspace'].map(async path =>
  ts.createSourceFile(path, await readFile(new URL(`../entrypoints/${path}.tsx`, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)));
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const file = { type: 'image/png', size: 100 };
function setup(kind, options = {}) {
  const names = kind === 'canvas' ? ['saveInput', 'readFiles', 'remove', 'update', 'reorder', 'rotateInput'] : ['saveSubject', 'uploadSubject', 'removeSubject', 'rotateSubject'];
  const tree = sources[kind === 'canvas' ? 0 : 1], values = {};
  const visit = node => {
    if (ts.isVariableDeclaration(node) && names.includes(node.name.getText(tree))) values[node.name.getText(tree)] = node.initializer.getText(tree);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  const state = { inputs: [], selected: [], errors: [], availability: [], uploading: [], focus: 0 };
  const subjects = [{ id: 'a', subjectImage: 'old-a', role: '人物', detail: '帽子' }, { id: 'b', subjectImage: 'old-b', role: '场景', detail: '' }];
  const globals = {
    disabled: false, locked: false, pendingInput: { current: false }, revision: { current: 0 }, scope: { current: 'A:style:v1' }, contextKey: 'A:style:v1',
    target: { current: 'subject' }, mode: 'style', subjects, current: undefined, isSubject: true, index: 0,
    normalizeImage: async () => 'new-image', crypto: { randomUUID: () => 'added' },
    setUploading: value => state.uploading.push(value), setUploadError: value => state.errors.push(value), setError: value => state.errors.push(value),
    onAvailability: value => state.availability.push(value), onSelect: value => state.selected.push(value), select: value => state.selected.push(value),
    onSubject: async value => state.inputs.push(value), onSubjects: async value => state.inputs.push(value), onReference: async value => state.inputs.push(value), onReferenceRotate: async value => state.inputs.push(value),
    setSettings() {}, subjectTab: { current: { focus: () => state.focus++ } }, inputArea: { current: null }, settingsPanel: { current: null },
    ...options,
  };
  const exports = {};
  runInNewContext(ts.transpileModule(`${names.map(name => `const ${name} = ${values[name]};`).join('\n')}\nObject.assign(exports, {${names}});`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, { ...globals, exports });
  return { ...exports, state, globals };
}

for (const kind of ['canvas', 'quick']) {
  const upload = (ui, value = file) => kind === 'canvas' ? ui.readFiles([value]) : ui.uploadSubject(value);
  test(`${kind}: invalid upload preserves existing input`, async () => {
    const ui = setup(kind);
    await upload(ui, { type: 'text/plain', size: 100 });
    assert.equal(ui.state.inputs.length, 0);
    assert.equal(ui.state.selected.length, 0);
    assert.ok(ui.state.errors.at(-1));
    assert.deepEqual(ui.state.availability, [false, true]);
  });
  test(`${kind}: upload waits for persistence and rejects rapid duplicate submission`, async () => {
    const saved = deferred(), ui = setup(kind, { onSubject: () => saved.promise });
    const pending = upload(ui); await tick();
    await upload(ui);
    assert.equal(ui.state.selected.length, 0);
    assert.deepEqual(ui.state.availability, [false]);
    saved.resolve(); await pending;
    assert.deepEqual(ui.state.selected, ['subject']);
    assert.deepEqual(ui.state.availability, [false, true]);
  });
  test(`${kind}: persistence failure preserves previous input and selected slot`, async () => {
    const ui = setup(kind, { onSubject: async () => { throw new Error('disk full'); } });
    await upload(ui);
    assert.equal(ui.state.inputs.length, 0);
    assert.equal(ui.state.selected.length, 0);
    assert.equal(ui.state.errors.at(-1), 'disk full');
    assert.equal(ui.globals.pendingInput.current, false);
  });
  test(`${kind}: navigation during normalization cannot save into another input`, async () => {
    const normalized = deferred(), ui = setup(kind, { normalizeImage: () => normalized.promise });
    const pending = upload(ui);
    ui.globals.scope.current = 'B:style:v2';
    normalized.resolve('late-image'); await pending;
    assert.equal(ui.state.inputs.length, 0);
    assert.equal(ui.state.selected.length, 0);
    assert.deepEqual(ui.state.availability, [false], 'late completion cannot release another context');
  });
  test(`${kind}: navigation during save prevents stale selection and availability updates`, async () => {
    const saved = deferred(), ui = setup(kind, { onSubject: () => saved.promise });
    const pending = upload(ui); await tick();
    ui.globals.scope.current = 'B:style:v2';
    saved.resolve(); await pending;
    assert.equal(ui.state.selected.length, 0);
    assert.deepEqual(ui.state.availability, [false]);
  });
  test(`${kind}: rotation propagates persistence failure so preview stays open`, async () => {
    const ui = setup(kind, { onSubject: async () => { throw new Error('save failed'); } });
    await assert.rejects(kind === 'canvas' ? ui.rotateInput('rotated') : ui.rotateSubject('rotated'), /save failed/);
    assert.deepEqual(ui.state.availability, [false, true]);
  });
  test(`${kind}: failed removal keeps selected input`, async () => {
    const ui = setup(kind, { onSubject: async () => { throw new Error('save failed'); } });
    await (kind === 'canvas' ? ui.remove() : ui.removeSubject());
    assert.equal(ui.state.selected.length, 0);
    assert.equal(ui.state.errors.at(-1), 'save failed');
  });
}

test('canvas: batch upload persists only complete images and preserves existing roles/order', async () => {
  const normalized = deferred(), ui = setup('canvas', { target: { current: 'add' }, mode: 'multi-reenact', normalizeImage: () => normalized.promise });
  const pending = ui.readFiles([file]);
  assert.equal(ui.state.inputs.length, 0, 'no temporary empty assets are persisted');
  normalized.resolve('new-image'); await pending;
  assert.equal(ui.state.inputs.length, 1);
  assert.equal(ui.state.inputs[0][0].detail, '帽子');
  assert.equal(ui.state.inputs[0][1].id, 'b');
  assert.equal(ui.state.inputs[0][2].subjectImage, 'new-image');
  assert.deepEqual(ui.state.selected, ['added']);
});

test('canvas: role and ordering failures are handled locally', async () => {
  const ui = setup('canvas', { current: { id: 'a' }, onSubjects: async () => { throw new Error('save failed'); } });
  await ui.update({ role: '物品' });
  await ui.reorder(1);
  assert.equal(ui.state.errors.filter(value => value === 'save failed').length, 2);
  assert.equal(ui.state.selected.length, 0);
});
