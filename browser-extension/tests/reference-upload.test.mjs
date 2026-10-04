import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = await readFile(new URL('../entrypoints/popup/App.tsx', import.meta.url), 'utf8');
const tree = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ['drawerKey', 'referenceContext', 'applyReferenceUpload', 'applyReferenceRotation'];
const declarations = new Map();
let contextUpdate;
function visit(node) {
  if (ts.isVariableDeclaration(node) && names.includes(node.name.getText(tree))) declarations.set(node.name.getText(tree), node.initializer.getText(tree));
  if (ts.isIfStatement(node) && node.expression.getText(tree) === 'referenceContext.current.key !== drawerKey') contextUpdate = node.getText(tree);
  ts.forEachChild(node, visit);
}
visit(tree);
assert.ok(contextUpdate);
const declaration = name => `const ${name} = ${declarations.get(name)};`;
const compiled = ts.transpileModule(`
  ${declaration('applyReferenceUpload')}
  ${declaration('applyReferenceRotation')}
  const renderContext = (selection, preferences, activeJob) => {
    ${declaration('drawerKey')}
    ${declaration('referenceContext')}
    ${contextUpdate}
  };
  Object.assign(exports, { applyReferenceUpload, applyReferenceRotation, renderContext });
`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function fixture(overrides = {}) {
  const state = { modes: {}, versions: {}, subjects: {}, multi: {}, instructions: {}, selections: [], busy: [] };
  const selectionRevision = { current: 0 }, referenceContext = { current: { key: 'old:style:v1' } };
  const requests = [], exports = {};
  const next = { id: 'next', projectId: 'next-project', image: 'new-image' };
  runInNewContext(compiled, {
    exports, blocked: false, selection: { projectId: 'old', error: '读取失败' }, selectionRevision, referenceContext,
    useRef: () => referenceContext,
    request: async message => { requests.push(message); return next; },
    subjectImage: () => 'retained-subject', multiSubjects: [{ id: 'a', subjectImage: 'a', role: '人物', detail: '帽子' }, { id: 'b', subjectImage: 'b', role: '物品', detail: '' }],
    setBusy: value => state.busy.push(value), setError: value => { state.error = value; }, setHistoryOpen: value => { state.historyOpen = value; }, setGalleryOpen: value => { state.galleryOpen = value; },
    setSelection: value => state.selections.push(value),
    setProjectMode: (id, mode) => { state.modes[id] = mode; },
    setVersions: update => { state.versions = update(state.versions); },
    setSubjectDrafts: update => { state.subjects = update(state.subjects); },
    setMultiSubjectDrafts: update => { state.multi = update(state.multi); },
    setInstructions: update => { state.instructions = update(state.instructions); },
    ...overrides,
  });
  return { ...exports, state, requests, next, selectionRevision };
}

test('fresh reference recovers a failed image and migrates input into a new version', async () => {
  for (const mode of ['style', 'reenact', 'recreate', 'multi-reenact']) {
    const ui = fixture();
    await ui.applyReferenceUpload('new-image', mode, 'retained-instruction');
    assert.equal(ui.requests[0].type, 'alchemy:upload-reference');
    assert.equal(ui.requests[0].image, 'new-image');
    assert.equal(ui.state.selections[0], ui.next);
    assert.equal(ui.state.modes['next-project'], mode);
    assert.equal(ui.state.versions[`next-project:${mode}`], 'new');
    assert.equal(ui.state.instructions[`next-project:${mode}:new`], 'retained-instruction');
    if (mode === 'multi-reenact') assert.deepEqual(Array.from(ui.state.multi[`next-project:${mode}:new`], item => `${item.id}:${item.role}:${item.detail}`), ['a:人物:帽子', 'b:物品:']);
    else assert.equal(ui.state.subjects[`next-project:${mode}`], mode === 'recreate' ? undefined : 'retained-subject');
    assert.deepEqual(ui.state.busy, [true, false]);
    assert.equal(ui.state.error, '');
    assert.equal(ui.state.historyOpen, false);
  }
});

test('rotation still requires an existing image and both entries respect busy protection', async () => {
  const missing = fixture();
  await assert.rejects(missing.applyReferenceRotation('rotated', 'style'), /当前无法修改图片/);
  assert.equal(missing.requests.length, 0);
  for (const entry of ['applyReferenceUpload', 'applyReferenceRotation']) {
    const busy = fixture({ blocked: true, selection: { image: 'old' } });
    await assert.rejects(busy[entry]('new', 'style'), /当前无法修改图片/);
    assert.equal(busy.requests.length, 0);
  }
  const valid = fixture({ selection: { image: 'old' } });
  await valid.applyReferenceRotation('rotated', 'style', 'instruction');
  assert.equal(valid.requests[0].image, 'rotated');
  assert.equal(valid.state.versions['next-project:style'], 'new');
});

test('project, mode, version and away/back changes invalidate an outstanding upload', async () => {
  for (const change of ['project', 'mode', 'version', 'away-back', 'selection']) {
    let resolve;
    const ui = fixture({ request: () => new Promise(done => { resolve = done; }) });
    ui.renderContext({ projectId: 'old' }, { mode: 'style' }, { id: 'v1' });
    const pending = ui.applyReferenceUpload('new-image', 'style', 'instruction');
    if (change === 'selection') ui.selectionRevision.current++;
    else {
      ui.renderContext({ projectId: change === 'project' ? 'other' : 'old' }, { mode: change === 'mode' ? 'reenact' : 'style' }, { id: ['version', 'away-back'].includes(change) ? 'v2' : 'v1' });
      if (change === 'away-back') ui.renderContext({ projectId: 'old' }, { mode: 'style' }, { id: 'v1' });
    }
    resolve(ui.next);
    await assert.rejects(pending, /当前输入已切换/);
    assert.equal(ui.state.selections.length, 0, change);
    for (const key of ['versions', 'subjects', 'multi', 'instructions']) assert.deepEqual(ui.state[key], {}, change);
    assert.deepEqual(ui.state.busy, [true, false]);
  }
});

test('ordinary rerenders preserve pending uploads; request failures preserve all inputs', async () => {
  let resolve;
  const ui = fixture({ request: () => new Promise(done => { resolve = done; }) });
  const pending = ui.applyReferenceUpload('new-image', 'style');
  ui.renderContext({ projectId: 'old' }, { mode: 'style' }, { id: 'v1' });
  resolve(ui.next);
  await pending;
  assert.equal(ui.state.selections[0], ui.next);
  const failed = fixture({ request: async () => { throw new Error('上传失败'); } });
  await assert.rejects(failed.applyReferenceUpload('new-image', 'style'), /上传失败/);
  assert.equal(failed.state.selections.length, 0);
  for (const key of ['versions', 'subjects', 'multi', 'instructions']) assert.deepEqual(failed.state[key], {});
  assert.deepEqual(failed.state.busy, [true, false]);
});
