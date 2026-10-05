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
  const original = globals;
  globals = { noticeNavigation: { current: undefined }, setNewProjectOpen() {}, setTasksOpen() {}, setViewsReady() {}, setProjectModes() {}, setInputRevisions() {}, ...globals,
    setProjectMode: original.setProjectMode || ((_id, mode) => original.setPreferences(value => ({ ...value, mode }))),
    request: async message => message.type === 'alchemy:project-views' ? original.projectViews || {} : original.request(message),
  };
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
      workspace: false, job, activeProject: { jobs: [{ id: 'old' }] }, selection: { id: 'selected', projectId: 'A', inputRevision: 7, image: 'large-image', sourceUrl: '' },
      preferences: { mode: 'style' }, subjectKey: () => 'A:style', versions: {}, instructions: { 'A:style:old': 'unsaved', 'B:style:new': 'other project' },
      subjectDrafts: { 'A:style': 'subject' }, multiSubjectDrafts: {}, promptDrafts: { old: { promptZh: 'edited' }, unrelated: {} }, lang: 'en',
      handoffPending: pending, busy: false, savingMode: false, subjectUnavailable: {}, reading: false, connected: true, loadingProject: false,
      setBusy() {}, setError: value => errors.push(value), request: async message => { sent.push(message); },
    };
    const ui = evaluate(script, globals, ['openWorkspace']);
    await ui.openWorkspace();
    assert.equal(sent[0].context.selection.projectId, 'A');
    assert.equal(sent[0].context.selection.image, undefined);
    assert.equal(sent[0].context.selection.inputRevision, 7);
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

test('quick reopen keeps durable project choices while restoring inputs; explicit handoff and legacy drafts retain their choices', async () => {
  for (const scenario of ['saved-project', 'legacy-draft', 'explicit-handoff']) {
    const state = { modes: {}, versions: {}, preferences: {} };
    const setter = key => value => { state[key] = typeof value === 'function' ? value(state[key]) : value; };
    let refresh;
    const source = { id: 'reference-A', projectId: 'A' };
    const saved = { mode: 'style', selection: source, draft: {
      versions: { 'A:style': 'old-choice', 'B:reenact': 'old-B', 'C:style': 'legacy-C' },
      instructions: { 'A:style:old-choice': 'unsaved input' }, subjectDrafts: { 'A:style': 'subject-image' },
    } };
    const context = {
      workspace: scenario === 'explicit-handoff',
      projectViews: scenario === 'legacy-draft' ? {} : {
        A: { mode: 'recreate', versions: { style: 'new-choice', recreate: 'chosen-recreate' } },
        B: { mode: 'reenact', versions: { reenact: 'chosen-B' } },
      },
      window: { addEventListener() {}, removeEventListener() {} },
      location: { search: scenario === 'explicit-handoff' ? '?handoff=test' : '', hash: '', pathname: '/popup.html' },
      history: { replaceState() {} }, URLSearchParams,
      modeRevision: { current: 0 }, visibilityRevision: { current: 0 }, selectionRevision: { current: 0 }, deletingProjects: { current: false },
      request: async message => message.type === 'alchemy:project-reference' ? { ...source, image: 'reference' } : saved,
      readState: async () => ({ preferences: { paired: true, mode: 'reenact' }, selection: source }),
      pollWhileVisible: callback => { refresh = callback; return () => {}; },
      setProjectModes: setter('modes'), setProjectMode: (id, mode) => { state.modes[id] = mode; },
      setVersions: setter('versions'), setPreferences: setter('preferences'), setSelection: setter('selection'),
      setInstructions: setter('instructions'), setSubjectDrafts: setter('subjects'),
      setMultiSubjectDrafts() {}, setPromptDrafts() {}, setLang() {}, setSettings() {}, setDraftReady() {}, setProject() {}, setHistoryOpen() {}, setGalleryOpen() {},
      setError: value => { if (value) assert.fail(value); }, setDraftError: value => assert.fail(value),
    };
    evaluate(`const start = ${initialize};`, context, ['start']).start();
    await new Promise(resolve => setImmediate(resolve));
    await refresh();
    assert.equal(state.modes.A, scenario === 'saved-project' ? 'recreate' : 'style', scenario);
    assert.equal(state.versions['A:style'], scenario === 'saved-project' ? 'new-choice' : 'old-choice', scenario);
    assert.equal(state.versions['B:reenact'], scenario === 'saved-project' ? 'chosen-B' : 'old-B', scenario);
    if (scenario !== 'legacy-draft') assert.equal(state.versions['A:recreate'], 'chosen-recreate');
    assert.equal(state.versions['C:style'], 'legacy-C');
    assert.equal(state.instructions['A:style:old-choice'], 'unsaved input');
    assert.equal(state.subjects['A:style'], 'subject-image');
  }
});

