// Browser integration tests: requires Playwright Chromium and an existing production MV3 build.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access, cp } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { verifyExtension } from './extension.mjs';
import { sourceState, fingerprint } from './inventory.mjs';

test('isolated real extension loads and preserves host styling, menu behavior and Escape focus', { timeout: 60000 }, async () => {
  const report = await verifyExtension();
  assert.equal(report.status, 'passed', JSON.stringify(report.checks, null, 2));
  assert.ok(report.checks.length >= 10);
  assert.ok(report.checks.every(check => check.status === 'passed'));
  assert.equal(report.environment.productionBundleModified, false);
  assert.equal(report.environment.nativeMessagingBlocked, true);
  assert.equal(report.environment.fixtureRemoved, true);
  assert.ok(report.checks.some(check => check.ruleId === 'UI-EXTENSION-NATIVE' && check.status === 'passed'));
  await assert.rejects(access(report.environment.isolatedExtension));
  assert.equal(report.environment.profileRemoved, true);
  assert.equal(report.environment.browserClosed, true);
  assert.equal(report.environment.serverClosed, true);
  await assert.rejects(access(report.environment.profile));
  await access(report.evidence.trace);
  await access(report.evidence.markdown);
  assert.equal(report.reportPath, report.evidence.report);
  assert.equal(report.summaryPath, report.evidence.markdown);
  assert.equal(report.environment.before.sourceHash, report.environment.after.sourceHash);
  assert.equal(report.environment.before.buildHash, report.environment.after.buildHash);
  await access(report.evidence['panel-closed']);
  assert.ok(report.uncovered.some(item => item.includes('Closed Shadow DOM')));
  console.log(`Extension evidence: ${report.evidence.report}`);
});

