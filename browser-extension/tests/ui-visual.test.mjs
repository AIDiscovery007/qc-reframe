import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requireExtension } from '../../agent-tool/ui/inventory.mjs';
import { compareVisual, proposeVisual, acceptVisual, visualPolicy } from '../../agent-tool/ui/visual.mjs';

const sharp = requireExtension('sharp');
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'reframe-visual-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const baselineDirectory = join(directory, 'baselines');
  const report = {
    status: 'passed', source: { hash: 'a'.repeat(64), buildHash: 'b'.repeat(64), revision: 'test-fixture', dirty: false },
    fixture: { hash: 'c'.repeat(64) }, rulesAndRunnerHash: 'd'.repeat(64),
    environment: { platform: 'synthetic', arch: 'test', osRelease: '1', browser: 'test-browser-1', headless: true, dpr: 1, locale: 'zh-CN', timezone: 'Asia/Taipei', motion: 'reduce', previewShell: 'test-shell' },
    scenarios: ['popup', 'workspace-wide'].map(id => ({ id, status: 'passed', path: '/fixture?state=ready', viewport: { width: 4, height: 3 }, fontsHash: 'f'.repeat(64), evidence: { screenshot: join(directory, id + '.png') } })),
  };
  const image = async (id = 'popup', { width = 4, height = 3, color = '#669999' } = {}) => sharp({ create: { width, height, channels: 4, background: color } }).png().toFile(join(directory, id + '.png'));
  await image(); await image('workspace-wide');
  const run = async (fn, options = {}) => {
    const result = await fn(report, { baselineDirectory, scenarioIds: ['popup'], ...options });
    t.after(() => rm(result.directory, { recursive: true, force: true }));
    return result;
  };
  const accept = (candidate, options = {}) => acceptVisual(candidate.directory, { baselineDirectory, scenario: 'popup', reason: 'Synthetic fixture approved for this test only', reviewer: 'test fixture', ...options });
  return { directory, baselineDirectory, report, image, run, accept };
}

test('missing baselines remain uncovered and proposing never accepts them', async t => {
  const f = await fixture(t);
  const comparison = await f.run(compareVisual);
  assert.equal(comparison.status, 'uncovered');
  assert.match(comparison.scenarios[0].reason, /missing-baseline/);
  const proposal = await f.run(proposeVisual);
  assert.equal(proposal.status, 'candidate');
  assert.equal(proposal.comparisonStatus, 'uncovered');
  await assert.rejects(readdir(f.baselineDirectory), { code: 'ENOENT' });
  const html = await readFile(proposal.htmlPath, 'utf8');
  assert.match(html, /candidate.json/);
  assert.match(html, /test-browser-1/);
  assert.match(html, new RegExp('a'.repeat(64)));
});

test('identical images pass; color and size changes fail with before/after/diff evidence', async t => {
  const f = await fixture(t);
  await f.accept(await f.run(proposeVisual));
  assert.equal((await f.run(compareVisual)).status, 'passed');
  await f.image('popup', { color: '#ff0000' });
  const changed = await f.run(compareVisual);
  assert.equal(changed.status, 'failed');
  assert.equal(changed.scenarios[0].changedPixels, 12);
  for (const path of Object.values(changed.scenarios[0].evidence)) assert.equal((await sharp(await readFile(path)).metadata()).format, 'png');
  await f.image('popup', { width: 5 });
  const resized = await f.run(compareVisual);
  assert.equal(resized.status, 'failed');
  assert.equal(resized.scenarios[0].reason, 'screenshot-size-changed');
  assert.equal((await sharp(await readFile(resized.scenarios[0].evidence.diff)).metadata()).width, 5);
});

test('small channel noise has a fixed ceiling and never permits changed pixels above it', async t => {
  const f = await fixture(t);
  await f.accept(await f.run(proposeVisual));
  await f.image('popup', { color: '#6e9999' }); // red 102 -> 110, exactly the fixed tolerance.
  assert.equal((await f.run(compareVisual)).status, 'passed');
  await f.image('popup', { color: '#6f9999' });
  assert.equal((await f.run(compareVisual)).status, 'failed');
  assert.deepEqual(visualPolicy, { channelTolerance: 8, maxDiffPixels: 0 });
});

