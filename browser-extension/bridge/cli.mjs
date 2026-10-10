import { spawn } from "node:child_process";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";

const conflict = (message) => Object.assign(new Error(message), { status: 409 });
const parseVersion = (text) => String(text).trim().match(/^(?:codex(?:-cli)?\s+)?(\d+\.\d+\.\d+(?:-[\w.-]+)?)$/)?.[1] || null;
const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
export function newerVersion(latest, current) {
  const a = parseVersion(latest), b = parseVersion(current);
  if (!a || !b) return false;
  const numbers = a.split(/[.-]/).slice(0, 3).map(Number), other = b.split(/[.-]/).slice(0, 3).map(Number);
  for (let i = 0; i < 3; i++) if (numbers[i] !== other[i]) return numbers[i] > other[i];
  return !a.includes("-") && b.includes("-");
}

// Never forward subprocess output on failure: user package-manager configuration may contain credentials.
export function runCliCommand(file, args, { env = process.env, signal, cwd, timeout = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("操作已停止。"));
    const proc = spawn(file, args, { env, cwd, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let stdout = "", failure;
    const stop = (message) => {
      failure ||= new Error(message);
      try { process.platform === "win32" ? proc.kill("SIGKILL") : process.kill(-proc.pid, "SIGKILL"); } catch {}
    };
    const abort = () => stop("操作已停止。");
    const timer = setTimeout(() => stop("命令执行超时，请检查网络与本机安装状态。"), timeout);
    signal?.addEventListener("abort", abort, { once: true });
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", chunk => {
      stdout += chunk;
      if (stdout.length > 256 * 1024) stop("本机命令返回过多数据，请在终端检查安装。");
    });
    proc.on("error", error => { failure = new Error(error.code === "EACCES" ? "没有执行权限，请检查本机安装权限。" : "无法启动本机命令，请检查安装。"); });
    proc.on("close", code => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (failure || code !== 0) reject(failure || new Error(`本机命令执行失败（${code}），请在终端检查安装。`));
      else resolve(stdout.trim());
    });
  });
}

export async function resolveCodexExecutable(env = process.env) {
  return resolveExecutable(env.CODEX_BIN || "codex", env);
}

export async function resolveExecutable(binary, env = process.env) {
  const candidates = /[/\\]/.test(binary) ? [resolve(binary)] : (env.PATH || "").split(delimiter).filter(Boolean).map(dir => join(dir, binary));
  for (const executable of candidates) {
    try {
      await access(executable, constants.X_OK);
      if (!(await stat(executable)).isFile()) continue;
      return { executable, resolved: await realpath(executable) };
    } catch {}
  }
  return null;
}

