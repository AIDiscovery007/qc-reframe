import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const code = ts.transpileModule(await readFile(new URL('../entrypoints/workspace/SessionPicker.tsx', import.meta.url), 'utf8'), {
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
  const jsx = (type, props) => ({ type, props });
  runInNewContext(code, { exports, AbortController, Map, setTimeout: fn => { timers.add(fn); return fn; }, clearTimeout: fn => timers.delete(fn),
    require: name => name === 'react' ? react : name === 'react/jsx-runtime' ? { jsx, jsxs: jsx }
      : name.endsWith('/client') ? { request: (message, signal) => new Promise(resolve => requests.push({ message, signal, resolve })) }
      : name.endsWith('/motion-dialog') ? { showMotionDialog: () => () => {} } : name.endsWith('/brand') ? { logo: '' } : { default: () => null },
  });
  const render = () => { index = 0; tree = exports.default({ value: [], onConfirm: async () => {}, onClose() {}, ...props }); effects.splice(0).forEach(fn => fn()); return tree; };
  const nodes = value => !value ? [] : Array.isArray(value) ? value.flatMap(nodes) : typeof value === 'object' ? [value, ...nodes(value.props?.children)] : [value];
  render();
  return { requests, render, flushTimers() { const queued = [...timers]; timers.clear(); queued.forEach(fn => fn()); },
    search(value) { nodes(tree).find(node => node.props?.['aria-label'] === '搜索会话').props.onChange({ target: { value } }); render(); },
    selected: () => nodes(nodes(tree).find(node => node.props?.className === 'session-selected')).filter(node => node.props?.['data-session-id']).map(node => node.props['data-session-id']),
    candidates: () => nodes(nodes(tree).find(node => node.props?.className === 'session-candidates')).filter(node => node.props?.['data-session-id']),
    toggle(id) { const input = nodes(tree).find(node => node.props?.['data-session-id'] === id); assert.ok(input); assert.ok(!input.props.disabled); input.props.onChange(); render(); },
    archive(checked) { nodes(tree).find(node => node.type === 'input' && node.props.type === 'checkbox' && !node.props['data-session-id']).props.onChange({ target: { checked } }); render(); },
    click(text) { nodes(tree).find(node => node.type === 'button' && nodes(node).includes(text)).props.onClick(); render(); },
    cancel() { tree.props.onCancel({ preventDefault() {} }); render(); },
    disabled: () => nodes(tree).filter(node => ['input', 'button'].includes(node.type)).every(node => node.props.disabled),
    text: () => nodes(tree).filter(node => typeof node === 'string').join(' '),
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
