import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

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

test('returning to projects and paths restores their choices, including an older version and empty lane', async () => {
  let projectModes = {}, versions = { 'A:recreate': 'A-old', 'A:style': 'A-style', 'B:reenact': 'B-third', 'B:style': 'new' };
  const basePreferences = { mode: 'multi-reenact', paired: true };
  const change = (id, mode) => evaluate(['setProjectMode'], {
    setProjectModes: fn => { projectModes = fn(projectModes); }, setPreferences: () => assert.fail('must not change global preference'),
  }).setProjectMode(id, mode);
  change('A', 'recreate'); change('B', 'reenact');
  const jobs = [
    { id: 'A-new', mode: 'recreate' }, { id: 'A-old', mode: 'recreate' }, { id: 'A-style', mode: 'style' },
  ];
  const view = (id, projectJobs) => {
    const preferences = evaluate(['preferences'], { storedSelection: { projectId: id }, projectModes, basePreferences }).preferences;
    const { modeJobs, modeJob } = evaluate(['modeJobs', 'modeJob'], { activeProject: { id, jobs: projectJobs }, versions });
    return { mode: preferences.mode, job: modeJob(preferences.mode) };
  };
  assert.equal(view('A', jobs).mode, 'recreate'); assert.equal(view('A', jobs).job.id, 'A-old');
  assert.equal(view('B', [{ id: 'B-third', mode: 'reenact' }]).job.id, 'B-third');
  change('A', 'style'); assert.equal(view('A', jobs).job.id, 'A-style');
  change('A', 'recreate'); assert.equal(view('A', jobs).job.id, 'A-old');
  change('B', 'style'); assert.equal(view('B', [{ id: 'B-style', mode: 'style' }]).job, undefined);
  assert.equal(view('A', jobs).job.id, 'A-old');
  assert.equal(view('unvisited', []).mode, 'style', 'an unvisited project cannot inherit the last global/project mode');
  versions['A:recreate'] = 'removed'; assert.equal(view('A', jobs).job.id, 'A-new', 'missing version falls back within the same lane');
});

test('subject drafts and durable current input are isolated from other historical versions', () => {
  let selected = { id: 'v1', instruction: 'old instruction' };
  const selection = { projectId: 'A', image: 'current reference', inputVersions: { style: 'v2' }, inputs: { style: { subjectImage: 'current subject', instruction: 'current instruction' } } };
  const drafts = { 'A:style:v2': 'edited latest subject', 'A:style': 'legacy unscoped subject' };
  const ui = evaluate(['subjectKey', 'subjectDraftKey', 'currentInput', 'subjectImage', 'instructionKey', 'taskInstruction'], {
    selection, modeJob: () => selected, subjectDrafts: drafts, instructions: {}, defaultInstructions: { style: 'default' },
    references: { v1: { reenact: { subjectImage: 'historical subject' } }, v2: { reenact: { subjectImage: 'old latest subject' } } },
  });
  assert.equal(ui.subjectImage('style'), 'historical subject');
  assert.equal(ui.taskInstruction('style'), 'old instruction');
  selected = { id: 'v2' };
  assert.equal(ui.subjectImage('style'), 'edited latest subject');
  delete drafts['A:style:v2'];
  assert.equal(ui.subjectImage('style'), 'current subject');
  assert.equal(ui.taskInstruction('style'), 'current instruction');
  selection.inputs.style.subjectImage = '';
  assert.equal(ui.subjectImage('style'), '', 'removal cannot resurrect a historical subject');
  selected = undefined;
  assert.equal(ui.subjectDraftKey('style'), 'A:style:new');
  assert.equal(ui.taskInstruction('style'), 'current instruction');
});

test('historical display never substitutes the latest project reference', () => {
  const selection = { projectId: 'A', image: 'new reference' };
  const display = (job, references) => evaluate(['displayImage', 'displaySelection'], { selection, job, references });
  assert.equal(display(undefined, {}).displayImage, 'new reference');
  assert.equal(display({ id: 'v1' }, {}).displayImage, undefined, 'wait for the historical snapshot instead of showing a wrong reference');
  const saved = display({ id: 'v1' }, { v1: { image: 'old reference' } });
  assert.equal(saved.displayImage, 'old reference');
  assert.equal(saved.displaySelection.image, 'old reference');
  assert.equal(selection.image, 'new reference', 'displaying history must not change durable current input');
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