test('native permission is stripped before browser launch while production assets stay unchanged', async t => {
  // Given production code that can start a host, the test browser must never receive that permission.
  const directory = await mkdtemp(join(tmpdir(), 'reframe-native-isolation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const extensionPath = join(directory, 'chrome-mv3');
  await cp(new URL('../../browser-extension/.output/chrome-mv3/', import.meta.url), extensionPath, { recursive: true });
  const manifestPath = join(extensionPath, 'manifest.json'), manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.permissions = [...new Set([...(manifest.permissions || []), 'nativeMessaging'])];
  manifest.optional_permissions = [...new Set([...(manifest.optional_permissions || []), 'nativeMessaging'])];
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(join(directory, 'ui-build.json'), JSON.stringify({ sourceHash: (await sourceState()).hash, buildHash: await fingerprint(extensionPath) }));
  const original = await fingerprint(extensionPath);
  const { chromium } = createRequire(new URL('../../browser-extension/package.json', import.meta.url))('playwright');
  const launch = chromium.launchPersistentContext;
  let loadedPath, loadedManifest, loadedScript;
  chromium.launchPersistentContext = async (_profile, options) => {
    loadedPath = options.args.find(arg => arg.startsWith('--load-extension=')).slice('--load-extension='.length);
    loadedManifest = JSON.parse(await readFile(join(loadedPath, 'manifest.json'), 'utf8'));
    loadedScript = await readFile(join(loadedPath, manifest.background.service_worker));
    throw new Error('Intentional browser launch failure after inspecting safe fixture');
  };
  let report;
  try { report = await verifyExtension({ extensionPath }); }
  finally { chromium.launchPersistentContext = launch; }
  assert.equal(report.status, 'failed');
  assert.ok(loadedPath, 'the inspected fixture reached the browser boundary');
  assert.notEqual(loadedPath, extensionPath);
  assert.ok(!loadedManifest.permissions?.includes('nativeMessaging'));
  assert.ok(!loadedManifest.optional_permissions?.includes('nativeMessaging'));
  assert.deepEqual(loadedScript, await readFile(join(extensionPath, manifest.background.service_worker)));
  const expected = structuredClone(manifest);
  expected.permissions = expected.permissions.filter(value => value !== 'nativeMessaging');
  expected.optional_permissions = expected.optional_permissions.filter(value => value !== 'nativeMessaging');
  assert.deepEqual(loadedManifest, expected, 'only Native Messaging permissions may differ');
  assert.equal(await fingerprint(extensionPath), original);
  assert.equal(report.environment.productionBundleModified, false);
  assert.equal(report.environment.fixtureRemoved, true);
  await assert.rejects(access(loadedPath));
});

test('Chromium failing to load an invalid isolated extension returns failure and cleans resources', { timeout: 45000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'reframe-invalid-extension-'));
  const extensionPath = join(directory, 'chrome-mv3');
  await mkdir(extensionPath);
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(extensionPath, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Intentional missing worker fixture', version: '1.0.0', background: { service_worker: 'missing.js' }, action: { default_popup: 'popup.html' } }));
  await writeFile(join(extensionPath, 'popup.html'), '<!doctype html><title>Invalid extension fixture</title>');
  await writeFile(join(directory, 'ui-build.json'), JSON.stringify({ sourceHash: (await sourceState()).hash, buildHash: await fingerprint(extensionPath) }));
  const report = await verifyExtension({ extensionPath });
  assert.equal(report.status, 'failed');
  assert.ok(report.checks.some(check => check.ruleId === 'UI-EXTENSION-LOAD' && check.status === 'failed'));
  assert.equal(report.environment.profileRemoved, true);
  assert.equal(report.environment.browserClosed, true);
  assert.equal(report.environment.serverClosed, true);
  assert.equal(report.environment.fixtureRemoved, true);
  await assert.rejects(access(report.environment.profile));
  console.log(`Intentional extension-load failure evidence: ${report.evidence.report}`);
});

for (const phase of ['verification', 'tracing cleanup']) test(`SIGTERM during ${phase} fails the report and releases browser, profile and server`, { timeout: 60000 }, async t => {
  const script = `import {verifyExtension} from ${JSON.stringify(new URL('./extension.mjs', import.meta.url).href)};
import {createRequire} from 'node:module';
const phase = ${JSON.stringify(phase)};
if (phase === 'tracing cleanup') {
  const {chromium} = createRequire(${JSON.stringify(new URL('../../browser-extension/package.json', import.meta.url).href)})('playwright');
  const launch = chromium.launchPersistentContext;
  chromium.launchPersistentContext = async function (...args) {
    const context = await launch.apply(this, args), stop = context.tracing.stop.bind(context.tracing);
    context.tracing.stop = async (...args) => {
      process.kill(process.pid, 'SIGTERM');
      await new Promise(resolve => setImmediate(resolve));
      process.kill(process.pid, 'SIGTERM');
      await new Promise(resolve => setImmediate(resolve));
      return stop(...args);
    };
    return context;
  };
}
const report = await verifyExtension({progress: message => { if (phase === 'verification' && message.includes('closed Shadow host')) process.kill(process.pid, 'SIGTERM'); }});
console.log(JSON.stringify(report));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && !child.signalCode) child.kill('SIGTERM'); });
  let output = '', errors = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { errors += data; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(code, 143, errors);
  const report = JSON.parse(output.trim());
  assert.equal(report.status, 'failed');
  assert.equal(report.environment.interrupted, 'SIGTERM');
  assert.equal(report.environment.profileRemoved, true);
  assert.equal(report.environment.browserClosed, true);
  assert.equal(report.environment.serverClosed, true);
  assert.equal(report.environment.fixtureRemoved, true);
  await assert.rejects(access(report.environment.profile));
  assert.ok(report.checks.some(check => check.ruleId === 'UI-EXTENSION-LOAD' && check.status === 'passed'));
  const persisted = JSON.parse(await readFile(report.reportPath, 'utf8'));
  assert.equal(persisted.status, 'failed');
  assert.equal(persisted.environment.interrupted, 'SIGTERM');
  assert.match(await readFile(report.summaryPath, 'utf8'), /Status: \*\*failed\*\*/);
  console.log(`Signal cleanup evidence: ${report.evidence.report}`);
});

test('missing build fingerprint fails before Chromium launches and still writes both reports', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'reframe-unstamped-extension-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const report = await verifyExtension({ extensionPath: join(directory, 'chrome-mv3') });
  assert.equal(report.status, 'failed');
  assert.ok(report.checks.some(check => check.ruleId === 'UI-EXTENSION-BUILD' && check.status === 'failed' && check.actual.includes('verify')));
  assert.equal(report.environment.chromium, undefined);
  await access(report.evidence.report);
  await access(report.evidence.markdown);
});

test('build changes during an isolated copied-extension run invalidate the successful UI observations', { timeout: 60000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'reframe-drifting-extension-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const extensionPath = join(directory, 'chrome-mv3');
  await cp(new URL('../../browser-extension/.output/chrome-mv3/', import.meta.url), extensionPath, { recursive: true });
  await writeFile(join(directory, 'ui-build.json'), JSON.stringify({ sourceHash: (await sourceState()).hash, buildHash: await fingerprint(extensionPath) }));
  const report = await verifyExtension({ extensionPath, progress: message => {
    if (message.includes('closed Shadow host')) writeFileSync(join(extensionPath, 'intentional-drift.txt'), 'Fingerprint failure fixture only.');
  } });
  assert.equal(report.status, 'failed');
  assert.ok(report.checks.some(check => check.ruleId === 'UI-EXTENSION-LOAD' && check.status === 'passed'));
  assert.ok(report.checks.some(check => check.ruleId === 'UI-EXTENSION-BUILD' && check.target === 'Fingerprints after cleanup' && check.status === 'failed'));
  assert.deepEqual(report.checks.filter(check => check.status === 'failed').map(check => check.ruleId), ['UI-EXTENSION-BUILD']);
  assert.equal(report.environment.browserClosed, true);
  console.log(`Intentional build-drift evidence: ${report.evidence.report}`);
});
