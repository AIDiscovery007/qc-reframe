// Local lifecycle commands. No model calls, browser-profile edits, or global config writes.
import { access, mkdir, open, readFile, rmdir, writeFile, rename } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { storagePaths, ensureStorage, migrateStorage, moveLegacyFile, readStoredConfig, rotateServiceLog } from "../bridge/storage.mjs";
import { connectionOrigins } from "../bridge/connection.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = resolve(process.env.ALCHEMY_DATA_DIR || join(root, ".local"));
const paths = storagePaths(dataDir);
const configFile = paths.settings;
const port = Number(process.env.ALCHEMY_PORT || 43187);
const url = `http://127.0.0.1:${port}`;
const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const runtimeKeys = ["CODEX_BIN", "PI_BIN", "ALCHEMY_SKILL_PATH", "IMAGEGEN_SKILL_PATH", "ALCHEMY_EXTENSION_ID"];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const readable = async path => { try { await access(path); return true; } catch { return false; } };
const cliCommand = path => process.platform === "win32" ? `& '${path.replaceAll("'", "''")}'` : `'${path.replaceAll("'", "'\"'\"'")}'`;

async function environment() {
  let saved = {};
  const stored = await readStoredConfig(dataDir, "runtime.json");
  if (stored !== undefined) saved = JSON.parse(stored);
  const env = { ...process.env };
  for (const key of runtimeKeys) if (!env[key] && typeof saved[key] === "string") env[key] = saved[key];
  env.ALCHEMY_SKILL_PATH ||= join(root, ".agents/skills/alchemy/SKILL.md");
  env.IMAGEGEN_SKILL_PATH ||= join(env.CODEX_HOME || join(homedir(), ".codex"), "skills/.system/imagegen/SKILL.md");
  return env;
}

async function checkSkill(env) {
  const skill = await readFile(env.ALCHEMY_SKILL_PATH, "utf8");
  if (!/^name:\s*alchemy\s*$/m.test(skill)) throw new Error("Alchemy skill 缺失或名称不匹配，请重新获取完整仓库。");
  for (const match of skill.matchAll(/\]\((references\/[^)]+)\)/g))
    if (!await readable(resolve(dirname(env.ALCHEMY_SKILL_PATH), match[1]))) throw new Error(`Alchemy skill 缺少 ${match[1]}`);
}

async function doctor(env, maintenance = false) {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 15)) throw new Error("需要 Node.js 22.15+，请先安装受支持的 Node.js LTS。");
  const candidates = env.CODEX_BIN ? [env.CODEX_BIN] : [
    ...(env.PATH || "").split(delimiter).filter(Boolean).map(dir => join(dir, process.platform === "win32" ? "codex.exe" : "codex")),
    ...["/Applications", join(homedir(), "Applications")].flatMap(dir =>
      ["Codex.app", "ChatGPT.app"].map(app => join(dir, app, "Contents/Resources/codex"))),
  ];
  let found = false;
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); } catch { continue; }
    const check = spawnSync(candidate, ["--version"], { encoding: "utf8", timeout: 10000 });
    if (check.status === 0 && /codex/i.test(check.stdout)) { env.CODEX_BIN = candidate; found = true; break; }
  }
  let cliIssue;
  if (!found) cliIssue = `找不到 Codex CLI${env.CODEX_BIN ? `（配置路径：${cliCommand(env.CODEX_BIN)}）` : ""}。请按官方说明 https://developers.openai.com/codex/cli 安装并登录，或用 CODEX_BIN 指定可执行文件的绝对路径后重新运行 npm run setup。`;
  else {
    const command = cliCommand(env.CODEX_BIN);
    const login = spawnSync(env.CODEX_BIN, ["login", "status"], { env, encoding: "utf8", timeout: 15000 });
    const cli = spawnSync(env.CODEX_BIN, ["app-server", "--help"], { env, encoding: "utf8", timeout: 10000 });
    if (login.status !== 0) cliIssue = `Codex 尚未登录或 CLI 无法运行。请运行 ${command} login 完成登录，再用 ${command} login status 复查。`;
    else if (cli.status !== 0) cliIssue = `此 Codex CLI 不支持 app-server，请在设置中心检查并按原安装方式升级，再用 ${command} --version 复查实际版本。`;
  }
  if (cliIssue && !maintenance) throw new Error(cliIssue);
  if (cliIssue) console.warn(`CLI 待处理，Reframe 初始化和本机管理仍可继续：${cliIssue}\n扩展自动连接后，请在插件模型中检查 Agent CLI、选择并验证模型，再开始逆向或生图。`);
  await checkSkill(env);
  const imagegen = await readable(env.IMAGEGEN_SKILL_PATH);
  console.log(`QC-Reframe ${version}\nNode.js ${process.versions.node}\nCodex CLI：${cliIssue ? "需要处理，请在设置中心检查" : "已登录"}\nAlchemy skill：就绪\n插件模型：在设置中心选择 Agent 并验证模型\nimagegen：${imagegen ? "已找到（实际生图能力以账户和模型为准）" : "未找到；可逆向提示词，Codex 内置生图前需配置 IMAGEGEN_SKILL_PATH，也可在设置中选择 API 生图"}`);
  return env;
}

