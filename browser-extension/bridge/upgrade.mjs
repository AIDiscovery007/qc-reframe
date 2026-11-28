import { spawn } from "node:child_process";
import { open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bad } from "./http.mjs";

// The only source of upgrade information. The check sends a fixed request: no user data, cookies or tokens.
export const RELEASE_URL = "https://api.github.com/repos/AIDiscovery007/qc-reframe/releases/latest";
const RELEASE_PAGE = "https://github.com/AIDiscovery007/qc-reframe/releases/tag/";
const HOUR = 3600_000;
const MINUTE = 60_000;
const MAX_RESPONSE = 1024 * 1024;
const VERSION = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
const OUTCOMES = ["upgraded", "rolled_back", "failed"];
const STAGES = ["download", "verify", "stop", "replace", "setup", "start"];
// Release pages end with these fixed sections (see Contribution.md); they are not what is new in the release.
const FIXED_SECTIONS = new Set(["升级方式与数据", "验证与已知限制"]);
const NOTES = 6, NOTE_LENGTH = 60;
// Installer options that only the user may set by hand, and service variables the next service must not inherit.
const DROPPED_ENV = /^(QC_REFRAME_|ALCHEMY_(MANAGED|RESTART_ID|CHANNEL|DATA_DIR|PORT)$)/;

const parseVersion = value => { const match = typeof value === "string" && VERSION.exec(value); return match ? match.slice(1).map(Number) : null; };
/** True when `a` is a strictly newer release version than `b`. */
export function newerVersion(a, b) {
  const left = parseVersion(a), right = parseVersion(b);
  if (!left || !right) return false;
  for (let index = 0; index < 3; index++) if (left[index] !== right[index]) return left[index] > right[index];
  return false;
}
const isoTime = value => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const untrusted = () => Object.assign(new Error("untrusted release"), { untrusted: true });

