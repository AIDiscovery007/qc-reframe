import test from 'node:test';
import assert from 'node:assert/strict';
import { initialServiceStatus, pollServiceHealth } from '../lib/service-health.ts';

// A surface that records what the poller shows; `health` and `project` answers are scripted per poll.
function fixture({ projectId, health = [], projects = [], token = { current: 1 } } = {}) {
  const state = { status: { ...initialServiceStatus }, paired: false, activity: undefined, dataRevision: undefined, project: undefined, requests: [] };
  const refs = { projectRevision: { current: 0 }, deletingProjects: { current: false }, project: { current: undefined } };
  let poll;
  const stop = pollServiceHealth({
    query: async path => { assert.equal(path, '/health'); const next = health.shift(); if (next instanceof Error) throw next; return typeof next === 'function' ? next() : next; },
    request: async message => { state.requests.push(message); const next = projects.shift(); return typeof next === 'function' ? next() : next; },
    pollWhileVisible: callback => { poll = callback; return () => { poll = undefined; }; },
    generation: { token: () => token.current, apply: (_health, seen) => seen === token.current, current: seen => seen === token.current },
    ...refs,
    setStatus: patch => { state.status = { ...state.status, ...patch }; },
    setPaired: () => { state.paired = true; },
    setActivity: value => { state.activity = value; },
    setDataRevision: value => { state.dataRevision = value; },
    setProject: value => { state.project = value; refs.project.current = value; },
  }, projectId);
  return { state, refs, token, stop, poll: () => poll() };
}
const ready = { ready: true, skill: 'alchemy', active: 0, model: 'gpt-image', agent: 'pi', projectsRevision: 'r1' };

test('user sees the connected Agent and model, with fast polling only while the service is busy', async () => {
  // Given a paired service that is idle, then running one visible task.
  const f = fixture({ health: [ready, { ...ready, active: 2, visibleActive: 1, hiddenProjectIds: ['hidden'] }, { ...ready, cliBusy: true }] });
  // When the surface polls.
  assert.equal(await f.poll(), 10_000);
  // Then status, pairing and the idle delay are shown.
  assert.deepEqual(f.state.status, { ...initialServiceStatus, connected: true, connectionText: '已连接 · alchemy', cliBusy: false, cliStatus: undefined, modelBusy: false, reverseAgent: 'pi', selectedModel: 'gpt-image' });
  assert.equal(f.state.paired, true);
  assert.equal(await f.poll(), 2000);
  assert.deepEqual(f.state.activity, { busy: true, active: 1, hiddenProjectIds: ['hidden'] });
  assert.equal(await f.poll(), 2000, 'a busy CLI also keeps the fast cadence');
});

test('user without the reverse skill or with an older bridge sees it named, not an empty library', async () => {
  // Given health that lacks the skill and the project revision field.
  const f = fixture({ projectId: 'A', health: [{ ready: false, skill: '', active: 0 }, { ready: false, skill: '', active: 0 }], projects: [{ id: 'A', revision: 'p1' }, { id: 'A', revision: 'p2' }] });
  // When it polls twice.
  await f.poll(); await f.poll();
  // Then the missing skill and legacy revision are reported, the Agent defaults to Codex and the project is refetched every time.
  assert.equal(f.state.status.connectionText, '未找到图片逆向技能');
  assert.equal(f.state.status.reverseAgent, 'codex');
  assert.equal(f.state.dataRevision, 'legacy');
  assert.equal(f.state.requests.length, 2, 'a legacy bridge cannot tell whether projects changed');
  assert.equal(f.state.requests[1].revision, 'p1', 'the saved project revision lets the bridge answer unchanged');
});

test('user keeps the open project until the bridge project revision moves', async () => {
  // Given an open project and a bridge revision that stays, then moves with an unchanged answer.
  const f = fixture({ projectId: 'A', health: [ready, ready, { ...ready, projectsRevision: 'r2' }], projects: [{ id: 'A', revision: 'p1' }, { unchanged: true, revision: 'p1' }] });
  await f.poll(); await f.poll();
  assert.equal(f.state.requests.length, 1, 'an unchanged bridge revision does not refetch');
  // When the revision moves but the project itself is unchanged.
  await f.poll();
  // Then the project is asked with its saved revision and kept.
  assert.deepEqual(f.state.requests.map(item => item.revision), [undefined, 'p1']);
  assert.equal(f.state.project.revision, 'p1');
});

test('user mutations started during a poll are not overwritten by that older poll', async () => {
  // Given a health read that resolves after a local project mutation began.
  let f;
  f = fixture({ projectId: 'A', health: [() => { f.refs.projectRevision.current++; return { ...ready, active: 1 }; }, ready],
    projects: [{ id: 'A', revision: 'before-mutation' }, { id: 'A', revision: 'after-mutation' }] });
  // When the poll completes.
  await f.poll();
  // Then status still updates, but activity and the project answer are left to the newer mutation.
  assert.equal(f.state.status.connected, true);
  assert.equal(f.state.activity, undefined);
  assert.equal(f.state.project, undefined);
  // And the next poll at the same bridge revision still refetches, because the dropped answer was never adopted.
  await f.poll();
  assert.equal(f.state.requests.length, 2);
  assert.equal(f.state.project.revision, 'after-mutation');
  assert.deepEqual(f.state.activity, { busy: false, active: 0, hiddenProjectIds: [] });
});

test('user deleting projects sees neither revision nor project refreshes until deletion settles', async () => {
  // Given a deletion in progress.
  const f = fixture({ projectId: 'A', health: [ready] });
  f.refs.deletingProjects.current = true;
  // When health arrives.
  await f.poll();
  // Then neither the library revision nor the open project is reloaded mid-deletion.
  assert.equal(f.state.dataRevision, undefined);
  assert.deepEqual(f.state.requests, []);
});

test('user sees the service as disconnected on failure, except for reads made under superseded settings or after leaving', async () => {
  // Given three failing health reads, the last still in flight when the surface leaves.
  let rejectLate;
  const f = fixture({ health: [new Error('本机服务未启动'), () => { f.token.current++; throw new Error('stale failure'); },
    () => new Promise((_resolve, reject) => { rejectLate = reject; })] });
  // When the first fails under current settings.
  assert.equal(await f.poll(), 10_000);
  // Then the error is shown as disconnected.
  assert.equal(f.state.status.connected, false); assert.equal(f.state.status.connectionText, '本机服务未启动');
  // When image settings change while the second read is pending, its failure is dropped.
  await f.poll();
  assert.equal(f.state.status.connectionText, '本机服务未启动');
  // When the surface leaves while a read is in flight, its failure changes nothing.
  const pending = f.poll(); f.stop();
  rejectLate(new Error('late failure')); await pending;
  assert.equal(f.state.status.connectionText, '本机服务未启动');
});

test('user leaving a project discards a project answer that arrives afterwards', async () => {
  // Given a project request that resolves after the surface cleaned up.
  let f, release;
  f = fixture({ projectId: 'A', health: [ready], projects: [() => new Promise(resolve => { release = resolve; })] });
  const pending = f.poll();
  await new Promise(resolve => setImmediate(resolve));
  // When the surface stops, then the late project arrives.
  f.stop(); release({ id: 'A', revision: 'late' }); await pending;
  // Then the late project is not shown.
  assert.equal(f.state.project, undefined);
});