async function token() {
  return (await readStoredConfig(dataDir, "token"))?.trim() || "";
}

async function probe() {
  let response;
  try {
    response = await fetch(`${url}/health`, { headers: { Authorization: `Bearer ${await token()}` }, signal: AbortSignal.timeout(1500) });
  } catch (error) {
    if (error.cause?.code === "ECONNREFUSED") return null;
    throw new Error(`无法确认 ${url} 的状态，未启动或停止任何现有服务。`);
  }
  if (!response.ok) throw new Error(`端口 ${port} 已被其他服务或另一份 QC-Reframe 安装占用，未改动现有服务。`);
  const health = await response.json();
  if (health.service !== "qc-alchemy") throw new Error(`端口 ${port} 已占用；可能是旧版服务，请先从原终端停止它。`);
  return health;
}

function connectionInfo() {
  console.log(`\n服务：${url}\n扩展目录：${join(root, ".output/chrome-mv3")}\n数据目录：${dataDir}\n连接：从上述目录加载的扩展会自动连接，无需填写配对码。\n首次加载说明：${join(root, "docs/INSTALL_WITH_CODEX.md")}\n检查：npm run status　停止：npm stop`);
}

async function start(env) {
  const existing = await probe();
  if (existing) {
    if (existing.version !== version) throw new Error(`已运行 ${existing.version}，当前文件为 ${version}。请先停止旧服务，再运行 npm start。`);
    if (!existing.ready) throw new Error("服务已运行，但 Alchemy skill 未就绪。请先停止服务并运行 npm run doctor。");
    console.log("本机服务已运行，复用现有服务和配对码。");
    connectionInfo();
    return;
  }
  const release = await prepareStart(env);
  try { await launch(env); } finally { await release(); }
}

// Hold the startup lock from preflight through handoff; neither path reacquires it.
async function prepareStart(env, checkCli = true) {
  const manifest = JSON.parse(await readFile(join(root, ".output/chrome-mv3/manifest.json"), "utf8"));
  if (manifest.version !== version) throw new Error("扩展构建与当前版本不同，请先运行 npm run setup。");
  if (checkCli) await doctor(env, true);
  else await checkSkill(env);
  await ensureStorage(dataDir);
  const lock = join(paths.runtime, "start.lock");
  try { await mkdir(lock); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error(`另一个启动操作尚未结束。如上次启动被中断，确认没有启动操作后移除 ${lock} 空目录再重试。`);
    throw error;
  }
  try {
    if (await readable(join(dataDir, "start.lock"))) throw new Error("旧版启动锁仍存在，请确认旧启动命令已结束后移除数据目录根部的 start.lock 空目录。");
    await access(join(root, "bridge/server.mjs"), constants.R_OK);
  } catch (error) { await rmdir(lock); throw error; }
  return () => rmdir(lock);
}

async function launch(env) {
  let child;
  try {
    await migrateStorage(dataDir);
    await rotateServiceLog(paths.log);
    const log = await open(paths.log, "a", 0o600);
    try {
      child = spawn(process.execPath, [join(root, "bridge/server.mjs")], {
        cwd: root, env: { ...env, ALCHEMY_DATA_DIR: dataDir, ALCHEMY_MANAGED: "1" },
        detached: true, windowsHide: true, stdio: ["ignore", log.fd, log.fd],
      });
      await once(child, "spawn");
    } finally { await log.close(); }
    for (let i = 0; i < 32; i++) {
      await sleep(250);
      if (child.exitCode !== null) throw new Error(`服务启动失败，请查看 ${paths.log}。`);
      const health = await probe();
      if (health?.ready && health.version === version && health.managed) {
        child.unref();
        console.log("本机服务已在后台启动，关闭本终端后仍可使用。");
        connectionInfo();
        return;
      }
    }
    throw new Error(`服务未按时就绪，请查看 ${paths.log}。`);
  } catch (error) { child?.kill(); throw error; }
}

