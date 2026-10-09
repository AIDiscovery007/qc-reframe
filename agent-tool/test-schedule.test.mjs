import test from 'node:test';
import assert from 'node:assert/strict';
import { planSchedule } from './test-schedule.mjs';

const target = (sha, fields = {}) => ({ sha, head: sha, base: '', ref: 'main', fork: false, code: true, ...fields });
test('user（维护者）每小时只运行准确版本尚未成功且不在跑的代码', () => {
  // Given exact successes, running work, failure, cancellation and a new PR merge.
  const targets = ['a', 'b', 'c', 'd', 'e'].map(sha => target(sha));
  const jobs = [
    { name: 'full/v1/policy/main/a', conclusion: 'success', status: 'completed' },
    { name: 'full/v1/policy/main/b', conclusion: null, status: 'in_progress' },
    { name: 'full/v1/policy/main/c', conclusion: 'failure', status: 'completed' },
    { name: 'full/v1/policy/main/d', conclusion: 'cancelled', status: 'completed' },
    { name: 'full/v1/old/main/e', conclusion: 'success', status: 'completed' },
  ];
  // When planning with the current trusted controller policy.
  const plan = planSchedule({ targets, jobs, controller: 'policy' });
  // Then only failed, cancelled and new/current-policy identities run.
  assert.deepEqual(plan.include.map(item => item.sha), ['c', 'd', 'e']);
  assert.deepEqual(plan.deferred.map(item => item.reason), ['success', 'running']);
});

test('user（维护者）保留fork审批边界、文档轻量和手动提前full，不重复在跑版本', () => {
  // Given a fork, a docs-only PR, a blocked merge and an already-running target.
  const targets = [target('fork', { fork: true }), target('docs', { code: false }), target('blocked', { blocked: 'merge-conflict' }), target('running')];
  const jobs = [{ name: 'full/v1/policy/main/running', status: 'in_progress' }];
  // When scheduled normally, then only actionable trusted code may be enqueued.
  let result = planSchedule({ targets, jobs, controller: 'policy' });
  assert.deepEqual(result.include, []);
  assert.deepEqual(result.deferred.map(item => item.reason), ['fork-independent-trusted-verification-required', 'docs', 'merge-conflict', 'running']);
  // When manually requested early, docs may run full but forks/blocked/running stay protected.
  result = planSchedule({ targets, jobs, controller: 'policy', force: true });
  assert.deepEqual(result.include.map(item => item.sha), ['docs']);
});

