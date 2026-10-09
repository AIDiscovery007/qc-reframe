import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, appendFileSync, unlinkSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { isDoc } from './ci.mjs';
import { execFileSync } from 'node:child_process';
export function planSchedule({ targets, jobs, controller, force = false }) {
  const include = [], deferred = [];
  for (const target of targets) {
    const name = `full/v1/${controller}/${target.number ? `pr${target.number}` : 'main'}/${target.sha}`;
    const matches = jobs.filter(job => job.name === name);
    const reason = target.fork ? 'fork-native-full-required' : target.blocked || (!target.code && !force ? 'docs' : null) || (matches.some(job => job.status !== 'completed') ? 'running'
      : !force && matches.some(job => job.conclusion === 'success') ? 'success' : null);
    if (reason) deferred.push({ ...target, reason });
    else include.push({ ...target, name });
  }
  return { include, deferred };
}

export function verifyTarget({ root, target }) {
  if (![target.sha, target.head, ...(target.base ? [target.base] : [])].every(sha => /^[a-f\d]{40}$/.test(sha))) throw Error('Invalid target SHA');
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  if (git('rev-parse', 'HEAD') !== target.sha) throw Error('Checkout SHA differs from frozen target');
  if (target.number && git('show', '-s', '--format=%P', 'HEAD') !== `${target.base} ${target.head}`) throw Error('Merge parents differ from frozen PR base/head');
  return target;
}

export function requireFull({ target, controller, jobs, native }) {
  const name = `full/v1/${controller}/${target.number ? `pr${target.number}` : 'main'}/${target.sha}`;
  if (target.fork && !target.blocked && native?.event === 'pull_request' && native.head === target.head && native.status === 'completed' && native.conclusion === 'success' && native.jobPassed && native.report?.commit === target.sha && native.report.status === 'passed' && native.report.mode === 'full' && native.report.deferred?.length === 0) return { status: 'passed', target, nativeRun: native.runId };
  if (target.blocked || target.fork || !jobs.some(job => job.name === name && job.status === 'completed' && job.conclusion === 'success')) throw Error(`Current target lacks successful full evidence: ${name}`);
  return { status: 'passed', target, name };
}

async function onlyDocs(api, files, base, head) {
  if (!files.length || files.some(file => !isDoc(file.filename) || file.previous_filename && !isDoc(file.previous_filename))) return false;
  for (const sha of [base, head]) {
    const tree = await api.get(`git/trees/${sha}?recursive=1`);
    if (tree.truncated || !Array.isArray(tree.tree)) return false;
    for (const file of files) for (const path of [file.filename, file.previous_filename].filter(Boolean)) {
      const entry = tree.tree.find(entry => entry.path === path);
      if (entry && (entry.type !== 'blob' || entry.mode !== '100644')) return false;
    }
  }
  return true;
}

export async function discoverTargets({ api, branch, repository, jobs = [] }) {
  const main = await api.get(`commits/${encodeURIComponent(branch)}`);
  const targets = [{ sha: main.sha, head: main.sha, base: '', number: 0, ref: branch, fork: false, code: true }];
  const previous = jobs.find(job => job.main && job.conclusion === 'success');
  if (previous) {
    const sha = previous.name.split('/').at(-1);
    const diff = await api.get(`compare/${sha}...${main.sha}`);
    // GitHub compare returns at most 300 files. At the boundary stay conservative.
    targets[0].code = !diff.files || diff.files.length >= 300 || !['ahead', 'identical'].includes(diff.status) || (diff.status !== 'identical' && !await onlyDocs(api, diff.files, sha, main.sha));
  }
  for (const item of await api.list('pulls?state=open&per_page=100')) {
    const pr = await api.get(`pulls/${item.number}`);
    const files = await api.list(`pulls/${item.number}/files?per_page=100`);
    if (files.length !== pr.changed_files) throw Error(`Incomplete changed files for PR ${pr.number}`);
    targets.push({ sha: pr.merge_commit_sha || '', head: pr.head.sha, base: pr.base.sha, number: pr.number, ref: `refs/pull/${pr.number}/merge`, fork: pr.head.repo?.full_name !== repository, code: !await onlyDocs(api, files, pr.base.sha, pr.head.sha), blocked: pr.mergeable !== true || !pr.merge_commit_sha ? 'merge-unavailable-or-conflict' : null });
  }
  return targets;
}

