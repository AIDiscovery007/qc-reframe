import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { endianness, homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { connectionOrigins } from "../bridge/connection.mjs";
import { channels } from "../lib/channel.mjs";

const quote = value => `'${value.replaceAll("'", "'\"'\"'")}'`;

async function existingFile(path) {
  try {
    if (!(await lstat(path)).isFile()) throw new Error(`启动器路径冲突，保留原文件：${path}`);
    return await readFile(path, "utf8");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
}

async function writeRegistration(path, content, previous, mode) {
  if (content === previous) return;
  if (previous === undefined) return writeFile(path, content, { mode, flag: "wx" });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode, flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    // An exclusive-create collision is not our file to remove.
    if (error.code !== "EEXIST") await unlink(temporary).catch(cleanupError => {
      if (cleanupError.code !== "ENOENT") throw new AggregateError([error, cleanupError], "Native launcher update and temporary-file cleanup failed");
    });
    throw error;
  }
}

// Per-browser Native Messaging folders under the macOS application-support root.
export const launcherBrowsers = { chrome: { label: "Chrome", profile: "Google/Chrome" }, codex: { label: "Codex", profile: "OpenAI/Codex" } };
// ALCHEMY_APP_SUPPORT_DIR stands in for ~/Library/Application Support, only for isolated tests.
const supportRoot = () => resolve(process.env.ALCHEMY_APP_SUPPORT_DIR || join(homedir(), "Library/Application Support"));
const supported = () => process.platform !== "win32" && (!!process.env.ALCHEMY_APP_SUPPORT_DIR || process.platform === "darwin");
// Each channel registers under its own host name, so the release and dev launchers never replace each other.
const registrationPath = (browser, { hostName }) => join(supportRoot(), launcherBrowsers[browser].profile, "NativeMessagingHosts", `${hostName}.json`);

// A QC-Reframe registration whose launcher file is gone belongs to a deleted or moved installation
// and can start nothing, so registering this installation may replace it.
async function abandonedRegistration(manifest, { hostName }) {
  if (manifest?.name !== hostName || manifest.type !== "stdio" || typeof manifest.path !== "string" || !isAbsolute(manifest.path)) return false;
  try { await lstat(manifest.path); return false; }
  catch (error) { if (error.code === "ENOENT" || error.code === "ENOTDIR") return true; throw error; }
}

async function ownedRegistration(path, executable, { hostName }) {
  const text = await existingFile(path);
  if (text === undefined) return false;
  try { const manifest = JSON.parse(text); return manifest?.name === hostName && manifest.type === "stdio" && manifest.path === executable; }
  catch { return false; }
}

export async function registerLauncher({ root, dataDir, port, env, uninstall, browser, channel = channels.release }) {
  if (!Object.hasOwn(launcherBrowsers, browser) || !supported())
    throw new Error(`此平台或浏览器尚不支持按需启动器；请手动运行 ${channel.commands.start}。目前支持 macOS 的 Chrome 与 Codex。`);
  const { hostName } = channel;
  const manifestPath = registrationPath(browser, channel);
  const directory = dirname(manifestPath);
  const executable = join(dataDir, "runtime", channel.launcherFile);
  const owner = `# QC-Reframe installation: ${JSON.stringify(root)}\n`;
  const current = await existingFile(manifestPath);
  const launcher = await existingFile(executable);
  if (current !== undefined) {
    let manifest;
    try { manifest = JSON.parse(current); } catch { /* Invalid registrations belong to someone else. */ }
    const owned = manifest?.name === hostName && manifest.type === "stdio" && manifest.path === executable && launcher?.startsWith(`#!/bin/sh\n${owner}`);
    // Uninstall removes only this installation's own registration; an abandoned foreign one stays.
    if (!owned && (uninstall || !await abandonedRegistration(manifest, channel)))
      throw new Error("本机启动器注册属于另一份安装或存在冲突，未覆盖或删除。请从原安装目录撤销。");
  }
  if (launcher !== undefined && !launcher.startsWith(`#!/bin/sh\n${owner}`))
    throw new Error("本机启动器文件属于其他安装，未覆盖或删除。");
  if (uninstall) {
    if (current !== undefined) await unlink(manifestPath);
    // The executable is shared; keep it while another browser's registration still points to it.
    const others = await Promise.all(Object.keys(launcherBrowsers).filter(other => other !== browser).map(other => ownedRegistration(registrationPath(other, channel), executable, channel)));
    if (launcher !== undefined && !others.includes(true)) await unlink(executable);
    return;
  }
  const manifest = JSON.parse(await readFile(join(root, channel.outputDir, "manifest.json"), "utf8"));
  const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (manifest.version !== version) throw new Error(`扩展构建与当前版本不同，请先运行 ${channel.commands.setup}。`);
  const origins = [...connectionOrigins(env.ALCHEMY_EXTENSION_ID, channel)].map(origin => `${origin}/`);
  // The browser's PATH, Node options and ALCHEMY_* variables are not authority.
  // Capture only installation configuration, never account credentials or tokens.
  // USER lets Claude Code find its macOS keychain login; it is an account name, not a credential.
  const keys = ["HOME", "USER", "PATH", "TMPDIR", "LANG", "CODEX_HOME", "CODEX_BIN", "PI_BIN", "CLAUDE_BIN", "CLAUDE_CONFIG_DIR", "ALCHEMY_SKILL_PATH", "IMAGEGEN_SKILL_PATH", "ALCHEMY_EXTENSION_ID"];
  const fixed = { ...Object.fromEntries(keys.filter(key => typeof env[key] === "string").map(key => [key, env[key]])), ALCHEMY_DATA_DIR: dataDir, ALCHEMY_PORT: String(port),
    // Only the dev launcher names its channel; the release launcher keeps its earlier form.
    ...(channel.name === "release" ? {} : { ALCHEMY_CHANNEL: channel.name }) };
  const command = ["/usr/bin/env", "-i", ...Object.entries(fixed).map(([key, value]) => `${key}=${value}`), process.execPath, join(root, "scripts/manage.mjs"), "native-host", JSON.stringify(origins)];
  const script = `#!/bin/sh\n${owner}exec ${command.map(quote).join(" ")} "$@"\n`;
  const registration = JSON.stringify({ name: hostName, description: `Start this ${channel.shortName} installation on demand`, path: executable, type: "stdio", allowed_origins: origins }, null, 2) + "\n";
  await mkdir(join(dataDir, "runtime"), { recursive: true, mode: 0o700 });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // Exclusive creation prevents a conflicting installation from being overwritten.
  // Owned updates replace each file atomically after both ownership checks above.
  await writeRegistration(executable, script, launcher, 0o700);
  await writeRegistration(manifestPath, registration, current, 0o600);
}

function readRequest(signal) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const finish = (error, value) => {
      process.stdin.off("data", data);
      process.stdin.off("end", end);
      process.stdin.off("error", fail);
      process.stdin.pause();
      signal.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(value);
    };
    const fail = error => finish(error);
    const end = () => fail(new Error("启动器请求不完整，未启动服务。"));
    const abort = () => fail(signal.reason);
    const data = chunk => {
      if (buffer.length + chunk.length > 1028) return fail(new Error("启动器请求过大，未启动服务。"));
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const size = buffer[endianness() === "LE" ? "readUInt32LE" : "readUInt32BE"](0);
      if (!size || size > 1024 || buffer.length > size + 4) return fail(new Error("启动器帧长度无效，未启动服务。"));
      if (buffer.length < size + 4) return;
      try {
        const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(4)));
        if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1 || value.action !== "ensure-start")
          throw new Error("启动器只接受 ensure-start 请求，未启动服务。");
        finish(undefined, value);
      } catch (error) { fail(new Error(`启动器请求无效：${error instanceof SyntaxError || error instanceof TypeError ? "需要有效 UTF-8 JSON。" : error.message}`)); }
    };
    process.stdin.on("data", data);
    process.stdin.once("end", end);
    process.stdin.once("error", fail);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

