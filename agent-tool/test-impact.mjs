import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function collectNode({ root, tests, directory, signal, progress = () => {} }) {
  root = await realpath(root);
  const started = performance.now(), results = [];
  await mkdir(directory, { recursive: true });
  for (const [i, id] of tests.entries()) {
    signal?.throwIfAborted();
    progress(id);
    const coverage = join(directory, `node-${i}`), start = performance.now();
    await mkdir(coverage); // Exclusive per file/run; never mix an earlier collection.
    let output = '';
    const env = { ...process.env, NODE_V8_COVERAGE: coverage, NODE_DISABLE_COMPILE_CACHE: '1' };
    delete env.NODE_TEST_CONTEXT;
    const code = await new Promise((done, reject) => {
      const child = spawn(process.execPath, ['--test', '--test-reporter=tap', resolve(root, id)], {
        cwd: root, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
      });
      const kill = () => { try { process.platform === 'win32' ? child.kill('SIGKILL') : process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
      const timeout = setTimeout(kill, 300000);
      signal?.addEventListener('abort', kill, { once: true });
      child.once('close', () => { clearTimeout(timeout); signal?.removeEventListener('abort', kill); });
      child.stdout.on('data', data => { output += data; });
      child.stderr.on('data', data => { output += data; });
      child.on('error', reject); child.on('close', done);
    });
    const counts = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map(key => [key, Number(output.match(new RegExp('^# ' + key + ' (\\d+)$', 'm'))?.[1] ?? NaN)]));
    const executed = new Set(), unknown = new Set();
    const files = (await readdir(coverage)).filter(file => file.endsWith('.json'));
    for (const file of files) {
      const report = JSON.parse(await readFile(join(coverage, file), 'utf8'));
      for (const script of report.result) {
        if (!script.functions.some(fn => fn.ranges.some(range => range.count > 0))) continue;
        if (!script.url.startsWith('file:')) { if (!script.url.startsWith('node:')) unknown.add(script.url || 'anonymous'); continue; }
        const name = relative(root, fileURLToPath(script.url)).replaceAll('\\', '/');
        if (!name.startsWith('../') && !name.includes('/node_modules/') && !name.startsWith('node_modules/')) executed.add(name);
      }
    }
    await writeFile(join(directory, `node-${i}.log`), output);
    results.push({ id, code, ...counts, error: code === 0 ? undefined : output.slice(-4000), status: code === 0 && files.length && counts.tests > 0 && Number.isFinite(counts.skipped) && Number.isFinite(counts.todo) && counts.cancelled === 0 && counts.fail === 0 && !signal?.aborted ? 'passed' : 'failed', executed: [...executed].sort(), unknown: [...unknown].sort(), durationMs: Math.round(performance.now() - start) });
  }
  return { status: results.every(item => item.status === 'passed') ? 'passed' : 'failed', granularity: 'node-test-file', tests: results, durationMs: Math.round(performance.now() - started) };
}

export function selectTests({ index, environment, changes, tests, core, reliable, now = Date.now() }) {
  const full = reason => ({ mode: 'full', selected: [...tests].sort(), deferred: [], fallback: reason });
  if (!index || !Array.isArray(index.tests) || !Array.isArray(index.shadow) || index.tests.some(item => !Array.isArray(item.executed) || !Array.isArray(item.dependencies)) || index.schema !== 1 || index.status !== 'passed' || !index.complete) return full('missing-or-incomplete-index');
  if (index.environment !== environment || !Number.isFinite(Date.parse(index.createdAt)) || now - Date.parse(index.createdAt) > 7 * 86400000 || Date.parse(index.createdAt) > now) return full('stale-or-incompatible-index');
  if (tests.some(id => !index.tests.some(item => item.id === id) && !changes.some(change => change.file === id && ['A', 'M'].includes(change.status))) || index.tests.some(item => !tests.includes(item.id))) return full('changed-inventory');
  const selected = new Set(core);
  for (const change of changes) {
    if (tests.includes(change.file) && ['A', 'M'].includes(change.status)) { selected.add(change.file); continue; }
    if (change.status !== 'M' || !reliable.includes(change.file) || !index.shadow.includes(change.file)) return full(`unknown-or-unvalidated:${change.file}`);
    const affected = index.tests.filter(item => [...item.executed, ...item.dependencies].includes(change.file));
    if (!affected.length) return full(`unmapped:${change.file}`);
    for (const item of affected) selected.add(item.id);
  }
  if (!changes.length || [...selected].some(id => !tests.includes(id))) return full('empty-diff-or-changed-inventory');
  return { mode: 'selected', selected: [...selected].sort(), deferred: tests.filter(id => !selected.has(id)).sort(), fallback: null };
}

export async function publishIndex({ output, commit, environment, before, after, tests, expected, validations, previous, reliable, cancelled = false }) {
  const ids = tests.map(item => item.id).sort();
  if (cancelled || JSON.stringify(before) !== JSON.stringify(after) || !['static', 'types', 'gate'].every(key => validations[key] === true)
    || !expected.length || new Set(ids).size !== ids.length || JSON.stringify(ids) !== JSON.stringify([...expected].sort()) || tests.some(item => item.status !== 'passed' || item.skipped !== 0 || item.todo !== 0)) throw Error('Only successful complete stable collection can publish an index');
  const shadow = [];
  if (previous?.complete && previous.status === 'passed' && previous.environment === environment && JSON.stringify(previous.tests.map(item => item.id).sort()) === JSON.stringify(ids)) {
    for (const source of reliable) {
      const old = previous.tests.filter(item => [...item.executed, ...item.dependencies].includes(source)).map(item => item.id);
      const current = tests.filter(item => [...item.executed, ...item.dependencies].includes(source)).map(item => item.id);
      if (old.length && current.length === old.length && current.every(id => old.includes(id))) shadow.push(source);
    }
  }
  const index = { schema: 1, status: 'passed', complete: true, createdAt: new Date().toISOString(), commit, environment, files: after, shadow, tests, boundaries: ['file/scenario granularity, not individual assertions', 'page coverage excludes service workers/background', 'anonymous VM, file reads, detached or env-reset subprocesses need conservative dependencies', 'CSS/assets and unknown source paths require full'] };
  await writeFile(output + '.tmp', JSON.stringify(index));
  await (await import('node:fs/promises')).rename(output + '.tmp', output);
  return index;
}

export async function mapBrowserCoverage(entries, { root, buildDirectory, origin, receipts = [] }) {
  const { createRequire } = await import('node:module');
  const { TraceMap, eachMapping } = createRequire(new URL('../browser-extension/package.json', import.meta.url))('@jridgewell/trace-mapping');
  const executed = new Set(), dependencies = new Set(), unknown = [], attribution = [];
  for (const entry of entries) {
    const digest = value => createHash('sha256').update(value).digest('hex');
    const detail = { scriptId: entry.scriptId, url: entry.url || 'anonymous', classification: 'unknown' };
    attribution.push(detail);
    try {
      if (typeof entry.source !== 'string') throw Error('coverage source unavailable');
      detail.sha256 = digest(entry.source); detail.sourceLength = entry.source.length;
      const url = new URL(entry.url);
      if (url.origin !== origin) throw Error('non-preview URL');
      const receipt = receipts.find(item => item.url === entry.url && item.sha256 === detail.sha256);
      if (receipt) {
        if (!receipt.sources?.length) throw Error('empty harness sources');
        for (const source of receipt.sources) {
          const file = resolve(root, source.file);
          if (relative(root, file).startsWith('..') || digest(await readFile(file)) !== source.sha256) throw Error('harness source drift');
        }
        for (const source of receipt.sources) dependencies.add(source.file);
        detail.classification = 'harness'; detail.reason = 'parent IPC receipt: exact delivered body and repository source hashes';
        detail.sources = receipt.sources;
        continue;
      }
      const bundle = resolve(buildDirectory, '.' + decodeURIComponent(url.pathname));
      if (relative(buildDirectory, bundle).startsWith('..')) throw Error('outside build');
      if (digest(await readFile(bundle, 'utf8')) !== detail.sha256) throw Error('bundle content mismatch');
      const map = new TraceMap(JSON.parse(await readFile(bundle + '.map', 'utf8')));
      const starts = [0];
      for (let i = 0; i < entry.source.length; i++) if (entry.source[i] === '\n') starts.push(i + 1);
      const ranges = entry.functions.flatMap(fn => fn.ranges).sort((a, b) => (a.endOffset - a.startOffset) - (b.endOffset - b.startOffset));
      eachMapping(map, point => {
        if (!point.source) return;
        const name = relative(root, resolve(bundle, '..', point.source)).replaceAll('\\', '/');
        if (name.startsWith('../') || name.includes('/node_modules/')) return;
        dependencies.add(name); // Loaded bundle membership is conservative, not execution.
        const offset = starts[point.generatedLine - 1] + point.generatedColumn;
        if (ranges.find(range => range.startOffset <= offset && offset < range.endOffset)?.count > 0) executed.add(name);
      });
      detail.classification = 'mapped'; detail.reason = 'build source map';
    } catch (error) { detail.reason = error.message; unknown.push(`${entry.url || 'anonymous'}: ${error.message}`); }
  }
  return { executed: [...executed].sort(), dependencies: [...dependencies].sort(), unknown, attribution, scope: 'page JavaScript only; bundle membership is conservative; workers/background/CSS excluded' };
}