export function github(repository = process.env.GITHUB_REPOSITORY) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository || '')) throw Error('Set GITHUB_REPOSITORY=owner/repo');
  const request = args => JSON.parse(execFileSync('gh', ['api', ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));
  return {
    get: async path => request([`repos/${repository}/${path}`]),
    list: async (path, key) => {
      const pages = request(['--paginate', '--slurp', `repos/${repository}/${path}`]);
      if (!Array.isArray(pages) || pages.some(page => !Array.isArray(key ? page[key] : page))) throw Error('Incomplete API page');
      return pages.flatMap(page => key ? page[key] : page);
    },
  };
}

export async function fullJobs(api) {
  // Bounded history is conservative: old success outside this window causes a rerun.
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const runs = await api.list(`actions/workflows/test-full.yml/runs?per_page=100&created=${encodeURIComponent('>=' + since)}`, 'workflow_runs');
  const jobs = [];
  for (const run of runs) {
    if (!['schedule', 'workflow_dispatch'].includes(run.event) || run.head_branch !== process.env.DEFAULT_BRANCH || run.id === Number(process.env.GITHUB_RUN_ID)) continue;
    for (const job of await api.list(`actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`, 'jobs')) {
      jobs.push({ ...job, conclusion: run.status === 'completed' && run.conclusion !== 'success' ? run.conclusion : job.conclusion, runId: run.id, runAttempt: run.run_attempt, main: job.name.split('/')[3] === 'main', testedSha: job.name.split('/').at(-1), controllerSha: run.head_sha });
    }
  }
  return jobs;
}

export function attemptArtifact(artifacts, name, attempt) {
  if (!Number.isInteger(attempt) || attempt < 1) throw Error('Missing successful run attempt');
  return artifacts.filter(item => item.name === `${name}-attempt-${attempt}` && !item.expired).sort((a,b) => b.id-a.id)[0];
}

export async function nativeFull(api, target) {
  const runs = await api.list(`actions/workflows/uiux.yml/runs?event=pull_request&head_sha=${target.head}&per_page=100`, 'workflow_runs');
  for (const run of runs) {
    if (run.event !== 'pull_request' || run.head_sha !== target.head || run.status !== 'completed' || run.conclusion !== 'success') continue;
    const jobs = await api.list(`actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`, 'jobs');
    if (!jobs.some(job => job.name === 'uiux' && job.status === 'completed' && job.conclusion === 'success')) continue;
    const artifacts = await api.list(`actions/runs/${run.id}/artifacts?per_page=100`, 'artifacts');
    const artifact = attemptArtifact(artifacts, 'uiux-evidence', run.run_attempt);
    if (!artifact) continue;
    const directory = mkdtempSync(join(tmpdir(), 'reframe-native-evidence-'));
    try {
      const archive = join(directory, 'artifact.zip');
      writeFileSync(archive, execFileSync('gh', ['api', `repos/${process.env.GITHUB_REPOSITORY}/actions/artifacts/${artifact.id}/zip`], { maxBuffer: 256 * 1024 * 1024 }));
      const report = JSON.parse(execFileSync('unzip', ['-p', archive, 'regression/report.json'], { maxBuffer: 32 * 1024 * 1024 }));
      if (report.commit === target.sha) return { event: run.event, head: run.head_sha, status: run.status, conclusion: run.conclusion, jobPassed: true, runId: run.id, report };
    } finally { rmSync(directory, {recursive:true,force:true}); }
  }
  return null;
}

const controllerRoot = fileURLToPath(new URL('../', import.meta.url));
export function controllerId(root = controllerRoot) {
  const files = ['.github/workflows/test-full.yml', 'agent-tool/test-schedule.mjs', 'agent-tool/test-impact.mjs', 'agent-tool/test-run.mjs', 'agent-tool/test-policy.mjs', 'browser-extension/package-lock.json'];
  const hash = createHash('sha256');
  for (const file of files) hash.update(file).update(readFileSync(resolve(root, file)));
  return hash.digest('hex').slice(0, 16);
}

