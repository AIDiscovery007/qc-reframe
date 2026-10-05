import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const code = ts.transpileModule(await readFile(new URL('../entrypoints/workspace/SessionPicker.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const selectCode = ts.transpileModule(await readFile(new URL('../entrypoints/popup/SelectField.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
function picker(props = {}) {
  const hooks = [], effects = [], timers = new Set(), requests = [];
  let index = 0, tree;
  const react = {
    useRef(value) { const key = index++; return hooks[key] ||= { current: value }; },
    useState(value) { const key = index++; if (!(key in hooks)) hooks[key] = value; return [hooks[key], next => { hooks[key] = typeof next === 'function' ? next(hooks[key]) : next; }]; },
    useEffect(fn, deps) {
      const key = index++, previous = hooks[key];
      if (!previous || deps.some((item, i) => !Object.is(item, previous.deps[i]))) {
        previous?.cleanup?.(); hooks[key] = { deps }; effects.push(() => { hooks[key].cleanup = fn(); });
      }
    },
  };
  const exports = {};
  const jsx = (type, props) => typeof type === 'function' ? type(props) : ({ type, props });
  const select = {};
  runInNewContext(selectCode, { exports: select, require: name => name === 'react/jsx-runtime' ? { jsx, jsxs: jsx } : { default: () => null } });
  runInNewContext(code, { exports, AbortController, Map, document: { activeElement: null }, setTimeout: fn => { timers.add(fn); return fn; }, clearTimeout: fn => timers.delete(fn),
    require: name => name === 'react' ? react : name === 'react/jsx-runtime' ? { jsx, jsxs: jsx }
      : name.endsWith('/client') ? { request: (message, signal) => new Promise((resolve, reject) => requests.push({ message, signal, resolve, reject })) }
      : name.endsWith('/motion-dialog') ? { showMotionDialog: () => () => {} } : name.endsWith('/brand') ? { logo: '' }
      : name.endsWith('/SelectField') ? select
      : name.endsWith('/TaskOrchestration') ? { default: props => jsx('section', { ...props, children: [props.title, props.detail, props.children, props.actions] }) } : { default: () => null },
  });
  const render = () => { index = 0; tree = exports.default({ value: [], onConfirm: async () => {}, onClose() {}, ...props }); effects.splice(0).forEach(fn => fn()); return tree; };
  const nodes = value => !value ? [] : Array.isArray(value) ? value.flatMap(nodes) : typeof value === 'object' ? [value, ...nodes(value.props?.children)] : [value];
  render();
  return { requests, render, flushTimers() { const queued = [...timers]; timers.clear(); queued.forEach(fn => fn()); },
    search(value) { nodes(tree).find(node => node.props?.['aria-label'] === '搜索会话').props.onChange({ target: { value } }); render(); },
    scope(value) { nodes(tree).find(node => node.props?.['aria-label'] === '搜索范围').props.onChange({ target: { value } }); render(); },
    selected: () => nodes(nodes(tree).find(node => node.props?.className === 'session-selected')).filter(node => node.props?.['data-session-id']).map(node => node.props['data-session-id']),
    candidates: () => nodes(nodes(tree).find(node => node.props?.className === 'session-candidates')).filter(node => node.props?.['data-session-id']),
    toggle(id) { const input = nodes(tree).find(node => node.props?.['data-session-id'] === id); assert.ok(input); assert.ok(!input.props.disabled); input.props.onChange(); render(); },
    archive(checked) { nodes(tree).find(node => node.type === 'input' && node.props.type === 'checkbox' && !node.props['data-session-id']).props.onChange({ target: { checked } }); render(); },
    click(text) { const button = nodes(tree).find(node => node.type === 'button' && nodes(node).includes(text)); assert.ok(button && !button.props.disabled); button.props.onClick(); render(); },
    cancel() { tree.props.onCancel({ preventDefault() {} }); render(); },
    disabled: () => nodes(tree).filter(node => ['input', 'button', 'select'].includes(node.type)).every(node => node.props.disabled),
    selectedText: () => nodes(nodes(tree).find(node => node.props?.className === 'session-selected')).filter(node => typeof node === 'string').join(' '),
    text: () => nodes(tree).filter(node => typeof node === 'string').join(' '),
    task: () => nodes(tree).find(node => node.props?.progressLabel === '正文索引进度')?.props,
    unmount() { hooks.forEach(hook => hook?.cleanup?.()); },
  };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
test('closing the session picker aborts its pending list request', () => {
  const view = picker(); view.flushTimers();
  assert.equal(view.requests[0].signal.aborted, false);
  view.unmount(); assert.equal(view.requests[0].signal.aborted, true);
});
test('changing picker search aborts the previous request and ignores its late response', async () => {
  const view = picker(); view.flushTimers();
  view.search('小说'); view.flushTimers();
  assert.equal(view.requests[0].signal.aborted, true);
  assert.equal(view.requests[1].signal.aborted, false);
  assert.equal(view.requests[1].message.searchTerm, '小说');
  view.requests[1].resolve({ data: [{ id: 'new', title: '新的小说', updatedAt: 1 }], nextCursor: null });
  await flush(); view.render();
  view.requests[0].resolve({ data: [{ id: 'old', title: '旧的视频', updatedAt: 1 }], nextCursor: null });
  await flush(); view.render();
  assert.match(view.text(), /新的小说/); assert.doesNotMatch(view.text(), /旧的视频/);
  view.unmount();
});

const row = id => ({ id, title: `会话 ${id}`, updatedAt: 1 });
async function respond(view, data, nextCursor = null) {
  view.requests.at(-1).resolve({ data, nextCursor }); await flush(); view.render();
}
test('selected sessions stay separate across pages, search and archives, and can be removed while hidden from candidates', async () => {
  const view = picker({ value: [row('a')] }); view.flushTimers();
  await respond(view, [row('a'), row('b')], 'next');
  assert.deepEqual(view.selected(), ['a']);
  assert.deepEqual(view.candidates().map(node => node.props['data-session-id']), ['b']);
  view.toggle('b'); view.click('加载更多');
  assert.equal(view.requests.at(-1).message.cursor, 'next');
  await respond(view, [row('b'), row('c')]); view.toggle('c');
  assert.deepEqual(view.selected(), ['a', 'b', 'c']);
  assert.equal(view.candidates().length, 0);
  view.search('其他'); view.flushTimers(); await respond(view, [row('d')]);
  assert.deepEqual(view.selected(), ['a', 'b', 'c']);
  view.archive(true); view.flushTimers();
  assert.equal(view.requests.at(-1).message.archived, true);
  await respond(view, [row('e')]);
  view.toggle('b');
  assert.deepEqual(view.selected(), ['a', 'c']);
  assert.deepEqual(view.candidates().map(node => node.props['data-session-id']), ['e']);
  view.toggle('e'); assert.deepEqual(view.selected(), ['a', 'c', 'e']);
  view.unmount();
});
test('five selections remain removable while candidates are disabled; confirmation preserves order and blocks closing during save', async () => {
  let resolveSave, saved, closed = 0;
  const view = picker({ value: ['a', 'b', 'c', 'd', 'e'].map(row), onConfirm: ids => { saved = [...ids]; return new Promise(resolve => { resolveSave = resolve; }); }, onClose: () => closed++ });
  view.flushTimers(); await respond(view, [row('f')]);
  assert.equal(view.selected().length, 5); assert.equal(view.candidates()[0].props.disabled, true);
  view.toggle('b'); assert.equal(view.candidates()[0].props.disabled, false);
  view.toggle('f'); view.click('确认选择');
  assert.deepEqual(saved, ['a', 'c', 'd', 'e', 'f']); assert.equal(view.disabled(), true);
  view.cancel(); assert.equal(closed, 0);
  resolveSave(); await flush(); view.render(); assert.equal(closed, 1);
  view.unmount();
});
test('cancel discards draft changes without mutating the provided selection', async () => {
  const value = [row('a')]; let saved = false, closed = 0;
  const view = picker({ value, onConfirm: async () => { saved = true; }, onClose: () => closed++ });
  view.flushTimers(); await respond(view, [row('b')]); view.toggle('b'); view.toggle('a'); view.click('取消');
  assert.deepEqual(value.map(item => item.id), ['a']); assert.equal(saved, false); assert.equal(closed, 1);
  view.unmount();
});

const indexStatus = (state, indexed = 0) => ({ state, indexed, total: 8, failed: state === 'partial' ? 2 : 0, updatedAt: state === 'empty' ? null : 1 });
async function answer(view, result) { view.requests.at(-1).resolve(result); await flush(); view.render(); }
test('content search requires an explicit first build and retains title search and selected identities', async () => {
  const view = picker({ value: [{ ...row('a'), snippet: 'old snippet', match: 'content' }] });
  view.flushTimers(); assert.equal(view.requests.at(-1).message.scope, 'title');
  view.scope('content'); view.flushTimers();
  assert.equal(view.requests[0].signal.aborted, true);
  assert.equal(view.requests.at(-1).message.scope, 'content');
  await answer(view, { data: [], nextCursor: null, index: indexStatus('empty') });
  view.flushTimers(); assert.equal(view.requests.length, 2);
  assert.match(view.text(), /建立本地索引/);
  assert.doesNotMatch(view.selectedText(), /old snippet/);
  view.click('建立索引'); assert.equal(view.requests.at(-1).message.action, 'refresh');
  await answer(view, indexStatus('building', 1));
  assert.match(view.text(), /正在建立正文索引 已处理 1 \/ 8/);
  view.unmount();
});
test('content snippets render as plain text and never enter selected rows', async () => {
  const view = picker(); view.scope('content'); view.search('林夏'); view.flushTimers();
  const snippet = '<img src=x onerror=alert(1)> 林夏在雨夜读信';
  await answer(view, { data: [{ ...row('b'), match: 'content', snippet }], nextCursor: null, index: indexStatus('ready', 8) });
  assert.match(view.text(), /正文匹配/); assert.ok(view.text().includes(snippet));
  view.toggle('b'); assert.doesNotMatch(view.selectedText(), /正文匹配|onerror/);
  view.scope('title'); view.flushTimers(); assert.equal(view.requests.at(-1).message.scope, 'title');
  assert.deepEqual(view.selected(), ['b']);
  view.unmount();
});
test('index progress polls without reloading pages until completion and reloads the current query once', async () => {
  const view = picker(); view.scope('content'); view.search('灯塔'); view.flushTimers();
  await answer(view, { data: [row('b')], nextCursor: 'next', index: indexStatus('building', 1) });
  view.flushTimers(); assert.equal(view.requests.at(-1).message.action, 'status');
  await answer(view, indexStatus('building', 3)); view.flushTimers();
  assert.equal(view.requests.filter(item => item.message.type === 'alchemy:sessions-list').length, 1);
  assert.deepEqual(view.candidates().map(item => item.props['data-session-id']), ['b']);
  await answer(view, indexStatus('ready', 8)); view.flushTimers();
  assert.equal(view.requests.at(-1).message.type, 'alchemy:sessions-list');
  assert.equal(view.requests.at(-1).message.searchTerm, '灯塔');
  assert.equal(view.requests.at(-1).message.cursor, undefined);
  await answer(view, { data: [row('c')], nextCursor: null, index: indexStatus('ready', 8) });
  view.flushTimers(); assert.equal(view.requests.filter(item => item.message.type === 'alchemy:sessions-list').length, 2);
  view.unmount();
});
test('closing aborts only the pending index status request, without cancelling or clearing the backend index', async () => {
  const view = picker(); view.scope('content'); view.flushTimers();
  await answer(view, { data: [], nextCursor: null, index: indexStatus('building', 2) });
  view.flushTimers(); const pending = view.requests.at(-1);
  assert.equal(pending.message.action, 'status'); assert.equal(pending.signal.aborted, false);
  view.unmount(); assert.equal(pending.signal.aborted, true);
  assert.equal(view.requests.some(item => ['clear', 'cancel'].includes(item.message.action)), false);
});
test('closing during a build request aborts its reader and ignores a late response', async () => {
  const view = picker(); view.scope('content'); view.flushTimers();
  await answer(view, { data: [], nextCursor: null, index: indexStatus('empty') });
  view.click('建立索引'); const pending = view.requests.at(-1);
  view.unmount(); assert.equal(pending.signal.aborted, true);
  pending.resolve(indexStatus('building')); await flush(); view.flushTimers();
  assert.equal(view.requests.length, 2);
});
test('building indexes can be stopped and cleared without losing selection or accepting a late status response', async () => {
  const view = picker({ value: [row('a')] }); view.scope('content'); view.flushTimers();
  await answer(view, { data: [], nextCursor: null, index: indexStatus('building', 2) });
  view.flushTimers(); const status = view.requests.at(-1);
  view.click('停止并清除'); const clear = view.requests.at(-1);
  assert.equal(clear.message.action, 'clear'); assert.equal(status.signal.aborted, true);
  clear.resolve(indexStatus('empty')); await flush(); view.render();
  status.resolve(indexStatus('building', 4)); await flush(); view.render();
  assert.match(view.text(), /建立本地索引/); assert.doesNotMatch(view.text(), /正在建立索引/);
  assert.deepEqual(view.selected(), ['a']);
  view.unmount();
});
test('search responses started while clearing cannot restore the previous index after clear completes', async () => {
  const view = picker(); view.scope('content'); view.flushTimers();
  await answer(view, { data: [], nextCursor: null, index: indexStatus('ready', 8) });
  view.click('清除索引'); const clear = view.requests.at(-1);
  view.search('灯塔'); view.flushTimers(); const search = view.requests.at(-1);
  clear.resolve(indexStatus('empty')); await flush(); view.render();
  assert.equal(search.signal.aborted, true);
  search.resolve({ data: [row('outdated')], nextCursor: null, index: indexStatus('ready', 8) });
  await flush(); view.render();
  assert.match(view.text(), /建立本地索引/); assert.doesNotMatch(view.text(), /会话 outdated/);
  view.flushTimers(); assert.equal(view.requests.at(-1).message.searchTerm, '灯塔');
  await answer(view, { data: [], nextCursor: null, index: indexStatus('empty') });
  assert.match(view.text(), /建立本地索引/);
  view.unmount();
});
test('partial coverage is visible, clear keeps selections and waits for another explicit build', async () => {
  const view = picker({ value: [row('a')] }); view.scope('content'); view.flushTimers();
  await answer(view, { data: [row('b')], nextCursor: null, index: indexStatus('partial', 6) });
  assert.match(view.text(), /6 \/ 8.*2 个暂未收录/);
  view.click('清除索引'); assert.equal(view.requests.at(-1).message.action, 'clear');
  await answer(view, indexStatus('empty')); view.flushTimers();
  await answer(view, { data: [], nextCursor: null, index: indexStatus('empty') });
  assert.deepEqual(view.selected(), ['a']);
  assert.match(view.text(), /建立索引/);
  view.flushTimers(); assert.equal(view.requests.some(item => item.message.action === 'refresh'), false);
  view.unmount();
});
test('new search and index controls are disabled while confirming content selections', async () => {
  let resolveSave;
  const view = picker({ onConfirm: () => new Promise(resolve => { resolveSave = resolve; }) });
  view.scope('content'); view.flushTimers();
  await answer(view, { data: [row('a')], nextCursor: null, index: indexStatus('ready', 8) });
  view.toggle('a'); view.click('确认选择'); assert.equal(view.disabled(), true);
  resolveSave(); await flush(); view.unmount();
});

test('initial index failure exposes clear and rebuild without losing selected sessions', async () => {
  const view = picker({ value: [row('a')] }); view.scope('content'); view.flushTimers();
  view.requests.at(-1).reject(new Error('索引初始化失败')); await flush(); view.render();
  assert.match(view.text(), /无法读取本地正文索引，可清除后重新建立/);
  assert.doesNotMatch(view.text(), /正在检查本地正文索引/);
  view.click('清除索引'); assert.equal(view.requests.at(-1).message.action, 'clear');
  await answer(view, indexStatus('empty')); view.flushTimers();
  await answer(view, { data: [], nextCursor: null, index: indexStatus('empty') });
  view.click('建立索引'); assert.equal(view.requests.at(-1).message.action, 'refresh');
  await answer(view, indexStatus('building'));
  assert.deepEqual(view.selected(), ['a']);
  view.unmount();
});

test('progress counts processed sessions and explains skipped content without showing a fatal error', async () => {
  const view = picker(); view.scope('content'); view.flushTimers();
  await answer(view, { data: [], nextCursor: null, index: { ...indexStatus('building', 2), processed: 6, failed: 4, issues: [{ code: 'response_limit', count: 3 }, { code: 'changed', count: 1 }] } });
  assert.equal(view.task().phase, 'running'); assert.equal(view.task().progress, 75);
  assert.match(view.text(), /已处理 6 \/ 8 · 2 个可搜索/);
  assert.match(view.text(), /单条对话数据仍超过 24 MB/); assert.match(view.text(), /读取期间会话发生变化/);
  assert.match(view.text(), /已收录会话中暂未找到结果，索引仍在更新/);
  assert.doesNotMatch(view.text(), /正文索引需要处理/);
  view.unmount();
});

test('an empty result list refreshes as newly indexed sessions become searchable before completion', async () => {
  const view = picker(); view.scope('content'); view.flushTimers();
  await answer(view, { data: [], nextCursor: null, index: indexStatus('building', 0) });
  view.flushTimers(); await answer(view, { ...indexStatus('building', 1), processed: 1 });
  view.flushTimers(); assert.equal(view.requests.at(-1).message.type, 'alchemy:sessions-list');
  await answer(view, { data: [row('fresh')], nextCursor: null, index: indexStatus('building', 1) });
  assert.deepEqual(view.candidates().map(item => item.props['data-session-id']), ['fresh']);
  view.unmount();
});
