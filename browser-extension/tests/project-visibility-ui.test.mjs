import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createBridge } from '../bridge/server.mjs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { projectVisibilityActions } from '../lib/project-visibility.ts';

function fixture(overrides = {}) {
  const state = { notice: undefined, error: '', busy: false, refreshed: 0, focus: 0 };
  const requests = [];
  const context = {
    hiddenProjectIds: ['hidden'], showHidden: false, selection: { projectId: 'visible' }, project: { id: 'visible' },
    visibilityPending: { current: false }, visibilityRevision: { current: 0 }, selectionRevision: { current: 0 }, projectRevision: { current: 0 }, deletingProjects: { current: false },
    document: { activeElement: { isConnected: false, matches: selector => selector === ":focus-visible" } }, requestAnimationFrame: callback => callback(),
    visibilityFeedback: { current: { focus: () => state.focus++ } },
    setBusy: value => state.busy = value, setVisibilityError: value => state.error = value,
    setVisibilityNotice: value => state.notice = value,
    setHiddenProjectIds: update => context.hiddenProjectIds = update(context.hiddenProjectIds),
    setProject: update => context.project = typeof update === 'function' ? update(context.project) : update,
    setSelection: value => context.selection = value, setHistoryOpen: value => state.historyOpen = value,
    setPreferences: update => { context.showHidden = update({}).showHiddenProjects; },
    refresh: () => state.refreshed++,
    request: async message => { requests.push(message); return message.type === 'alchemy:show-hidden-projects' ? message.show : { updatedIds: message.ids }; },
    ...overrides,
  };
  // Capture each render's values, as React does, while refs remain shared across renders.
  const render = () => projectVisibilityActions(context, context);
  const handlers = { setProjectsHidden: (...args) => render().setProjectsHidden(...args), toggleHiddenProjects: (...args) => render().toggleHiddenProjects(...args) };
  return { ...handlers, context, state, requests };
}

test('mixed selection only changes eligible IDs; undo restores actual changed subset', async () => {
  const ui = fixture();
  const updated = await ui.setProjectsHidden(['visible', 'hidden', 'visible'], true);
  assert.deepEqual(Array.from(updated), ['visible']);
  assert.deepEqual(Array.from(ui.requests[0].ids), ['visible']);
  assert.equal(ui.state.historyOpen, true);
  assert.equal(ui.context.selection, undefined);
  assert.equal(ui.state.notice.hidden, true);
  await ui.setProjectsHidden(ui.state.notice.ids, false, true);
  assert.deepEqual(Array.from(ui.context.hiddenProjectIds), ['hidden']);
  assert.equal(ui.state.notice.undone, true);
  assert.equal(ui.state.focus, 2);
});

test('partial success reports and undoes only server-confirmed eligible IDs', async () => {
  const ui = fixture({ request: async () => ({ updatedIds: ['visible', 'unexpected'] }) });
  await ui.setProjectsHidden(['visible', 'another', 'hidden'], true);
  assert.deepEqual(Array.from(ui.state.notice.ids), ['visible']);
  assert.deepEqual(Array.from(ui.context.hiddenProjectIds), ['hidden', 'visible']);
});

test('failed action preserves previous outcome and original states and releases retry', async () => {
  const ui = fixture();
  await ui.setProjectsHidden(['visible'], true);
  const notice = ui.state.notice;
  ui.context.request = async () => { throw new Error('offline'); };
  await assert.rejects(ui.setProjectsHidden(['visible'], false, true), /offline/);
  assert.equal(ui.state.notice, notice);
  assert.deepEqual(Array.from(ui.context.hiddenProjectIds), ['hidden', 'visible']);
  assert.equal(ui.state.busy, false);
  assert.equal(ui.context.visibilityPending.current, false);
  ui.context.request = async message => ({ updatedIds: message.ids });
  await ui.setProjectsHidden(['visible'], false, true);
  assert.deepEqual(Array.from(ui.context.hiddenProjectIds), ['hidden']);
});

test('pending mutation rejects duplicate input and never overwrites new project context', async () => {
  let finish;
  const ui = fixture({ request: () => new Promise(resolve => { finish = resolve; }) });
  const pending = ui.setProjectsHidden(['visible'], true);
  assert.deepEqual(Array.from(await ui.setProjectsHidden(['another'], true)), []);
  await ui.toggleHiddenProjects();
  ui.context.selectionRevision.current++;
  ui.context.project = { id: 'new-project' };
  ui.context.selection = { projectId: 'new-project' };
  finish({ updatedIds: ['visible'] });
  await pending;
  assert.equal(ui.context.project.id, 'new-project');
  assert.equal(ui.context.selection.projectId, 'new-project');
  assert.equal(ui.state.historyOpen, undefined);
});

test('scope failure remains retryable without changing current scope', async () => {
  const ui = fixture({ request: async () => { throw new Error('scope failed'); } });
  await ui.toggleHiddenProjects();
  assert.equal(ui.context.showHidden, false);
  assert.equal(ui.state.error, 'scope failed');
  assert.equal(ui.state.busy, false);
  ui.context.request = async message => message.show;
  await ui.toggleHiddenProjects();
  assert.equal(ui.context.showHidden, true);
  assert.equal(ui.state.error, '');
});

