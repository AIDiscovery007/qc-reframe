import test from 'node:test';
import assert from 'node:assert/strict';
import { creationContext, emptyCreationState, createInputWriter } from '../lib/creation-context.ts';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const subjects = [{ id: 'a', subjectImage: 'a', role: '人物', detail: '帽子' }, { id: 'b', subjectImage: 'b', role: '物品', detail: '' }];
const input = mode => ({ selection: { projectId: 'A', inputRevision: 7 }, mode, referenceJobId: 'v1', image: 'new-reference',
  instruction: 'retained instruction', subjectImage: 'retained subject', subjects, sessionIds: ['session-1'] });
const selection = { id: 'next', projectId: 'A', inputRevision: 8, inputVersions: { style: 'new', recreate: 'new', reenact: 'new', 'multi-reenact': 'new', session: 'new' } };
function fixture(send) {
  const calls = [], scope = { context: {}, revision: 0 };
  const writer = createInputWriter(async message => { calls.push(message); return send ? send(message) : selection; }, () => ({ ...scope }));
  return { writer, calls, scope };
}

test('input writer sends CAS, immutable version identity and only the inputs for each mode', async () => {
  for (const mode of ['style', 'reenact', 'recreate', 'multi-reenact', 'session']) {
    const { writer, calls } = fixture();
    const next = await writer.save(input(mode), () => {});
    assert.equal(next, selection);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].type, 'alchemy:update-project-input');
    assert.equal(calls[0].projectId, 'A');
    assert.equal(calls[0].expectedRevision, 7);
    assert.equal(calls[0].referenceJobId, 'v1');
    assert.equal(calls[0].instruction, 'retained instruction');
    assert.equal(calls[0].image, 'new-reference');
    assert.equal(calls[0].subjectImage, ['style', 'reenact'].includes(mode) ? 'retained subject' : undefined);
    assert.equal(calls[0].subjects, mode === 'multi-reenact' ? subjects : undefined);
    assert.deepEqual(calls[0].sessionIds, mode === 'session' ? ['session-1'] : undefined);
    const committed = creationContext(emptyCreationState, { type: 'adopt', selection: next, savedMode: mode });
    assert.equal(committed.inputRevisions.A, 8);
    assert.equal(committed.versions[`A:${mode}`], 'new');
    assert.equal(writer.pending, false);
  }
});

test('navigation invalidates delivery while leaving the submitted durable write independent', async () => {
  for (const change of ['project', 'mode', 'version', 'away-back', 'selection']) {
    const response = deferred(), { writer, calls, scope } = fixture(() => response.promise);
    const pending = writer.save(input('style'), () => {});
    if (change === 'selection') scope.revision++;
    else scope.context = {};
    response.resolve(selection);
    assert.equal(await pending, undefined, change);
    assert.equal(calls.length, 1);
    assert.equal(writer.pending, false);
  }
});

test('ordinary renders keep the input lease, failed writes release it for retry', async () => {
  const response = deferred(), ui = fixture(() => response.promise);
  const pending = ui.writer.save(input('style'), () => {});
  assert.equal(ui.writer.pending, true);
  response.resolve(selection);
  assert.equal(await pending, selection);
  let fail = true;
  const retry = fixture(() => { if (fail) throw new Error('项目输入已变化'); return selection; });
  await assert.rejects(retry.writer.save(input('style'), () => {}), /项目输入已变化/);
  assert.equal(retry.writer.pending, false);
  fail = false;
  assert.equal(await retry.writer.save(input('style'), () => {}), selection);
});

test('synchronous duplicate writes are rejected before a render and cannot unlock the first write', async () => {
  const response = deferred(), { writer, calls } = fixture(() => response.promise);
  const pending = writer.save(input('style'), () => {});
  await assert.rejects(writer.save(input('style'), () => {}), /当前无法修改图片/);
  assert.equal(writer.pending, true);
  assert.equal(calls.length, 1);
  response.resolve(selection); await pending;
  assert.equal(writer.pending, false);
});

test('a successful subject-only save removes its working draft and preserves historical drafts', async () => {
  const next = { ...selection, inputVersions: { style: 'v1' }, inputs: { style: { subjectImage: 'replacement' } } };
  const { writer, calls } = fixture(() => next);
  const committed = await writer.save({ ...input('style'), image: undefined, subjectImage: 'replacement' }, () => {});
  assert.equal(calls[0].image, undefined);
  const before = { ...emptyCreationState, subjectDrafts: { 'A:style:v1': 'old draft', 'A:style:v0': 'historical' },
    instructions: { 'A:style:v1': 'old instruction', 'B:style:new': 'other project' } };
  const after = creationContext(before, { type: 'adopt', selection: committed, savedMode: 'style' });
  assert.deepEqual(after.subjectDrafts, { 'A:style:v0': 'historical' });
  assert.deepEqual(after.instructions, { 'B:style:new': 'other project' });
  assert.equal(after.versions['A:style'], 'v1');
  assert.equal(before.subjectDrafts['A:style:v1'], 'old draft', 'previous state is immutable');
});


test('accepted input commits in the same continuation as its lease check', async () => {
  let resolve;
  const response = new Promise(done => { resolve = done; });
  const scope = { context: {}, revision: 0 }, oldContext = scope.context;
  const writer = createInputWriter(() => response, () => ({ ...scope }));
  const commits = [];
  const pending = writer.save(input('style'), next => commits.push({ context: scope.context, next }));
  resolve(selection);
  queueMicrotask(() => { scope.context = {}; });
  await pending;
  assert.equal(commits.length, 1);
  assert.equal(commits[0].context, oldContext, 'no unguarded consumer continuation can overwrite the next context');
  assert.notEqual(scope.context, oldContext);
});
