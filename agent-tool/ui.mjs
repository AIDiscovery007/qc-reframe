#!/usr/bin/env node
import { root, contextFor, syncCatalog } from './ui/inventory.mjs';
import { scenarios } from './ui/catalog.mjs';

const help = `Reframe UIUX tools (run from any directory)
  node agent-tool/ui.mjs context [--files PATH ...] [--json]
  node agent-tool/ui.mjs check [--changed] [--base REF] [--json]
  node agent-tool/ui.mjs sync [--check] [--json]
  node agent-tool/ui.mjs verify [--scenario ID] [--no-build] [--fault NAME] [--json]
  node agent-tool/ui.mjs inspect --scenario ID [--no-build] [--json]

verify builds by default, starts its own isolated preview/browser, writes reports to
an OS temporary directory and stops its own processes. --no-build requires a matching
source/build fingerprint from a prior verify. No bridge, real data or model calls.
Faults: canvas-padding, quick-height, image-offset (expected to FAIL).
sync updates the generated catalog only; no visual baseline updates.
Exit: 0 passed (warnings allowed), 1 check/run failed, 2 invalid arguments.
Scenarios: ${scenarios.map(scenario => scenario.id).join(', ')}
`;

function parse(args) {
  const [command, ...rest] = args;
  const allowed = {
    context: ['--files', '--json'], check: ['--changed', '--base', '--json'],
    sync: ['--check', '--json'], verify: ['--scenario', '--no-build', '--fault', '--json'],
    inspect: ['--scenario', '--no-build', '--json'],
  };
  if (!allowed[command]) throw new Error('未知命令');
  const options = { command, files: [], build: true };
  const seen = new Set();
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (!allowed[command].includes(arg) || seen.has(arg)) throw new Error(`未知或重复参数 ${arg}`);
    seen.add(arg);
    if (arg === '--files') {
      while (rest[index + 1] && !rest[index + 1].startsWith('--')) options.files.push(rest[++index]);
      if (!options.files.length) throw new Error('--files 需要至少一个路径');
    } else if (['--scenario', '--base', '--fault'].includes(arg)) {
      if (!rest[index + 1] || rest[index + 1].startsWith('-')) throw new Error(`${arg} 需要值`);
      options[arg.slice(2)] = rest[++index];
    } else if (arg === '--no-build') options.build = false;
    else options[arg.slice(2)] = true;
  }
  if (command === 'inspect' && !options.scenario) throw new Error('inspect 必须提供 --scenario');
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
    if (options.command === 'context') {
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
      const { checkStyles } = await import('./ui/static.mjs');
      result = await checkStyles({ root, changed: options.changed, base: options.base || 'HEAD' });
      try { await syncCatalog(true); }
      catch (error) { result.findings.push({ ruleId: 'UI-CATALOG-SYNC', severity: 'error', file: 'browser-extension/docs/uiux/catalog.md', line: 1, message: error.message }); }
      result.status = result.findings.some(finding => finding.severity === 'error') ? 'failed' : 'passed';
      if (!options.json) {
        for (const finding of result.findings) console.log(`${finding.severity} ${finding.ruleId} ${finding.file}:${finding.line} ${finding.message}`);
        console.log(`${result.status} · ${result.findings.length} findings; coverage: ${JSON.stringify(result.coverage)}`);
      }
      if (result.status === 'failed') process.exitCode = 1;
    } else {
      const { verify } = await import('./ui/runner.mjs');
      result = await verify({ ...options, inspect: options.command === 'inspect', progress: message => console.error(message) });
      if (!options.json) {
        for (const scenario of result.scenarios) console.log(`${scenario.status} ${scenario.id} (${scenario.checks.length} checks)`);
        console.log(`${result.status}\n${result.error || ''}\n报告：${result.summaryPath}\n测量：${result.reportPath}`);
      }
      if (result.status !== 'passed') process.exitCode = 1;
    }
    if (options.json) console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    process.exitCode = 1;
    if (options.json) console.log(JSON.stringify({ status: 'failed', error: error.message }));
    else console.error(error.message);
  }
}
await main();
