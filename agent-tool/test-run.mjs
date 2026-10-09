#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { readFile, writeFile, readdir, lstat, readlink, mkdir, mkdtemp } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { isDoc } from './ci.mjs';
import { collectNode, selectTests, publishIndex } from './test-impact.mjs';
import { coreNode, coreBrowser, reliableSources, withConservativeDependencies, browserDomain, reviewedBrowserDomain } from './test-policy.mjs';
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const ordered = entries => Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b, 'en')));

export async function snapshot(root, commit) {
  if (git(root, 'rev-parse', '--show-object-format').trim() !== 'sha1') throw Error('Unsupported Git object format');
  if (commit) return ordered(git(root, 'ls-tree', '-rz', '--full-tree', commit).split('\0').filter(Boolean).flatMap(line => {
    const tab = line.indexOf('\t'), file = line.slice(tab + 1), [mode, type, oid] = line.slice(0, tab).split(' ');
    return isDoc(file) ? [] : [[file, { mode, oid, type }]];
  }));
  const entries = [];
  for (const file of [...new Set(git(root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0').filter(Boolean))]) {
    if (isDoc(file)) continue;
    const path = resolve(root, file), stat = await lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (!stat) continue;
    if (!stat.isFile() && !stat.isSymbolicLink()) throw Error('Unsupported source type: ' + file);
    const data = stat.isSymbolicLink() ? Buffer.from(await readlink(path)) : await readFile(path);
    const oid = createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
    entries.push([file, { mode: stat.isSymbolicLink() ? '120000' : stat.mode & 0o111 ? '100755' : '100644', oid, type: 'blob' }]);
  }
  return ordered(entries);
}
export function changesBetween(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().flatMap(file => JSON.stringify(before[file]) === JSON.stringify(after[file]) ? [] : [{ file, status: !before[file] ? 'A' : !after[file] ? 'D' : 'M' }]);
}
export async function loadIndex(path, root) {
  try {
    const index = JSON.parse(await readFile(path, 'utf8'));
    if (index.schema !== 1 || index.status !== 'passed' || !index.complete || !/^[a-f\d]{40}$/.test(index.commit)) return null;
    git(root, 'merge-base', '--is-ancestor', index.commit, 'HEAD');
    if (JSON.stringify(index.files) !== JSON.stringify(await snapshot(root, index.commit))) return null;
    return index;
  } catch { return null; } // Invalid/missing evidence always becomes a full run.
}
async function inventory(root) {
  const node = [];
  for (const directory of ['browser-extension/tests', 'agent-tool', 'agent-tool/ui']) {
    for (const name of await readdir(resolve(root, directory))) if (name.endsWith('.test.mjs')) node.push(`${directory}/${name}`);
  }
  const { scenarios } = await import('./ui/catalog.mjs');
  return [...node, ...scenarios.map(scene => `browser:${scene.id}`)].sort();
}
async function environment(root, files) {
  const { evidenceEnvironment } = await import('./ui/evidence.mjs');
  const hash = createHash('sha256').update(JSON.stringify({runtime:await evidenceEnvironment({portableFonts:true}),buildMode:'coverage'}));
  for (const [file, entry] of Object.entries(files)) if ((file.startsWith('agent-tool/') && file.endsWith('.mjs') && !file.endsWith('.test.mjs')) || ['browser-extension/package-lock.json', 'browser-extension/wxt.config.ts'].includes(file)) hash.update(file).update(entry.oid);
  return hash.digest('hex');
}
async function command(root, name, args, signal, log) {
  let output = '';
  const code = await new Promise((done, reject) => {
    const child = spawn(name, args, {cwd:root, detached:process.platform !== 'win32', stdio:['ignore','pipe','pipe']});
    const kill = () => { try { process.platform === 'win32' ? child.kill('SIGKILL') : process.kill(-child.pid,'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
    signal.addEventListener('abort',kill,{once:true});
    const timeout = setTimeout(kill,300000);
    child.stdout.on('data',data => {output += data;}); child.stderr.on('data',data => {output += data;});
    child.once('error',reject); child.once('close',code => {clearTimeout(timeout);signal.removeEventListener('abort',kill);done(code);});
  });
  await writeFile(log,output);
  if (code !== 0 || signal.aborted) throw Error(`${name} ${args.join(' ')} failed (${code}); ${log}`);
}
export async function run({ root = process.cwd(), index: indexPath, output, full = false, base = 'HEAD', build = true, planOnly = false, visual = false } = {}) {
  const started = performance.now(), before = await snapshot(root), tests = await inventory(root), env = await environment(root, before);
  const previous = await loadIndex(indexPath,root);
  const browserIsolated = browserDomain(before) === reviewedBrowserDomain;
  const changes = previous ? changesBetween(previous.files,before) : [];
  const core = [...coreNode, ...coreBrowser, ...tests.filter(id => id.startsWith('agent-tool/'))];
  const plan = full || visual ? {mode:'full',selected:tests,deferred:[],fallback:visual ? 'visual-full-required' : 'explicit-full'} : selectTests({index:previous,environment:env,changes,tests,core,reliable:reliableSources});
  if (planOnly) return { ...plan, changes, environment:env };
  const directory = output ? resolve(output) : await mkdtemp(join(tmpdir(),'reframe-tests-'));
  await mkdir(directory,{recursive:true});
  if ((await readdir(directory)).length) throw Error('Output directory must be empty and exclusive');
  const report = { schema:1, status:'failed', commit:git(root,'rev-parse','HEAD').trim(), environment:env, ...plan, changes, browserIsolated, directory, phases:{}, tests:[], indexPublished:false };
  const controller = new AbortController(), interrupt = () => controller.abort();
  process.on('SIGINT',interrupt); process.on('SIGTERM',interrupt);
  const priorMode = process.env.REFRAME_TEST_COVERAGE;
  process.env.REFRAME_TEST_COVERAGE = '1'; // All CI paths use the same reproducible build mode.
  const phase = async (name, fn) => { controller.signal.throwIfAborted(); const start=performance.now(); try {return await fn();} finally {report.phases[name]=Math.round(performance.now()-start);} };
  try {
    const { prepare } = await import('./ui/build.mjs');
    const { gate, check } = await import('./ui/gate.mjs');
    await phase('buildMs',()=>prepare({build}));
    await phase('typesMs',()=>command(resolve(root,'browser-extension'),'npm',['run','compile'],controller.signal,join(directory,'types.log')));
    report.node = await phase('nodeMs',()=>collectNode({root,tests:plan.selected.filter(id=>!id.startsWith('browser:')),directory:join(directory,'node'),signal:controller.signal,progress:id=>console.error('Test '+id)}));
    report.tests.push(...report.node.tests.map(item=>withConservativeDependencies(item,undefined,browserIsolated)));
    if (report.node.status !== 'passed' || report.node.tests.some(item=>item.skipped !== 0 || item.todo !== 0)) throw Error('Node tests failed; see node logs');
    const { validateCoverage, validateBrowserCoverage } = await import('./ui/evidence.mjs');
    let browser;
    if (plan.mode === 'full') {
      report.gate = await phase('gateMs',()=>gate({coverage:true,build:false,base,tier:visual?'full':'browser',baselineDirectory:resolve(root,`browser-extension/docs/uiux/visual-baselines/${process.platform}`),reason:'complete-regression',progress:console.error}));
      report.skippedChecks = validateCoverage(report.gate); // Only three existing declared capability exceptions; all others fail.
      browser = report.gate.steps[1];
    } else {
      report.static = await phase('staticMs',()=>check({changed:true,base}));
      if (report.static.status !== 'passed') throw Error('Static validation failed');
      const { verify } = await import('./ui/runner.mjs'), { verifyExtension } = await import('./ui/extension.mjs');
      browser = await phase('browserMs',()=>verify({coverage:true,build:false,scenarioIds:plan.selected.filter(id=>id.startsWith('browser:')).map(id=>id.slice(8)),reason:'selected-regression',progress:console.error}));
      report.browser = browser;
      report.extension = await phase('extensionMs',()=>verifyExtension({progress:console.error}));
      report.skippedChecks = validateBrowserCoverage(browser, report.extension, plan.selected.filter(id=>id.startsWith('browser:')).map(id=>id.slice(8)));
    }
    // skipped counts whole scenarios; declared skipped assertions retain their actual evidence separately.
    report.tests.push(...browser.scenarios.map(item=>({id:`browser:${item.id}`,status:item.status,skipped:Number(item.status==='skipped'),todo:0,skippedChecks:item.checks.filter(check=>check.status==='skipped'),durationMs:item.durationMs,...item.execution})).map(item=>withConservativeDependencies(item,undefined,browserIsolated)));
    const after = await snapshot(root);
    if (env !== await environment(root,after)) throw Error('Environment changed during regression');
    if (JSON.stringify(before) !== JSON.stringify(after)) throw Error('Source changed during regression');
    controller.signal.throwIfAborted();
    if (plan.mode === 'full') {
      try {
        if (report.tests.some(item=>!Array.isArray(item.executed) || !item.executed.length)) throw Error('Missing execution coverage');
        if (JSON.stringify(before) !== JSON.stringify(await snapshot(root,report.commit))) throw Error('Working tree differs from commit; local evidence only');
        const trustedPrevious = previous?.environment===env && Date.now()-Date.parse(previous.createdAt)<=7*86400000 ? previous : null;
        const index = await publishIndex({output:join(directory,'test-index.json'),commit:report.commit,environment:env,before,after,tests:report.tests,expected:tests,validations:{static:true,types:true,gate:true},previous:trustedPrevious,reliable:reliableSources,cancelled:controller.signal.aborted});
        report.indexPublished=true; report.shadow=index.shadow;
      } catch(error) { report.indexUnavailable=error.message; }
    }
    report.status='passed';
  } catch(error) { report.error=error.message; }
  finally {
    if (controller.signal.aborted) {report.status='failed';report.error='Regression cancelled';}
    report.durationMs=Math.round(performance.now()-started);
    await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2));
    if (process.env.GITHUB_STEP_SUMMARY) {
      const {appendFile}=await import('node:fs/promises');
      await appendFile(process.env.GITHUB_STEP_SUMMARY,`\nRegression: ${report.status}; mode: ${report.mode}; selected ${report.selected.length}; deferred ${report.deferred.length}; fallback ${report.fallback || 'none'}; ${report.durationMs}ms.\nIndex: ${report.indexPublished ? 'published' : report.indexUnavailable || 'not a full collection'}.\n`);
    }
    process.off('SIGINT',interrupt);process.off('SIGTERM',interrupt);
    if (priorMode===undefined) delete process.env.REFRAME_TEST_COVERAGE; else process.env.REFRAME_TEST_COVERAGE=priorMode;
  }
  return report;
}
async function main() {
  const {values,positionals}=parseArgs({allowPositionals:true,options:{index:{type:'string'},output:{type:'string'},base:{type:'string'},full:{type:'boolean'},'no-build':{type:'boolean'},visual:{type:'boolean'}}});
  if (positionals.length!==1 || !['run','plan'].includes(positionals[0])) throw Error('Usage: test-run.mjs run|plan [--index FILE] [--output DIR] [--base REF] [--full] [--no-build] [--visual]');
  const result=await run({...values,build:!values['no-build'],planOnly:positionals[0]==='plan'});
  console.log(JSON.stringify(result,null,2));
  if (result.status==='failed') process.exitCode=1;
}
if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) main().catch(error=>{console.error(error);process.exitCode=1;});