export function verifyController(root, expectedSha) {
  const sha = execFileSync('git', ['rev-parse','HEAD'], {cwd:root,encoding:'utf8'}).trim();
  if (sha !== expectedSha) throw Error('verify-full requires the current trusted default-branch checkout; run its absolute script path');
  execFileSync('git', ['diff','--exit-code','HEAD','--','agent-tool','.github/workflows','browser-extension/package-lock.json'], {cwd:root,stdio:'pipe'});
  return sha;
}

async function main() {
  const [command, argument] = process.argv.slice(2);
  if (command === 'verify-target') {
    console.log(JSON.stringify(verifyTarget({ root: process.cwd(), target: JSON.parse(process.env.TEST_TARGET) })));
    return;
  }
  const api = github(), branch = process.env.DEFAULT_BRANCH;
  if (!branch) throw Error('Set DEFAULT_BRANCH');
  const controller = controllerId();
  let jobs;
  try { jobs = await fullJobs(api); }
  catch (error) {
    // Bootstrap has no full workflow on the server yet. Only that exact 404 is empty history.
    if (process.env.ALLOW_FULL_BOOTSTRAP === '1' && String(error.stderr || error.message).includes('HTTP 404')) jobs = [];
    else throw error;
  }
  if (command === 'baseline') {
    if (!argument) throw Error('baseline requires an output file');
    const job = jobs.find(job => job.main && job.status === 'completed' && job.conclusion === 'success' && job.name.startsWith(`full/v1/${controller}/`));
    if (!job) { console.log('No trusted full main index; fallback full'); return; }
    const artifacts = await api.list(`actions/runs/${job.runId}/artifacts?per_page=100`, 'artifacts');
    const artifact = attemptArtifact(artifacts, `test-index-${job.testedSha}`, job.runAttempt);
    if (!artifact) { console.log('No index artifact; fallback full'); return; }
    const archive = argument + '.zip';
    writeFileSync(archive, execFileSync('gh', ['api', `repos/${process.env.GITHUB_REPOSITORY}/actions/artifacts/${artifact.id}/zip`], { maxBuffer: 32 * 1024 * 1024 }));
    const body = execFileSync('unzip', ['-p', archive, 'test-index.json'], { maxBuffer: 32 * 1024 * 1024 });
    const index = JSON.parse(body);
    if (index.commit !== job.testedSha || index.status !== 'passed' || !index.complete) throw Error('Index provenance mismatch');
    writeFileSync(argument, body); unlinkSync(archive);
    console.log(`Trusted main index: ${index.commit}`);
    return;
  }
  const targets = await discoverTargets({ api, branch, repository: process.env.GITHUB_REPOSITORY, jobs: jobs.filter(job => job.name.startsWith(`full/v1/${controller}/`)) });
  if (command === 'verify-full') {
    const controlSha = verifyController(controllerRoot, targets[0].sha);
    const target = targets.find(item => item.number === Number(argument));
    if (!target) throw Error('Current target not found');
    const native = target.fork ? await nativeFull(api, target) : null;
    // Re-read after evidence lookup so a concurrently advancing PR cannot pass on an old tuple.
    const refreshed = await discoverTargets({ api, branch, repository: process.env.GITHUB_REPOSITORY });
    if (refreshed[0].sha !== controlSha) throw Error('Trusted main advanced during verification');
    const fresh = refreshed.find(item => item.number === target.number);
    if (!fresh || ['sha', 'head', 'base'].some(key => fresh[key] !== target[key])) throw Error('Target advanced during verification');
    console.log(JSON.stringify(requireFull({ target, controller, jobs, native })));
  } else if (command === 'plan') {
    const selected = argument ? targets.filter(item => item.number === Number(argument)) : targets;
    if (argument && !selected.length) throw Error('Requested target not found');
    const plan = planSchedule({ targets: selected, jobs, controller, force: process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' });
    if (plan.include.length > 256) throw Error('Matrix limit exceeded; cannot silently truncate targets');
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify({ include: plan.include })}\ncount=${plan.include.length}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Full regression plan (controller ${controller}):\n\n\`\`\`json\n${JSON.stringify(plan, null, 2)}\n\`\`\`\n`);
    console.log(JSON.stringify(plan));
  } else throw Error('Usage: test-schedule.mjs plan [PR|0] | verify-full PR|0 | baseline FILE | verify-target');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
