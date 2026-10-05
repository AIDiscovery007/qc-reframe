import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = await readFile(new URL('../entrypoints/popup/App.tsx', import.meta.url), 'utf8');
const tree = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ['drawerKey', 'referenceContext', 'saveInput', 'applyReferenceUpload', 'applyReferenceRotation'];
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
  ${declaration('saveInput')}
  ${declaration('applyReferenceUpload')}
  ${declaration('applyReferenceRotation')}
  const renderContext = (selection, preferences, activeJob) => {
    ${declaration('drawerKey')}
    ${declaration('referenceContext')}
    ${contextUpdate}
  };
  Object.assign(exports, { saveInput, applyReferenceUpload, applyReferenceRotation, renderContext });
`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function fixture(overrides = {}) {
  const state = { modes: {}, versions: {}, subjects: {}, multi: {}, instructions: {}, selections: [], busy: [], inputRevisions: {}, refreshNonce: 0 };
  const selectionRevision = { current: 0 }, referenceContext = { current: { key: 'old:style:v1' } };
  const requests = [], exports = {};
  const next = { id: 'next', projectId: 'old', image: 'new-image', inputRevision: 8, inputVersions: { style: 'new', recreate: 'new', reenact: 'new', 'multi-reenact': 'new' } };
  runInNewContext(compiled, {
    exports, blocked: false, selection: { projectId: 'old', inputRevision: 7, error: '读取失败' }, displayImage: undefined, inputSaving: { current: false }, taskInstruction: () => 'default-instruction', selectionRevision, referenceContext,
    useRef: () => referenceContext, modeJob: () => ({ id: 'v1' }),
    request: async message => { requests.push(message); return next; },
    subjectImage: () => 'retained-subject', multiSubjects: [{ id: 'a', subjectImage: 'a', role: '人物', detail: '帽子' }, { id: 'b', subjectImage: 'b', role: '物品', detail: '' }],
    setBusy: value => state.busy.push(value), setError: value => { state.error = value; }, setHistoryOpen: value => { state.historyOpen = value; }, setGalleryOpen: value => { state.galleryOpen = value; },
    setSelection: value => state.selections.push(value),
    setInputRevisions: update => { state.inputRevisions = update(state.inputRevisions); },
    setRefreshNonce: update => { state.refreshNonce = update(state.refreshNonce); },
    setVersions: update => { state.versions = update(state.versions); },
    setSubjectDrafts: update => { state.subjects = update(state.subjects); },
    setMultiSubjectDrafts: update => { state.multi = update(state.multi); },
    setInstructions: update => { state.instructions = update(state.instructions); },
    ...overrides,
  });
  return { ...exports, state, requests, next, selectionRevision };
}

test('reference replacement uses CAS and keeps project identity across every mode', async () => {
  for (const mode of ['style', 'reenact', 'recreate', 'multi-reenact']) {
    const ui = fixture();
    await ui.applyReferenceUpload('new-image', mode, 'retained-instruction');
    assert.equal(ui.requests[0].type, 'alchemy:update-project-input');
    assert.equal(ui.requests[0].projectId, 'old');
    assert.equal(ui.requests[0].expectedRevision, 7);
    assert.equal(ui.requests[0].image, 'new-image');
    assert.equal(ui.state.selections[0], ui.next);
    assert.equal(ui.state.inputRevisions.old, 8);
    assert.equal(ui.state.versions[`old:${mode}`], 'new');
    assert.equal(ui.requests[0].referenceJobId, 'v1');
    assert.equal(ui.requests[0].instruction, 'retained-instruction');
    if (mode === 'multi-reenact') assert.deepEqual(Array.from(ui.requests[0].subjects, item => `${item.id}:${item.role}:${item.detail}`), ['a:人物:帽子', 'b:物品:']);
    else assert.equal(ui.requests[0].subjectImage, mode === 'recreate' ? undefined : 'retained-subject');
    for (const key of ['subjects', 'multi', 'instructions']) assert.equal(Object.keys(ui.state[key]).length, 0, 'durable input must not be duplicated in session drafts');
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
    const busy = fixture({ blocked: true, displayImage: 'old' });
    await assert.rejects(busy[entry]('new', 'style'), /当前无法修改图片/);
    assert.equal(busy.requests.length, 0);
  }
  const valid = fixture({ displayImage: 'old' });
  await valid.applyReferenceRotation('rotated', 'style', 'instruction');
  assert.equal(valid.requests[0].image, 'rotated');
  assert.equal(valid.state.versions['old:style'], 'new');
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
    await pending;
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

test('subject-only saves retain the server version and never write another historical draft', async () => {
  const ui = fixture();
  ui.next.inputVersions = { style: 'v1' };
  ui.next.inputs = { style: { subjectImage: 'replacement', instruction: 'same instruction' } };
  ui.state.subjects = { 'old:style:v1': 'previous draft', 'old:style:v0': 'historical draft' };
  ui.state.instructions = { 'old:style:v1': 'previous instruction', 'other:style:v1': 'other project instruction' };
  await ui.saveInput('style', undefined, 'same instruction', 'replacement');
  assert.equal(ui.requests[0].image, undefined);
  assert.equal(ui.requests[0].subjectImage, 'replacement');
  assert.equal(ui.requests[0].projectId, 'old');
  assert.equal(ui.state.versions['old:style'], 'v1');
  assert.equal(ui.state.selections[0].inputs.style.subjectImage, 'replacement');
  assert.equal(ui.state.subjects['old:style:v1'], undefined);
  assert.equal(ui.state.subjects['old:style:v0'], 'historical draft');
  assert.equal(ui.state.instructions['old:style:v1'], undefined);
  assert.equal(ui.state.instructions['other:style:v1'], 'other project instruction');
  assert.equal(ui.state.subjects['old:style:new'], undefined);
  assert.equal(ui.state.subjects['old:style'], undefined);
});

test('CAS rejection preserves input and releases the transaction for retry', async () => {
  let fail = true;
  const sent = [];
  const ui = fixture({ request: async message => {
    sent.push(message);
    if (fail) throw new Error('项目输入已变化，请刷新后重试');
    return ui.next;
  } });
  await assert.rejects(ui.saveInput('reenact', 'new', 'instruction'), /项目输入已变化/);
  assert.equal(sent[0].expectedRevision, 7);
  assert.equal(ui.state.selections.length, 0);
  assert.deepEqual(ui.state.subjects, {});
  fail = false;
  await ui.saveInput('reenact', 'new', 'instruction');
  assert.equal(ui.state.selections.length, 1);
});

test('input transaction excludes duplicate writes before React rerenders', async () => {
  let finish;
  const sent = [];
  const ui = fixture({ request: message => { sent.push(message); return new Promise(resolve => { finish = resolve; }); } });
  const pending = ui.saveInput('style', 'first', 'instruction');
  await assert.rejects(ui.saveInput('style', 'second', 'instruction'), /当前无法修改图片/);
  assert.equal(sent.length, 1);
  finish(ui.next); await pending;
});
