import test from 'node:test';
import assert from 'node:assert/strict';
import { createGenerationSession, generationReadiness } from '../lib/generation-session.ts';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const job = (id = 'version-a', mode = 'style') => ({ id, mode, result: { promptZh: '专属提示词', promptEn: 'dedicated prompt' }, reenact: {}, generations: [] });
const input = (patch = {}) => ({ job: job(), lang: 'zh', disabled: false, subjectImage: 'subject-a', ...patch });

test('user submits Magpie pixels with immutable image inputs instead of an aspect ratio', async () => {
  // Given a ready attached-image task, When submitted and then edited, Then pixels and inputs retain their original values.
  const f = fixture(), imageSize = { width: 1536, height: 1024 };
  const candidate = input({ imageSize, pixelSize: true });
  const action = f.session.act(candidate, false, f.callbacks);
  imageSize.width = 512; candidate.subjectImage = 'later';
  assert.deepEqual(f.requests[0].message.imageSize, { width: 1536, height: 1024 });
  assert.equal(f.requests[0].message.aspectRatio, undefined);
  assert.equal(f.requests[0].message.subjectImage, 'subject-a');
  f.requests[0].resolve(job()); await action;
});

test('user cannot submit malformed pixels or mix pixel and ratio channels', async () => {
  // Given a valid prompt, When dimensions are invalid or belong to another channel, Then no generation request is sent.
  const f = fixture();
  for (const patch of [
    ...[{ width: '1024', height: 1024 }, { width: 1024 }, { width: 1024, height: 1024, extra: true }].map(imageSize => ({ imageSize, pixelSize: true })),
    { pixelSize: true, aspectRatio: { width: 1, height: 1 } }, { imageSize: { width: 1024, height: 1024 } },
  ]) {
    assert.equal(generationReadiness(input(patch)).canGenerate, false);
    assert.equal(await f.session.act(input(patch), false, f.callbacks), false);
  }
  assert.equal(f.requests.length, 0);
});

test('user retries saving an existing generated result without another paid generation', async () => {
  // Given generated output awaiting persistence, When saving is retried, Then only the existing generation save operation is requested.
  const f = fixture(), generation = { id: 'save-pending', status: 'failed', resultSavePending: true };
  const candidate = input({ job: { ...job(), generations: [generation] } });
  assert.equal(generationReadiness(candidate).canGenerate, false);
  const action = f.session.save(generation, f.callbacks);
  assert.deepEqual(f.requests[0].message, { type: 'alchemy:save-generation', jobId: 'version-a', generationId: 'save-pending' });
  assert.equal(await f.session.save(generation, f.callbacks), false);
  f.requests[0].reject(new Error('storage full'));
  assert.equal(await action, false);
  assert.equal(f.session.getSnapshot().error, 'storage full');
  const retry = f.session.save(generation, f.callbacks);
  f.requests[1].resolve(job()); await retry;
  assert.equal(f.requests.some(item => item.message.type === 'alchemy:generate'), false);
  assert.equal(f.updates.length, 1);
});
function fixture(id = 'version-a') {
  const requests = [], updates = [], pending = [];
  const session = createGenerationSession(id, message => {
    const operation = deferred(); requests.push({ message, ...operation }); return operation.promise;
  });
  return { session, requests, updates, pending, callbacks: {
    onUpdate: (...args) => updates.push(args), onRequestState: (...args) => pending.push(args),
  } };
}

for (const allowMulti of [true, false]) test(`${allowMulti ? 'workspace' : 'quick'} generation rejects every invalid input through its real command interface`, async () => {
  const blocks = [
    { disabled: true }, { requestPending: true }, { subjectImage: '' }, { job: { ...job(), result: undefined } },
    { job: { ...job(), reenact: undefined } }, { job: { ...job(), result: { promptZh: '[SUBJECT]', promptEn: 'valid' } } },
    { lang: 'en', job: { ...job(), result: { promptZh: 'valid', promptEn: '[subject]' } } },
    { job: { ...job(), generations: [{ id: 'running', status: 'running' }] } },
    { aspectRatio: { width: 0, height: 1 } }, { aspectRatio: { width: 21, height: 1 } },
    { aspectRatio: { width: NaN, height: 1 } }, { aspectRatio: { width: 1.5, height: 1 } },
    { job: job('version-a', 'multi-reenact'), subjects: [{ subjectImage: 'one' }] },
    { job: job('version-a', 'multi-reenact'), subjects: [{ subjectImage: 'one' }, { subjectImage: '' }] },
  ];
  const f = fixture();
  for (const block of blocks) {
    const candidate = input({ allowMulti, ...block });
    assert.equal(generationReadiness(candidate).canGenerate, false);
    assert.equal(await f.session.act(candidate, false, f.callbacks), false);
  }
  assert.equal(f.requests.length, 0);
  assert.deepEqual(f.pending, []);
});