export async function inspectCodex({ env = process.env, run = runCliCommand } = {}) {
  const located = await resolveCodexExecutable(env);
  if (!located) return { installed: false, version: null, executable: null, source: "missing", reason: "未找到本机 Codex CLI，请先安装，或检查 CODEX_BIN。" };
  const { executable, resolved } = located;
  const info = { installed: true, version: null, executable, source: "custom", reason: "此安装来源无法安全自动升级，请通过原安装方式更新。" };
  try { info.version = parseVersion(await run(executable, ["--version"], { env })); }
  catch { info.reason = "Codex CLI 无法运行，请检查安装与执行权限。"; }
  if (!info.version) info.reason = "Codex CLI 无法运行或版本无法识别，请通过原安装方式检查。";
  if (/\.app[\\/]Contents[\\/]/i.test(resolved)) return { ...info, source: "app", reason: "当前使用桌面 App 内置 Codex，请通过该 App 更新。" };
  if (process.platform === "win32") return info;
  const standalone = resolved.match(/^(.*)\/packages\/standalone\/releases\/([^/]+)\/bin\/codex$/);
  if (standalone) {
    try {
      const pkg = JSON.parse(await readFile(join(dirname(dirname(resolved)), "codex-package.json"), "utf8"));
      if (pkg.layoutVersion === 1 && pkg.variant === "codex" && pkg.entrypoint === "bin/codex" && pkg.version === info.version && standalone[2] === `${pkg.version}-${pkg.target}`) {
        const detected = { ...info, source: "standalone", reason: "当前使用独立安装版，请通过 codex update 更新。" };
        if (executable === resolved || executable.startsWith(`${standalone[1]}/packages/standalone/releases/`))
          return { ...detected, reason: "当前固定到某个版本文件，请将 CODEX_BIN 改为安装器创建的 codex 入口后更新。" };
        const help = await run(executable, ["update", "--help"], { env });
        if (/Usage:\s+codex update\b/.test(help)) return { ...detected, reason: undefined, manager: executable,
          managerEnv: { ...env, CODEX_HOME: standalone[1], CODEX_INSTALL_DIR: dirname(executable), CODEX_NON_INTERACTIVE: "1" } };
        return detected;
      }
    } catch { /* An incomplete package must not be treated as a managed installation. */ }
    return info;
  }
  const cask = resolved.match(/^(.*)\/Caskroom\/codex\//);
  if (cask) {
    const manager = join(cask[1], "bin/brew");
    try {
      if (await realpath((await run(manager, ["--prefix"], { env })).trim()) === await realpath(cask[1]))
        return { ...info, source: "homebrew", reason: info.version ? undefined : info.reason, manager, managerEnv: env };
    } catch {}
    return info;
  }
  const npm = resolved.match(/^(.*)\/lib\/node_modules\/@openai\/codex\//);
  if (npm) {
    const prefix = npm[1], manager = join(prefix, "bin/npm"), node = join(prefix, "bin/node");
    try {
      await access(node, constants.X_OK);
      const pkg = JSON.parse(await readFile(join(prefix, "lib/node_modules/@openai/codex/package.json"), "utf8"));
      const managerEnv = { ...env, PATH: `${join(prefix, "bin")}${delimiter}${env.PATH || ""}` };
      if (pkg.name === "@openai/codex" && await realpath(await run(manager, ["prefix", "--global"], { env: managerEnv })) === await realpath(prefix))
        return { ...info, source: "npm", reason: info.version ? undefined : info.reason, manager, managerEnv, prefix };
    } catch {}
  }
  return info;
}

export async function latestRelease(source, fetcher = fetch) {
  const url = source === "standalone" ? "https://api.github.com/repos/openai/codex/releases/latest"
    : source === "homebrew" ? "https://formulae.brew.sh/api/cask/codex.json" : "https://registry.npmjs.org/@openai%2fcodex/latest";
  const response = await fetcher(url, { signal: AbortSignal.timeout(12_000), redirect: "error" });
  if (!response.ok) throw new Error("版本服务暂时不可用，请稍后重试。");
  const body = await response.json();
  const version = parseVersion(source === "standalone" ? (!body.prerelease && !body.draft ? String(body.tag_name).replace(/^rust-v/, "") : null) : body.version);
  if (!version) throw new Error("版本服务返回了无法识别的版本号。");
  return version;
}

export function createCliManager({ inspect = inspectCodex, run = runCliCommand, latest = latestRelease, onUpdated = async () => {}, now = Date.now } = {}) {
  let installation, inspectedAt = 0, inspection, checking, checkedAt, latestVersion = null, checkError, operation, controller, lastAttempt = 0, closed = false;
  const view = () => {
    const command = !installation?.manager ? null : installation.source === "standalone" ? `${quote(installation.executable)} update` : installation.source === "homebrew"
      ? `${quote(installation.manager)} update && ${quote(installation.manager)} upgrade --cask codex`
      : `${quote(installation.manager)} install --global --prefix ${quote(installation.prefix)} @openai/codex@latest --registry=https://registry.npmjs.org`;
    return { installed: installation?.installed || false, version: installation?.version || null,
    executable: installation?.executable || null, source: installation?.source || "missing", reason: installation?.reason,
    detectedAt: inspectedAt ? new Date(inspectedAt).toISOString() : null,
    command,
    comparisonReference: ["app", "custom"].includes(installation?.source) ? "npm-stable" : undefined,
    instructions: { url: "https://developers.openai.com/codex/cli/", ...(command ? { command } : {}),
      ...(installation?.executable ? { loginCommand: `${quote(installation.executable)} login` } : {}),
      message: installation?.source === "app" ? "请通过桌面 App 检查更新。稳定版 CLI 仅供版本比较，不代表此 App 可升级。"
        : installation?.reason || "使用当前安装来源升级后，重新检查并验证模型。" },
    latestVersion, checkedAt, checkError, updateAvailable: newerVersion(latestVersion, installation?.version),
    canUpdate: !!installation?.manager && !!installation.version && newerVersion(latestVersion, installation.version) && !controller,
    operation };
  };
  const discover = async (force = false) => {
    if (!force && installation && now() - inspectedAt < 10_000) return;
    inspection ||= inspect().then(next => {
      if (installation && (installation.executable !== next.executable || installation.source !== next.source)) { latestVersion = null; checkedAt = undefined; checkError = undefined; lastAttempt = 0; }
      installation = next; inspectedAt = now();
    }).finally(() => { inspection = undefined; });
    await inspection;
  };
  const check = async (rediscover = true) => {
    if (controller || closed) return view();
    const previousOperation = operation;
    checking ||= (async () => {
      if (rediscover) await discover(true);
      if (!installation.installed || !installation.version) return view();
      lastAttempt = now();
      try { latestVersion = await latest(installation.source); checkedAt = new Date().toISOString(); checkError = undefined; }
      catch { checkError = "检查更新失败，请检查网络后重试。"; latestVersion = null; }
      return view();
    })().finally(() => { checking = undefined; });
    await checking;
    if (rediscover && !controller && operation === previousOperation && operation?.status !== "running") operation = undefined;
    return view();
  };
  return {
    get busy() { return !!controller; },
    peek: () => installation ? view() : null,
    async status() {
      if (!controller) await discover();
      if (!closed && !controller && installation?.installed && installation.version && (!lastAttempt || now() - lastAttempt >= 86_400_000)) void check(false).catch(() => {});
      return view();
    },
    check,
    async update() {
      if (closed) throw conflict("本机服务已停止，请重新启动后再试。");
      if (controller) throw conflict("Codex 正在升级，请等待完成。");
      await check();
      if (closed) throw conflict("本机服务已停止，请重新启动后再试。");
      if (controller) throw conflict("Codex 正在升级，请等待完成。");
      if (!view().canUpdate) throw conflict(checkError || installation.reason || "当前没有可升级的版本，请先检查更新。");
      controller = new AbortController();
      const signal = controller.signal, target = { ...installation }, requestedVersion = latestVersion;
      operation = { status: "running", stage: "正在升级 Codex…", startedAt: new Date().toISOString() };
      void (async () => {
        let refreshStarted = false, upgraded = false;
        try {
          const options = { env: target.managerEnv, signal, timeout: 10 * 60_000 };
          if (target.source === "standalone") await run(target.executable, ["update"], options);
          else if (target.source === "homebrew") {
            await run(target.manager, ["update"], options);
            await run(target.manager, ["upgrade", "--cask", "codex"], options);
          } else await run(target.manager, ["install", "--global", "--prefix", target.prefix, "@openai/codex@latest", "--registry=https://registry.npmjs.org"], options);
          operation.stage = "正在检查升级结果与刷新模型…";
          await discover(true);
          if (installation.executable !== target.executable || installation.source !== target.source || !installation.version || newerVersion(requestedVersion, installation.version) || installation.version === target.version)
            throw new Error("升级后的 Codex 路径或版本不符合预期，请检查原安装；未切换到其他 CLI。");
          upgraded = true;
          refreshStarted = true;
          await onUpdated();
          operation = { ...operation, status: "completed", stage: "升级完成，请重新验证模型。", finishedAt: new Date().toISOString() };
        } catch (error) {
          // Package managers can fail after replacing files; discard model trust in that case too.
          await discover(true).catch(() => {});
          let recoveryError;
          if (!refreshStarted && (installation?.version !== target.version || installation?.executable !== target.executable)) {
            try { await onUpdated(); } catch (failure) { recoveryError = failure; }
          }
          operation = { ...operation, status: "failed", stage: upgraded ? "Codex 已升级，复检未完成" : "升级未完成",
            error: `${error.message}${recoveryError ? `；复检失败：${recoveryError.message}` : ""}`, finishedAt: new Date().toISOString() };
        } finally { controller = undefined; }
      })();
      return view();
    },
    close() { closed = true; controller?.abort(); },
  };
}
