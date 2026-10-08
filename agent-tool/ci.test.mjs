import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync, chmodSync, symlinkSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, checkDocs, localLinks } from './ci.mjs';

const script = fileURLToPath(new URL('./ci.mjs', import.meta.url));
function fixture(t) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'reframe-ci-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'CI fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  const write = (name, body = 'text\n') => { mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true }); writeFileSync(path.join(cwd, name), body); };
  const commit = () => { git('add', '-A'); git('commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD'); };
  write('README.md');
  write('source.js');
  const base = commit();
  const push = (head, before = base) => classify({ cwd, eventName: 'push', event: { before, after: head }, sha: head });
  return { cwd, git, write, commit, base, push };
}

test('docs-only push passes; changed broken link and whitespace fail', t => {
  const f = fixture(t);
  f.write('README.md', '[source](source.js)\n');
  assert.equal(checkDocs(f.push(f.commit()), f.cwd).status, 'passed');
  f.write('README.md', '[missing](missing.md)\n');
  assert.throws(() => checkDocs(f.push(f.commit()), f.cwd), /链接失效/);
  f.write('README.md', 'trailing space \n');
  assert.throws(() => checkDocs(f.push(f.commit()), f.cwd));
});

test('PR examines cumulative branch diff and excludes unrelated base advancement', t => {
  const f = fixture(t);
  f.git('checkout', '-qb', 'feature');
  f.write('source.js', 'code\n'); f.commit();
  f.write('README.md', 'docs\n'); const head = f.commit();
  assert.equal(classify({ cwd: f.cwd, eventName: 'pull_request', event: { pull_request: { base: { sha: f.base }, head: { sha: head } } } }).mode, 'full');
  f.git('checkout', '-qb', 'docs', f.base);
  f.write('README.md', 'only docs\n'); const docs = f.commit();
  const result = classify({ cwd: f.cwd, eventName: 'pull_request', event: { pull_request: { base: { sha: head }, head: { sha: docs } } } });
  assert.equal(result.mode, 'docs');
  assert.equal(result.base, f.base);
});

test('mixed, unknown Markdown, UI contracts/baselines, tools, dependencies and workflow require full', t => {
  const f = fixture(t);
  for (const name of ['unknown.md', 'browser-extension/docs/uiux/README.md', 'browser-extension/docs/uiux/visual-baselines/linux/manifest.json', 'agent-tool/README.md', 'browser-extension/package-lock.json', '.github/workflows/uiux.yml', 'source.js']) {
    f.git('reset', '--hard', f.base);
    f.write('README.md', 'docs\n'); f.write(name, 'change\n');
    assert.equal(f.push(f.commit()).mode, 'full', name);
  }
});

test('manual, unknown events, empty diff, unavailable/all-zero/missing base and Git errors fail closed', t => {
  const f = fixture(t);
  assert.equal(f.push(f.base).mode, 'full');
  for (const before of ['0'.repeat(40), 'a'.repeat(40), '--help', undefined]) assert.equal(f.push(f.base, before).mode, 'full');
  for (const eventName of ['workflow_dispatch', 'unknown', 'pull_request']) assert.equal(classify({ cwd: f.cwd, eventName, event: {} }).mode, 'full');
  assert.equal(classify({ cwd: path.join(f.cwd, 'missing'), eventName: 'push', event: { before: f.base }, sha: f.base }).mode, 'full');
});

test('deletion checks incoming links; rename considers both names', t => {
  const f = fixture(t);
  f.write('agent-logs/old.md'); f.write('README.md', '[log](agent-logs/old.md)\n'); const base = f.commit();
  rmSync(path.join(f.cwd, 'agent-logs/old.md'));
  let result = f.push(f.commit(), base);
  assert.equal(result.mode, 'docs');
  assert.throws(() => checkDocs(result, f.cwd), /链接失效/);
  f.git('reset', '--hard', base);
  renameSync(path.join(f.cwd, 'agent-logs/old.md'), path.join(f.cwd, 'agent-logs/new.md'));
  result = f.push(f.commit(), base);
  assert.deepEqual(new Set(result.files), new Set(['agent-logs/old.md', 'agent-logs/new.md']));
  assert.throws(() => checkDocs(result, f.cwd), /链接失效/);
  f.git('reset', '--hard', base);
  renameSync(path.join(f.cwd, 'source.js'), path.join(f.cwd, 'agent-logs/code.md'));
  assert.equal(f.push(f.commit(), base).mode, 'full');
  f.git('reset', '--hard', base);
  renameSync(path.join(f.cwd, 'agent-logs/old.md'), path.join(f.cwd, 'unknown.md'));
  assert.equal(f.push(f.commit(), base).mode, 'full');
});