// Render the real components; effects (network/thumbnail reads) do not run during SSR.
const componentCache = new Map();
async function component(name) {
  const source = await readFile(new URL(`../entrypoints/popup/${name}.tsx`, import.meta.url), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  const jsx = await import('react/jsx-runtime');
  runInNewContext(output, { exports, localStorage: { getItem: () => 'list' }, require: name => {
    if (name === 'react') return React;
    if (name === 'react/jsx-runtime') return jsx;
    if (name === 'react-dom') return { createPortal: element => element };
    if (name.startsWith('./')) return { default: componentCache.get(name.slice(2)) || (() => null) };
    return {};
  }});
  componentCache.set(name, exports.default);
  return exports.default;
}
await component('ProjectItem');
await component('HiddenProjectsToggle');
const ProjectHistory = await component('ProjectHistory');
const projects = [false, true].map((hidden, i) => ({ id: String(i), title: `Project ${i}`, hidden, updatedAt: '2026-10-03', jobCount: 0, modes: {} }));
test('normal list and compact browsing have no checkboxes or bulk actions; single-item actions remain', () => {
  for (const workspace of [true, false]) {
    const html = renderToStaticMarkup(React.createElement(ProjectHistory, { projects, workspace, total: 2, page: 1, pageSize: 20, search: '', showHidden: true }));
    assert.doesNotMatch(html, /type="checkbox"|隐藏所选|恢复所选|删除所选/);
    assert.match(html, /批量管理/);
    assert.match(html, /隐藏项目：Project 0/);
    assert.match(html, /恢复项目：Project 1/);
  }
});

test('partial undo keeps the remaining undo action and zero updates never claims success', async () => {
  const ui = fixture({ document: { activeElement: { isConnected: true, matches: () => true } } });
  await ui.setProjectsHidden(['visible', 'another'], true);
  ui.context.request = async () => ({ updatedIds: ['visible'] });
  await ui.setProjectsHidden(ui.state.notice.ids, false, true);
  assert.deepEqual(Array.from(ui.context.hiddenProjectIds), ['hidden', 'another']);
  assert.deepEqual(Array.from(ui.state.notice.ids), ['another']);
  assert.equal(ui.state.notice.hidden, true);
  assert.equal(ui.state.notice.undone, false);
  assert.match(ui.state.error, /1 个项目未撤销/);
  assert.equal(ui.state.focus, 2);
  ui.context.request = async () => ({ updatedIds: [] });
  await assert.rejects(ui.setProjectsHidden(['another'], false, true), /未变化/);
  assert.equal(ui.state.notice, undefined);
});


test('delayed scope response preserves a project opened through TaskCenter selection revision', async () => {
  let finish;
  const ui = fixture({ showHidden: true, selection: { projectId: 'hidden' }, project: { id: 'hidden', hidden: true }, request: () => new Promise(resolve => { finish = resolve; }) });
  const pending = ui.toggleHiddenProjects();
  ui.context.selectionRevision.current++;
  ui.context.selection = { projectId: 'visible' };
  ui.context.project = { id: 'visible', hidden: false };
  finish(false);
  await pending;
  assert.equal(ui.context.showHidden, false);
  assert.equal(ui.context.selection.projectId, 'visible');
  assert.equal(ui.context.project.id, 'visible');
  assert.equal(ui.state.historyOpen, undefined);
});

test('scope change still closes the same hidden selection when no navigation occurred', async () => {
  const ui = fixture({ showHidden: true, selection: { projectId: 'hidden' }, project: { id: 'hidden', hidden: true } });
  await ui.toggleHiddenProjects();
  assert.equal(ui.context.selection, undefined);
  assert.equal(ui.context.project, undefined);
  assert.equal(ui.state.historyOpen, true);
});

test('real bridge returns only actual changes to stale and concurrent UI windows', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'visibility-ui-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const skillPath = join(dir, 'SKILL.md');
  await writeFile(skillPath, '---\nname: alchemy\n---\nTest skill');
  const app = await createBridge({ dataDir: dir, skillPath, generationSkillPath: skillPath });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(async () => { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); });
  const request = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal(response.status, 200);
    return response.json();
  };
  const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=';
  const project = await request('/projects', { image });
  const window = () => fixture({ hiddenProjectIds: [], selection: undefined, project: undefined, request: message => request('/projects/visibility', { ids: message.ids, hidden: message.hidden }) });
  const first = window(), stale = window();
  await first.setProjectsHidden([project.id], true);
  assert.deepEqual(Array.from(first.state.notice.ids), [project.id]);
  await assert.rejects(stale.setProjectsHidden([project.id], true), /未变化/);
  assert.equal(stale.state.notice, undefined, 'a no-op must not create an undo for another window');
  assert.equal(stale.state.refreshed, 1, 'refresh stale state even when no project changed');
  assert.equal((await request(`/projects/${project.id}`)).hidden, true);
  await first.setProjectsHidden(first.state.notice.ids, false, true);
  const windows = [window(), window()];
  const outcomes = await Promise.allSettled(windows.map(ui => ui.setProjectsHidden([project.id], true)));
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(windows.filter(ui => ui.state.notice).length, 1, 'only one concurrent request owns the change');
  const repeated = await request('/projects/visibility', { ids: [project.id], hidden: true });
  assert.deepEqual(repeated.updatedIds, []);
  assert.equal(repeated.hidden, true);
  assert.equal(typeof repeated.revision, 'string', 'existing response fields remain compatible');
});
