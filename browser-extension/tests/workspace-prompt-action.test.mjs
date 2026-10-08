import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { validGenerationRatio } from '../lib/generation-session.ts';
import { creationContext, emptyCreationState, resolveCreation } from '../lib/creation-context.ts';

// Exercise the actual workspace action derivation and submitted input for each path.
const source = await readFile(new URL('../entrypoints/popup/App.tsx', import.meta.url), 'utf8');
const tree = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ['instructionStale', 'genericPrompt', 'needsPrompt', 'subjectError', 'reverseHint', 'genericHint', 'reverseDisabled', 'ratio', 'chainDisabled', 'reverse'];
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
    exports, workspace: true, chainRatio: undefined, drawerKey: "project:mode:version", validGenerationRatio, preferences: { mode }, result: undefined, job: undefined, blocked: false, promptDraft: undefined,
    selection: { image: 'reference' }, referenceError: undefined, displayImage: 'reference', subjectDraftKey: mode => `project:${mode}:new`, subjectUnavailable: {}, subjectKey: mode => `project:${mode}`,
    taskInstruction: () => 'instruction', defaultInstructions: { [mode]: 'instruction' }, subjectImage: () => 'subject',
    multiSubjects: [{ id: 'one', subjectImage: 'one' }, { id: 'two', subjectImage: 'two' }], multiPrompt: 'instruction', multiStale: false,
    contextFor: mode => resolveCreation({ ...emptyCreationState, instructions: { [`project:${mode}:v1`]: (overrides.taskInstruction || (() => 'instruction'))() } },
      { projectId: 'project' }, { id: 'project', jobs: [{ ...overrides.job, id: 'v1', mode, result: overrides.result }] }, {}, mode, 'instruction'),
    modeJob: () => overrides.job,
    dispatchCreation: action => Object.assign(drafts, creationContext(emptyCreationState, action).subjectDrafts),
    start: (mode, input, generate) => calls.push({ mode, input, generate }), ...overrides,
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

test('style follows effective subjects across saves, deletion, history and project switches', () => {
  const generic = { id: 'generic', mode: 'style', instruction: 'instruction', result: {} };
  const dedicated = { ...generic, id: 'dedicated', reenact: { basePrompt: 'instruction' } };
  const project = { id: 'project', jobs: [generic, dedicated] };
  const references = { generic: { image: 'reference' }, dedicated: { image: 'reference', reenact: { subjectImage: 'historical-subject' } } };
  let state = { ...emptyCreationState, versions: { 'project:style': 'generic' } };
  let selection = { projectId: 'project', image: 'reference', inputVersions: { style: 'generic' }, inputRevision: 1, inputs: { style: { instruction: 'instruction' } } };
  const submit = (expected, source = selection, saved = project, refs = references) => {
    const context = resolveCreation(state, source, saved, refs, 'style', 'instruction');
    const ui = fixture('style', { contextFor: () => context, subjectImage: () => context.subjectImage, job: context.job, result: context.job?.result });
    ui.reverse();
    assert.equal(ui.calls.length, 1);
    assert.equal(ui.calls[0].input?.subjectImage, expected);
  };
  submit(undefined);
  selection = { ...selection, inputRevision: 2, inputs: { style: { instruction: 'instruction', subjectImage: 'uploaded' } } };
  state = creationContext(state, { type: 'adopt', selection, savedMode: 'style' });
  submit('uploaded');
  state = creationContext(state, { type: 'select', key: 'project:style', version: 'dedicated' });
  submit('historical-subject');
  state = creationContext(state, { type: 'select', key: 'project:style', version: 'generic' });
  submit('uploaded');
  selection = { ...selection, inputRevision: 3, inputs: { style: { instruction: 'instruction', subjectImage: '' } } };
  state = creationContext(state, { type: 'adopt', selection, savedMode: 'style' });
  submit(undefined);
  submit(undefined, { projectId: 'other', image: 'reference', inputs: { style: { instruction: 'instruction' } } }, { id: 'other', jobs: [] });
  submit(undefined);
  assert.equal(project.jobs[1].reenact.basePrompt, 'instruction');
  assert.equal(references.dedicated.reenact.subjectImage, 'historical-subject');
});

test('missing subject resources block style extraction; valid replacements and explicit deletion recover', () => {
  const job = { id: 'v1', mode: 'style', instruction: 'instruction', result: {}, reenact: { basePrompt: 'instruction' } };
  const project = { id: 'project', jobs: [job] };
  const selection = { projectId: 'project', inputVersions: { style: 'v1' } };
  const references = { v1: { image: 'reference', subjectError: '历史主体图损坏' } };
  const check = (state, selected, expected, blocked = false) => {
    const context = resolveCreation(state, selected, project, references, 'style', 'instruction');
    const ui = fixture('style', { contextFor: () => context, subjectImage: () => context.subjectImage, job, result: job.result });
    ui.reverse();
    assert.equal(ui.reverseDisabled, blocked);
    assert.equal(ui.calls.length, blocked ? 0 : 1);
    if (blocked) {
      assert.equal(ui.reverseHint, context.subjectError);
      assert.equal(context.subjectImage, '', '损坏的当前主体不得回退到历史主体');
    }
    else assert.equal(ui.calls[0].input?.subjectImage, expected);
  };
  check(emptyCreationState, selection, undefined, true);
  references.v1 = { image: 'reference', reenact: { subjectImage: 'historical-subject' } };
  check(emptyCreationState, { ...selection, inputs: { style: { subjectImage: '', subjectError: '当前主体图损坏' } } }, undefined, true);
  check(emptyCreationState, { ...selection, inputs: { style: { subjectImage: 'replacement' } } }, 'replacement');
  check(emptyCreationState, { ...selection, inputs: { style: { subjectImage: '' } } }, undefined);
  references.v1 = { image: 'reference', subjectError: '历史主体图损坏' };
  for (const subjectImage of ['draft-replacement', '']) {
    const state = creationContext(emptyCreationState, { type: 'edit', key: 'project:style', version: 'v1', subjectImage });
    check(state, selection, subjectImage || undefined);
  }
});


test('continuous action uses a new reverse submission and blocks incomplete inputs or invalid ratios', () => {
  for (const mode of ['style', 'recreate', 'reenact', 'multi-reenact']) {
    const ui = fixture(mode);
    ui.reverse(true);
    assert.equal(ui.calls.length, 1);
    assert.equal(ui.calls[0].generate, true);
    ui.reverse();
    assert.equal(ui.calls[1].generate, false);
  }
  for (const overrides of [{ subjectImage: () => '' }, { promptDraft: {} }, { blocked: true },
    { chainRatio: { key: 'project:mode:version', ratio: { width: 0, height: 1 } } }]) {
    const ui = fixture('style', overrides);
    ui.reverse(true);
    assert.equal(ui.calls.length, 0);
  }
  const ui = fixture('style', { subjectImage: () => '' });
  ui.reverse();
  assert.equal(ui.calls.length, 1, 'reference-only style still supports reverse only');
});
