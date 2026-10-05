import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const code = ts.transpileModule(await readFile(new URL('../entrypoints/workspace/SessionPicker.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
function picker() {
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
  const render = () => { index = 0; tree = exports.default({ value: [], onConfirm: async () => {}, onClose() {} }); effects.splice(0).forEach(fn => fn()); return tree; };
  const nodes = value => !value ? [] : Array.isArray(value) ? value.flatMap(nodes) : typeof value === 'object' ? [value, ...nodes(value.props?.children)] : [value];
  render();
  return { requests, render, flushTimers() { const queued = [...timers]; timers.clear(); queued.forEach(fn => fn()); },
    search(value) { nodes(tree).find(node => node.props?.['aria-label'] === '搜索会话').props.onChange({ target: { value } }); render(); },
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