test('browser, font, viewport and fixture mismatches cannot report visual success', async t => {
  const f = await fixture(t);
  await f.accept(await f.run(proposeVisual));
  for (const [object, key, value] of [
    [f.report.environment, 'browser', 'other-browser'],
    [f.report.scenarios[0], 'fontsHash', 'e'.repeat(64)],
    [f.report.scenarios[0], 'viewport', { width: 5, height: 3 }],
    [f.report.fixture, 'hash', 'e'.repeat(64)],
  ]) {
    const previous = object[key]; object[key] = value;
    const result = await f.run(compareVisual);
    assert.equal(result.status, 'uncovered', key);
    assert.match(result.scenarios[0].reason, /incompatible-baseline/, key);
    object[key] = previous;
  }
  delete f.report.scenarios[0].fontsHash;
  assert.equal((await f.run(compareVisual)).status, 'failed');
  await assert.rejects(f.run(proposeVisual), /fontsHash/);
});

test('explicit acceptance updates only the selected scene and preserves review provenance', async t => {
  const f = await fixture(t);
  const both = await f.run(proposeVisual, { scenarioIds: ['popup', 'workspace-wide'] });
  await assert.rejects(f.accept(both, { scenario: undefined }), /核心场景/);
  await assert.rejects(f.accept(both, { reason: '' }), /reason/);
  await assert.rejects(f.accept(both, { reviewer: '' }), /reviewer/);
  await f.accept(both);
  assert.deepEqual(await readdir(f.baselineDirectory), ['popup']);
  await f.accept(both, { scenario: 'workspace-wide' });
  const otherPath = join(f.baselineDirectory, 'workspace-wide/manifest.json');
  const other = await readFile(otherPath);
  await f.image('popup', { color: '#abcdef' });
  const update = await f.run(proposeVisual);
  await f.accept(update, { reason: 'Intentional synthetic color change', reviewer: 'named test reviewer' });
  assert.deepEqual(await readFile(otherPath), other);
  const manifest = JSON.parse(await readFile(join(f.baselineDirectory, 'popup/manifest.json')));
  assert.equal(manifest.review.reviewer, 'named test reviewer');
  assert.equal(manifest.source.hash, f.report.source.hash);
  assert.equal(manifest.fixtureHash, f.report.fixture.hash);
  assert.equal(manifest.history.length, 1);
  assert.equal(manifest.history[0].review.reviewer, 'test fixture');
  assert.equal((await f.run(compareVisual)).status, 'passed');
});

test('unsafe scene IDs, image paths, symlinks and modified candidates are rejected', async t => {
  const f = await fixture(t);
  await assert.rejects(f.run(compareVisual, { scenarioIds: ['../outside'] }), /核心场景/);
  const proposal = await f.run(proposeVisual);
  const original = JSON.parse(await readFile(proposal.candidatePath));
  const malicious = structuredClone(original);
  malicious.scenarios[0].screenshot.file = '../outside.png';
  await writeFile(proposal.candidatePath, JSON.stringify(malicious));
  await assert.rejects(f.accept(proposal), /图片路径/);
  await writeFile(proposal.candidatePath, JSON.stringify(original));
  const candidateImage = join(proposal.directory, 'popup.after.png');
  await rm(candidateImage);
  await symlink(f.report.scenarios[0].evidence.screenshot, candidateImage);
  await assert.rejects(f.accept(proposal), /符号链接/);
  await rm(candidateImage);
  await f.image('popup', { color: '#000000' });
  await writeFile(candidateImage, await readFile(f.report.scenarios[0].evidence.screenshot));
  await assert.rejects(f.accept(proposal), /图片已变化/);
  await assert.rejects(readdir(f.baselineDirectory), { code: 'ENOENT' });
});

test('failed reports, fault injection and weakened candidate thresholds cannot seed baselines', async t => {
  const f = await fixture(t);
  f.report.status = 'failed';
  await assert.rejects(f.run(proposeVisual), /通过/);
  f.report.status = 'passed'; f.report.fault = 'image-offset';
  await assert.rejects(f.run(proposeVisual), /故障/);
  delete f.report.fault;
  const proposal = await f.run(proposeVisual);
  const manifest = JSON.parse(await readFile(proposal.candidatePath));
  manifest.scenarios[0].policy.maxDiffPixels = 100;
  await writeFile(proposal.candidatePath, JSON.stringify(manifest));
  await assert.rejects(f.accept(proposal), /阈值/);
});

