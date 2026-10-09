#!/usr/bin/env node
import { contextFor, syncCatalog } from './ui/inventory.mjs';
import { scenarios } from './ui/catalog.mjs';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const help = `Reframe UIUX tools (run from any directory)
  node agent-tool/ui.mjs prepare [--no-build] [--json]
  node agent-tool/ui.mjs evidence --report FILE --sha256 DIGEST [--reason TEXT] [--json]
  node agent-tool/ui.mjs context [--files PATH ...] [--json]
  node agent-tool/ui.mjs check [--changed] [--base REF] [--json]
  node agent-tool/ui.mjs sync [--check] [--json]
  node agent-tool/ui.mjs verify [--scenario ID | --scenarios ID ...] [--no-build] [--fault NAME] [--reason TEXT] [--json]
  node agent-tool/ui.mjs inspect --scenario ID [--no-build] [--json]
  node agent-tool/ui.mjs examples [--origin URL] [--json]
  node agent-tool/ui.mjs visual --report FILE [--scenario ID] [--baseline-dir DIR] [--json]
  node agent-tool/ui.mjs baseline --report FILE [--scenario ID] [--baseline-dir DIR] [--json]
  node agent-tool/ui.mjs accept --candidate DIR --scenario ID --reason TEXT --reviewer NAME [--baseline-dir DIR] [--json]
  node agent-tool/ui.mjs extension [--json]
  node agent-tool/ui.mjs gate [--tier quick|browser|full] [--base REF] [--no-build] [--baseline-dir DIR] [--reason TEXT] [--json]
  node agent-tool/ui.mjs change --files PATH ... --reason TEXT [--output FILE] [--json]
  node agent-tool/ui.mjs change --record FILE [--json]

verify builds by default, starts its own isolated preview/browser, writes reports to
an OS temporary directory and stops its own processes. --no-build requires a matching
source/build fingerprint from a prior verify. No bridge, real data or model calls.
Faults: canvas-padding, quick-height, image-offset (expected to FAIL).
sync updates the generated catalog only; no visual baseline updates.
baseline proposes candidates; accept requires explicit review of one named scene.
extension checks an existing fingerprinted build in a disposable profile.
gate browser includes preview and extension; full additionally requires accepted visual baselines.
Exit: 0 passed (warnings allowed), 1 check/run failed, 2 invalid arguments.
Scenarios: ${scenarios.map(scenario => scenario.id).join(', ')}
`;

function parse(args) {
  const [command, ...rest] = args;
  const allowed = {
    prepare: ['--no-build', '--json'], evidence: ['--report', '--sha256', '--reason', '--json'],
    context: ['--files', '--json'], check: ['--changed', '--base', '--json'],
    sync: ['--check', '--json'], verify: ['--scenario', '--scenarios', '--no-build', '--fault', '--reason', '--json'],
    inspect: ['--scenario', '--no-build', '--json'],
    examples: ['--origin', '--json'], extension: ['--json'],
    visual: ['--report', '--scenario', '--baseline-dir', '--json'],
    baseline: ['--report', '--scenario', '--baseline-dir', '--json'],
    accept: ['--candidate', '--scenario', '--reason', '--reviewer', '--baseline-dir', '--json'],
    gate: ['--tier', '--base', '--no-build', '--baseline-dir', '--reason', '--json'],
    change: ['--files', '--reason', '--output', '--record', '--json'],
  };
  if (!allowed[command]) throw new Error('未知命令');
  const options = { command, files: [], build: true };
  const seen = new Set();
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (!allowed[command].includes(arg) || seen.has(arg)) throw new Error(`未知或重复参数 ${arg}`);
    seen.add(arg);
    if (arg === '--files' || arg === '--scenarios') {
      const values = [];
      while (rest[index + 1] && !rest[index + 1].startsWith('--')) values.push(rest[++index]);
      if (!values.length) throw new Error(arg + ' 需要至少一个值');
      options[arg === '--files' ? 'files' : 'scenarioIds'] = values;
    } else if (['--scenario', '--base', '--fault', '--origin', '--report', '--baseline-dir', '--candidate', '--reason', '--reviewer', '--tier', '--output', '--record', '--sha256'].includes(arg)) {
      if (!rest[index + 1] || rest[index + 1].startsWith('-')) throw new Error(`${arg} 需要值`);
      options[arg.slice(2)] = rest[++index];
    } else if (arg === '--no-build') options.build = false;
    else options[arg.slice(2)] = true;
  }
  if (command === 'evidence' && (!options.report || !/^[a-f0-9]{64}$/.test(options.sha256 || ''))) throw new Error('evidence 必须提供 --report 与可信 --sha256');
  if (options.scenarioIds && (options.scenario || options.fault || new Set(options.scenarioIds).size !== options.scenarioIds.length || options.scenarioIds.some(id => !scenarios.some(scene => scene.id === id)))) throw new Error('场景列表重复、未知或与单场景/故障冲突');
  if (command === 'inspect' && !options.scenario) throw new Error('inspect 必须提供 --scenario');
  if (['visual', 'baseline'].includes(command) && !options.report) throw new Error(command + ' 必须提供 --report');
  if (command === 'accept' && ['candidate', 'scenario', 'reason', 'reviewer'].some(key => !options[key])) throw new Error('accept 必须提供 candidate/scenario/reason/reviewer');
  if (options.tier && !['quick', 'browser', 'full'].includes(options.tier)) throw new Error('未知门禁层级');
  if (command === 'change' && (options.record ? options.files.length || options.reason || options.output : !options.files.length || !options.reason)) throw new Error('change 使用 --record 或 --files/--reason，不能混用');
  if (['visual', 'baseline', 'accept'].includes(command) && options.scenario && !['workspace-wide', 'workspace-narrow', 'popup'].includes(options.scenario)) throw new Error('非视觉核心场景');
  if (options.scenario && !scenarios.some(scenario => scenario.id === options.scenario)) throw new Error('未知场景 ' + options.scenario);
  if (options.fault && !['canvas-padding', 'quick-height', 'image-offset'].includes(options.fault)) throw new Error('未知故障 ' + options.fault);
  if (options.fault && options.scenario && options.scenario !== (options.fault === 'canvas-padding' ? 'workspace-wide' : 'popup')) throw new Error('故障与场景不匹配');
  return options;
}