test('workspace handoff restores its own source and mode without polling back to another view', async () => {
  const state = { preferences: {}, selections: [], drafts: {} };
  let refresh;
  const source = { id: 'A', projectId: 'A-project', sourceUrl: '', inputRevision: 8 };
  const context = {
    workspace: true, window: { addEventListener() {}, removeEventListener() {} }, location: { search: '?handoff=test', hash: '', pathname: '/workspace.html' }, history: { replaceState() {} }, URLSearchParams,
    modeRevision: { current: 0 }, visibilityRevision: { current: 0 }, selectionRevision: { current: 0 }, deletingProjects: { current: false },
    request: async message => message.type === 'alchemy:workspace-handoff' ? { selection: source, mode: 'reenact', draft: { instructions: { key: 'unsaved' }, versions: { key: 'new' } } } : { ...source, id: 'A-current', inputRevision: 8, image: 'A-image' },
    readState: async () => ({ preferences: { paired: true, mode: 'recreate' }, selection: { id: 'B', image: 'B-image' } }),
    pollWhileVisible: callback => { refresh = callback; return () => {}; },
    setPreferences: update => { state.preferences = update(state.preferences); },
    setSelection: value => state.selections.push(value), setInstructions: value => { state.drafts = value; },
    setSubjectDrafts() {}, setMultiSubjectDrafts() {}, setPromptDrafts() {}, setVersions() {}, setLang() {}, setSettings() {}, setNewProjectOpen() {}, setTasksOpen() {}, setDraftReady() {}, setProject() {}, setHistoryOpen() {}, setGalleryOpen() {}, setError: value => { if (value) assert.fail(value); },
  };
  evaluate(`const start = ${initialize};`, context, ['start']).start();
  await new Promise(resolve => setImmediate(resolve));
  await refresh(); await refresh();
  assert.equal(state.preferences.mode, 'reenact');
  assert.equal(state.preferences.paired, true);
  assert.equal(state.selections.at(-1).id, 'A-current');
  assert.equal(state.selections.at(-1).inputRevision, 8);
  assert.equal(state.selections.at(-1).image, 'A-image');
  assert.equal(state.drafts.key, 'unsaved');
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


test('live workspace handoff merges drafts, routes settings/tasks, and ignores superseded responses', async () => {
  const state = { instructions: { 'other:style:new': 'keep me' }, versions: { 'other:style': 'old' }, inputRevisions: {}, subjects: { other: 'image' }, selections: [], mode: '', settings: false, tasks: false };
  const revision = { current: 0 }, pending = new Map();
  const setter = key => value => { state[key] = typeof value === 'function' ? value(state[key] || {}) : value; };
  const handoff = { selection: { id: 'source', projectId: 'project' }, mode: 'reenact', draft: { instructions: { 'project:reenact:new': 'incoming' }, versions: { 'project:reenact': 'new' } } };
  const ui = evaluate(`let cancelled = false, ownContext = false, previous;\n${extract(app, ['restoreDraft', 'navigateHandoff', 'navigateReminder'])}`, {
    selectionRevision: revision, workspace: true, URLSearchParams,
    request: message => {
      if (message.id === 'slow-handoff' || message.id === 'slow-project') return new Promise(resolve => pending.set(message.id, resolve));
      return Promise.resolve(message.type === 'alchemy:workspace-handoff' ? handoff : { id: 'reference', projectId: message.id, image: 'reference-image' });
    },
    setSelection: value => state.selections.push(value), setProject() {}, setProjectMode: (_id, mode) => { state.mode = mode; },
    setInputRevisions: setter('inputRevisions'), setInstructions: setter('instructions'), setVersions: setter('versions'), setSubjectDrafts: setter('subjects'), setMultiSubjectDrafts: setter('multi'), setPromptDrafts: setter('prompts'), setLang() {},
    setSettings: setter('settings'), setSettingsSection: setter('section'), setTasksOpen: setter('tasks'), setNewProjectOpen() {}, setHistoryOpen() {}, setGalleryOpen() {},
    setError: value => { if (value) assert.fail(value); },
  }, ['navigateHandoff', 'navigateReminder']);
  await ui.navigateHandoff(new URLSearchParams({ handoff: 'one', view: 'settings', section: 'models' }));
  assert.equal(state.settings, true); assert.equal(state.section, 'models'); assert.equal(state.tasks, false); assert.equal(state.mode, 'reenact');
  assert.equal(state.selections.at(-1).image, 'reference-image');
  assert.equal(state.selections.at(-1).error, undefined);
  assert.equal(state.inputRevisions.project, 0);
  assert.equal(state.instructions['other:style:new'], 'keep me'); assert.equal(state.instructions['project:reenact:new'], 'incoming');
  assert.equal(state.subjects.other, 'image'); assert.equal(state.versions['other:style'], 'old'); assert.equal(state.versions['project:reenact'], 'new');
  const stale = ui.navigateHandoff(new URLSearchParams({ handoff: 'slow-handoff', view: 'settings' }));
  await ui.navigateHandoff(new URLSearchParams({ handoff: 'two', view: 'tasks' }));
  const count = state.selections.length;
  pending.get('slow-handoff')({ ...handoff, mode: 'recreate' }); await stale;
  assert.equal(state.selections.length, count); assert.equal(state.tasks, true); assert.equal(state.settings, false); assert.equal(state.mode, 'reenact');
  handoff.selection.projectId = 'slow-project';
  const staleReference = ui.navigateHandoff(new URLSearchParams({ handoff: 'three', view: 'settings' }));
  await new Promise(resolve => setImmediate(resolve));
  await ui.navigateReminder(new URLSearchParams({ tasks: 'unread' }));
  const before = state.selections.length;
  pending.get('slow-project')({ id: 'late', projectId: 'slow-project' }); await staleReference;
  assert.equal(state.selections.length, before); assert.equal(state.tasks, true); assert.equal(state.settings, false);
});


test('stale handoff opens the latest reference without restoring outdated drafts and marks input for hydration', async () => {
  const state = { selections: [], errors: [], inputRevisions: { project: 6 }, instructions: { 'other:style:new': 'keep instruction' }, versions: { 'other:style': 'old' }, subjects: { other: 'keep subject' } };
  const handoff = { selection: { id: 'old-source', projectId: 'project', inputRevision: 6 }, mode: 'style', draft: {
    instructions: { 'project:style:new': 'outdated instruction' }, subjectDrafts: { 'project:style:new': 'outdated subject' }, versions: { 'project:style': 'outdated-version' },
  } };
  const reference = { id: 'latest-source', projectId: 'project', image: 'latest-reference', inputRevision: 8, inputs: { style: { subjectImage: 'latest subject' } } };
  const setter = key => value => { state[key] = typeof value === 'function' ? value(state[key] || {}) : value; };
  const ui = evaluate(`let cancelled = false, ownContext = false, previous;\n${extract(app, ['restoreDraft', 'navigateHandoff'])}`, {
    selectionRevision: { current: 0 }, workspace: true,
    request: async message => message.type === 'alchemy:workspace-handoff' ? handoff : reference,
    setSelection: value => state.selections.push(value), setProject() {}, setProjectMode() {},
    setInputRevisions: setter('inputRevisions'), setInstructions: setter('instructions'), setVersions: setter('versions'), setSubjectDrafts: setter('subjects'),
    setMultiSubjectDrafts: () => assert.fail('stale multi drafts must not restore'), setPromptDrafts: () => assert.fail('stale prompt drafts must not restore'), setLang() {},
    setSettings() {}, setTasksOpen() {}, setNewProjectOpen() {}, setHistoryOpen() {}, setGalleryOpen() {}, setError: value => state.errors.push(value),
  }, ['navigateHandoff']);
  await ui.navigateHandoff(new URLSearchParams({ handoff: 'stale' }));
  const selected = state.selections.at(-1);
  assert.equal(selected.id, 'latest-source');
  assert.equal(selected.image, 'latest-reference');
  assert.equal(selected.inputRevision, 8);
  assert.equal(selected.error, undefined);
  assert.equal(selected.inputs, undefined, 'durable inputs must be hydrated before resuming work');
  assert.equal(state.inputRevisions.project, -1, 'hydration must refresh current lane choices even for a previously visited project');
  assert.match(state.errors.at(-1), /项目输入已更新.*旧窗口草稿未覆盖/);
  assert.deepEqual(state.instructions, { 'other:style:new': 'keep instruction' });
  assert.deepEqual(state.subjects, { other: 'keep subject' });
  assert.deepEqual(state.versions, { 'other:style': 'old' });
});

for (const draftRevision of [7, 8]) test(`ordinary quick initialization validates draft revision ${draftRevision} against durable input`, async () => {
  const state = { modes: {}, versions: {}, preferences: {}, drafts: {}, errors: [] };
  const setter = key => value => { state[key] = typeof value === 'function' ? value(state[key]) : value; };
  let refresh;
  const selection = { id: 'input-8', projectId: 'A', inputRevision: 8 };
  const saved = { mode: 'style', selection: { ...selection, inputRevision: draftRevision }, draft: {
    versions: { 'A:style': 'new' }, instructions: { 'A:style:new': 'quick instruction', 'B:style:new': 'other instruction' },
    subjectDrafts: { 'A:style:new': 'quick subject', 'B:style:new': 'other subject' },
    multiSubjectDrafts: { 'A:multi-reenact:new': [{ id: 'quick multi' }] },
    promptDrafts: { historicalJob: { promptZh: 'unsaved historical prompt' } },
  } };
  const cleanup = evaluate(`const start = ${initialize};`, {
    workspace: false, projectViews: { A: { mode: 'style', versions: { style: 'new' }, inputRevision: 8 } },
    window: { addEventListener() {}, removeEventListener() {} }, location: { search: '', hash: '', pathname: '/popup.html' },
    history: { replaceState() {} }, URLSearchParams,
    modeRevision: { current: 0 }, visibilityRevision: { current: 0 }, selectionRevision: { current: 0 }, deletingProjects: { current: false },
    request: async message => message.type === 'alchemy:project-reference' ? { ...selection, inputs: { style: { instruction: 'workspace instruction' } } } : saved,
    readState: async () => ({ preferences: { paired: true, mode: 'style' }, selection }),
    pollWhileVisible: callback => { refresh = callback; return () => {}; },
    setProjectModes: setter('modes'), setProjectMode() {}, setVersions: setter('versions'), setPreferences: setter('preferences'), setSelection: setter('selection'),
    setInstructions: setter('instructions'), setSubjectDrafts: setter('subjects'), setMultiSubjectDrafts: setter('multi'), setPromptDrafts: setter('prompts'),
    setLang() {}, setSettings() {}, setDraftReady() {}, setProject() {}, setHistoryOpen() {}, setGalleryOpen() {},
    setError: value => { if (value) assert.fail(value); }, setDraftError: value => assert.fail(value),
  }, ['start']).start();
  await new Promise(resolve => setImmediate(resolve));
  await refresh();
  const fresh = draftRevision === 8;
  assert.equal(state.instructions['A:style:new'], fresh ? 'quick instruction' : undefined);
  assert.equal(state.subjects['A:style:new'], fresh ? 'quick subject' : undefined);
  assert.equal(state.multi['A:multi-reenact:new']?.[0].id, fresh ? 'quick multi' : undefined);
  assert.equal(state.instructions['B:style:new'], 'other instruction');
  assert.equal(state.subjects['B:style:new'], 'other subject');
  assert.equal(state.prompts.historicalJob.promptZh, 'unsaved historical prompt', 'prompt edits belong to immutable jobs, not the current input revision');
  assert.equal(state.versions['A:style'], 'new');
  cleanup();
});


test('toast and unread entries route inside every Reframe surface without calling the background or changing the host URL', async () => {
  const script = extract(app, ['openNotice']);
  for (const surface of [{ workspace: true }, { workspace: false }, { workspace: false, embedded: true }]) {
    const routes = [], errors = [];
    const noticeNavigation = { current: async params => routes.push(Object.fromEntries(params)) };
    const ui = evaluate(script, { ...surface, noticeNavigation, URLSearchParams,
      request: () => assert.fail('must not open a tab'), location: new Proxy({}, { set() { assert.fail('must not change host URL'); } }),
      setError: error => errors.push(error) }, ['openNotice']);
    ui.openNotice({ id: 'image', jobId: 'job', generationId: 'image' });
    ui.openNotice({ id: 'prompt', jobId: 'job' }); ui.openNotice();
    assert.deepEqual(routes, [{ task: 'job', generation: 'image' }, { task: 'job' }, { tasks: 'unread' }]);
    noticeNavigation.current = undefined; ui.openNotice();
    assert.match(errors[0], /正在恢复界面/);
  }
});

test('lightweight reminder navigation keeps its local version through polling, preserves drafts and accepts a new collected selection', async () => {
  const state = { versions: {}, preferences: {}, instructions: {}, subjects: {}, prompts: {}, multi: {}, errors: [] };
  const setter = key => value => { state[key] = typeof value === 'function' ? value(state[key]) : value; };
  let refresh, finishRead, delayRead = false, globalSelection = { id: 'A', projectId: 'A', image: 'A-image' };
  const jobId = '11111111-1111-4111-8111-111111111111', generationId = '22222222-2222-4222-8222-222222222222';
  const noticeNavigation = { current: undefined }, revision = { current: 0 };
  const target = { id: jobId, projectId: 'B', mode: 'recreate', generations: [{ id: generationId }, { id: 'newer' }] };
  const cleanup = evaluate(`const start = ${initialize};`, {
    workspace: false, noticeNavigation, URLSearchParams, Date,
    location: { search: '?website=yes', hash: '#pinterest-section', pathname: '/pin/123' },
    history: { replaceState() { assert.fail('must not rewrite the website URL'); } },
    window: { addEventListener() { assert.fail('must not listen to the website hash'); }, removeEventListener() {} },
    modeRevision: { current: 0 }, visibilityRevision: { current: 0 }, selectionRevision: revision, deletingProjects: { current: false },
    request: async message => {
      if (message.type === 'alchemy:quick-draft') return { draft: { instructions: { 'A:style:new': 'keep A', 'B:recreate:new': 'keep B' }, promptDrafts: { edited: { promptZh: 'unsaved' } } } };
      if (message.type === 'alchemy:project-reference') return { id: 'B', projectId: 'B', image: 'B-image', inputRevision: 3 };
      assert.fail(message.type);
    },
    query: async () => target,
    readState: async () => {
      if (delayRead) await new Promise(resolve => { finishRead = resolve; });
      return { preferences: { paired: true, mode: 'style' }, selection: globalSelection };
    },
    pollWhileVisible: callback => { refresh = callback; return () => {}; },
    setVersions: setter('versions'), setPreferences: setter('preferences'), setSelection: setter('selection'),
    setInstructions: setter('instructions'), setSubjectDrafts: setter('subjects'), setMultiSubjectDrafts: setter('multi'), setPromptDrafts: setter('prompts'),
    setTargetGeneration: setter('generation'), setTargetPrompt: setter('prompt'), setTasksOpen: setter('tasks'),
    setLang() {}, setSettings() {}, setDraftReady() {}, setProject() {}, setHistoryOpen() {}, setGalleryOpen() {}, dispatchDrawer() {},
    setError: value => { if (value) state.errors.push(value); }, setDraftError: value => assert.fail(value),
  }, ['start']).start();
  await new Promise(resolve => setImmediate(resolve)); await refresh();
  await noticeNavigation.current(new URLSearchParams({ task: jobId, generation: generationId }));
  assert.equal(state.selection.projectId, 'B'); assert.equal(state.versions['B:recreate'], jobId);
  assert.equal(state.generation.id, generationId); assert.equal(state.prompt, undefined);
  await refresh(); await refresh();
  globalSelection = { ...globalSelection, jobId: 'finished-A', inputRevision: 4 }; await refresh();
  assert.equal(state.selection.projectId, 'B', 'unchanged global A must not override locally selected B');
  assert.equal(state.instructions['A:style:new'], 'keep A'); assert.equal(state.instructions['B:recreate:new'], 'keep B');
  assert.equal(state.prompts.edited.promptZh, 'unsaved');
  await noticeNavigation.current(new URLSearchParams({ task: jobId }));
  const first = state.prompt.request;
  await noticeNavigation.current(new URLSearchParams({ task: jobId }));
  assert.ok(state.prompt.request > first); assert.equal(state.generation, undefined);
  await noticeNavigation.current(new URLSearchParams({ tasks: 'unread' })); assert.equal(state.tasks, true);
  delayRead = true;
  const stalePoll = refresh();
  await noticeNavigation.current(new URLSearchParams({ task: jobId }));
  globalSelection = { id: 'C', projectId: 'C', image: 'C-image' };
  finishRead(); await stalePoll;
  assert.equal(state.selection.projectId, 'B', 'a stale poll must not override newer local navigation');
  delayRead = false; await refresh();
  assert.equal(state.selection.projectId, 'C', 'a new image collection must still reach the panel');
  assert.deepEqual(state.errors, []); cleanup(); assert.equal(noticeNavigation.current, undefined);
});

test('quick result honors a reminded historical generation before running/latest fallbacks', () => {
  const script = extract(quick, ['running', 'generation']);
  const job = { generations: [{ id: 'old', status: 'completed' }, { id: 'running', status: 'running' }, { id: 'latest', status: 'completed' }] };
  assert.equal(evaluate(script, { job, targetGeneration: 'old' }, ['generation']).generation.id, 'old');
  assert.equal(evaluate(script, { job, targetGeneration: undefined }, ['generation']).generation.id, 'running');
});
