import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptDefaultInstruction, defaultInstructions, numberedDefaultInstruction } from '../lib/task-instruction.ts';
import { emptyCreationState, resolveCreation } from '../lib/creation-context.ts';

const legacy = '以图 1 为主体，以图 2 为风格参考模板，生成基于图 1 的风格转换与主体重演提示词。';
const resolve = (mode, input, { job, reference, state = emptyCreationState } = {}) => resolveCreation(state,
  { projectId: 'A', inputs: input && { [mode]: input }, inputVersions: job && { [mode]: job.id } },
  { id: 'A', jobs: job ? [job] : [] }, job && reference ? { [job.id]: reference } : {}, mode, defaultInstructions[mode]);

test('defaults number only supplied images for all modes and every reference position', () => {
  for (const mode of Object.keys(defaultInstructions)) {
    const single = numberedDefaultInstruction(mode, 0, 0);
    assert.match(single, /图 1（参考/);
    assert.doesNotMatch(single, /图 [2-9]/);
  }
  for (const mode of ['style', 'reenact']) for (const index of [0, 1]) {
    const text = numberedDefaultInstruction(mode, 1, index);
    assert.ok(text.includes(`图 ${index + 1}（参考图）`));
    assert.ok(text.includes(`图 ${2 - index}（主体图）`));
  }
  for (let count = 1; count <= 6; count++) for (let index = 0; index <= count; index++) {
    const text = numberedDefaultInstruction('multi-reenact', count, index);
    assert.ok(text.includes(`图 ${index + 1}（参考模板）`));
    const subjects = text.slice(0, text.indexOf('提供的各主体'));
    for (let number = 1; number <= count + 1; number++)
      assert.equal(subjects.includes(`图 ${number}`), number !== index + 1);
  }
});

test('exact old and numbered defaults adapt after reorder, removal and addition', () => {
  let text = adaptDefaultInstruction(legacy, 'reenact', 1, 0);
  assert.match(text, /图 2（主体图）.*图 1（参考图）/);
  text = adaptDefaultInstruction(text, 'reenact', 1, 1);
  assert.match(text, /图 1（主体图）.*图 2（参考图）/);
  text = adaptDefaultInstruction(text, 'reenact', 0, 0);
  assert.doesNotMatch(text, /图 2/);
  let multi = numberedDefaultInstruction('multi-reenact', 3, 2);
  multi = adaptDefaultInstruction(multi, 'multi-reenact', 2, 1);
  assert.match(multi, /图 1、图 3提供的各主体/);
  assert.match(multi, /图 2（参考模板）/);
  multi = adaptDefaultInstruction(multi, 'multi-reenact', 4, 1);
  assert.match(multi, /图 1、图 3、图 4、图 5提供的各主体/);
});

test('empty and user-edited instructions are never treated as defaults', () => {
  for (const text of ['', ' ', '保留图1主体和图2参考的颜色', legacy + '只保留构图。', legacy.replace('风格转换', '铅笔画'),
    numberedDefaultInstruction('reenact', 1, 0) + '\n用户补充'])
    assert.equal(adaptDefaultInstruction(text, 'reenact', 1, 1), text);
});

test('saved inputs and legacy drafts resolve managed defaults without rewriting snapshots', () => {
  const input = { instruction: legacy, referenceIndex: 0, subjectImage: 'subject' };
  const snapshot = structuredClone(input);
  assert.match(resolve('reenact', input).instruction, /图 2（主体图）.*图 1（参考图）/);
  assert.deepEqual(input, snapshot);
  const state = { ...emptyCreationState, instructions: { 'A:reenact:new': legacy }, subjectDrafts: { 'A:reenact:new': 'subject' } };
  assert.match(resolve('reenact', undefined, { state }).instruction, /图 1（主体图）.*图 2（参考图）/);
  const cleared = { ...state, instructions: { 'A:reenact:new': '' } };
  assert.equal(resolve('reenact', input, { state: cleared }).instruction, '');
});

test('normalizing historical defaults alone does not invalidate a prompt or mutate its job', () => {
  const job = { id: 'v1', mode: 'reenact', instruction: legacy, reenact: {}, result: { promptZh: 'unchanged' } };
  const before = structuredClone(job);
  const view = resolve('reenact', undefined, { job, reference: { reenact: { subjectImage: 'subject' } } });
  assert.equal(view.instructionStale, false);
  assert.equal(view.orderStale, false);
  assert.deepEqual(job, before);
  const subjects = [{ id: 'a', role: '人物', detail: '', subjectImage: 'a' }, { id: 'b', role: '物品', detail: '', subjectImage: 'b' }];
  const multiJob = { id: 'm1', mode: 'multi-reenact', instruction: defaultInstructions['multi-reenact'], reenact: { subjects }, result: {} };
  const multi = resolve('multi-reenact', undefined, { job: multiJob, reference: { reenact: { subjects } } });
  assert.equal(multi.multiStale, false);
  assert.equal(multi.instructionStale, false);
});
