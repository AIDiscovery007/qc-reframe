import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { validationWindow } from './build.mjs';
import { planFor, extension } from './inventory.mjs';
import { scenarios } from './catalog.mjs';
import { validateCoverage, sealArtifacts, fileDigest, inspectEvidence } from './evidence.mjs';

const lock = join(extension, '.output/ui-validation.lock');

test('development plan bounds image-viewer CSS feedback and falls back for incomplete business ownership', async () => {
  const imageViewer = 'browser-extension/entrypoints/popup/image-viewer.css';
  const plan = await planFor([imageViewer]);
  assert.equal(plan.coverageUncertain, false);
  assert.equal(plan.scenarios.length, 9);
  for (const scene of scenarios.filter(scene => scene.rules.includes('UI-IMAGE-VIEWPORT'))) assert.ok(plan.scenarios.includes(scene.id));
  for (const id of plan.requiredRiskScenarios) assert.ok(plan.scenarios.includes(id));
  for (const files of [
    ['new/unknown.ts'], ['browser-extension/entrypoints/popup/style.css'], [],
    ['browser-extension/entrypoints/workspace/CanvasWorkspace.tsx'],
    ['browser-extension/entrypoints/popup/QuickWorkspace.tsx'],
    ['browser-extension/entrypoints/popup/ImageViewer.tsx'],
    ['browser-extension/entrypoints/popup/compact-editor.css'],
    [imageViewer, 'browser-extension/entrypoints/workspace/CanvasWorkspace.tsx'],
    [imageViewer, 'new/unknown.ts'], [imageViewer, imageViewer],
  ]) {
    const unknown = await planFor(files);
    assert.equal(unknown.coverageUncertain, true);
    assert.deepEqual(unknown.scenarios, scenarios.map(scene => scene.id));
    assert.ok(unknown.scenarios.includes('generation-actions'));
    assert.ok(unknown.scenarios.includes('image-order-paired'));
  }
});

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
