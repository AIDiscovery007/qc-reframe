import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

// Exercise the actual workspace action derivation and submitted input for each path.
const source = await readFile(new URL('../entrypoints/popup/App.tsx', import.meta.url), 'utf8');
const tree = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ['instructionStale', 'genericPrompt', 'needsPrompt', 'reverseHint', 'genericHint', 'reverseDisabled', 'reverse', 'extractStyle'];
const declarations = new Map();
function visit(node) {
  if (ts.isVariableDeclaration(node) && names.includes(node.name.getText(tree))) declarations.set(node.name.getText(tree), node.initializer.getText(tree));
  ts.forEachChild(node, visit);
}
visit(tree);
const compiled = ts.transpileModule(names.map(name => `const ${name} = ${declarations.get(name)};`).join('\n') + `\nObject.assign(exports, {${names.join(',')}});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function fixture(mode, overrides = {}) {
  const calls = [], drafts = {}, exports = {};
  runInNewContext(compiled, {
    exports, preferences: { mode }, result: undefined, job: undefined, blocked: false, promptDraft: undefined,
    selection: { image: 'reference' }, referenceError: undefined, displayImage: 'reference', subjectDraftKey: mode => `project:${mode}:new`, subjectUnavailable: {}, subjectKey: mode => `project:${mode}`,
    taskInstruction: () => 'instruction', defaultInstructions: { [mode]: 'instruction' }, subjectImage: () => 'subject',
    multiSubjects: [{ id: 'one', subjectImage: 'one' }, { id: 'two', subjectImage: 'two' }], multiPrompt: 'instruction', multiStale: false,
    start: (mode, input) => calls.push({ mode, input }), ...overrides,
    setSubjectDrafts: update => Object.assign(drafts, update(drafts)),
  });
  return { ...exports, calls, drafts };
}

test('each path submits its intended reference roles through the shared action', () => {
  for (const mode of ['style', 'recreate', 'reenact', 'multi-reenact']) {
    const ui = fixture(mode);
    assert.equal(ui.needsPrompt, true);
    assert.equal(ui.reverseDisabled, false);
    ui.reverse();
    assert.equal(ui.calls[0].mode, mode);
    const input = ui.calls[0].input;
    if (mode === 'recreate') assert.equal(input, undefined);
    else if (mode === 'multi-reenact') assert.equal(input.subjects.length, 2);
    else assert.equal(input.subjectImage, 'subject');
  }
});

test('initial style extraction permits reference-only input; reenact requires a subject', () => {
  const style = fixture('style', { subjectImage: () => '' });
  style.reverse();
  assert.equal(style.calls[0].input, undefined);
  const reenact = fixture('reenact', { subjectImage: () => '' });
  reenact.reverse();
  assert.equal(reenact.reverseDisabled, true);
  assert.equal(reenact.calls.length, 0);
});

test('completed, failed and cancelled jobs choose the appropriate phase', () => {
  assert.equal(fixture('recreate', { result: {}, job: { instruction: 'instruction' } }).needsPrompt, false);
  for (const status of ['failed', 'cancelled']) {
    const ui = fixture('recreate', { job: { status } });
    assert.equal(ui.needsPrompt, true);
    assert.equal(ui.reverseDisabled, false);
  }
});

test('changed instruction or multi-image arrangement requires fresh prompts', () => {
  assert.equal(fixture('recreate', { result: {}, job: { instruction: 'old instruction' } }).needsPrompt, true);
  assert.equal(fixture('multi-reenact', { result: {}, multiStale: true }).needsPrompt, true);
  assert.equal(fixture('reenact', { result: {}, job: { reenact: { basePrompt: 'instruction' } } }).needsPrompt, false);
});

test('generic prompts retain reference-only retry and offer a dedicated subject step', () => {
  const generic = fixture('style', { result: {}, subjectImage: () => '' });
  assert.equal(generic.needsPrompt, true);
  assert.ok(generic.genericHint);
  generic.reverse();
  assert.equal(generic.calls[0].input, undefined);
  const dedicated = fixture('style', { result: {} });
  assert.equal(dedicated.genericHint, '');
  dedicated.reverse();
  assert.equal(dedicated.calls[0].input.subjectImage, 'subject');
});

test('upload failure/loading, empty instructions, edits and busy state never submit', () => {
  for (const overrides of [
    { subjectUnavailable: { 'project:style': true } },
    { referenceError: '历史图片丢失' }, { displayImage: undefined }, { taskInstruction: () => '  ' }, { promptDraft: {} }, { blocked: true }, { selection: undefined },
  ]) {
    const ui = fixture('style', overrides);
    ui.reverse();
    assert.equal(ui.calls.length, 0);
  }
  const multi = fixture('multi-reenact', { multiSubjects: [{ subjectImage: 'one' }, { subjectImage: '' }] });
  multi.reverse();
  assert.equal(multi.calls.length, 0);
});

test('explicit generic extraction ignores an existing subject without changing the dedicated action', () => {
  const ui = fixture('style', { result: {}, job: { reenact: { basePrompt: 'instruction' } } });
  ui.extractStyle();
  assert.equal(ui.calls[0].mode, 'style');
  assert.equal(ui.calls[0].input, undefined);
  assert.equal(ui.drafts['project:style:new'], 'subject');
  ui.reverse();
  assert.equal(ui.calls[1].input.subjectImage, 'subject');
  for (const overrides of [{ blocked: true }, { promptDraft: {} }, { selection: {} }, { taskInstruction: () => ' ' }]) {
    const invalid = fixture('style', overrides);
    invalid.extractStyle();
    assert.equal(invalid.calls.length, 0);
  }
});
