import { access, readFile, writeFile, mkdir, mkdtemp, rename, rm, realpath, symlink, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve, relative, delimiter, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCliCommand, newerVersion, resolveExecutable } from './cli.mjs';

const PACKAGE = '@earendil-works/pi-coding-agent';
const DOCS = 'https://github.com/earendil-works/pi#readme';
const versionOf = text => String(text).trim().match(/^(?:pi\s+)?v?(\d+\.\d+\.\d+)$/)?.[1] || null;
const supportedNode = version => { const [major, minor] = String(version).replace(/^v/, '').split('.').map(Number); return major > 22 || major === 22 && minor >= 19; };
const conflict = message => Object.assign(new Error(message), { status: 409 });
const rootPath = (env, dataDir) => join(resolve(dataDir || env.ALCHEMY_DATA_DIR || fileURLToPath(new URL('../.local', import.meta.url))), 'runtime/cli/pi');
const contained = (root, path) => { const rel = relative(root, path); return rel && !rel.startsWith('..') && !rel.startsWith('/'); };
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

async function packageEntry(prefix, expectedVersion) {
  const root = join(prefix, 'node_modules', PACKAGE);
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (pkg.name !== PACKAGE || !versionOf(pkg.version) || expectedVersion && pkg.version !== expectedVersion || typeof pkg.bin?.pi !== 'string') throw Error('Pi 包信息不匹配。');
  const executable = await realpath(resolve(root, pkg.bin.pi));
  if (!contained(await realpath(root), executable)) throw Error('Pi 入口超出安装目录。');
  await access(executable, constants.X_OK);
  return { executable, resolved: executable, version: pkg.version };
}