export async function serveNative(start) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("本机启动器超时，请检查启动锁或手动运行 npm start。")), 9000);
  let response;
  try {
    const origins = JSON.parse(process.argv[3]);
    if (!Array.isArray(origins) || origins.some(origin => !/^chrome-extension:\/\/[a-p]{32}\/$/.test(origin))
      || process.argv.length !== 5 || !origins.includes(process.argv[4])) throw new Error("本机启动器拒绝未批准的扩展来源。");
    await readRequest(controller.signal);
    controller.signal.throwIfAborted();
    await start(controller.signal);
    response = { ok: true };
  } catch (error) { response = { ok: false, error: controller.signal.aborted ? controller.signal.reason.message : error.message }; }
  finally { clearTimeout(timer); }
  const body = Buffer.from(JSON.stringify(response));
  const header = Buffer.alloc(4);
  header[endianness() === "LE" ? "writeUInt32LE" : "writeUInt32BE"](body.length);
  await new Promise(resolve => process.stdout.write(Buffer.concat([header, body]), resolve));
  process.stdin.destroy();
}

/** Setup's default: register every supported browser that has a profile here; report, never fail setup. */
export async function registerInstalledLaunchers(options) {
  if (!supported()) return [];
  const results = [];
  for (const [browser, { label, profile }] of Object.entries(launcherBrowsers)) {
    try { if (!(await stat(join(supportRoot(), profile))).isDirectory()) continue; }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    try { await registerLauncher({ ...options, browser, uninstall: false }); results.push({ browser, label, ok: true }); }
    catch (error) { results.push({ browser, label, ok: false, error: error.message }); }
  }
  return results;
}
