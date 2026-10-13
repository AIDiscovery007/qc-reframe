import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { endianness, homedir } from "node:os";
import { join, resolve } from "node:path";
import { connectionOrigins } from "../bridge/connection.mjs";

const hostName = "com.qc.reframe";
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

export async function registerLauncher({ root, dataDir, port, env, uninstall, browser }) {
  if (browser !== "codex" || process.platform === "win32" || (!process.env.ALCHEMY_NATIVE_HOST_DIR && process.platform !== "darwin"))
    throw new Error("此平台或浏览器尚不支持按需启动器；请手动运行 npm start。首轮仅支持 macOS Codex。");
  const directory = resolve(process.env.ALCHEMY_NATIVE_HOST_DIR || join(homedir(), "Library/Application Support/OpenAI/Codex/NativeMessagingHosts"));
  const manifestPath = join(directory, `${hostName}.json`);
  const executable = join(dataDir, "runtime", "native-launcher");
  const owner = `# QC-Reframe installation: ${JSON.stringify(root)}\n`;
  const current = await existingFile(manifestPath);
  const launcher = await existingFile(executable);
  if (current !== undefined) {
    let manifest;
    try { manifest = JSON.parse(current); } catch { /* Invalid registrations belong to someone else. */ }
    if (manifest?.name !== hostName || manifest.type !== "stdio" || manifest.path !== executable || !launcher?.startsWith(`#!/bin/sh\n${owner}`))
      throw new Error("本机启动器注册属于另一份安装或存在冲突，未覆盖或删除。请从原安装目录撤销。");
  }
  if (launcher !== undefined && !launcher.startsWith(`#!/bin/sh\n${owner}`))
    throw new Error("本机启动器文件属于其他安装，未覆盖或删除。");
  if (uninstall) {
    if (current !== undefined) await unlink(manifestPath);
    if (launcher !== undefined) await unlink(executable);
    return;
  }
  const manifest = JSON.parse(await readFile(join(root, ".output/chrome-mv3/manifest.json"), "utf8"));
  const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (manifest.version !== version) throw new Error("扩展构建与当前版本不同，请先运行 npm run setup。");
  const origins = [...connectionOrigins(join(root, ".output/chrome-mv3"), env.ALCHEMY_EXTENSION_ID)].map(origin => `${origin}/`);
  // The browser's PATH, Node options and ALCHEMY_* variables are not authority.
  // Capture only installation configuration, never account credentials or tokens.
  const keys = ["HOME", "PATH", "TMPDIR", "LANG", "CODEX_HOME", "CODEX_BIN", "PI_BIN", "ALCHEMY_SKILL_PATH", "IMAGEGEN_SKILL_PATH", "ALCHEMY_EXTENSION_ID"];
  const fixed = { ...Object.fromEntries(keys.filter(key => typeof env[key] === "string").map(key => [key, env[key]])), ALCHEMY_DATA_DIR: dataDir, ALCHEMY_PORT: String(port) };
  const command = ["/usr/bin/env", "-i", ...Object.entries(fixed).map(([key, value]) => `${key}=${value}`), process.execPath, join(root, "scripts/manage.mjs"), "native-host", JSON.stringify(origins)];
  const script = `#!/bin/sh\n${owner}exec ${command.map(quote).join(" ")} "$@"\n`;
  const registration = JSON.stringify({ name: hostName, description: "Start this QC-Reframe installation on demand", path: executable, type: "stdio", allowed_origins: origins }, null, 2) + "\n";
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
