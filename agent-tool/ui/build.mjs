import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, open, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { AsyncLocalStorage } from 'node:async_hooks';
import { extension, sourceState, fingerprint } from './inventory.mjs';

const buildDirectory = resolve(extension, '.output/chrome-mv3');
const stampPath = resolve(extension, '.output/ui-build.json');
const lockPath = resolve(extension, '.output/ui-validation.lock');
const windowContext = new AsyncLocalStorage();

// Nested gate -> verify -> prepare shares this window; competing calls/processes fail closed.
export async function validationWindow(operation, run) {
  if (windowContext.getStore()) return run();
  await mkdir(resolve(extension, '.output'), { recursive: true });
  let handle;
  try { handle = await open(lockPath, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new Error(`验证窗口被占用 (${await readFile(lockPath, 'utf8').catch(() => 'owner unavailable')}); 未等待、未清锁。确认持有者结束后才能人工移除残留锁。`);
  }
  let interrupted;
  const cancel = signal => { interrupted = signal; };
  const signals = Object.fromEntries(['SIGINT', 'SIGTERM'].map(signal => [signal, () => cancel(signal)]));
  for (const [signal, handler] of Object.entries(signals)) process.on(signal, handler);
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, operation, startedAt: new Date().toISOString(), waitMs: 0 }));
    const result = await windowContext.run(true, run);
    if (interrupted && result?.status !== 'failed') throw new Error('验证窗口已取消: ' + interrupted);
    return result;
  } finally {
    await handle.close(); await unlink(lockPath);
    for (const [signal, handler] of Object.entries(signals)) process.off(signal, handler);
  }
}

export function prepare(options = {}) {
  return validationWindow('prepare', async () => {
    const startedAt = new Date().toISOString(), children = new Set();
    let interrupted = false;
    const interrupt = () => { interrupted = true; for (const child of children) terminate(child); };
    process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
    try {
      const source = await buildCurrent(options.build !== false, children);
      if (interrupted) throw new Error('构建已取消');
      return { status: 'passed', source, startedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - Date.parse(startedAt), build: options.build !== false };
    } finally {
      await Promise.all([...children].map(stop));
      process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
    }
  });
}

export function terminate(child, signal = 'SIGTERM') {
  if (!child || child.exitCode !== null || child.signalCode) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) { if (error.code !== 'ESRCH') throw error; }
}

async function buildCurrent(build, children) {
  const source = await sourceState();
  if (build) {
    await new Promise((resolvePromise, reject) => {
      const child = spawn('npm', ['run', 'build'], { cwd: extension, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
      children.add(child);
      let log = '';
      child.stdout.on('data', data => { log = (log + data).slice(-6000); });
      child.stderr.on('data', data => { log = (log + data).slice(-6000); });
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolvePromise() : reject(new Error(`Build failed (${code}):\n${log}`)));
    });
    if (source.hash !== (await sourceState()).hash) throw new Error('构建期间源码变化，停止验证；请重新运行 verify。');
    await writeFile(stampPath, JSON.stringify({ sourceHash: source.hash, buildHash: await fingerprint(buildDirectory) }));
  }
  const stamp = JSON.parse(await readFile(stampPath, 'utf8').catch(() => { throw new Error('没有 UI 构建指纹；先运行 prepare 或 verify（不加 --no-build）。'); }));
  if (stamp.sourceHash !== source.hash || stamp.buildHash !== await fingerprint(buildDirectory)) throw new Error('源码或构建与上次指纹不符；移除 --no-build 重新构建。');
  return { ...source, ...stamp };
}

export async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  const exited = once(child, 'exit');
  terminate(child);
  const timeout = setTimeout(() => terminate(child, 'SIGKILL'), 3000);
  await exited;
  clearTimeout(timeout);
}
