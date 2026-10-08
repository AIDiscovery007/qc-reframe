#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const exactDocs = new Set([
  'README.md', 'GLOSSARY.md', 'AGENTS.md', 'Contribution.md',
  'browser-extension/README.md', 'browser-extension/AGENTS.md',
  'browser-extension/docs/FEATURES.md', 'browser-extension/docs/architecture.md',
  'browser-extension/docs/INSTALL_WITH_CODEX.md',
]);
export const isDoc = file => exactDocs.has(file)
  || /^(?:\.agents\/roles|agent-logs|browser-extension\/docs\/releases)\/[^/]+\.md$/.test(file);
const decode = buffer => new TextDecoder('utf-8', { fatal: true }).decode(buffer);
function git(cwd, ...args) {
  return decode(execFileSync('git', args, { cwd, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
}
function commit(cwd, sha) {
  if (typeof sha !== 'string' || !/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(sha) || /^0+$/.test(sha)) throw Error('缺少有效提交 SHA');
  return git(cwd, 'rev-parse', '--verify', `${sha}^{commit}`).trim();
}
function tree(cwd, sha) {
  const entries = new Map();
  for (const line of git(cwd, 'ls-tree', '-r', '-z', '--full-tree', sha).split('\0').filter(Boolean)) {
    const tab = line.indexOf('\t');
    const [mode, type, oid] = line.slice(0, tab).split(' ');
    entries.set(line.slice(tab + 1), { mode, type, oid });
  }
  return entries;
}
export function classify({ cwd = process.cwd(), eventName, event, sha } = {}) {
  let base = '', head = '';
  try {
    if (eventName === 'workflow_dispatch') return { mode: 'full', reason: '手动触发', base, head };
    if (eventName === 'pull_request') {
      head = commit(cwd, event.pull_request.head.sha);
      const target = commit(cwd, event.pull_request.base.sha);
      base = commit(cwd, git(cwd, 'merge-base', target, head).trim());
    } else if (eventName === 'push') {
      head = commit(cwd, sha);
      base = commit(cwd, event.before);
      if (event.after && event.after !== head) throw Error('push after 与 GITHUB_SHA 不一致');
    } else throw Error('未知触发事件');
    const fields = git(cwd, 'diff', '--name-status', '-z', '--find-renames', '--no-ext-diff', '--no-textconv', base, head, '--').split('\0');
    if (fields.pop() !== '') throw Error('Git diff 输出不完整');
    const files = new Set();
    while (fields.length) {
      const status = fields.shift();
      if (!/^(?:[AMD]|R\d+)$/.test(status)) throw Error('非普通文件变更');
      for (let n = status.startsWith('R') ? 2 : 1; n > 0; n--) {
        const file = fields.shift();
        if (!file) throw Error('Git diff 路径缺失');
        files.add(file);
      }
    }
    if (!files.size) throw Error('空差异');
    const result = { base, head, files: [...files] };
    if ([...files].some(file => !isDoc(file))) return { ...result, mode: 'full', reason: '包含白名单之外路径' };
    const before = tree(cwd, base), after = tree(cwd, head);
    for (const file of files) {
      for (const entry of [before.get(file), after.get(file)].filter(Boolean)) {
        if (entry.mode !== '100644' || entry.type !== 'blob') throw Error('文档不是普通非执行文件');
      }
    }
    return { ...result, mode: 'docs', reason: '仅说明文档、协作规则或日志' };
  } catch (error) {
    // Never turn incomplete Git/event evidence into a lightweight success.
    return { mode: 'full', reason: `保守回退：${error.message}`, base, head };
  }
}

// Repository Markdown conventions: inline links/images and reference definitions.
// Code examples, URL schemes, absolute machine paths and fragment-only links are excluded.
export function localLinks(markdown, file) {
  const prose = markdown.replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[^\n]*(?:\n|$)/gm, '')
    .replace(/(`+)[\s\S]*?\1/g, '');
  const links = [];
  const destinations = /\]\(\s*(<[^>\n]+>|(?:\\.|[^\s()\\]|\((?:\\.|[^()\\])*\))+)(?:\s+["'][^\n]*?["'])?\s*\)|^ {0,3}\[[^\]\n]+\]:\s*(<[^>\n]+>|\S+)/gm;
  for (const match of prose.matchAll(destinations)) {
    let target = (match[1] || match[2]).replace(/^<|>$/g, '').replace(/\\([\s\S])/g, '$1');
    if (/^(?:[a-z][a-z\d+.-]*:|\/|#|\?)/i.test(target)) continue;
    target = decodeURIComponent(target.split(/[?#]/, 1)[0]);
    if (!target) continue;
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), target));
    if (resolved === '..' || resolved.startsWith('../')) throw Error(`${file}: 链接超出仓库 ${target}`);
    links.push(resolved);
  }
  return links;
}
const exists = (entries, target) => target === '.' || entries.has(target) || [...entries.keys()].some(file => file.startsWith(`${target.replace(/\/$/, '')}/`));
export function checkDocs(result, cwd = process.cwd()) {
  if (result.mode !== 'docs') throw Error('差异不满足轻量文档检查条件');
  git(cwd, 'diff', '--check', '--no-ext-diff', '--no-textconv', result.base, result.head, '--');
  const before = tree(cwd, result.base), after = tree(cwd, result.head);
  const changed = new Set(result.files);
  const errors = [];
  let checked = 0;
  for (const [file, entry] of after) {
    if (!isDoc(file) || entry.mode !== '100644' || entry.type !== 'blob') continue;
    const content = git(cwd, 'cat-file', 'blob', entry.oid);
    for (const target of localLinks(content, file)) {
      checked++;
      // Check changed documents plus newly broken incoming links after deletion/rename.
      if (!exists(after, target) && (changed.has(file) || exists(before, target))) errors.push(`${file} -> ${target}`);
    }
  }
  if (errors.length) throw Error(`仓库链接失效：\n${errors.join('\n')}`);
  return { mode: 'docs', status: 'passed', changedFiles: changed.size, linksExamined: checked };
}
function fromEnvironment() {
  try {
    return classify({ eventName: process.env.GITHUB_EVENT_NAME, event: JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')), sha: process.env.GITHUB_SHA });
  } catch (error) {
    return { mode: 'full', reason: `事件读取失败：${error.message}`, base: '', head: '' };
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [command, ...extra] = process.argv.slice(2);
    if (!['classify', 'docs'].includes(command) || extra.length) throw Error('用法：node agent-tool/ci.mjs classify|docs（读取 GitHub 事件环境变量）');
    const result = fromEnvironment();
    if (command === 'classify') {
      if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `mode=${result.mode}\nbase=${result.base}\n`);
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `CI route: **${result.mode}**; ${JSON.stringify(result.reason)}; changed paths: ${result.files?.length ?? 'unknown'}\n`);
      console.log(JSON.stringify(result));
    } else console.log(JSON.stringify(checkDocs(result)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