test('submission locks synchronously and captures the original language, subject and reused ratio', async () => {
  const f = fixture(), ratio = { width: 1536, height: 1024 };
  const candidate = input({ lang: 'en', aspectRatio: ratio });
  const first = f.session.act(candidate, false, f.callbacks);
  assert.equal(f.session.getSnapshot().busy, true);
  assert.equal(f.session.getSnapshot().submitting, true);
  assert.equal(await f.session.act(candidate, false, f.callbacks), false);
  ratio.width = 20; candidate.subjectImage = 'later-subject'; candidate.lang = 'zh';
  assert.deepEqual(f.requests[0].message, { type: 'alchemy:generate', id: 'version-a', language: 'en', aspectRatio: { width: 1536, height: 1024 }, subjectImage: 'subject-a' });
  f.requests[0].resolve(job());
  assert.equal(await first, true);
  assert.equal(f.updates[0][1], 'subject-a');
  assert.deepEqual(f.pending, [[true], [false, '']]);
  assert.equal(f.session.getSnapshot().busy, false);
});

test('multi-image inputs keep ordered snapshots and are unavailable in the quick adapter', async () => {
  const f = fixture(), subjects = [{ id: 'b', subjectImage: 'b', role: '人物', detail: '帽子' }, { id: 'a', subjectImage: 'a', role: '场景', detail: '' }];
  const candidate = input({ job: job('version-a', 'multi-reenact'), subjects });
  assert.equal(await f.session.act({ ...candidate, allowMulti: false }, false, f.callbacks), false);
  const first = f.session.act(candidate, false, f.callbacks);
  subjects[0].role = '物品'; subjects.reverse();
  assert.deepEqual(f.requests[0].message.subjects.map(item => [item.id, item.role]), [['b', '人物'], ['a', '场景']]);
  assert.equal('subjectImage' in f.requests[0].message, false);
  f.requests[0].resolve(candidate.job); await first;
  assert.deepEqual(f.updates[0][2], f.requests[0].message.subjects);
});

for (const mode of ['recreate', 'session']) test(`${mode} submits without subject or reference image bytes`, async () => {
  const f = fixture(), candidate = input({ job: job('version-a', mode), subjectImage: 'must-not-leak' });
  const first = f.session.act(candidate, false, f.callbacks);
  assert.deepEqual(f.requests[0].message, { type: 'alchemy:generate', id: 'version-a', language: 'zh' });
  f.requests[0].resolve(candidate.job); await first;
  assert.equal(f.updates[0][1], undefined);
});

test('cancel targets only the captured running generation and remains available for invalid edited inputs', async () => {
  const f = fixture();
  assert.equal(await f.session.act(input(), true, f.callbacks), false);
  const candidate = input({ disabled: true, subjectImage: '', aspectRatio: { width: 0, height: 0 }, job: { ...job(), generations: [{ id: 'running-a', status: 'running' }] } });
  const first = f.session.act(candidate, true, f.callbacks);
  assert.equal(await f.session.act(candidate, true, f.callbacks), false);
  assert.deepEqual(f.requests[0].message, { type: 'alchemy:generation-cancel', id: 'version-a', generationId: 'running-a' });
  f.requests[0].resolve(job()); assert.equal(await first, true);
  assert.deepEqual(f.pending, []);
  assert.equal(f.session.getSnapshot().submitting, false);
});

test('failed submission preserves an error, settles the drawer and unlocks retry', async () => {
  const f = fixture();
  const first = f.session.act(input(), false, f.callbacks);
  f.requests[0].reject(new Error('disk full')); assert.equal(await first, false);
  assert.equal(f.session.getSnapshot().error, 'disk full');
  assert.deepEqual(f.pending, [[true], [false, 'disk full']]);
  const retry = f.session.act(input(), false, f.callbacks);
  assert.equal(f.session.getSnapshot().error, '');
  f.requests[1].resolve(job()); assert.equal(await retry, true);
});

test('navigation settles only the originating version and never updates its disposed view', async () => {
  const a = fixture(), b = fixture('version-b');
  let notifications = 0;
  a.session.subscribe(() => notifications++);
  const dispose = a.session.activate();
  const first = a.session.act(input(), false, a.callbacks);
  dispose(); const before = notifications;
  const second = b.session.act(input({ job: job('version-b') }), false, b.callbacks);
  a.requests[0].resolve(job());
  assert.equal(await first, false, 'a detached view cannot select a result');
  assert.equal(notifications, before);
  assert.deepEqual(a.pending, [[true], [false, '']]);
  assert.equal(a.updates[0][0].id, 'version-a', 'the captured commit still saves that version snapshot');
  assert.equal(b.session.getSnapshot().busy, true);
  assert.deepEqual(b.pending, [[true]]);
  b.requests[0].resolve(job('version-b')); assert.equal(await second, true);
  assert.equal(await b.session.act(input(), false, b.callbacks), false, 'an old job cannot submit through the new session');
});

