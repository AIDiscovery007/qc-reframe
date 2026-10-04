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
