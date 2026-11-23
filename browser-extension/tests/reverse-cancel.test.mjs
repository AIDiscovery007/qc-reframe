import test from 'node:test';
import assert from 'node:assert/strict';
import { createReverseCancellation } from '../lib/reverse-action.ts';

// One canceller serves every render; each click passes the job shown at that moment, as when switching paths.
function fixture() {
  const requests = [], updates = [], errors = [];
  let pending = [];
  const cancel = createReverseCancellation({
    request: message => new Promise((resolve, reject) => requests.push({ ...message, resolve, reject })),
    onUpdate: value => updates.push(value), onError: value => errors.push(value), onPending: value => { pending = [...value]; },
  });
  return {
    requests, updates, errors,
    get pending() { return pending; },
    render: job => () => cancel(job),
  };
}

test('cancel locks per task immediately and preserves the captured task across path switches', async () => {
  const ui = fixture();
  const first = ui.render({ id: 'style', status: 'running' });
  const pendingFirst = first();
  await first();
  const second = ui.render({ id: 'reenact', status: 'running' });
  const pendingSecond = second();
  await first(); await second();
  assert.deepEqual(ui.requests.map(item => item.id), ['style', 'reenact']);
  assert.deepEqual(ui.pending, ['style', 'reenact']);
  ui.requests[0].resolve({ id: 'style', status: 'cancelled' }); await pendingFirst;
  assert.deepEqual(ui.pending, ['reenact']);
  ui.requests[1].resolve({ id: 'reenact', status: 'cancelled' }); await pendingSecond;
  assert.deepEqual(ui.updates.map(item => item.id), ['style', 'reenact']);
  assert.deepEqual(ui.pending, []);
});

test('cancel failure reports feedback and unlocks retry; idle or completed tasks cannot be cancelled', async () => {
  const ui = fixture();
  await ui.render(undefined)();
  await ui.render({ id: 'done', status: 'completed' })();
  assert.equal(ui.requests.length, 0);
  const cancel = ui.render({ id: 'multi', status: 'running' });
  const failed = cancel();
  ui.requests[0].reject(new Error('取消失败')); await failed;
  assert.equal(ui.errors.at(-1), '取消失败');
  assert.equal(ui.updates.length, 0);
  assert.deepEqual(ui.pending, []);
  const retry = cancel();
  assert.equal(ui.requests.length, 2);
  assert.equal(ui.errors.at(-1), '');
  ui.requests[1].resolve({ id: 'multi', status: 'cancelled' }); await retry;
  assert.deepEqual(ui.pending, []);
});
