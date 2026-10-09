import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rename, rm, stat, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { root, extension, contextFor, fingerprint, fixtureState } from '../../agent-tool/ui/inventory.mjs';
import { rules, scenarios } from '../../agent-tool/ui/catalog.mjs';

const exec = promisify(execFile);
const cli = (args, cwd = root) => exec(process.execPath, [join(root, 'agent-tool/ui.mjs'), ...args], { cwd, timeout: 15000 });
async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'reframe-ui-tool-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('invalid UI commands and parameters exit 2 before starting verification', async () => {
  for (const args of [
    ['unknown'], ['context', '--unknown'], ['context', '--json', '--json'],
    ['context', '--files'], ['check', '--base'], ['verify', '--scenario'],
    ['verify', '--scenario', 'missing'], ['verify', '--fault', 'missing'],
    ['verify', '--scenario', 'popup', '--fault', 'canvas-padding'],
    ['inspect'], ['sync', '--no-build'], ['verify', 'extra'],
    ['gate', '--tier', 'unsafe'], ['visual'], ['baseline'], ['accept'], ['change'],
    ['visual', '--report', '/missing', '--scenario', 'generation-actions'],
  ]) {
    await assert.rejects(cli(args), error => {
      assert.equal(error.code, 2, args.join(' '));
      assert.match(error.stderr, /未知|重复|需要|必须|不匹配|使用|非视觉/, args.join(' '));
      assert.equal(error.stdout, '', args.join(' '));
      return true;
    });
  }
});

test('context JSON and repository-relative paths are independent of caller directory', async t => {
  const directory = await temporary(t);
  const source = 'browser-extension/entrypoints/popup/QuickWorkspace.tsx';
  const outputs = await Promise.all([root, extension, directory].map(async cwd => JSON.parse((await cli(['context', '--files', source, '--json'], cwd)).stdout)));
  assert.deepEqual(outputs[0], outputs[1]);
  assert.deepEqual(outputs[0], outputs[2]);
  assert.deepEqual(outputs[0].files, [source]);
  assert.equal(outputs[0].fullCoverageFallback, false);
  assert.ok(outputs[0].rules.some(rule => rule.id === 'UI-LAYOUT-QUICK'));
});

test('unknown dependencies widen context to all registered rules and scenarios', async () => {
  for (const files of [[], ['browser-extension/lib/future-ui.ts'], ['browser-extension/entrypoints/popup/QuickWorkspace.tsx', 'browser-extension/lib/future-ui.ts']]) {
    const result = await contextFor(files);
    assert.equal(result.fullCoverageFallback, true);
    assert.deepEqual(result.rules.map(rule => rule.id), rules.map(rule => rule.id));
    assert.deepEqual(result.scenarios.map(scenario => scenario.id), scenarios.map(scenario => scenario.id));
  }
  await assert.rejects(contextFor(['../outside.css']), /文件不在仓库内/);
});

test('static sources and aggregate entrypoints retain every geometry scenario', async () => {
  for (const file of [
    'browser-extension/entrypoints/popup/style.css',
    'browser-extension/entrypoints/popup/main.tsx',
    'browser-extension/entrypoints/workspace/main.tsx',
    'browser-extension/entrypoints/content.ts',
    'browser-extension/entrypoints/workspace/results.css',
  ]) {
    for (const files of [[file], [file, 'browser-extension/entrypoints/popup/QuickWorkspace.tsx']]) {
      const result = JSON.parse((await cli(['context', '--files', ...files, '--json'])).stdout);
      assert.equal(result.fullCoverageFallback, true, file);
      assert.deepEqual(result.rules.map(rule => rule.id), rules.map(rule => rule.id), file);
      assert.deepEqual(result.scenarios.map(scenario => scenario.id), scenarios.map(scenario => scenario.id), file);
    }
  }
});

test('independent components retain targeted geometry and the behavior regressions', async () => {
  for (const [file, ruleId, expectedGeometry] of [
    ['browser-extension/entrypoints/popup/QuickWorkspace.tsx', 'UI-LAYOUT-QUICK', ['popup', 'popup-narrow', 'popup-image-failed']],
    ['browser-extension/entrypoints/workspace/CanvasWorkspace.tsx', 'UI-LAYOUT-CANVAS', ['workspace-wide', 'workspace-prompt', 'workspace-narrow']],
    ['browser-extension/entrypoints/popup/ImagePreview.tsx', 'UI-IMAGE-PREVIEW', ['workspace-wide', 'workspace-prompt', 'workspace-narrow', 'popup', 'popup-narrow', 'popup-image-failed']],
  ]) {
    const result = await contextFor([file]);
    assert.equal(result.fullCoverageFallback, false, file);
    assert.deepEqual(result.rules.filter(rule => rule.kind === 'geometry').map(rule => rule.id), [ruleId], file);
    assert.ok(result.scenarios.some(scenario => scenario.example), file);
    assert.deepEqual(result.scenarios.filter(scenario => !scenario.regression && !scenario.example).map(scenario => scenario.id), expectedGeometry, file);
    assert.deepEqual(result.scenarios.filter(scenario => scenario.regression).map(scenario => scenario.id), scenarios.filter(scenario => scenario.regression).map(scenario => scenario.id));
  }
});