async function main() {
  if (!process.argv[2] || process.argv[2] === '--help') { console.log(help); return; }
  let options;
  try { options = parse(process.argv.slice(2)); }
  catch (error) { console.error(`${error.message}\n${help}`); process.exitCode = 2; return; }
  let result;
  try {
    if (options.command === 'prepare') {
      const { prepare } = await import('./ui/build.mjs');
      result = await prepare(options);
      if (!options.json) console.log(JSON.stringify(result, null, 2));
    } else if (options.command === 'evidence') {
      const { inspectEvidence } = await import('./ui/evidence.mjs');
      result = await inspectEvidence(options);
      if (!options.json) console.log(JSON.stringify(result, null, 2));
    } else if (options.command === 'context') {
      result = await contextFor(options.files);
      if (!options.json) {
        console.log(result.reason);
        for (const rule of result.rules) console.log(`${rule.id} · ${rule.title}\n  ${rule.sources.join(', ')}`);
        console.log('场景：' + result.scenarios.map(scenario => scenario.id).join(', '));
        console.log('组件、tokens 与覆盖限制：browser-extension/docs/uiux/catalog.md');
      }
    } else if (options.command === 'sync') {
      result = await syncCatalog(options.check);
      if (!options.json) console.log(`${result.written ? '已生成' : '同步检查通过'} ${result.file}`);
    } else if (options.command === 'check') {
      const { check } = await import('./ui/gate.mjs');
      result = await check({ changed: !!options.changed, base: options.base || 'HEAD' });
      if (!options.json) {
        for (const finding of result.findings) console.log(`${finding.severity} ${finding.ruleId} ${finding.file}:${finding.line} ${finding.message}`);
        console.log(`${result.status} · ${result.findings.length} findings; coverage: ${JSON.stringify(result.coverage)}`);
      }
      if (result.status === 'failed') process.exitCode = 1;
    } else if (['verify', 'inspect'].includes(options.command)) {
      const { verify } = await import('./ui/runner.mjs');
      result = await verify({ ...options, inspect: options.command === 'inspect', progress: message => console.error(message) });
      if (!options.json) {
        for (const scenario of result.scenarios) console.log(`${scenario.status} ${scenario.id} (${scenario.checks.length} checks)`);
        console.log(`${result.status}\n${result.error || ''}\n报告：${result.summaryPath}\n测量：${result.reportPath}`);
      }
      if (result.status !== 'passed') process.exitCode = 1;
    } else {
      const baselineDirectory = options['baseline-dir'];
      if (options.command === 'examples') {
        const { renderExamples, exampleCoverage } = await import('./ui/examples.mjs');
        const directory = await mkdtemp(join(tmpdir(), 'reframe-ui-examples-'));
        const htmlPath = join(directory, 'index.html');
        await writeFile(htmlPath, renderExamples({ baseURL: options.origin }));
        result = { status: 'generated', htmlPath, coverage: exampleCoverage, note: 'Navigation only; start preview separately. Run verify for executable evidence.' };
      } else if (options.command === 'extension') {
        const { verifyExtension } = await import('./ui/extension.mjs');
        result = await verifyExtension({ progress: message => console.error(message) });
      } else if (options.command === 'gate') {
        const { gate } = await import('./ui/gate.mjs');
        result = await gate({ ...options, baselineDirectory, progress: message => console.error(message) });
      } else if (options.command === 'change') {
        const { createChange, checkChange } = await import('./ui/maintenance.mjs');
        result = options.record ? await checkChange(JSON.parse(await readFile(options.record, 'utf8'))) : await createChange(options);
      } else {
        const { compareVisual, proposeVisual, acceptVisual } = await import('./ui/visual.mjs');
        const selection = { baselineDirectory, scenarioIds: options.scenario ? [options.scenario] : undefined };
        result = options.command === 'accept' ? await acceptVisual(options.candidate, { ...options, baselineDirectory }) : await (options.command === 'baseline' ? proposeVisual : compareVisual)(JSON.parse(await readFile(options.report, 'utf8')), selection);
      }
      if (['failed', 'uncovered'].includes(result.status)) process.exitCode = 1;
      if (!options.json) console.log(JSON.stringify(result, null, 2));
    }
    if (options.json) console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    process.exitCode = 1;
    if (options.json) console.log(JSON.stringify({ status: 'failed', error: error.message }));
    else console.error(error.message);
  }
}
await main();
