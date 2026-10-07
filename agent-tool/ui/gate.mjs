import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { root, syncCatalog } from './inventory.mjs';
import { checkStyles } from './static.mjs';
import { maintain } from './maintenance.mjs';

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

export async function gate({ tier = 'quick', base = 'HEAD', build = true, baselineDirectory, progress = () => {} } = {}) {
  if (!['quick', 'browser', 'full'].includes(tier)) throw new Error('未知门禁层级 ' + tier);
  const directory = await mkdtemp(join(tmpdir(), 'reframe-ui-gate-'));
  const result = { schemaVersion: 1, tier, status: 'failed', steps: [], scope: 'Browser tiers conservatively run every registered scenario; no incomplete dependency graph is used to omit checks.', directory };
  let interruptions = 0;
  const interrupt = () => { interruptions++; result.status = 'failed'; result.error = '门禁已取消'; };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  try {
    result.steps.push({ id: 'static-and-maintenance', ...await check({ changed: true, base }) });
    if (interruptions) throw new Error('门禁已取消');
    if (tier !== 'quick') {
      const { verify } = await import('./runner.mjs');
      const preview = await verify({ build, progress });
      result.steps.push({ id: 'preview', ...preview });
      if (interruptions) throw new Error('门禁已取消，不启动后续检查');
      const { verifyExtension } = await import('./extension.mjs');
      result.steps.push({ id: 'extension', ...await verifyExtension({ progress }) });
      if (interruptions) throw new Error('门禁已取消，不启动后续检查');
      if (preview.status === 'passed') {
        const { proposeVisual, compareVisual } = await import('./visual.mjs');
        result.visualCandidate = await proposeVisual(preview, { baselineDirectory });
        if (interruptions) throw new Error('门禁已取消，不启动后续检查');
        if (tier === 'full') result.steps.push({ id: 'visual', ...await compareVisual(preview, { baselineDirectory }) });
      } else if (tier === 'full') result.steps.push({ id: 'visual', status: 'uncovered', reason: 'preview did not pass' });
    }
    if (interruptions) throw new Error('门禁已取消');
    result.status = result.steps.every(step => step.status === 'passed') ? 'passed' : 'failed';
  } catch (error) { result.status = 'failed'; result.error = error.message; }
  result.reportPath = join(directory, 'gate.json');
  result.summaryPath = join(directory, 'gate.md');
  try {
    let savedInterruptions;
    do {
      savedInterruptions = interruptions;
      await writeFile(result.reportPath, JSON.stringify(result, null, 2));
      await writeFile(result.summaryPath, [`# UIUX gate: ${result.status}`, '', `Tier: ${tier}`, result.scope, '', ...result.steps.map(step => `- ${step.id}: ${step.status}${step.reportPath ? ` — ${step.reportPath}` : ''}`), '', result.error || '', result.visualCandidate ? `Visual candidate (not approval): ${result.visualCandidate.htmlPath}` : '', ''].join('\n'));
    } while (savedInterruptions !== interruptions);
  } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); }
  return result;
}