export async function resolvePiExecutable(env = process.env, dataDir) {
  if (env.PI_BIN) return resolveExecutable(env.PI_BIN, env);
  const root = rootPath(env, dataDir);
  let pointer;
  try { pointer = JSON.parse(await readFile(join(root, 'current.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return resolveExecutable('pi', env); throw Error('Reframe 管理的 Pi 安装记录损坏，请检查本机安装。'); }
  try {
    if (!/^release-[a-zA-Z0-9]+$/.test(pointer.release) || !versionOf(pointer.version)) throw Error();
    const release = await realpath(join(root, pointer.release));
    if (!contained(await realpath(root), release)) throw Error();
    const entry = await packageEntry(release, pointer.version);
    return { ...entry, source: 'managed', node: process.execPath };
  } catch { throw Error('Reframe 管理的 Pi 安装记录损坏，请检查本机安装。'); }
}

export async function inspectPi({ env = process.env, dataDir, run = runCliCommand } = {}) {
  const located = await resolvePiExecutable(env, dataDir);
  if (!located) return { installed: false, version: null, executable: null, source: 'missing', reason: env.PI_BIN ? 'PI_BIN 指定的 Pi 不存在，请修正配置后重试。' : '未找到本机 Pi CLI。' };
  const { executable, resolved } = located;
  const info = { installed: true, version: null, executable, resolved, source: located.source || 'custom', reason: '请通过原安装方式更新 Pi。' };
  try { info.version = versionOf(await run(located.node || executable, located.node ? [executable, '--version'] : ['--version'], { env })); } catch {}
  if (!info.version) return { ...info, reason: 'Pi CLI 无法运行或版本无法识别，请检查原安装。' };
  if (located.source === 'managed') return { ...info, reason: undefined, manager: 'managed' };
  if (/\.app[\\/]Contents[\\/]/i.test(resolved)) return { ...info, source: 'app', reason: '请通过桌面 App 更新内置 Pi。' };
  const match = resolved.match(/^(.*)\/lib\/node_modules\/@earendil-works\/pi-coding-agent\//);
  if (match && process.platform !== 'win32') {
    const prefix = match[1];
    try {
      const entry = await packageEntry(join(prefix, 'lib'), info.version);
      if (entry.resolved !== resolved) return info;
      const searchEnv = { ...env, PATH: `${join(prefix, 'bin')}${delimiter}${env.PATH || ''}` };
      const npm = await resolveExecutable('npm', searchEnv), runtime = await resolveExecutable('node', searchEnv);
      if (!npm || !runtime || !await isNpmPackage(npm.resolved)) return info;
      const manager = npm.executable, node = runtime.executable;
      const managerEnv = { ...env, PATH: `${dirname(node)}${delimiter}${searchEnv.PATH}` };
      if (!supportedNode(await run(runtime.resolved, ['--version'], { env: managerEnv }))) return info;
      await access(join(prefix, 'lib/node_modules', PACKAGE), constants.W_OK);
      await access(join(prefix, 'lib/node_modules/@earendil-works'), constants.W_OK);
      const help = await run(runtime.resolved, [executable, 'update', '--help'], { env: cleanEnvironment(managerEnv, dataDir || rootPath(env)) }).catch(() => '');
      const nativeUpdate = help.includes('--self') && help.includes('--no-approve');
      let npmPrefixVerified = false;
      if (!nativeUpdate) {
        try { npmPrefixVerified = await realpath(await run(runtime.resolved, [npm.resolved, 'prefix', '--global'], { env: managerEnv })) === await realpath(prefix); } catch {}
      }
      return { ...info, source: 'npm', reason: nativeUpdate || npmPrefixVerified ? undefined : '旧版 Pi 的 npm prefix 与原安装不匹配，请通过原安装方式更新。',
        ...(nativeUpdate || npmPrefixVerified ? { manager } : {}), nativeUpdate, npmPrefixVerified,
        managerResolved: npm.resolved, nodeResolved: runtime.resolved, managerEnv, prefix, node };
    } catch {}
  }
  return info;
}

const sameNpmInstallation = (left, right) => ['executable', 'resolved', 'prefix', 'manager', 'managerResolved', 'node', 'nodeResolved'].every(key => left[key] === right[key]);

export async function latestPiRelease(fetcher = fetch) {
  const response = await fetcher('https://registry.npmjs.org/@earendil-works%2fpi-coding-agent/latest', { signal: AbortSignal.timeout(12_000), redirect: 'error' });
  if (!response.ok) throw Error('Pi 版本服务暂时不可用。');
  const body = await response.json();
  if (body.name !== PACKAGE || !versionOf(body.version)) throw Error('Pi 版本服务返回了无法识别的包或版本。');
  return body.version;
}

async function isNpmPackage(path) {
  try { return path.endsWith('/bin/npm-cli.js') && JSON.parse(await readFile(join(dirname(dirname(path)), 'package.json'), 'utf8')).name === 'npm'; }
  catch { return false; }
}

async function localRuntime(env) {
  if (!supportedNode(process.versions.node)) return null;
  const npm = await resolveExecutable('npm', { ...env, PATH: `${dirname(process.execPath)}${delimiter}${env.PATH || ''}` });
  if (!npm) return null;
  try {
    if (!await isNpmPackage(npm.resolved)) return null;
    return { node: process.execPath, npm: npm.resolved, version: process.versions.node };
  } catch { return null; }
}

// npm gets empty configuration and a private cache; neither credentials nor lifecycle scripts are needed.
function cleanEnvironment(env, directory) {
  const clean = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LANG'].filter(key => env[key]).map(key => [key, env[key]]));
  return { ...clean, PATH: env.PATH || dirname(process.execPath), HOME: directory, USERPROFILE: directory, PI_TELEMETRY: '0', PI_CODING_AGENT_DIR: join(directory, 'pi-home') };
}
const requiredFlags = ['--mode', '--print', '--no-tools', '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-themes', '--no-approve', '--offline', '--system-prompt', '--append-system-prompt', '--extension', '--tools', '--model', '--provider', '--thinking'];

// Bind installer ownership to the directory identity; names alone never authorize deletion.
async function directoryIdentity(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || await realpath(path) !== path) throw Error('Pi 安装目录已变化。');
  return `${info.dev}:${info.ino}`;
}
async function ownedRelease(root, pointer) {
  if (!/^release-[a-zA-Z0-9]+$/.test(pointer?.release) || !versionOf(pointer.version)) return;
  const path = join(root, pointer.release), identity = await directoryIdentity(path);
  const marker = join(path, '.reframe-managed.json');
  if (!(await lstat(marker)).isFile()) return;
  const owner = JSON.parse(await readFile(marker, 'utf8'));
  if (owner.package === PACKAGE && owner.release === pointer.release && owner.identity === identity) return { path, identity };
}

export function createPiCliManager({ env = process.env, dataDir, run = runCliCommand, latest = latestPiRelease,
  inspect = () => inspectPi({ env, dataDir, run }), verify = async options => (await import('./pi-agent.mjs')).verifyPiInstallation(options), runtime = () => localRuntime(env), onUpdated = async () => {}, now = Date.now } = {}) {
  let installation, node, checkedAt, latestVersion, checkError, operation, controller, closed = false, checking, inspectedAt = 0, lastAttempt;
  const view = () => {
    const canInstall = !installation?.installed && !env.PI_BIN && !!node && supportedNode(node.version) && !controller && !closed;
    const reason = installation?.source === 'missing' && !env.PI_BIN && (!node || !supportedNode(node.version)) ? '安装 Pi 需要 Node.js 22.19+ 和 npm，请先更新本机运行时。' : installation?.reason;
    return { installed: !!installation?.installed, version: installation?.version || null, executable: installation?.executable || null,
      source: installation?.source || 'missing', reason, detectedAt: inspectedAt ? new Date(inspectedAt).toISOString() : null,
      latestVersion: latestVersion || null, checkedAt, checkError, updateAvailable: newerVersion(latestVersion, installation?.version),
      canInstall, canUpdate: !!installation?.manager && newerVersion(latestVersion, installation.version) && !controller && !closed,
      comparisonReference: ['custom', 'app'].includes(installation?.source) ? 'npm-stable' : undefined,
      instructions: { url: DOCS, message: reason || '安装或更新后，请重新验证 Pi 模型。', ...(installation?.executable ? { loginCommand: quote(installation.executable) } : {}), ...(installation?.nativeUpdate ? { command: `${quote(installation.executable)} update --self --no-approve` } : {}) }, operation };
  };
  const discover = async () => { const next = await inspect(); if (installation && (next.executable !== installation.executable || next.source !== installation.source)) { latestVersion = null; checkedAt = undefined; lastAttempt = undefined; } installation = next; node = await runtime(); inspectedAt = now(); };
  const check = async () => {
    if (closed || controller) return view();
    checking ||= (async () => { await discover(); lastAttempt = now(); try { latestVersion = await latest(); if (!versionOf(latestVersion)) throw Error(); checkedAt = new Date(now()).toISOString(); checkError = undefined; } catch { latestVersion = null; checkError = '检查 Pi 更新失败，请检查网络后重试。'; } })().finally(() => { checking = undefined; });
    await checking; return view();
  };
  const begin = async install => {
    if (closed) throw conflict('本机服务已停止。');
    if (controller) throw conflict('Pi 正在安装或更新，请等待完成。');
    await check();
    if (closed || controller) throw conflict('Pi 正在安装或更新，或服务已停止。');
    if (!(install ? view().canInstall : view().canUpdate) || !latestVersion) throw conflict(checkError || view().reason || '当前没有可安装或更新的 Pi 版本。');
    controller = new AbortController();
    const signal = controller.signal, target = { ...installation }, requested = latestVersion;
    operation = { status: 'running', stage: install ? '正在安装 Pi…' : '正在更新 Pi…', startedAt: new Date(now()).toISOString() };
    void (async () => {
      let directory, candidateIdentity, activated = false, refreshStarted = false, npmStarted = false;
      try {
        await mkdir(rootPath(env, dataDir), { recursive: true, mode: 0o700 });
        const root = await realpath(rootPath(env, dataDir)), rootIdentity = await directoryIdentity(root);
        let previousPointer, previous, candidate;
        if (target.source === 'managed') {
          try {
            previousPointer = JSON.parse(await readFile(join(root, 'current.json'), 'utf8'));
            previous = await ownedRelease(root, previousPointer);
            if (previous && (await packageEntry(previous.path, target.version)).executable !== target.executable) previous = undefined;
          } catch { previous = undefined; } // Legacy or unproven directories stay untouched.
        }
        directory = await mkdtemp(join(root, 'release-'));
        candidateIdentity = await directoryIdentity(directory);
        await writeFile(join(directory, '.reframe-managed.json'), JSON.stringify({ package: PACKAGE, release: basename(directory), identity: candidateIdentity }), { mode: 0o600 });
        const childEnv = cleanEnvironment(target.managerEnv || { ...env, PATH: `${dirname(node.node)}${delimiter}${env.PATH || ''}` }, directory);
        await writeFile(join(directory, 'npm-user'), '', { mode: 0o600 }); await writeFile(join(directory, 'npm-global'), '', { mode: 0o600 });
        const npmArgs = ['install', ...(target.source === 'npm' ? ['--global'] : []), '--prefix', target.source === 'npm' ? target.prefix : directory, `${PACKAGE}@${requested}`,
          '--registry=https://registry.npmjs.org', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', '--save=false', '--engine-strict',
          `--userconfig=${join(directory, 'npm-user')}`, `--globalconfig=${join(directory, 'npm-global')}`, `--cache=${join(directory, 'npm-cache')}`];
        if (target.source === 'npm') {
          const current = await inspect();
          if ((!target.nativeUpdate && !target.npmPrefixVerified) || current.nativeUpdate !== target.nativeUpdate || current.npmPrefixVerified !== target.npmPrefixVerified || current.source !== 'npm' || !sameNpmInstallation(current, target)) throw Error('Pi 安装来源已变化，请重新检查。');
          const bin = join(directory, 'bin'); await mkdir(bin);
          await symlink(target.nodeResolved || target.node, join(bin, 'node')); await symlink(target.managerResolved || target.manager, join(bin, 'npm'));
          Object.assign(childEnv, { PATH: `${bin}${delimiter}/usr/bin${delimiter}/bin`,
            npm_config_registry: 'https://registry.npmjs.org', npm_config_ignore_scripts: 'true', npm_config_engine_strict: 'true',
            npm_config_audit: 'false', npm_config_fund: 'false', npm_config_userconfig: join(directory, 'npm-user'),
            npm_config_globalconfig: join(directory, 'npm-global'), npm_config_cache: join(directory, 'npm-cache') });
          signal.throwIfAborted(); npmStarted = true;
          await run(target.nodeResolved || target.node, target.nativeUpdate ? [target.executable, 'update', '--self', '--no-approve'] : [target.managerResolved || target.manager, ...npmArgs], { env: childEnv, cwd: directory, signal, timeout: 600_000 });
        } else await run(node.node, [node.npm, ...npmArgs], { env: childEnv, cwd: directory, signal, timeout: 600_000 });
        signal.throwIfAborted();
        operation.stage = '正在验证 Pi 安装…';
        if (target.source !== 'npm') {
          const entry = candidate = await packageEntry(directory, requested);
          const reported = versionOf(await run(node.node, [entry.executable, '--version'], { env: childEnv, cwd: directory, signal }));
          const help = await run(node.node, [entry.executable, '--help', '--offline', '--no-extensions', '--no-skills', '--no-context-files'], { env: childEnv, cwd: directory, signal });
          if (reported !== requested || !requiredFlags.every(flag => help.includes(flag)) || !/\brpc\b/.test(help)) throw Error('新 Pi 缺少 Reframe 所需的 CLI 接口，保留原安装。');
          await verify({ ...entry, node: node.node, env: childEnv, dir: directory, signal });
          const current = await inspect();
          if (current.executable !== target.executable || current.source !== target.source) throw Error('Pi 安装来源已变化，请重新检查。');
          signal.throwIfAborted();
          await writeFile(join(directory, 'activate.json'), JSON.stringify({ release: directory.split(/[\\/]/).at(-1), version: requested }), { mode: 0o600 });
          await rename(join(directory, 'activate.json'), join(root, 'current.json')); activated = true;
        }
        if (target.source === 'npm') {
          const reported = versionOf(await run(target.nodeResolved || target.node, [target.executable, '--version'], { env: childEnv, cwd: directory, signal }));
          const help = await run(target.nodeResolved || target.node, [target.executable, '--help', '--offline', '--no-extensions', '--no-skills', '--no-context-files'], { env: childEnv, cwd: directory, signal });
          if (reported !== requested || !requiredFlags.every(flag => help.includes(flag)) || !/\brpc\b/.test(help)) throw Error('更新后的 Pi 版本或 CLI 接口不符合预期，请检查原安装。');
          await verify({ executable: target.executable, node: target.nodeResolved || target.node, env: childEnv, dir: directory, signal });
        }
        await discover();
        if (installation.version !== requested || (target.source === 'npm' ? installation.source !== 'npm' || !sameNpmInstallation(installation, target) : installation.source !== 'managed' || installation.executable !== candidate.executable)) throw Error('更新后的 Pi 路径或版本不符合预期。');
        refreshStarted = true; await onUpdated();
        signal.throwIfAborted();
        if (activated) {
          try {
            const stillActive = async () => {
              signal.throwIfAborted();
              const pointer = JSON.parse(await readFile(join(root, 'current.json'), 'utf8'));
              if (await directoryIdentity(root) !== rootIdentity || await directoryIdentity(directory) !== candidateIdentity || pointer.release !== basename(directory) || pointer.version !== requested) throw Error('Pi 安装来源已变化。');
            };
            for (const name of ['npm-cache', 'npm-user', 'npm-global', 'pi-home', 'verification.json', 'verification-system.txt']) {
              await stillActive();
              const path = join(directory, name);
              const info = await lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
              if (!info) continue;
              if (info.isDirectory()) await directoryIdentity(path);
              else if (!info.isFile() || await realpath(path) !== path) throw Error('Pi 安装临时文件已变化。');
              await rm(path, { recursive: info.isDirectory(), force: true });
            }
            if (previous) {
              await stillActive();
              const owned = await ownedRelease(root, previousPointer).catch(() => undefined);
              if (owned?.identity === previous.identity && owned.path === previous.path && owned.path !== directory) await rm(owned.path, { recursive: true, force: true });
            }
          } catch (error) {
            if (signal.aborted) throw error;
            operation.cleanupWarning = 'Pi 已更新，部分安装缓存或旧版本未能清理。';
          }
        }
        operation = { ...operation, status: 'completed', stage: 'Pi 已就绪，请重新验证模型。', finishedAt: new Date(now()).toISOString() };
      } catch (error) {
        await discover().catch(() => {});
        if (!refreshStarted && (npmStarted || activated || installation?.version !== target.version || installation?.executable !== target.executable)) { try { await onUpdated(); } catch {} }
        operation = { ...operation, status: 'failed', stage: activated ? 'Pi 已安装，复检未完成' : 'Pi 安装或更新未完成', error: error.message, finishedAt: new Date(now()).toISOString() };
      } finally { if (directory && candidateIdentity && !activated && await directoryIdentity(directory).catch(() => undefined) === candidateIdentity) await rm(directory, { recursive: true, force: true }).catch(() => {}); controller = undefined; }
    })();
    return view();
  };
  return { get busy() { return !!controller; }, peek: () => installation ? view() : null,
    async status() { if (!controller && (!installation || now() - inspectedAt >= 10_000)) await discover(); if (!closed && !controller && installation?.version && (lastAttempt === undefined || now() - lastAttempt >= 86_400_000)) void check().catch(() => {}); return view(); },
    check, install: () => begin(true), update: () => begin(false), close() { closed = true; controller?.abort(); } };
}