test('a symlinked baseline scene cannot redirect acceptance outside its directory', async t => {
  const f = await fixture(t);
  const proposal = await f.run(proposeVisual);
  const outside = join(f.directory, 'outside');
  await mkdir(outside);
  await mkdir(f.baselineDirectory);
  await writeFile(join(outside, 'sentinel.txt'), 'untouched');
  await symlink(outside, join(f.baselineDirectory, 'popup'));
  await assert.rejects(f.accept(proposal), /符号链接/);
  assert.deepEqual(await readdir(outside), ['sentinel.txt']);
  assert.equal(await readFile(join(outside, 'sentinel.txt'), 'utf8'), 'untouched');
  assert.equal((await f.run(compareVisual)).status, 'failed');
});

test('missing or invalid baseline environment and provenance fail instead of matching pixels', async t => {
  const f = await fixture(t);
  await f.accept(await f.run(proposeVisual));
  const path = join(f.baselineDirectory, 'popup/manifest.json');
  const original = JSON.parse(await readFile(path));
  const mutations = [
    ...['environment', 'environmentKey', 'source', 'fixtureHash', 'rulesAndRunnerHash', 'review', 'history'].map(key => entry => { delete entry[key]; }),
    entry => { entry.environment.browser = 'changed-without-new-key'; },
    entry => { entry.environment.headless = 'true'; },
    entry => { entry.environment.fontsHash = [entry.environment.fontsHash]; },
    entry => { entry.environmentKey = 'wrong'; },
    entry => { entry.source.hash = [entry.source.hash]; },
    entry => { entry.source.buildHash = 123; },
    entry => { delete entry.source.revision; },
    entry => { entry.source.dirty = 'false'; },
    entry => { entry.rulesAndRunnerHash = [entry.rulesAndRunnerHash]; },
    entry => { entry.review.reviewer = []; },
    entry => { entry.review.reviewedAt = 'yesterday'; },
    entry => { entry.screenshot.width++; },
  ];
  for (const mutate of mutations) {
    const manifest = structuredClone(original); mutate(manifest);
    await writeFile(path, JSON.stringify(manifest));
    assert.equal((await f.run(compareVisual)).status, 'failed', mutate.toString());
  }
  await writeFile(path, JSON.stringify(original));
  assert.equal((await f.run(compareVisual)).status, 'passed');
});

test('a missing PNG in an existing baseline blocks acceptance without resetting history', async t => {
  const f = await fixture(t);
  await f.accept(await f.run(proposeVisual));
  await f.image('popup', { color: '#abcdef' });
  await f.accept(await f.run(proposeVisual));
  const path = join(f.baselineDirectory, 'popup/manifest.json');
  const original = await readFile(path), manifest = JSON.parse(original);
  assert.equal(manifest.history.length, 1);
  await f.image('popup', { color: '#000000' });
  const next = await f.run(proposeVisual);
  await rm(join(f.baselineDirectory, 'popup', manifest.screenshot.file));
  const before = await readdir(join(f.baselineDirectory, 'popup'));
  assert.equal((await f.run(compareVisual)).status, 'failed');
  await assert.rejects(f.accept(next), { code: 'ENOENT' });
  assert.deepEqual(await readFile(path), original);
  assert.deepEqual(await readdir(join(f.baselineDirectory, 'popup')), before);
});

test('review HTML and acceptance reference the same captured image, independent of later source edits', async t => {
  const f = await fixture(t);
  const proposal = await f.run(proposeVisual);
  const manifest = JSON.parse(await readFile(proposal.candidatePath));
  assert.equal(manifest.scenarios[0].screenshot.file, 'popup.after.png');
  const html = await readFile(proposal.htmlPath, 'utf8');
  assert.match(html, /src="popup\.after\.png"/);
  assert.equal((await readdir(proposal.directory)).some(name => name.endsWith('.candidate.png')), false);
  const captured = await readFile(join(proposal.directory, 'popup.after.png'));
  await f.image('popup', { color: '#ff0000' });
  const accepted = await f.accept(proposal);
  assert.deepEqual(await readFile(join(f.baselineDirectory, 'popup', accepted.screenshot.file)), captured);
  await writeFile(proposal.htmlPath, html.replace('popup.after.png', 'another.png'));
  await assert.rejects(f.accept(proposal), /审阅 HTML 已变化/);
});