/** The release page's section titles as short plain text: Markdown, HTML and fenced code are dropped, never rendered. */
function releaseNotes(body) {
  if (typeof body !== "string") return [];
  const notes = [];
  let fenced = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s{0,3}(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    const heading = !fenced && /^##[ \t]+(.+)$/.exec(line);
    if (!heading) continue;
    const text = heading[1]
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/<[^>]*>/g, "")
      .replace(/[*_`~#]/g, "").replace(/\s+/g, " ").trim();
    if (!text || FIXED_SECTIONS.has(text)) continue;
    notes.push(text.length > NOTE_LENGTH ? `${text.slice(0, NOTE_LENGTH - 1)}…` : text);
    if (notes.length === NOTES) break;
  }
  return notes;
}

/** Keeps only what the settings page shows from a GitHub release; anything that is not a stable published release is refused. */
function releaseInfo(release) {
  if (!release || typeof release !== "object" || Array.isArray(release) || release.draft === true || release.prerelease === true) throw untrusted();
  const tag = release.tag_name;
  if (typeof tag !== "string" || !tag.startsWith("v") || !parseVersion(tag.slice(1)) || release.html_url !== RELEASE_PAGE + tag) throw untrusted();
  const title = typeof release.name === "string" && release.name.trim() ? release.name.trim().slice(0, 200) : tag;
  return { version: tag.slice(1), title, url: release.html_url, publishedAt: isoTime(release.published_at), notes: releaseNotes(release.body) };
}
const storedRelease = value => {
  if (!value || typeof value !== "object" || !parseVersion(value.version) || value.url !== `${RELEASE_PAGE}v${value.version}`
    || typeof value.title !== "string" || value.title.length > 200 || (value.publishedAt !== null && !isoTime(value.publishedAt))) return null;
  // Saved before release notes existed: no notes until the next check.
  const notes = Array.isArray(value.notes) && value.notes.length <= NOTES && value.notes.every(note => typeof note === "string" && note.length <= NOTE_LENGTH) ? value.notes : [];
  return { version: value.version, title: value.title, url: value.url, publishedAt: value.publishedAt, notes };
};

/**
 * GitHub answers 403 with no remaining quota, or 429 / Retry-After, when this network used up its unauthenticated
 * queries; other programs on the same IP share that quota. Returns the minutes until it may succeed again.
 */
function rateLimit(response, now) {
  const retryAfter = response.headers.get("retry-after"), remaining = response.headers.get("x-ratelimit-remaining");
  if (response.status !== 429 && !(response.status === 403 && (remaining === "0" || retryAfter))) return null;
  const seconds = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter)
    : /^\d+$/.test(response.headers.get("x-ratelimit-reset") ?? "") ? Number(response.headers.get("x-ratelimit-reset")) - now / 1000 : NaN;
  return { minutes: Number.isFinite(seconds) && seconds > 0 ? Math.min(60, Math.ceil(seconds / 60)) : null };
}

async function fetchRelease({ releaseUrl, timeoutMs, current, now }) {
  const response = await fetch(releaseUrl, {
    redirect: "error", signal: AbortSignal.timeout(timeoutMs),
    headers: { Accept: "application/vnd.github+json", "User-Agent": `QC-Reframe/${current}`, "X-GitHub-Api-Version": "2022-11-28" },
  });
  if (!response.ok) throw Object.assign(new Error(`GitHub ${response.status}`), { rateLimit: rateLimit(response, now) });
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_RESPONSE) { await reader.cancel().catch(() => {}); throw untrusted(); }
    chunks.push(value);
  }
  let release;
  try { release = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw untrusted(); }
  return releaseInfo(release);
}

/** Starts the installer of this installation detached, so it survives the service it stops; output goes to its own log. */
async function spawnDetached({ command, args, env, cwd, log }) {
  const handle = await open(log, "w", 0o600);
  try {
    const child = spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", handle.fd, handle.fd] });
    const exited = new Promise(resolve => { child.once("exit", resolve); child.once("error", resolve); });
    await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    child.unref();
    return { exited };
  } finally { await handle.close(); }
}

/**
 * Upgrade checks and one-click upgrades of a release installation.
 * The service only checks GitHub and starts the installer shipped with this installation for the confirmed latest
 * release; downloading, signature and checksum verification, replacement and rollback belong to scripts/install.sh.
 */
export async function createUpgradeService({
  root, current, channel, paths, port, allowShutdown, busy,
  releaseUrl = RELEASE_URL, timeoutMs = 10_000, now = Date.now, platform = process.platform,
  packaged, spawnInstaller = spawnDetached,
}) {
  packaged ??= await stat(join(root, "runtime-package.json")).then(() => true, () => false);
  const file = join(paths.config, "upgrade.json");
  const resultFile = join(paths.runtime, "upgrade-result.json");
  const state = { autoCheck: true, checkedAt: null, latest: null, checkError: null, skippedVersion: null };
  try {
    const saved = JSON.parse(await readFile(file, "utf8"));
    state.autoCheck = saved.autoCheck !== false;
    state.checkedAt = isoTime(saved.checkedAt);
    state.latest = storedRelease(saved.latest);
    state.checkError = typeof saved.checkError === "string" ? saved.checkError.slice(0, 200) : null;
    state.skippedVersion = parseVersion(saved.skippedVersion) ? saved.skippedVersion : null;
  } catch {}
  let checking, running = null, writes = Promise.resolve();
  const persist = () => {
    const text = JSON.stringify(state, null, 2) + "\n";
    writes = writes.then(async () => {
      const temporary = `${file}.${process.pid}.tmp`;
      await writeFile(temporary, text, { mode: 0o600 });
      await rename(temporary, file);
    }).catch(error => console.error(`无法保存更新检查设置：${error.message}`));
    return writes;
  };
  const age = () => state.checkedAt ? now() - Date.parse(state.checkedAt) : Infinity;

  const check = () => checking ||= (async () => {
    state.checkedAt = new Date(now()).toISOString();
    try {
      state.latest = await fetchRelease({ releaseUrl, timeoutMs, current, now: now() });
      state.checkError = null;
    } catch (error) {
      state.checkError = error.untrusted ? "无法检查更新：GitHub 没有返回可信的正式版本，请稍后重试。"
        : error.rateLimit ? `无法检查更新：GitHub 暂时限制了本网络的查询次数，${error.rateLimit.minutes ? `约 ${error.rateLimit.minutes} 分钟后可重试` : "请稍后重试"}。`
        : "无法检查更新：网络不可用或 GitHub 暂时无响应，请稍后重试。";
    }
    await persist();
  })().finally(() => { checking = undefined; });

  const blocker = () => {
    if (running) return `正在升级到 ${running.version}，完成后本机服务会自动重新启动。`;
    if (!packaged || channel.name !== "release") return `此服务从源码仓库运行，请用 git pull 更新后运行 ${channel.commands.setup}。`;
    if (!["darwin", "linux"].includes(platform)) return "插件内升级目前只支持 macOS 和 Linux，请按 README 手动更新。";
    if (!allowShutdown) return "此服务在终端前台运行，无法在插件内升级。请在该终端按 Ctrl+C 停止，再运行 npm start 后重试。";
    if (busy()) return "请等待当前任务、模型验证或 Agent CLI 操作完成后再升级。";
    return null;
  };

  const lastResult = async () => {
    try {
      const value = JSON.parse(await readFile(resultFile, "utf8"));
      if (!value || !parseVersion(value.version) || !(value.from === null || parseVersion(value.from)) || !OUTCOMES.includes(value.outcome)
        || !(value.stage === null || STAGES.includes(value.stage)) || !isoTime(value.at)) return null;
      return { version: value.version, from: value.from, outcome: value.outcome, stage: value.stage, at: value.at };
    } catch { return null; }
  };

  const view = async () => {
    const available = !!state.latest && newerVersion(state.latest.version, current);
    const reason = blocker();
    return {
      current, install: packaged ? "package" : "source", autoCheck: state.autoCheck,
      latest: state.latest, checkedAt: state.checkedAt, checkError: state.checkError,
      available, canUpgrade: available && !reason, reason, upgrading: !!running, lastResult: await lastResult(),
      // Skipping only silences reminders: the skipped release can still be installed from settings.
      skippedVersion: state.skippedVersion, remind: available && state.autoCheck && state.latest.version !== state.skippedVersion,
    };
  };

  return {
    /** True while the installer this service started has not exited; the service then refuses new work. */
    get running() { return !!running; },
    /** `auto` contacts GitHub at most once an hour and only when enabled; `manual` at most once a minute; no mode never. */
    async status(mode) {
      if (mode !== null && mode !== "auto" && mode !== "manual") throw bad("无效的检查方式");
      if (mode === "auto" ? state.autoCheck && age() >= HOUR : mode === "manual" && age() >= MINUTE) await check();
      else if (checking) await checking;
      return view();
    },
    /** Changes one setting: `autoCheck`, or `skippedVersion` (the current latest release, or null to clear the skip). */
    async settings(body) {
      const keys = body && typeof body === "object" ? Object.keys(body) : [];
      if (keys.length !== 1) throw bad("无效的更新设置");
      if (keys[0] === "autoCheck" && typeof body.autoCheck === "boolean") state.autoCheck = body.autoCheck;
      else if (keys[0] === "skippedVersion" && (body.skippedVersion === null || parseVersion(body.skippedVersion))) {
        if (body.skippedVersion !== null && body.skippedVersion !== state.latest?.version)
          throw bad(`只能跳过最新版本 ${state.latest?.version ?? "（尚未检查）"}，请重新检查更新后再试。`, 409);
        state.skippedVersion = body.skippedVersion;
      } else throw bad("无效的更新设置");
      await persist();
      return view();
    },
    /** Starts the installer for the version GitHub confirms as the latest release, if nothing would be interrupted. */
    async start(body) {
      if (!body || Object.keys(body).length !== 1 || !parseVersion(body.version)) throw bad("无效的升级版本");
      let blocked = blocker();
      if (blocked) throw bad(blocked, 409);
      if (age() >= MINUTE) await check();
      else if (checking) await checking;
      if (state.checkError) throw bad(state.checkError, 409);
      const latest = state.latest;
      if (!latest || latest.version !== body.version) throw bad(`GitHub 上的最新正式版本是 ${latest?.version ?? "未知"}，请重新检查更新后再试。`, 409);
      if (!newerVersion(latest.version, current)) throw bad(`当前已是 ${current}，无需升级。`, 409);
      if ((blocked = blocker())) throw bad(blocked, 409);
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !DROPPED_ENV.test(key)));
      Object.assign(env, {
        QC_REFRAME_DIR: root, QC_REFRAME_VERSION: latest.version, QC_REFRAME_REQUIRE_SIGNATURE: "1",
        ALCHEMY_DATA_DIR: paths.root, ALCHEMY_PORT: String(port()),
      });
      const startedAt = new Date(now()).toISOString();
      running = { version: latest.version };
      try {
        await rm(resultFile, { force: true });
        const { exited } = await spawnInstaller({ command: "/bin/bash", args: [join(root, "scripts/install.sh")], env, cwd: root, log: join(paths.logs, "upgrade.log") });
        void exited.finally(() => { running = null; });
      } catch (error) {
        running = null;
        console.error(`无法启动升级程序：${error.message}`);
        throw bad("无法启动升级程序，本机服务未改动。请查看本机服务日志后重试。", 503);
      }
      return { version: latest.version, startedAt };
    },
  };
}
