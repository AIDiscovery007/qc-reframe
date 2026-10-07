import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { creationContext, emptyCreationState, resolveCreation, restoredQuickDraft } from '../lib/creation-context.ts';

const source = await readFile(new URL('../entrypoints/popup/App.tsx', import.meta.url), 'utf8');
const tree = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const values = {};
const visit = node => {
  if (ts.isVariableDeclaration(node)) values[node.name.getText(tree)] = node.initializer?.getText(tree);
  if (ts.isCallExpression(node) && node.expression.getText(tree) === 'useEffect' && node.arguments[0]?.getText(tree).includes('type: "alchemy:reference"')) values.restoreJobReference = node.arguments[0].getText(tree);
  if (ts.isCallExpression(node) && node.expression.getText(tree) === 'useEffect' && node.arguments[0]?.getText(tree).includes('if (inputConflict)')) { values.hydrateInput = node.arguments[0].getText(tree); values.hydrateInputDependencies = node.arguments[1].getText(tree); }
  ts.forEachChild(node, visit);
};
visit(tree);
const evaluate = (names, globals) => {
  const exports = {};
  runInNewContext(ts.transpileModule(`${names.map(name => `const ${name} = ${values[name]};`).join('\n')}\nObject.assign(exports, {${names}});`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, { ...globals, exports });
  return exports;
};

test('project, mode and version choices resolve through the public context interface', () => {
  let state = creationContext(emptyCreationState, { type: 'views', views: {
    A: { versions: { recreate: 'A-old', style: 'A-style' } }, B: { versions: { reenact: 'B-third', style: 'new' } },
  } });
  const jobs = [{ id: 'A-new', mode: 'recreate' }, { id: 'A-old', mode: 'recreate' }, { id: 'A-style', mode: 'style' }];
  const resolve = (id, mode, records = jobs) => resolveCreation(state, { projectId: id }, { id, jobs: records }, {}, mode, 'default');
  assert.equal(resolve('A', 'recreate').job.id, 'A-old');
  assert.equal(resolve('B', 'reenact', [{ id: 'B-third', mode: 'reenact' }]).job.id, 'B-third');
  assert.equal(resolve('A', 'style').job.id, 'A-style');
  assert.equal(resolve('B', 'style', [{ id: 'B-style', mode: 'style' }]).job, undefined);
  state = creationContext(state, { type: 'select', key: 'A:recreate', version: 'removed' });
  assert.equal(resolve('A', 'recreate').job.id, 'A-new');
  assert.equal(resolveCreation(state, { projectId: 'B' }, { id: 'A', jobs }, {}, 'style', 'default').job, undefined);
});

test('durable empty input, historical snapshots and version drafts have explicit precedence', () => {
  let state = creationContext(emptyCreationState, { type: 'restore', draft: {
    versions: { 'A:style': 'v1' }, subjectDrafts: { 'A:style:v2': 'edited latest subject', 'A:style': 'legacy unscoped subject' },
  } });
  const selection = { projectId: 'A', image: 'current reference', inputVersions: { style: 'v2' }, inputs: { style: { subjectImage: 'current subject', instruction: 'current instruction' } } };
  const project = { id: 'A', jobs: [{ id: 'v2', mode: 'style' }, { id: 'v1', mode: 'style', instruction: 'old instruction' }] };
  const references = { v1: { image: 'historical reference', reenact: { subjectImage: 'historical subject' } } };
  const view = () => resolveCreation(state, selection, project, references, 'style', 'default');
  assert.equal(view().subjectImage, 'historical subject');
  assert.equal(view().instruction, 'old instruction');
  assert.equal(view().image, 'historical reference');
  assert.equal(selection.image, 'current reference');
  state = creationContext(state, { type: 'select', key: 'A:style', version: 'v2' });
  assert.equal(view().subjectImage, 'edited latest subject');
  assert.equal(view().image, undefined, 'missing historical snapshot must not use current reference');
  state = creationContext(state, { type: 'adopt', selection, savedMode: 'style' });
  assert.equal(view().subjectImage, 'current subject');
  assert.equal(view().instruction, 'current instruction');
  selection.inputs.style.subjectImage = '';
  assert.equal(view().subjectImage, '', 'removal cannot resurrect history');
  state = creationContext(state, { type: 'select', key: 'A:style', version: 'new' });
  assert.equal(view().draftKey, 'A:style:new');
  assert.equal(view().image, 'current reference');
});

test('multi input order, roles, details and instruction changes invalidate only that prompt', () => {
  const subjects = [{ id: 'a', subjectImage: 'image-a', role: '人物', detail: '帽子' }, { id: 'b', subjectImage: 'image-b', role: '场景', detail: '' }];
  const selection = { projectId: 'A', inputVersions: { 'multi-reenact': 'v1' }, inputs: { 'multi-reenact': { subjects, instruction: 'task' } } };
  const project = { id: 'A', jobs: [{ id: 'v1', mode: 'multi-reenact', instruction: 'task', result: {} }] };
  const references = { v1: { reenact: { subjects } } };
  const view = state => resolveCreation(state, selection, project, references, 'multi-reenact', 'default');
  assert.equal(view(emptyCreationState).multiStale, false);
  for (const changed of [[...subjects].reverse(), [{ ...subjects[0], role: '物品' }, subjects[1]], [{ ...subjects[0], detail: '鞋' }, subjects[1]]]) {
    const state = creationContext(emptyCreationState, { type: 'restore', draft: { multiSubjectDrafts: { 'A:multi-reenact:v1': changed } } });
    assert.equal(view(state).multiStale, true);
  }
  const edited = creationContext(emptyCreationState, { type: 'edit', key: 'A:multi-reenact', version: 'v1', instruction: 'new task' });
  assert.equal(view(edited).instructionStale, true);
  assert.equal(view(edited).multiStale, true);
  assert.equal(view(emptyCreationState).instruction, 'task');
});

test('stale quick drafts cannot replace durable inputs or saved views; prompt edits survive', () => {
  const draft = { instructions: { 'A:style:v1': 'stale', 'B:style:new': 'keep' }, subjectDrafts: { 'A:style:new': 'stale' },
    multiSubjectDrafts: {}, promptDrafts: { v1: { promptZh: 'edited' } }, versions: { 'A:style': 'v1', 'B:style': 'new' } };
  const restored = restoredQuickDraft(draft, 'A', true, { B: { versions: { style: 'v2' } } });
  assert.deepEqual(restored.instructions, { 'B:style:new': 'keep' });
  assert.deepEqual(restored.subjectDrafts, {});
  assert.deepEqual(restored.versions, {});
  assert.deepEqual(restored.promptDrafts, draft.promptDrafts);
  assert.equal(draft.instructions['A:style:v1'], 'stale');
});

test('deleting a project clears its drafts and revisions without touching another project', () => {
  const state = creationContext({ ...emptyCreationState, inputRevisions: { A: 2, B: 1 }, instructions: { 'A:style:new': 'gone', 'B:style:new': 'keep' } }, { type: 'delete', projectIds: ['A'] });
  assert.deepEqual(state.inputRevisions, { B: 1 });
  assert.deepEqual(state.instructions, { 'B:style:new': 'keep' });
});

test('complete recreation loads its historical reference and ignores a late snapshot after navigation', async () => {
  const tick = () => new Promise(resolve => setImmediate(resolve));
  for (const cancel of [false, true]) {
    const requests = [], restored = [];
    let finish;
    const ui = evaluate(['restoreJobReference'], {
      job: { id: 'recreate-old', mode: 'recreate' }, references: {}, referenceErrors: {},
      request: message => { requests.push(message); return new Promise(resolve => { finish = resolve; }); },
      setReferences: update => restored.push(update({})), setReferenceErrors: () => assert.fail('unexpected restoration failure'),
    });
    const cleanup = ui.restoreJobReference();
    assert.equal(requests[0].type, 'alchemy:reference');
    assert.equal(requests[0].id, 'recreate-old');
    if (cancel) cleanup();
    finish({ image: 'historical recreate reference' }); await tick();
    assert.equal(restored.length, cancel ? 0 : 1);
    if (!cancel) assert.equal(restored[0]['recreate-old'].image, 'historical recreate reference');
  }
});

function hydrationFixture(overrides = {}) {
  const state = { selections: [], requests: [], versions: { 'A:style': 'v1', 'B:style': 'B-old' }, inputRevisions: {}, subjects: { 'A:style:v1': 'old draft', 'B:style:new': 'other draft' }, multi: {}, instructions: { 'A:style:v1': 'old instruction' } };
  const selectionRevision = { current: 0 };
  const next = { id: 'input-8', projectId: 'A', inputRevision: 8, inputVersions: { style: 'new' }, inputs: { style: { subjectImage: 'durable subject' } } };
  const ui = evaluate(['inputConflict', 'hydrateInput'], {
    activeProject: { id: 'A', inputRevision: 8 }, viewsReady: true, selection: { id: 'input-7', projectId: 'A', inputRevision: 7 }, inputRevisions: state.inputRevisions, selectionRevision,
    request: async message => { state.requests.push(message); return next; },
    setSelection: value => state.selections.push(value), setError: value => { state.error = value; },
    setVersions: fn => { state.versions = fn(state.versions); }, setInputRevisions: fn => { state.inputRevisions = fn(state.inputRevisions); },
    setSubjectDrafts: fn => { state.subjects = fn(state.subjects); }, setMultiSubjectDrafts: fn => { state.multi = fn(state.multi); }, setInstructions: fn => { state.instructions = fn(state.instructions); },
    dispatchCreation: action => {
      const next = creationContext({ ...emptyCreationState, ...state, subjectDrafts: state.subjects, multiSubjectDrafts: state.multi,
        inputRevisions: overrides.inputRevisions || state.inputRevisions }, action);
      Object.assign(state, next, { subjects: next.subjectDrafts, multi: next.multiSubjectDrafts });
    },
    ...overrides,
  });
  return { ...ui, state, next, selectionRevision };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('first input hydration restores durable images and current lane while keeping other projects intact', async () => {
  const ui = hydrationFixture();
  ui.hydrateInput(); await tick();
  assert.equal(ui.state.requests.length, 1);
  assert.equal(ui.state.requests[0].type, 'alchemy:project-reference');
  assert.equal(ui.state.requests[0].id, 'A');
  assert.equal(ui.state.selections[0].inputs.style.subjectImage, 'durable subject');
  assert.equal(ui.state.inputRevisions.A, 8);
  assert.equal(ui.state.versions['A:style'], 'new');
  assert.equal(ui.state.versions['B:style'], 'B-old');
  assert.equal(ui.state.subjects['A:style:v1'], undefined);
  assert.equal(ui.state.subjects['B:style:new'], 'other draft');
  assert.equal(ui.state.instructions['A:style:v1'], undefined);
});

test('remote input changes block editing instead of silently replacing a loaded working input', async () => {
  const ui = hydrationFixture({ selection: { id: 'input-7', projectId: 'A', inputRevision: 7, inputs: { style: { subjectImage: 'local subject' } } }, inputRevisions: { A: 7 } });
  assert.equal(ui.inputConflict, true);
  ui.hydrateInput(); await tick();
  assert.match(ui.state.error, /其他窗口更新/);
  assert.equal(ui.state.requests.length, 0);
  assert.equal(ui.state.selections.length, 0);
  assert.equal(ui.state.versions['A:style'], 'v1');
  assert.equal(ui.state.subjects['A:style:v1'], 'old draft');
});

test('explicit historical navigation keeps its selected version when hydrating the same input revision', async () => {
  const ui = hydrationFixture({ selection: { id: 'history-navigation', projectId: 'A', inputRevision: 8 }, inputRevisions: { A: 8 } });
  ui.hydrateInput(); await tick();
  assert.equal(ui.state.selections[0].inputs.style.subjectImage, 'durable subject');
  assert.equal(ui.state.versions['A:style'], 'v1');
  assert.equal(ui.state.subjects['A:style:v1'], 'old draft');
});

test('input hydration cannot replace a selection after cleanup or a newer user action', async () => {
  for (const change of ['cleanup', 'revision']) {
    let finish;
    const ui = hydrationFixture({ request: () => new Promise(resolve => { finish = resolve; }) });
    const cleanup = ui.hydrateInput();
    if (change === 'cleanup') cleanup(); else ui.selectionRevision.current++;
    finish(ui.next); await tick();
    assert.equal(ui.state.selections.length, 0, change);
    assert.equal(ui.state.versions['A:style'], 'v1', change);
    assert.equal(ui.state.subjects['A:style:v1'], 'old draft', change);
  }
});

for (const entry of ['project list', 'sidebar', 'sidebar during hydration']) test(`reopening the same project from ${entry} reloads durable inputs without changing history`, async () => {
  const durable = { id: 'input-8', projectId: 'A', inputRevision: 8, inputVersions: { style: 'new' }, inputs: { style: { subjectImage: 'saved subject' } } };
  const state = { selection: durable, inputReload: 0, versions: { 'A:style': 'v1' }, inputRevisions: { A: 8 }, historyOpen: entry === 'project list', requests: [] };
  const selectionRevision = { current: 0 };
  let finishPending;
  const render = () => evaluate(['inputConflict', 'hydrateInput', 'hydrateInputDependencies', 'openProject'], {
    ...state, activeProject: { id: 'A', inputRevision: 8 }, viewsReady: true, selectionRevision,
    request: async message => {
      state.requests.push(message.type);
      if (entry === 'sidebar during hydration' && message.type === 'alchemy:project-reference' && !finishPending)
        return new Promise(resolve => { finishPending = resolve; });
      return durable;
    },
    setSelection: value => { state.selection = value; }, setInputReload: fn => { state.inputReload = fn(state.inputReload); },
    setInputRevisions: fn => { state.inputRevisions = fn(state.inputRevisions); }, setVersions: fn => { state.versions = fn(state.versions); },
    setSubjectDrafts: () => assert.fail('same revision must preserve historical drafts'), setMultiSubjectDrafts: () => assert.fail('same revision must preserve historical drafts'), setInstructions: () => assert.fail('same revision must preserve historical drafts'),
    dispatchCreation: action => Object.assign(state, creationContext({ ...emptyCreationState, ...state }, action)),
    setHistoryOpen: value => { state.historyOpen = value; }, setGalleryOpen() {}, setBusy() {}, setError: value => { assert.equal(value, ''); },
  });
  let previous = render();
  previous.hydrateInput();
  assert.equal(state.requests.length, 0, 'already hydrated input needs no request');
  for (let attempt = 0; attempt < 2; attempt++) {
    await previous.openProject({ id: 'A' });
    const next = render();
    assert.equal(state.historyOpen, false);
    assert.ok(next.hydrateInputDependencies.some((value, index) => !Object.is(value, previous.hydrateInputDependencies[index])), 'same id and revision still schedule hydration on every explicit open');
    const cleanup = next.hydrateInput();
    if (entry === 'sidebar during hydration' && attempt === 0) {
      await next.openProject({ id: 'A' });
      const reopened = render();
      assert.ok(reopened.hydrateInputDependencies.some((value, index) => !Object.is(value, next.hydrateInputDependencies[index])), 'reopen while inputs are still absent must restart hydration');
      cleanup(); reopened.hydrateInput();
      finishPending({ ...durable, inputs: { style: { subjectImage: 'obsolete response' } } });
    }
    await tick();
    assert.equal(state.selection.inputs.style.subjectImage, 'saved subject');
    assert.equal(state.versions['A:style'], 'v1', 'explicit historical choice remains unchanged');
    previous = render();
    previous.hydrateInput();
  }
  assert.equal(state.requests.filter(type => type === 'alchemy:project-reference').length, entry === 'sidebar during hydration' ? 3 : 2, 'one hydration per reopen, no loop after restoration');
});