for (const cancel of [false, true]) for (const remount of [false, true]) test(`${cancel ? 'cancel' : 'submit'} settles data but cannot reveal a result after ${remount ? 'leaving and returning' : 'leaving'}`, async () => {
  const f = fixture(), dispose = f.session.activate();
  let reveals = 0;
  const candidate = input({ job: { ...job(), generations: cancel ? [{ id: 'running-a', status: 'running' }] : [] } });
  const pending = f.session.act(candidate, cancel, { ...f.callbacks, onViewUpdate: () => reveals++ });
  dispose();
  if (remount) f.session.activate();
  f.requests[0].resolve(job());
  assert.equal(await pending, false);
  assert.equal(reveals, 0, 'an old request cannot select a result in a newer view lifecycle');
  assert.equal(f.updates.length, 1, 'data still belongs to the original job');
  assert.deepEqual(f.pending, cancel ? [] : [[true], [false, '']]);
  if (remount) {
    const next = f.session.act(candidate, cancel, { ...f.callbacks, onViewUpdate: () => reveals++ });
    f.requests[1].resolve(job());
    assert.equal(await next, true);
    assert.equal(reveals, 1, 'a request from the current lifecycle reveals normally');
  }
});

test('old image responses and failures cannot replace the newly selected generation', async () => {
  const f = fixture();
  const releaseA = f.session.loadImage({ id: 'a', status: 'completed' });
  releaseA(); f.session.loadImage({ id: 'b', status: 'completed' });
  f.requests[1].resolve({ image: 'image-b', path: '/b', width: 100, height: 200 });
  await Promise.resolve();
  f.requests[0].reject(new Error('late failure')); await Promise.resolve();
  assert.equal(f.session.getSnapshot().asset.key, 'version-a:b');
  assert.equal(f.session.getSnapshot().asset.image, 'image-b');
  assert.equal(f.session.getSnapshot().imageError, '');
  f.session.loadImage({ id: 'running', status: 'running' });
  assert.equal(f.session.getSnapshot().asset, undefined);
  assert.equal(f.requests.length, 2);
});

test('closing comparison or leaving the view invalidates snapshot reads without cancelling tasks', async () => {
  const f = fixture(), dispose = f.session.activate();
  const close = f.session.loadReference({ id: 'a', status: 'completed' });
  close(); f.session.loadReference();
  f.requests[0].resolve({ image: 'old-reference' }); await Promise.resolve();
  assert.equal(f.session.getSnapshot().original, undefined);
  f.session.loadImage({ id: 'a', status: 'completed' });
  dispose(); f.requests[1].resolve({ image: 'late-image' }); await Promise.resolve();
  assert.equal(f.session.getSnapshot().asset, undefined);
  assert.equal(f.requests.some(item => item.message.type === 'alchemy:generation-cancel'), false);
});


test('automatic handoff blocks manual generation until settled and allows failed-chain retry', async () => {
  const f = fixture();
  const waiting = input({ job: { ...job(), autoGeneration: { language: 'zh', status: 'pending' } } });
  assert.equal(await f.session.act(waiting, false, f.callbacks), false);
  assert.equal(f.requests.length, 0);
  const retry = f.session.act(input({ job: { ...job(), autoGeneration: { language: 'zh', status: 'failed' } } }), false, f.callbacks);
  assert.equal(f.requests.length, 1);
  f.requests[0].resolve(job());
  assert.equal(await retry, true);
});


test('user submits unrestricted finite Magpie intent and unusable values become automatic', async () => {
  // Given a ready Magpie task, When raw dimensions require correction or automatic fallback, Then readiness remains open and the captured message has no NaN or Infinity.
  for (const imageSize of [null, { width: 10000, height: 10000 }, { width: 1.5, height: 1024 }, { width: 1e100, height: 2 }, { width: NaN, height: 1024 }, { width: Infinity, height: 1024 }, { width: -1, height: 1024 }, { width: null, height: 1024 }]) {
    const f = fixture(), candidate = input({ pixelSize: true, imageSize });
    assert.equal(generationReadiness(candidate).canGenerate, true);
    const action = f.session.act(candidate, false, f.callbacks);
    const positive = [imageSize?.width, imageSize?.height].every(value => Number.isFinite(value) && value > 0);
    assert.deepEqual(f.requests[0].message.imageSize, positive ? imageSize : undefined);
    assert.equal(f.requests[0].message.aspectRatio, undefined);
    f.requests[0].resolve(job()); await action;
  }
});
