import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const app = await readFile(new URL('../entrypoints/popup/App.tsx', import.meta.url), 'utf8');
const quick = await readFile(new URL('../entrypoints/popup/QuickWorkspace.tsx', import.meta.url), 'utf8');
function extract(source, names) {
  const tree = ts.createSourceFile('test.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX), values = {};
  const visit = node => {
    if (ts.isVariableDeclaration(node) && names.includes(node.name.getText(tree))) values[node.name.getText(tree)] = node.initializer.getText(tree);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return Object.entries(values).map(([name, value]) => `const ${name} = ${value};`).join('\n');
}
function evaluate(source, globals, names) {
  const exports = {};
  runInNewContext(ts.transpileModule(`${source}\nObject.assign(exports,{${names.join(',')}});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, { exports, ...globals });
  return exports;
}

test('quick handoff captures the displayed version, keeps draft edits and blocks pending inputs', async () => {
  const names = ['draftSnapshot', 'workspaceContext', 'openWorkspace'];
  const script = extract(app, names);
  for (const job of [{ id: 'old' }, { id: 'latest' }, undefined]) {
    const sent = [], errors = [], pending = { current: false };
    const globals = {
      workspace: false, job, activeProject: { jobs: [{ id: 'old' }] }, selection: { id: 'selected', projectId: 'A', image: 'large-image', sourceUrl: '' },
      preferences: { mode: 'style' }, subjectKey: () => 'A:style', versions: {}, instructions: { 'A:style:old': 'unsaved', 'B:style:new': 'other project' },
      subjectDrafts: { 'A:style': 'subject' }, multiSubjectDrafts: {}, promptDrafts: { old: { promptZh: 'edited' }, unrelated: {} }, lang: 'en',
      handoffPending: pending, busy: false, savingMode: false, subjectUnavailable: {}, reading: false, connected: true, loadingProject: false,
      setBusy() {}, setError: value => errors.push(value), request: async message => { sent.push(message); },
    };
    const ui = evaluate(script, globals, ['openWorkspace']);
    await ui.openWorkspace();
    assert.equal(sent[0].context.selection.projectId, 'A');
    assert.equal(sent[0].context.selection.image, undefined);
    assert.equal(sent[0].draft.versions['A:style'], job?.id || 'new');
    assert.equal(sent[0].draft.instructions['A:style:old'], 'unsaved');
    assert.equal(sent[0].draft.instructions['B:style:new'], undefined);
    assert.equal(sent[0].draft.promptDrafts.unrelated, undefined);
    for (const condition of [{ busy: true }, { savingMode: true }, { reading: true }, { subjectUnavailable: { 'A:style': true } }, { loadingProject: true }]) {
      await evaluate(script, { ...globals, ...condition }, ['openWorkspace']).openWorkspace();
      assert.equal(sent.length, 1, JSON.stringify(condition));
    }
    await evaluate(script, { ...globals, request: async () => { throw new Error('tab failed'); } }, ['openWorkspace']).openWorkspace();
    assert.equal(errors.at(-1), 'tab failed');
    assert.equal(pending.current, false);
  }
});

test('quick generation cannot bypass dedicated prompts and ignores late responses after context change', async () => {
  const names = ['generic', 'incomplete', 'inputsReady', 'act'];
  const script = extract(quick, names);
  const job = { id: 'old', mode: 'style', result: { promptZh: 'manually removed placeholder', promptEn: 'valid' }, reenact: {} };
  for (const block of [{ job: { ...job, reenact: undefined } }, { job: { ...job, result: { promptZh: '[SUBJECT]' } } }, { subject: '' }, { disabled: true }, { running: { id: 'running' } }, { pending: { current: true } }]) {
    const ui = evaluate(script, { job, lang: 'zh', subject: 'image', disabled: false, running: undefined, pending: { current: false }, ...block,
      request: () => assert.fail('blocked input must not submit'), setCancelling: () => assert.fail('blocked input must not enter pending'),
    }, ['act']);
    await ui.act(false);
  }
  const sent = [], updated = [], errors = [], mounted = { current: true }, pending = { current: false };
  let finish;
  const ui = evaluate(script, { job, lang: 'en', subject: 'subject', disabled: false, running: undefined, generation: { aspectRatio: { width: 1536, height: 1024 } }, mounted, pending,
    setCancelling() {}, setError: value => errors.push(value), onUpdate: value => updated.push(value), request: message => { sent.push(message); return new Promise(resolve => { finish = resolve; }); },
  }, ['act']);
  const operation = ui.act(false);
  await ui.act(false);
  assert.equal(sent.length, 1, 'rapid repeat must not duplicate a request');
  assert.equal(sent[0].aspectRatio.width, 1536);
  assert.equal(sent[0].subjectImage, 'subject');
  mounted.current = false;
  finish({ id: 'old' }); await operation;
  assert.equal(updated.length, 0);
  assert.equal(pending.current, false);
});

const tree = ts.createSourceFile('App.tsx', app, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let initialize;
const visit = node => {
  if (ts.isCallExpression(node) && node.expression.getText(tree) === 'useEffect' && node.arguments[0]?.getText(tree).includes('const initialize = async')) initialize = node.arguments[0].getText(tree);
  ts.forEachChild(node, visit);
};
visit(tree);

test('workspace handoff restores its own source and mode without polling back to another view', async () => {
  const state = { preferences: {}, selections: [], drafts: {} };
  let refresh;
  const source = { id: 'A', projectId: 'A-project', sourceUrl: '' };
  const context = {
    workspace: true, window: { addEventListener() {}, removeEventListener() {} }, location: { search: '?handoff=test', hash: '', pathname: '/workspace.html' }, history: { replaceState() {} }, URLSearchParams,
    modeRevision: { current: 0 }, visibilityRevision: { current: 0 }, selectionRevision: { current: 0 }, deletingProjects: { current: false },
    request: async message => message.type === 'alchemy:workspace-handoff' ? { selection: source, mode: 'reenact', draft: { instructions: { key: 'unsaved' }, versions: { key: 'new' } } } : { ...source, image: 'A-image' },
    readState: async () => ({ preferences: { paired: true, mode: 'recreate' }, selection: { id: 'B', image: 'B-image' } }),
    pollWhileVisible: callback => { refresh = callback; return () => {}; },
    setPreferences: update => { state.preferences = update(state.preferences); },
    setSelection: value => state.selections.push(value), setInstructions: value => { state.drafts = value; },
    setSubjectDrafts() {}, setMultiSubjectDrafts() {}, setPromptDrafts() {}, setVersions() {}, setLang() {}, setSettings() {}, setDraftReady() {}, setProject() {}, setHistoryOpen() {}, setGalleryOpen() {}, setError: value => assert.fail(value),
  };
  evaluate(`const start = ${initialize};`, context, ['start']).start();
  await new Promise(resolve => setImmediate(resolve));
  await refresh(); await refresh();
  assert.equal(state.preferences.mode, 'reenact');
  assert.equal(state.preferences.paired, true);
  assert.equal(state.selections.at(-1).id, 'A');
  assert.equal(state.selections.at(-1).image, 'A-image');
  assert.equal(state.drafts.key, 'unsaved');
});

test('subject replacement failure clears old input and context changes release upload state', async () => {
  const tree = ts.createSourceFile('QuickWorkspace.tsx', quick, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let reset;
  const visit = node => {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === 'useEffect' && node.arguments[0]?.getText(tree).includes('revision.current++')) reset = node.arguments[0].getText(tree);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  const subjects = [], availability = [], uploading = [], errors = [], revision = { current: 0 };
  let finish;
  const globals = { revision, subjectTab: { current: null }, disabled: false, uploading: false, select() {}, setUploading: value => uploading.push(value), setError: value => errors.push(value),
    onSubject: value => subjects.push(value), onAvailability: value => availability.push(value), normalizeImage: () => new Promise(resolve => { finish = resolve; }),
  };
  const ui = evaluate(`${extract(quick, ['uploadSubject'])}\nconst reset = ${reset};`, globals, ['uploadSubject', 'reset']);
  const cleanup = ui.reset();
  const pending = ui.uploadSubject({ type: 'image/png', size: 100 });
  cleanup(); ui.reset();
  finish('old context image'); await pending;
  assert.equal(subjects.length, 0);
  assert.equal(uploading.at(-1), false);
  assert.equal(availability.at(-1), true);
  await ui.uploadSubject({ type: 'text/plain', size: 100 });
  assert.equal(subjects.at(-1), '', 'failed replacement must not retain an invisible old subject');
  assert.match(errors.at(-1), /PNG/);
  assert.equal(availability.at(-1), true);
});

test('live reminder navigation switches versions without reinitializing and ignores stale results', async () => {
  const script = extract(app, ['navigateReminder', 'onReminderNavigation']);
  const state = { preferences: {}, versions: {}, selections: [], drawers: [], tasks: false, history: true, gallery: true };
  const revision = { current: 0 }, location = { hash: '', pathname: '/workspace.html', search: '?preview=yes' };
  let resolveSlow;
  const jobId = '11111111-1111-4111-8111-111111111111', imageId = '22222222-2222-4222-8222-222222222222';
  const target = { id: jobId, projectId: 'project', mode: 'reenact', generations: [{ id: imageId }] };
  const ui = evaluate(`let cancelled = false, ownContext = false, previous;\n${script}`, {
    workspace: true, selectionRevision: revision, URLSearchParams, Date, location,
    history: { replaceState(_state, _title, url) { state.url = url; location.hash = ''; } },
    query: async path => path.endsWith('33333333-3333-4333-8333-333333333333') ? new Promise(resolve => { resolveSlow = resolve; }) : target,
    request: async () => ({ id: 'reference', projectId: 'project', image: 'image' }),
    setSelection: value => state.selections.push(value), setPreferences: fn => { state.preferences = fn(state.preferences); },
    setVersions: fn => { state.versions = fn(state.versions); }, setTasksOpen: value => { state.tasks = value; },
    setHistoryOpen: value => { state.history = value; }, setGalleryOpen: value => { state.gallery = value; },
    setSettings() {}, setNewProjectOpen() {}, setError: value => { if (value) assert.fail(value); },
    setTargetGeneration: value => { state.generation = value; }, setTargetPrompt: value => { state.prompt = value; },
    dispatchDrawer: value => state.drawers.push(value),
  }, ['navigateReminder', 'onReminderNavigation']);
  location.hash = `#reminder=task=${jobId}&generation=${imageId}`;
  ui.onReminderNavigation(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.url, '/workspace.html?preview=yes');
  assert.equal(state.selections.length, 1); assert.equal(state.preferences.mode, 'reenact');
  assert.equal(state.versions['project:reenact'], jobId); assert.equal(state.generation.id, imageId);
  assert.equal(state.drawers.at(-1).open, true); assert.equal(state.history, false); assert.equal(state.gallery, false);
  await ui.navigateReminder(new URLSearchParams({ task: jobId }));
  assert.equal(state.prompt.jobId, jobId); assert.equal(state.drawers.at(-1).open, false);
  const slow = ui.navigateReminder(new URLSearchParams({ task: '33333333-3333-4333-8333-333333333333' }));
  await ui.navigateReminder(new URLSearchParams({ tasks: 'unread' }));
  resolveSlow(target); await slow;
  assert.equal(state.tasks, true); assert.equal(state.selections.length, 2, 'late task must not replace newer navigation');
});

for (const delayed of ['handoff', 'reference']) for (const kind of ['single', 'batch', 'latest']) {
  test(`reminders during delayed ${delayed} initialization preserve drafts and navigate to ${kind}`, async () => {
    const tick = () => new Promise(resolve => setImmediate(resolve));
    let finish, refresh;
    const gate = new Promise(resolve => { finish = resolve; });
    const source = { id: 'source', projectId: 'source-project', sourceUrl: '' };
    const jobId = '11111111-1111-4111-8111-111111111111', generationId = '22222222-2222-4222-8222-222222222222';
    const target = { id: jobId, projectId: 'target-project', mode: 'style', generations: [{ id: generationId }] };
    const state = { preferences: {}, versions: {}, selections: [], tasks: false, requests: [] }, listeners = new Map();
    const location = new URL('https://example.test/workspace.html?handoff=test&keep=value');
    const handoff = { selection: source, mode: 'reenact', draft: { instructions: { draft: 'unsaved' }, subjectDrafts: { draft: 'subject-image' }, versions: { draft: 'new' } } };
    const cleanup = evaluate(`const start = ${initialize};`, {
      workspace: true, location, URLSearchParams,
      window: { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) },
      history: { replaceState(_state, _title, url) { location.href = new URL(url, location).href; } },
      modeRevision: { current: 0 }, visibilityRevision: { current: 0 }, selectionRevision: { current: 0 }, deletingProjects: { current: false },
      request: async message => {
        if (message.type === 'alchemy:workspace-handoff') { if (delayed === 'handoff') await gate; return handoff; }
        if (message.id === source.projectId) { if (delayed === 'reference') await gate; return { ...source, image: 'source-image' }; }
        return { id: 'target', projectId: target.projectId, image: 'target-image' };
      },
      query: async path => { state.requests.push(path); return target; },
      readState: async () => ({ preferences: { paired: true, mode: 'recreate' }, selection: { id: 'unrelated' } }),
      pollWhileVisible: callback => { refresh = callback; return () => {}; },
      setPreferences: fn => { state.preferences = fn(state.preferences); }, setSelection: value => state.selections.push(value),
      setInstructions: value => { state.instructions = value; }, setSubjectDrafts: value => { state.subjects = value; },
      setVersions: value => { state.versions = typeof value === 'function' ? value(state.versions) : value; },
      setTasksOpen: value => { state.tasks = value; }, setTargetGeneration: value => { state.generation = value; },
      setTargetPrompt: value => { state.prompt = value; }, dispatchDrawer: value => { state.drawer = value; },
      setMultiSubjectDrafts() {}, setPromptDrafts() {}, setLang() {}, setSettings() {}, setNewProjectOpen() {},
      setDraftReady() {}, setProject() {}, setHistoryOpen() {}, setGalleryOpen() {}, setError: value => { if (value) assert.fail(value); },
    }, ['start']).start();
    await tick();
    if (kind === 'latest') {
      location.hash = '#reminder=tasks=unread&request=first';
      location.hash = '#reminder=task=33333333-3333-4333-8333-333333333333&request=second';
    }
    location.hash = kind === 'batch' ? '#reminder=tasks=unread&request=latest' : `#reminder=task=${jobId}&generation=${generationId}&request=latest`;
    finish(); await tick(); await refresh();
    assert.equal(location.search, '?keep=value'); assert.equal(location.hash, '');
    assert.equal(state.instructions.draft, 'unsaved'); assert.equal(state.subjects.draft, 'subject-image'); assert.equal(state.versions.draft, 'new');
    if (kind === 'batch') {
      assert.equal(state.tasks, true); assert.equal(state.selections.at(-1).id, source.id);
      assert.equal(state.preferences.mode, 'reenact'); assert.deepEqual(state.requests, []);
    } else {
      assert.equal(state.tasks, false); assert.equal(state.selections.at(-1).id, 'target');
      assert.equal(state.preferences.mode, 'style'); assert.equal(state.generation.id, generationId);
      assert.equal(state.versions['target-project:style'], jobId); assert.equal(state.drawer.open, true);
      assert.deepEqual(state.requests, [`/jobs/${jobId}`], 'only the latest reminder is consumed');
    }
    cleanup(); assert.equal(listeners.has('hashchange'), false);
  });
}
