import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { root, syncCatalog } from './inventory.mjs';
import { checkStyles } from './static.mjs';
import { maintain } from './maintenance.mjs';
import { validationWindow } from './build.mjs';
import { evidenceState, evidenceEnvironment, sealArtifacts } from './evidence.mjs';

export async function check({ changed = true, base = 'HEAD' } = {}) {
  const result = await checkStyles({ root, changed, base });
  try { await syncCatalog(true); }
  catch (error) { result.findings.push({ ruleId: 'UI-CATALOG-SYNC', severity: 'error', file: 'browser-extension/docs/uiux/catalog.md', line: 1, message: error.message }); }
  // Exceptions are reconciled against the full advisory inventory, even in changed mode.
  const inventory = changed ? await checkStyles({ root, changed: false }) : result;
  const maintenance = await maintain(inventory.findings);
  result.exceptions = maintenance.findings.filter(finding => finding.exception);
  for (const message of maintenance.errors) result.findings.push({ ruleId: 'UI-EXCEPTION', severity: 'error', file: 'browser-extension/docs/uiux/exceptions.json', line: 1, message });
  result.status = result.findings.some(finding => finding.severity === 'error') ? 'failed' : 'passed';
  return result;
}

export function gate(options = {}) { return validationWindow('gate', () => runGate(options)); }

async function runGate({ tier = 'quick', base = 'HEAD', build = true, baselineDirectory, reason = 'final-validation', progress = () => {} } = {}) {
  if (!['quick', 'browser', 'full'].includes(tier)) throw new Error('未知门禁层级 ' + tier);
  const directory = await mkdtemp(join(tmpdir(), 'reframe-ui-gate-'));
  const result = { schemaVersion: 2, startedAt: new Date().toISOString(), reason, timing: { waitMs: 0, phases: {} }, tier, base, status: 'failed', steps: [], scope: 'Browser tiers conservatively run every registered scenario; no incomplete dependency graph is used to omit checks.', directory };
  let initialEnvironment;
  let interruptions = 0;
  const interrupt = () => { interruptions++; result.status = 'failed'; result.error = '门禁已取消'; };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  try {
    let phaseStart = performance.now();
    result.steps.push({ id: 'static-and-maintenance', ...await check({ changed: true, base }) });
    result.timing.phases.staticMs = Math.round(performance.now() - phaseStart);
    if (interruptions) throw new Error('门禁已取消');
    if (tier !== 'quick') {
      initialEnvironment = await evidenceEnvironment();
      const { verify } = await import('./runner.mjs');
      phaseStart = performance.now();
      const preview = await verify({ build, progress, reason });
      result.timing.phases.previewMs = Math.round(performance.now() - phaseStart);
      result.steps.push({ id: 'preview', ...preview });
      if (interruptions) throw new Error('门禁已取消，不启动后续检查');
      const { verifyExtension } = await import('./extension.mjs');
      phaseStart = performance.now();
      result.steps.push({ id: 'extension', ...await verifyExtension({ progress }) });
      result.timing.phases.extensionMs = Math.round(performance.now() - phaseStart);
      if (interruptions) throw new Error('门禁已取消，不启动后续检查');
      if (preview.status === 'passed') {
        const { proposeVisual, compareVisual } = await import('./visual.mjs');
        phaseStart = performance.now();
        result.visualCandidate = await proposeVisual(preview, { baselineDirectory });
        if (interruptions) throw new Error('门禁已取消，不启动后续检查');
        if (tier === 'full') result.steps.push({ id: 'visual', ...await compareVisual(preview, { baselineDirectory }) });
        result.timing.phases.visualMs = Math.round(performance.now() - phaseStart);
      } else if (tier === 'full') result.steps.push({ id: 'visual', status: 'uncovered', reason: 'preview did not pass' });
    }
    if (interruptions) throw new Error('门禁已取消');
    if (tier !== 'quick') {
      result.evidenceState = await evidenceState();
      const preview = result.steps.find(step => step.id === 'preview');
      if (preview.source?.hash !== result.evidenceState.sourceHash || preview.source?.buildHash !== result.evidenceState.buildHash || preview.fixture?.hash !== result.evidenceState.fixtureHash || preview.rulesAndRunnerHash !== result.evidenceState.checkerHash) throw new Error('门禁期间来源变化，证据作废');
      if (JSON.stringify(initialEnvironment) !== JSON.stringify(result.evidenceState.environment)) throw new Error('门禁期间环境变化，证据作废');
      result.artifacts = await sealArtifacts(result);
    }
    result.status = result.steps.every(step => step.status === 'passed') ? 'passed' : 'failed';
  } catch (error) { result.status = 'failed'; result.error = error.message; }
  result.finishedAt = new Date().toISOString();
  result.timing.durationMs = Date.parse(result.finishedAt) - Date.parse(result.startedAt);
  result.reportPath = join(directory, 'gate.json');
  result.summaryPath = join(directory, 'gate.md');
  try {
    let savedInterruptions;
    do {
      savedInterruptions = interruptions;
      await writeFile(result.reportPath, JSON.stringify(result, null, 2));
      await writeFile(result.summaryPath, [`# UIUX gate: ${result.status}`, '', `Tier: ${tier}`, `Reason: ${reason}; duration: ${result.timing.durationMs} ms; wait: ${result.timing.waitMs} ms`, `Phases: ${JSON.stringify(result.timing.phases)}`, result.scope, '', ...result.steps.map(step => `- ${step.id}: ${step.status}${step.reportPath ? ` — ${step.reportPath}` : ''}`), '', result.error || '', result.visualCandidate ? `Visual candidate (not approval): ${result.visualCandidate.htmlPath}` : '', ''].join('\n'));
    } while (savedInterruptions !== interruptions);
  } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); }
  const { fileDigest } = await import('./evidence.mjs');
  return { ...result, evidenceSha256: await fileDigest(result.reportPath) };
}
