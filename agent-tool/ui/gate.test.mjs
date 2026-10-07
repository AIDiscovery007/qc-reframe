import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

test('cancelling preview stops the gate without launching the extension stage', { timeout: 45000 }, async () => {
  const script = `import {gate} from ${JSON.stringify(new URL('./gate.mjs', import.meta.url).href)};
const report = await gate({tier:'browser',build:false,progress:message => {
  if (message === '检查 workspace-wide') process.kill(process.pid,'SIGTERM');
}});
console.log(JSON.stringify(report));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { errors += data; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(code, 0, errors);
  const report = JSON.parse(output);
  assert.equal(report.status, 'failed');
  assert.match(report.error, /取消/);
  assert.ok(report.steps.some(step => step.id === 'preview'));
  assert.ok(!report.steps.some(step => step.id === 'extension'));
  assert.equal(report.visualCandidate, undefined);
});

test('signals during visual candidates and report persistence cannot turn a cancelled gate green', { timeout: 120000 }, async () => {
  const script = `import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const original = fs.promises.writeFile, sent = new Set();
fs.promises.writeFile = async function(path,...args) {
  const name = String(path).split('/').pop();
  if (['candidate.json','gate.json'].includes(name) && !sent.has(name)) {
    sent.add(name); process.kill(process.pid,'SIGTERM');
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  return original.call(this,path,...args);
};
syncBuiltinESMExports();
const {gate}=await import(${JSON.stringify(new URL('./gate.mjs', import.meta.url).href)});
const report=await gate({tier:'browser',build:false});
console.log(JSON.stringify({report,sent:[...sent]}));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { errors += data; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(code, 0, errors);
  const { report, sent } = JSON.parse(output);
  assert.deepEqual(sent, ['candidate.json', 'gate.json']);
  assert.equal(report.status, 'failed');
  assert.match(report.error, /取消/);
  assert.ok(report.steps.every(step => step.status === 'passed'), 'Cancellation alone must fail the gate');
  const saved = JSON.parse(await readFile(report.reportPath, 'utf8'));
  assert.equal(saved.status, 'failed');
  assert.match(saved.error, /取消/);
  assert.match(await readFile(report.summaryPath, 'utf8'), /gate: failed/);
});