test('sync --check validates the current generated catalog without writing it', async t => {
  const directory = await temporary(t);
  const path = join(extension, 'docs/uiux/catalog.md');
  const before = await readFile(path);
  const modified = (await stat(path)).mtimeMs;
  const result = JSON.parse((await cli(['sync', '--check', '--json'], directory)).stdout);
  assert.deepEqual(result, { file: 'browser-extension/docs/uiux/catalog.md', current: true, written: false });
  assert.deepEqual(await readFile(path), before);
  assert.equal((await stat(path)).mtimeMs, modified);
});

test('fingerprints are location-independent and detect same-size edits, renames and deletion', async t => {
  const first = await temporary(t), second = await temporary(t);
  for (const directory of [first, second]) await mkdir(join(directory, 'nested'));
  await writeFile(join(first, 'a.css'), 'abcd');
  await writeFile(join(first, 'nested/b.css'), 'same');
  await writeFile(join(second, 'nested/b.css'), 'same');
  await writeFile(join(second, 'a.css'), 'abcd');
  const original = await fingerprint(first);
  assert.equal(await fingerprint(second), original);
  await writeFile(join(first, 'a.css'), 'abce');
  assert.notEqual(await fingerprint(first), original);
  await writeFile(join(first, 'a.css'), 'abcd');
  assert.equal(await fingerprint(first), original);
  await rename(join(first, 'a.css'), join(first, 'renamed.css'));
  const renamed = await fingerprint(first);
  assert.notEqual(renamed, original);
  await rm(join(first, 'renamed.css'));
  assert.notEqual(await fingerprint(first), renamed);
});

test('user（开发者）预览与采集依赖变化会更新fixture指纹', async t => {
  const directory = await temporary(t);
  // Given an isolated copy of every declared preview/coverage dependency.
  const files = ['agent-tool/test-impact.mjs', 'agent-tool/test-policy.mjs', 'agent-tool/test-run.mjs', 'agent-tool/ui.mjs', 'agent-tool/preview.mjs', 'agent-tool/gallery-preview.mjs',
    'browser-extension/bridge/image-order.mjs', 'browser-extension/tests/example.browser.js', 'browser-extension/docs/gallery/example/result.png'];
  for (const file of files) {
    await mkdir(join(directory, file, '..'), { recursive: true });
    await writeFile(join(directory, file), 'original');
  }
  // When each dependency changes, then the fingerprint changes independently of product builds.
  const original = await fixtureState(directory);
  assert.deepEqual(original.files, [...files].sort());
  for (const file of files) {
    await writeFile(join(directory, file), 'modified');
    assert.notEqual((await fixtureState(directory)).hash, original.hash, file);
    await writeFile(join(directory, file), 'original');
  }
  await writeFile(join(directory, 'browser-extension/tests/unrelated.test.mjs'), 'unit test');
  assert.deepEqual(await fixtureState(directory), original);
  await writeFile(join(directory, 'browser-extension/tests/another.browser.js'), 'new fixture');
  assert.notEqual((await fixtureState(directory)).hash, original.hash);
});


test('changing a copied preview image-order dependency changes behavior and fixture hash', async t => {
  const directory = await temporary(t), original = await fixtureState();
  const helper = 'browser-extension/bridge/image-order.mjs';
  assert.ok(original.files.includes(helper));
  for (const file of original.files) {
    await mkdir(join(directory, file, '..'), { recursive: true });
    await copyFile(join(root, file), join(directory, file));
  }
  assert.deepEqual(await fixtureState(directory), original);
  const path = join(directory, helper), url = pathToFileURL(path).href;
  const before = await import(url);
  assert.deepEqual(before.orderedImages('reference', ['subject']).paths, ['subject', 'reference']);
  const source = await readFile(path, 'utf8');
  assert.ok(source.includes('fallback = subjectCount'));
  await writeFile(path, source.replace('fallback = subjectCount', 'fallback = 0'));
  const after = await import(url + '?modified');
  assert.deepEqual(after.orderedImages('reference', ['subject']).paths, ['reference', 'subject']);
  assert.notEqual((await fixtureState(directory)).hash, original.hash);
});


test('maintenance CLI records are reviewable, stale records fail and quick gate runs from another directory', async t => {
  const directory = await temporary(t), output = join(directory, 'proposal.json');
  const created = JSON.parse((await cli(['change', '--files', 'browser-extension/entrypoints/popup/style.css', '--reason', 'Contract verification only', '--output', output, '--json'], directory)).stdout);
  assert.equal(created.reviewStatus, 'proposed');
  assert.equal(JSON.parse((await cli(['change', '--record', output, '--json'], directory)).stdout).status, 'passed');
  created.files[0].sha256 = '0'.repeat(64);
  await writeFile(output, JSON.stringify(created));
  await assert.rejects(cli(['change', '--record', output, '--json'], directory), error => error.code === 1 && JSON.parse(error.stdout).status === 'failed');
  const quick = JSON.parse((await cli(['gate', '--tier', 'quick', '--json'], directory)).stdout);
  assert.equal(quick.status, 'passed');
  assert.equal(quick.steps.length, 1);
  assert.ok((await readFile(quick.reportPath, 'utf8')).includes('static-and-maintenance'));
});