test('user（维护者）只有当前merge的准确父提交和当前成功job可以用于合并', async t => {
  // Given a real temporary Git repository with a base/head merge and an old successful job.
  const { verifyTarget, requireFull, verifyController } = await import('./test-schedule.mjs');
  const { mkdtempSync, writeFileSync, rmSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const root = mkdtempSync(join(tmpdir(), 'reframe-schedule-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-b', 'main'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'fixture');
  mkdirSync(join(root,'agent-tool')); writeFileSync(join(root,'agent-tool/test-schedule.mjs'),'trusted');
  writeFileSync(join(root, 'base'), 'a'); git('add', '.'); git('commit', '-qm', 'base'); const base = git('rev-parse', 'HEAD');
  git('checkout', '-qb', 'feature'); writeFileSync(join(root, 'feature'), 'b'); git('add', '.'); git('commit', '-qm', 'feature'); const head = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'main'); git('merge', '--no-ff', '-qm', 'merge', 'feature'); const sha = git('rev-parse', 'HEAD');
  const current = { sha, base, head, number: 1, code: true };
  // When verifying exact checkout and successful full evidence.
  assert.equal(verifyTarget({ root, target: current }).sha, sha);
  assert.equal(verifyController(root,sha),sha);
  assert.throws(()=>verifyController(root,base));
  writeFileSync(join(root,'agent-tool/test-schedule.mjs'),'dirty controller');
  assert.throws(()=>verifyController(root,sha));
  writeFileSync(join(root,'agent-tool/test-schedule.mjs'),'trusted');
  assert.throws(() => verifyTarget({ root, target: { ...current, head: base } }));
  assert.throws(() => requireFull({ target: current, controller: 'policy', jobs: [{ name: 'full/v1/policy/main/old', status: 'completed', conclusion: 'success' }] }));
  assert.equal(requireFull({ target: current, controller: 'policy', jobs: [{ name: `full/v1/policy/pr1/${sha}`, status: 'completed', conclusion: 'success' }] }).status, 'passed');
  // Then cancellation at that SHA still isn't success.
  assert.throws(() => requireFull({ target: current, controller: 'policy', jobs: [{ name: `full/v1/policy/pr1/${sha}`, status: 'completed', conclusion: 'cancelled' }] }));
});

test('user（维护者）API或分页证据不完整时看见失败，不会得到虚假的空调度成功', async () => {
  // Given a GitHub boundary that fails while listing open PRs.
  const { discoverTargets } = await import('./test-schedule.mjs');
  const api = { get: async () => ({ sha: 'a'.repeat(40) }), list: async () => { throw Error('page 2 failed'); } };
  // When the trusted planner discovers targets, then the failure is surfaced.
  await assert.rejects(discoverTargets({ api, branch: 'main' }), /page 2 failed/);
});

test('user（维护者）不会把schedule控制提交误认为实际被测main或PR版本', async () => {
  // Given a scheduled run whose controller SHA differs from the target SHA.
  const { fullJobs } = await import('./test-schedule.mjs');
  const old = process.env.DEFAULT_BRANCH; process.env.DEFAULT_BRANCH='main';
  try {
    const api={list:async(path)=>path.includes('/attempts/') ? [{name:'full/v1/policy/main/target',status:'completed',conclusion:'success'},{name:'full/v1/policy/pr1/merge',status:'completed',conclusion:'success'}] : [{id:9876,event:'schedule',head_branch:'main',head_sha:'controller',run_attempt:1,status:'completed',conclusion:'success'}]};
    // When reading successful worker evidence, then target kind/SHA come from the exact worker identity.
    const jobs=await fullJobs(api);
    assert.equal(jobs[0].main,true); assert.equal(jobs[0].testedSha,'target');
    assert.equal(jobs[1].main,false); assert.equal(jobs[1].testedSha,'merge');
  } finally {if(old===undefined)delete process.env.DEFAULT_BRANCH;else process.env.DEFAULT_BRANCH=old;}
});

test('user（维护者）fork伪造成功报告或同名成功job仍须独立可信验收', async () => {
  // Given a fork-controlled report claiming full success for the current merge,
  // alongside a successful job copying the trusted scheduler's exact name.
  const {requireFull}=await import('./test-schedule.mjs');
  const current=target('merge',{number:1,head:'head',base:'base',fork:true});
  const native={event:'pull_request',head:'head',status:'completed',conclusion:'success',jobPassed:true,report:{commit:'merge',status:'passed',mode:'full',deferred:[]}};
  const jobs=[{name:'full/v1/policy/pr1/merge',status:'completed',conclusion:'success'}];
  // When checking any combination, fork-supplied success is never automatic acceptance.
  for (const evidence of [{jobs:[],native},{jobs},{jobs,native}]) {
    assert.throws(()=>requireFull({target:current,controller:'policy',...evidence}),/Fork requires independent trusted maintainer verification/);
  }
  // Then even a manual schedule request defers this fork for independent verification.
  const plan=planSchedule({targets:[current],jobs,controller:'policy',force:true});
  assert.deepEqual(plan.include,[]);
  assert.equal(plan.deferred[0].reason,'fork-independent-trusted-verification-required');
});

test('user（维护者）可执行或符号链接文档不会被定时调度误判为纯说明', async () => {
  // Given a main change named README.md, but its Git mode is executable.
  const {discoverTargets}=await import('./test-schedule.mjs');
  const api={get:async path=>path.startsWith('commits/')?{sha:'new'}:path.startsWith('compare/')?{status:'ahead',files:[{filename:'README.md'}]}:{truncated:false,tree:[{path:'README.md',type:'blob',mode:path.includes('new')?'100755':'100644'}]},list:async()=>[]};
  // When scheduling against a previous successful full main target, then code validation remains required.
  const targets=await discoverTargets({api,branch:'main',jobs:[{main:true,conclusion:'success',name:'full/v1/policy/main/old'}]});
  assert.equal(targets[0].code,true);
});

test('user（维护者）重跑成功只读取该attempt的最新artifact，旧失败证据不能串入', async () => {
  // Given repeated artifacts from attempts 1 and 2, including two entries in the current attempt.
  const {attemptArtifact}=await import('./test-schedule.mjs');
  const artifacts=[{id:1,name:'test-index-target-attempt-1'},{id:2,name:'test-index-target-attempt-2'},{id:3,name:'test-index-target-attempt-2'},{id:4,name:'test-index-target-attempt-2',expired:true}];
  // When selecting attempt 2, then only its newest available artifact qualifies.
  assert.equal(attemptArtifact(artifacts,'test-index-target',2).id,3);
  assert.equal(attemptArtifact(artifacts,'test-index-target',3),undefined);
  assert.throws(()=>attemptArtifact(artifacts,'test-index-target',undefined));
});
