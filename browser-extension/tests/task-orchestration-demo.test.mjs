import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const code = ts.transpileModule(await readFile(new URL("../entrypoints/workspace/TaskOrchestrationDemo.tsx", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
function demo() {
  const hooks = [], effects = [], tasks = [], listeners = new Map(), exports = {};
  const document = { hidden: false, activeElement: null, addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
  let index = 0, tree, unmounted = false, lateWrites = 0;
  const react = {
    useRef(value) { return hooks[index++] ||= { current: value }; },
    useState(value) { const key = index++; if (!(key in hooks)) hooks[key] = value; return [hooks[key], next => { if (unmounted) lateWrites++; hooks[key] = next; }]; },
    useEffect(fn) { const key = index++; if (!hooks[key]) { hooks[key] = {}; effects.push(() => { hooks[key].cleanup = fn(); }); } },
  };
  const jsx = (type, props) => ({ type, props });
  runInNewContext(code, { exports, AbortController, document, require: name => name === "react" ? react : name === "react/jsx-runtime" ? { jsx, jsxs: jsx }
    : name.endsWith("/export-simulation") ? { simulateLocalExport: (signal, onProgress) => new Promise((resolve, reject) => tasks.push({ signal, onProgress, resolve, reject })) }
    : name.endsWith("/brand") ? { logo: "" } : { default: "task" } });
  const nodes = value => !value ? [] : Array.isArray(value) ? value.flatMap(nodes) : typeof value === "object" ? [value, ...nodes(value.props?.children), ...nodes(value.props?.actions)] : [];
  const render = () => {
    index = 0; tree = exports.default();
    for (const node of nodes(tree)) if (node.props?.ref && !node.props.ref.current) node.props.ref.current = { name: node.props.children, focus() { document.activeElement = this; } };
    effects.splice(0).forEach(fn => fn());
  };
  const buttons = () => nodes(tree).filter(node => node.type === "button");
  render();
  return { tasks, document, listeners, render, start(keyboard = false) { const result = buttons()[0].props.onClick({ detail: keyboard ? 0 : 1 }); render(); return result; },
    cancel() { buttons()[1].props.onClick({ detail: 1 }); render(); }, focusCancel() { buttons()[1].props.ref.current.focus(); },
    hide() { document.hidden = true; listeners.get("visibilitychange")(); render(); },
    task: () => nodes(tree).find(node => node.type === "task").props,
    unmount() { unmounted = true; hooks.forEach(hook => hook?.cleanup?.()); }, lateWrites: () => lateWrites,
  };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
test("replay ignores progress and completion from a superseded task", async () => {
  const view = demo(); view.start(); const first = view.tasks[0]; view.start(true);
  assert.equal(first.signal.aborted, true);
  first.onProgress(100); first.resolve({ files: 99 }); await flush(); view.render();
  assert.equal(view.task().phase, "running"); assert.equal(view.task().progress, 0); assert.equal(view.task().instant, true);
  view.tasks[1].resolve({ files: 3 }); await flush(); view.render();
  assert.equal(view.task().phase, "success"); assert.match(view.task().detail, /^3 /); view.unmount();
});
test("cancel restores focus only when the disappearing enabled control owns it", async () => {
  const view = demo(); view.start(); view.focusCancel(); view.cancel();
  assert.equal(view.document.activeElement.name, "开始模拟导出"); assert.equal(view.task().phase, "cancelled");
  view.tasks[0].resolve({ files: 3 }); await flush(); view.render(); assert.equal(view.task().phase, "cancelled");
  view.start(); const other = {}; view.document.activeElement = other; view.cancel();
  assert.equal(view.document.activeElement, other); view.unmount();
});
test("hiding the page aborts the simulation and late success cannot replace cancellation", async () => {
  const view = demo(); view.start(); view.hide();
  assert.equal(view.tasks[0].signal.aborted, true); assert.equal(view.task().phase, "cancelled"); assert.equal(view.task().instant, true);
  view.tasks[0].resolve({ files: 3 }); await flush(); view.render(); assert.equal(view.task().phase, "cancelled"); view.unmount();
});
test("unmount aborts work, removes visibility listener and rejects late state writes", async () => {
  const view = demo(); view.start(); view.unmount();
  assert.equal(view.listeners.size, 0); assert.equal(view.tasks[0].signal.aborted, true);
  view.tasks[0].onProgress(100); view.tasks[0].resolve({ files: 3 }); await flush(); assert.equal(view.lateWrites(), 0);
});
