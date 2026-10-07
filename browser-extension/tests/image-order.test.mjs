import test from 'node:test';
import assert from 'node:assert/strict';
import { orderedImageIds, moveImage } from '../lib/image-order.ts';
import { createInputWriter, emptyCreationState, resolveCreation } from '../lib/creation-context.ts';

test('moving subjects across the reference preserves roles and supports every reference position', () => {
  let subjects = ['person', 'cup'], referenceIndex = 0;
  for (const [id, delta, expected] of [
    ['reference', 1, ['person', 'reference', 'cup']],
    ['cup', -1, ['person', 'cup', 'reference']],
    ['person', 1, ['cup', 'person', 'reference']],
    ['reference', -1, ['cup', 'reference', 'person']],
  ]) {
    const moved = moveImage(subjects, referenceIndex, id, delta);
    subjects = moved.subjectIds; referenceIndex = moved.referenceIndex;
    assert.deepEqual(orderedImageIds(subjects, referenceIndex), expected);
  }
  assert.equal(moveImage(subjects, referenceIndex, 'cup', -1), undefined);
  assert.equal(moveImage(subjects, referenceIndex, 'person', 1), undefined);
  assert.deepEqual(orderedImageIds([], 0), ['reference']);
});

test('new input defaults to reference first; old snapshots and drafts retain their original numbering', () => {
  const selection = { projectId: 'A', image: 'reference' };
  const resolve = (state, selected = selection, jobs = []) => resolveCreation(state, selected, { id: 'A', jobs }, {}, 'reenact', 'default');
  assert.equal(resolve(emptyCreationState).referenceIndex, 0);
  const oldJob = { id: 'old', mode: 'reenact', reenact: {}, result: {} };
  assert.equal(resolve(emptyCreationState, selection, [oldJob]).referenceIndex, 1);
  assert.equal(resolve(emptyCreationState, selection, [{ ...oldJob, referenceIndex: 0 }]).referenceIndex, 0);
  assert.equal(resolve(emptyCreationState, { ...selection, inputs: { reenact: { subjectImage: 'old subject' } } }).referenceIndex, 1);
  const draft = { ...emptyCreationState, subjectDrafts: { 'A:reenact:new': 'old draft' } };
  assert.equal(resolve(draft).referenceIndex, 1);
  assert.equal(resolve(draft, { ...selection, inputs: { reenact: { referenceIndex: 0, subjectImage: 'saved subject' } } }).referenceIndex, 0);
});

test('current input with a different order cannot reuse the prompt while historical views keep their snapshot', () => {
  const job = { id: 'v1', mode: 'reenact', referenceIndex: 1, reenact: {}, result: {} };
  const selection = { projectId: 'A', inputVersions: { reenact: 'v1' }, inputs: { reenact: { referenceIndex: 0, subjectImage: 'subject' } } };
  const view = selected => resolveCreation(emptyCreationState, selected, { id: 'A', jobs: [job] }, {}, 'reenact', 'default');
  assert.equal(view(selection).orderStale, true);
  assert.equal(view({ ...selection, inputVersions: { reenact: 'new' } }).referenceIndex, 1);
  assert.equal(view({ ...selection, inputVersions: { reenact: 'new' } }).orderStale, false);
  const restored = resolveCreation(emptyCreationState, { projectId: 'A' }, { id: 'A', jobs: [job] },
    { v1: { referenceIndex: 0, generationSubjectImage: 'restored subject' } }, 'reenact', 'default');
  assert.equal(restored.referenceIndex, 0);
  assert.equal(restored.orderStale, true);
});

test('saving order uses the same revision gate and ignores a response after navigation', async () => {
  let release, context = {}, commits = 0;
  const sent = [];
  const writer = createInputWriter(message => { sent.push(message); return new Promise(resolve => { release = resolve; }); }, () => ({ context, revision: 2 }));
  const input = { selection: { projectId: 'A', inputRevision: 2 }, mode: 'reenact', instruction: 'keep roles', referenceIndex: 0, subjectImage: 'subject' };
  const pending = writer.save(input, () => { commits++; });
  await assert.rejects(writer.save(input, () => {}), /当前无法修改/);
  assert.equal(sent[0].referenceIndex, 0);
  assert.equal(sent[0].expectedRevision, 2);
  context = {}; release({ projectId: 'A', inputRevision: 3 }); await pending;
  assert.equal(commits, 0);
  assert.equal(writer.pending, false);
});