test('ordinary unreferenced document deletion passes', t => {
  const f = fixture(t); f.write('GLOSSARY.md'); const base = f.commit();
  rmSync(path.join(f.cwd, 'GLOSSARY.md'));
  assert.equal(checkDocs(f.push(f.commit(), base), f.cwd).status, 'passed');
});

test('NUL-delimited paths preserve spaces, tabs, newlines, Unicode and shell metacharacters', t => {
  const f = fixture(t);
  const file = 'agent-logs/中文 space\tline\n$(echo danger).md';
  f.write(file);
  const result = f.push(f.commit());
  assert.equal(result.mode, 'docs'); assert.deepEqual(result.files, [file]);
  assert.equal(checkDocs(result, f.cwd).status, 'passed');
});

test('executable and symlink documents require full', t => {
  const f = fixture(t);
  chmodSync(path.join(f.cwd, 'README.md'), 0o755);
  assert.equal(f.push(f.commit()).mode, 'full');
  f.git('reset', '--hard', f.base);
  symlinkSync('source.js', path.join(f.cwd, 'GLOSSARY.md'));
  assert.equal(f.push(f.commit()).mode, 'full');
});

test('local link conventions: code, references, images, encoded paths, titles and fragments', () => {
  assert.deepEqual(localLinks('```md\n[x](missing)\n```\n`[x](missing)`\n[x](../README.md#title) ![pic](<assets/a b.png>)\n[ref]: ../GLOSSARY.md "title"\n[x](a%20b.md) [x](a(b).md "title") [web](https://example.com) [local](/tmp/report) [anchor](#hello)', 'docs/readme.md'), ['README.md', 'docs/assets/a b.png', 'GLOSSARY.md', 'docs/a b.md', 'docs/a(b).md']);
  assert.throws(() => localLinks('[x](../../outside)', 'README.md'), /超出仓库/);
});

test('CLI emits outputs and propagates lightweight failures; malformed event is full', t => {
  const f = fixture(t); f.write('README.md', '[bad](missing)\n'); const head = f.commit();
  const eventFile = path.join(f.cwd, 'event.json'), output = path.join(f.cwd, 'output');
  writeFileSync(eventFile, JSON.stringify({ before: f.base, after: head }));
  const env = { ...process.env, GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: eventFile, GITHUB_SHA: head, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: path.join(f.cwd, 'summary') };
  const run = command => execFileSync(process.execPath, [script, command], { cwd: f.cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(JSON.parse(run('classify')).mode, 'docs');
  assert.match(readFileSync(output, 'utf8'), /^mode=docs\nbase=[a-f\d]{40}\n$/);
  assert.throws(() => run('docs'), error => error.status === 1 && /链接失效/.test(error.stderr));
  writeFileSync(eventFile, '{'); assert.equal(JSON.parse(run('classify')).mode, 'full');
  assert.throws(() => run('docs'));
});

test('unchanged historical broken links do not block; untracked files cannot satisfy new links', t => {
  const f = fixture(t);
  f.write('GLOSSARY.md', '[historical](old-missing.md)\n'); const base = f.commit();
  f.write('README.md', 'documentation update\n');
  assert.equal(checkDocs(f.push(f.commit(), base), f.cwd).status, 'passed');
  f.write('README.md', '[new](untracked.md)\n'); const head = f.commit();
  f.write('untracked.md');
  assert.throws(() => checkDocs(f.push(head, base), f.cwd), /链接失效/);
});