async function main() {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("ALCHEMY_PORT 无效。");
  const command = process.argv[2];
  const env = await environment();
  if (["setup", "start", "run", "restart-after"].includes(command))
    connectionOrigins(join(root, ".output/chrome-mv3"), env.ALCHEMY_EXTENSION_ID);
  if (command === "restart-after") {
    if (!process.send || !process.argv[3] || !process.env.ALCHEMY_RESTART_ID) throw new Error("重启必须从已连接的插件发起。");
    const cancelled = new AbortController();
    const cancel = () => cancelled.abort();
    process.once("SIGTERM", cancel);
    process.once("disconnect", cancel);
    let release;
    try {
      // The running service already supplies its CLI environment; do not run slow CLI probes again.
      release = await prepareStart(env, false);
      cancelled.signal.throwIfAborted();
      const confirmed = once(process, "message", { signal: AbortSignal.any([cancelled.signal, AbortSignal.timeout(5000)]) });
      process.send("ready");
      const [message] = await confirmed;
      if (message !== "restart") throw new Error("重启未确认。");
      process.removeListener("disconnect", cancel);
      process.disconnect();
      for (let i = 0; i < 100; i++) {
        cancelled.signal.throwIfAborted();
        const health = await probe();
        if (!health) return await launch(env);
        if (health.instanceId !== process.argv[3]) throw new Error("服务实例已变化，未替换其他服务。");
        await sleep(100);
      }
      throw new Error("原服务未按时停止，请运行 npm run status 检查。");
    } finally {
      process.removeListener("SIGTERM", cancel);
      process.removeListener("disconnect", cancel);
      if (process.connected) process.disconnect();
      if (release) await release();
    }
  }
  if (command === "doctor") return doctor(env);
  if (command === "pair") {
    const value = await token();
    if (!value) throw new Error("尚未初始化配对码，请先运行 npm start。");
    console.log(value);
    return;
  }
  if (command === "status") {
    const health = await probe();
    console.log(health ? JSON.stringify(health, null, 2) : "本机服务未运行。运行 npm start 启动。");
    if (!health?.ready) process.exitCode = 1;
    return;
  }
  if (command === "stop") {
    const health = await probe();
    if (!health) { console.log("本机服务已停止。"); return; }
    if (!health.managed) throw new Error("此服务由原终端启动，请在原终端按 Ctrl+C 停止。");
    const response = await fetch(`${url}/shutdown`, {
      method: "POST", headers: { Authorization: `Bearer ${await token()}` }, signal: AbortSignal.timeout(5000),
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || "停止失败");
    for (let i = 0; i < 20; i++) { if (!await probe()) { console.log("本机服务已停止，配对码和项目数据保留。"); return; } await sleep(100); }
    throw new Error("停止请求已发送，但服务尚未退出，请检查 npm run status。");
  }
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  if (command === "setup") {
    await doctor(env, true);
    if (!process.env.npm_execpath) throw new Error("请使用 npm run setup 执行初始化。");
    for (const args of [["ci"], ["run", "build"]]) {
      const run = spawnSync(process.execPath, [process.env.npm_execpath, ...args], { cwd: root, env, stdio: "inherit" });
      if (run.status !== 0) throw new Error(`npm ${args.join(" ")} 失败，请修复后重试。`);
    }
    await ensureStorage(dataDir);
    await moveLegacyFile(join(dataDir, "runtime.json"), configFile);
    await writeFile(`${configFile}.tmp`, JSON.stringify(Object.fromEntries(runtimeKeys.map(key => [key, env[key]])), null, 2) + "\n", { mode: 0o600 });
    await rename(`${configFile}.tmp`, configFile);
    console.log("初始化完成。运行 npm start 启动；首次在浏览器加载扩展后会自动连接。");
    return;
  }
  if (command === "start") return start(env);
  if (command === "run") {
    await doctor(env, true);
    const child = spawn(process.execPath, [join(root, "bridge/server.mjs")], { cwd: root, env, stdio: "inherit" });
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => child.kill(signal));
    const [code] = await once(child, "exit");
    process.exitCode = code || 0;
    return;
  }
  throw new Error("使用 npm run setup / doctor / status / pair，或 npm start / stop。");
}

try { await main(); }
catch (error) { console.error(`QC-Reframe：${error.message}`); process.exitCode = 1; }
