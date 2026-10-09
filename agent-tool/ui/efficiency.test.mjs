import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { validationWindow } from './build.mjs';
import { extension } from './inventory.mjs';
import { scenarios } from './catalog.mjs';
import { validateCoverage, sealArtifacts, fileDigest, inspectEvidence } from './evidence.mjs';

const lock = join(extension, '.output/ui-validation.lock');

test('shared window permits nesting, refuses competing ownership and releases on exception', async () => {
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let release;
  const held = validationWindow('test-owner', async () => { entered(); await new Promise(resolve => { release = resolve; }); });
  await started;
  await assert.rejects(validationWindow('competitor', () => {}), /验证窗口被占用/);
  release(); await held;
  await assert.rejects(validationWindow('outer', () => validationWindow('inner', () => { throw new Error('expected nested failure'); })), /expected nested/);
  await assert.rejects(access(lock));
});

for (const signal of ['SIGINT', 'SIGTERM']) test(`${signal} releases a validation window without silently reporting success`, async () => {
  const script = `import {validationWindow} from ${JSON.stringify(new URL('./build.mjs', import.meta.url).href)};
try { await validationWindow('signal-fixture', async () => { process.kill(process.pid,${JSON.stringify(signal)}); await new Promise(resolve=>setTimeout(resolve,30)); return {status:'passed'}; }); console.log('unexpected success'); }
catch(error) { console.log(error.message); }`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script]);
  let out = '', err = '';
  child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { err += chunk; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(code, 0, err); assert.match(out, /验证窗口已取消/); assert.doesNotMatch(out, /unexpected success/);
  await assert.rejects(access(lock));
});

// Structure-only fixtures, never evidence that a browser was executed.
function coverageFixture() {
  const state = { sourceHash: 's', buildHash: 'b', fixtureHash: 'f', checkerHash: 'c' };
  const counts = { BUILD: 2, LOAD: 1, NETWORK: 2, POPUP: 2, 'CLOSED-SHADOW': 3, MENU: 2, FOCUS: 2, 'PAGE-ERROR': 1, CLEANUP: 1 };
  return { schemaVersion: 2, tier: 'browser', status: 'passed', evidenceState: state, steps: [
    { id: 'static-and-maintenance', status: 'passed' },
    { id: 'preview', status: 'passed', scope: 'complete', source: { hash: 's', buildHash: 'b' }, fixture: { hash: 'f' }, rulesAndRunnerHash: 'c', scenarios: scenarios.map(scene => ({ id: scene.id, status: 'passed', evidence: { screenshot: '/synthetic.png' }, checks: (scene.regression ? ['UI-BEHAVIOR'] : scene.rules).map(ruleId => ({ ruleId, status: 'passed' })) })) },
    { id: 'extension', status: 'passed', checks: Object.entries(counts).flatMap(([id, count]) => Array.from({ length: count }, () => ({ ruleId: 'UI-EXTENSION-' + id, status: 'passed' }))), environment: { productionBundleModified: false, profileRemoved: true, browserClosed: true, serverClosed: true, before: { sourceHash: 's', buildHash: 'b' }, after: { sourceHash: 's', buildHash: 'b' } } },
  ] };
}

test('receipt structure rejects missing/duplicate scenarios, omitted assertions, unreviewed skips, cancellation and stale internal hashes', () => {
  assert.deepEqual(validateCoverage(coverageFixture()), []);
  for (const mutate of [
    report => report.steps[1].scenarios.pop(),
    report => report.steps[1].scenarios.push(report.steps[1].scenarios[0]),
    report => { report.steps[1].scenarios[0].checks = []; },
    report => { report.steps[1].scenarios[0].checks[0].status = 'skipped'; },
    report => { report.steps[2].checks.pop(); },
    report => { report.steps[2].environment.interrupted = 'SIGTERM'; },
    report => { report.steps[1].fixture.hash = 'changed'; },
    report => { report.steps[1].scope = 'development-only'; },
  ]) { const report = coverageFixture(); mutate(report); assert.throws(() => validateCoverage(report)); }
});

test('artifact receipt changes on edit and fails on deletion; wrong trusted digest fails before reuse', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'reframe-evidence-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'report.json'); await writeFile(path, '{}');
  const report = { steps: [{ reportPath: path }] }, original = await sealArtifacts(report);
  const digest = await fileDigest(path);
  await writeFile(path, '{"tampered":true}');
  assert.notDeepEqual(await sealArtifacts(report), original);
  await assert.rejects(inspectEvidence({ report: path, sha256: digest }), /摘要不符/);
  await rm(path);
  await assert.rejects(sealArtifacts(report));
});

test('user（维护者）仅接受三项既定能力声明，且对应场景始终核心必跑', async () => {
  // Given complete structural evidence with the two read-only rotations and unsupported native picker.
  const {coreBrowser}=await import('../test-policy.mjs');
  const report=coverageFixture();
  const declared=[
    ['example-image-viewer-result-short','UI-IMAGE-VIEWPORT','rotation aspect ratio',{present:false}],
    ['example-image-viewer-result-popup','UI-IMAGE-VIEWPORT','rotation aspect ratio',{present:false}],
    ['example-native-controls','UI-EXAMPLE-KEYBOARD','native select keyboard picker',{capability:{changed:false}}],
  ];
  for(const [id,ruleId,target,actual] of declared) report.steps[1].scenarios.find(scene=>scene.id===id).checks.push({ruleId,target,actual,status:'skipped',message:'Declared capability boundary'});
  // When validating, then all three retain their identities/reasons and cannot be deferred.
  const skips=validateCoverage(report);
  assert.equal(skips.length,3);
  for(const item of skips) {assert.ok(item.ruleId);assert.ok(item.reason);assert.ok(coreBrowser.includes(`browser:${item.scenario}`));}
  // An extra undocumented skipped check remains a failure, even on a declared scene.
  report.steps[1].scenarios.find(scene=>scene.id===declared[0][0]).checks.push({ruleId:'UI-IMAGE-VIEWPORT',target:'new check',status:'skipped',message:'unexpected'});
  assert.throws(()=>validateCoverage(report),/未经说明/);
});
