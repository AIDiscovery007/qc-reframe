// What the extension needs to offer and follow an in-extension upgrade of a release installation. The service decides
// whether an upgrade may start; this module only reads its answers. No runtime imports, so tests load it directly.

export type UpgradeStage = "download" | "verify" | "stop" | "replace" | "setup" | "start";
export type UpgradeOutcome = "upgraded" | "rolled_back" | "failed";
/** `notes` are the release page's section titles as plain text; older services send none. */
export type UpgradeRelease = { version: string; title: string; url: string; publishedAt: string | null; notes?: string[] };
/** The installer's own record of its last run, written in the data folder before it exits. */
export type UpgradeResult = { version: string; from: string | null; outcome: UpgradeOutcome; stage: UpgradeStage | null; at: string };
export type UpgradeStatus = {
  current: string; install: "package" | "source"; autoCheck: boolean;
  latest: UpgradeRelease | null; checkedAt: string | null; checkError: string | null;
  available: boolean; canUpgrade: boolean; reason: string | null; upgrading: boolean; lastResult: UpgradeResult | null;
  /** Not sent by older services: the release the user chose not to be reminded of, and whether the latest one is to be pointed out. */
  skippedVersion?: string | null; remind?: boolean;
};
export type UpgradeTicket = { version: string; startedAt: string };
export type UpgradeWait = { outcome: UpgradeOutcome; status: UpgradeStatus; result: UpgradeResult | null };
export type ReopenStorage = {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
};

const VERSION = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
const LOG = ".local/logs/upgrade.log";
const STAGES: Record<UpgradeStage, string> = { download: "下载", verify: "校验", stop: "停止旧服务", replace: "替换文件", setup: "初始化", start: "启动新服务" };
// Stages after which the installer has already touched the installation.
const CHANGED: ReadonlySet<UpgradeStage> = new Set(["replace", "setup", "start"]);
export const REOPEN_KEY = "upgradeReopenAt";
const REOPEN_WINDOW = 120_000;

const parse = (value: unknown) => { const match = typeof value === "string" && VERSION.exec(value); return match ? match.slice(1).map(Number) : null; };
/** True when `a` is a strictly newer release version than `b`. */
export function newerVersion(a: unknown, b: unknown) {
  const left = parse(a), right = parse(b);
  if (!left || !right) return false;
  for (let index = 0; index < 3; index++) if (left[index] !== right[index]) return left[index]! > right[index]!;
  return false;
}

/**
 * A service newer than the running extension needs a reload before anything else; otherwise a newer release is pointed
 * out unless the user skipped it or turned automatic checks off. Settings still offer every available release.
 */
export function upgradeHint(extensionVersion: string, status: UpgradeStatus | undefined): "reload" | "available" | undefined {
  if (!status) return;
  if (newerVersion(status.current, extensionVersion)) return "reload";
  if (status.available && status.remind !== false) return "available";
}

/** The release the icon and the system notification should point out, if any. */
export function remindedVersion(extensionVersion: string, status: UpgradeStatus | undefined) {
  // Unlike the sidebar hint, a background reminder needs the service's explicit `remind`: an older service sends none
  // and cannot report that the user turned reminders off.
  return status?.remind === true && upgradeHint(extensionVersion, status) === "available" ? status.latest?.version ?? null : null;
}

/** True for a reply that has the shape of an upgrade status, so a stray reply cannot clear or set a reminder. */
export function isUpgradeStatus(value: unknown): value is UpgradeStatus {
  const status = value as UpgradeStatus | null;
  return !!status && typeof status === "object" && typeof status.current === "string" && typeof status.available === "boolean"
    && (status.latest === null || typeof status.latest === "object" && typeof status.latest.version === "string");
}

/**
 * Follows an accepted upgrade until the new version answers or the installer's record of this attempt says otherwise.
 * The service is expected to be unreachable while files are replaced, so read failures only mean "not yet".
 */
export async function waitForUpgrade(ticket: UpgradeTicket, read: () => Promise<UpgradeStatus>, signal: AbortSignal,
  timeout = 600_000, pause = () => new Promise<void>(resolve => setTimeout(resolve, 1500)), now = Date.now): Promise<UpgradeWait> {
  const deadline = now() + timeout;
  const started = Date.parse(ticket.startedAt);
  while (now() < deadline) {
    signal.throwIfAborted();
    let status: UpgradeStatus | undefined;
    try { status = await read(); } catch {}
    signal.throwIfAborted();
    if (status) {
      if (status.current === ticket.version) return { outcome: "upgraded", status, result: status.lastResult };
      const last = status.lastResult;
      if (last && last.version === ticket.version && last.outcome !== "upgraded" && Date.parse(last.at) >= started) return { outcome: last.outcome, status, result: last };
      if (!status.upgrading) return { outcome: "failed", status, result: null };
    }
    await pause();
  }
  throw new Error(`未能确认升级结果。请在安装目录运行 npm run status 查看本机服务，并查看 ${LOG}。`);
}

export function upgradeOutcomeMessage(outcome: UpgradeOutcome, result: UpgradeResult | null, version: string) {
  if (outcome === "upgraded") return `已升级到 ${version}。`;
  if (!result) return `升级程序意外退出，未能确认结果。请查看安装目录下的 ${LOG}，必要时按 README 重新运行安装命令。`;
  const stage = result.stage ? STAGES[result.stage] : "未知阶段";
  if (outcome === "rolled_back") return `升级到 ${version} 失败（${stage}），已恢复 ${result.from ?? "原版本"} 并重新启动本机服务。详情见 ${LOG}。`;
  if (result.stage && !CHANGED.has(result.stage)) return `升级到 ${version} 失败（${stage}），本机服务未改动。详情见 ${LOG}，可稍后重试。`;
  return `升级到 ${version} 失败（${stage}），且未能自动恢复。请按 README 重新运行安装命令，详情见 ${LOG}。`;
}

/** Marks that the next extension start should reopen the connection settings. */
export async function markReopenAfterReload(storage: ReopenStorage, at = Date.now()) {
  await storage.set({ [REOPEN_KEY]: at });
}

/** Reopens once if the mark is recent; any mark is consumed so a reload that never happened cannot reopen later. */
export async function reopenAfterReload(storage: ReopenStorage, open: () => Promise<void>, at = Date.now()) {
  const mark = (await storage.get(REOPEN_KEY))[REOPEN_KEY];
  if (mark === undefined) return false;
  await storage.remove(REOPEN_KEY);
  if (typeof mark !== "number" || at - mark < 0 || at - mark > REOPEN_WINDOW) return false;
  await open();
  return true;
}
