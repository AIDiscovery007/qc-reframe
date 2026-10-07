import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { root, contextFor } from './inventory.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const nonempty = value => typeof value === 'string' && !!value.trim();
const identity = finding => JSON.stringify([finding?.ruleId, finding?.file, finding?.line, finding?.expected, finding?.actual]);
const exceptionFile = resolve(root, 'browser-extension/docs/uiux/exceptions.json');

// Exceptions annotate advisory debt; they never downgrade errors or hide findings.
export function reviewExceptions(findings, entries, today = new Date().toISOString().slice(0, 10)) {
  const errors = [], seen = new Set();
  if (!Array.isArray(entries)) return { findings, errors: ['exceptions must be an array'] };
  for (const entry of entries) {
    const key = identity(entry);
    if (!entry || !entry.ruleId || !entry.file || /[*?]/.test(entry.file) || !Number.isInteger(entry.line) || entry.line < 1 ||
        !nonempty(entry.reason) || !nonempty(entry.owner) || !nonempty(entry.reviewCondition) || !entry.expected || !entry.actual ||
        !/^\d{4}-\d{2}-\d{2}$/.test(entry.expires || '') || !Number.isFinite(Date.parse(entry.expires)) || new Date(entry.expires).toISOString().slice(0, 10) !== entry.expires) {
      errors.push('例外必须精确到规则/文件/行/期望/实值，并有原因、负责人、复查条件和有效到期日'); continue;
    }
    if (seen.has(key)) errors.push(`重复例外：${entry.file}:${entry.line}`);
    seen.add(key);
    if (entry.expires <= today) errors.push(`例外已到期：${entry.file}:${entry.line} (${entry.expires})`);
    const match = findings.find(finding => identity(finding) === key);
    if (!match) errors.push(`例外已失效或位置变化，应复核并移除：${entry.file}:${entry.line}`);
    else if (match.severity !== 'warning') errors.push(`例外不能放行错误：${entry.file}:${entry.line}`);
  }
  return {
    findings: findings.map(finding => {
      const entry = entries.find(entry => entry && identity(entry) === identity(finding));
      return entry ? { ...finding, exception: { owner: entry.owner, reason: entry.reason, expires: entry.expires, reviewCondition: entry.reviewCondition } } : finding;
    }), errors,
  };
}

export async function maintain(findings = []) {
  const policy = JSON.parse(await readFile(exceptionFile, 'utf8'));
  if (policy.schemaVersion !== 1) throw new Error('Unsupported exception schema');
  return reviewExceptions(findings, policy.exceptions);
}

function localPath(file, directory) {
  const path = relative(directory, resolve(directory, file));
  if (!path || isAbsolute(path) || path === '..' || path.startsWith('../')) throw new Error(`文件不在仓库内：${file}`);
  return path;
}

export async function createChange({ files, reason, output }) {
  if (!files?.length || !reason?.trim()) throw new Error('设计变更记录需要 --files 和 --reason');
  const paths = [...new Set(files.map(file => localPath(file, root)))];
  const context = await contextFor(paths);
  const record = {
    schemaVersion: 1, intent: reason.trim(), createdAt: new Date().toISOString(), reviewStatus: 'proposed',
    files: await Promise.all(paths.map(async path => ({ path, sha256: digest(await readFile(resolve(root, path))) }))),
    rules: context.rules.map(rule => rule.id), scenarios: context.scenarios.map(scenario => scenario.id),
    scopeReason: context.reason, evidence: [],
    reviewChecklist: ['确认设计意图及合法变体', '复核组件复用与所有受影响表面', '附上静态/交互/截图证据', '设计变化时单独审阅指定视觉基线'],
  };
  if (output) await writeFile(resolve(output), JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  return record;
}

export async function checkChange(record, directory = root) {
  const errors = [];
  if (record?.schemaVersion !== 1 || !nonempty(record.intent) || !Array.isArray(record.files) || !record.files.length || !Array.isArray(record.rules) || !Array.isArray(record.scenarios)) {
    return { status: 'failed', errors: ['变更记录格式不完整'] };
  }
  const seen = new Set();
  for (const file of record.files) {
    try {
      const path = localPath(file.path, directory);
      if (seen.has(path)) errors.push(`重复来源：${path}`);
      seen.add(path);
      if (digest(await readFile(resolve(directory, path))) !== file.sha256) errors.push(`来源已变更，需重新复核：${path}`);
    } catch (error) { errors.push(error.message); }
  }
  if (directory === root) {
    const context = await contextFor(record.files.map(file => file.path));
    if (JSON.stringify(record.rules) !== JSON.stringify(context.rules.map(rule => rule.id)) || JSON.stringify(record.scenarios) !== JSON.stringify(context.scenarios.map(scenario => scenario.id))) errors.push('规则/场景映射已变更，需重新生成影响范围');
  }
  return { status: errors.length ? 'failed' : 'passed', errors, reviewStatus: record.reviewStatus, note: '仅验证记录与当前来源/映射一致；不替代设计审阅或证明 evidence 已执行。' };
}
