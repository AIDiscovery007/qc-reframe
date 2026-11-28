import { browser } from "wxt/browser";
import type { bridge as Bridge } from "./bridge";
import { isUpgradeStatus, remindedVersion, type UpgradeStatus } from "./service-upgrade";

const alarm = "reframe-upgrade-check";
const notificationId = "reframe-upgrade";
// The service contacts GitHub at most once an hour; asking it every half hour keeps a new release under ~90 minutes away.
const PERIOD_MINUTES = 30;
/** The release the icon points out; the task reminder service draws the icon. */
export const UPGRADE_BADGE_KEY = "upgradeBadge";
// The last release a system notification was shown for, or that the user already saw in the extension.
const NOTIFIED_KEY = "upgradeNotified";

type Options = {
  bridge: typeof Bridge; extensionVersion(): string;
  refreshBadge(): Promise<void>; openSettings(): Promise<void>;
};

/**
 * Reminds the user of a newer release without the extension being open: the icon says NEW and one system notification
 * per release offers to upgrade or skip it. Only the service decides what is newer and whether to remind; this module
 * never wakes a stopped service and never contacts GitHub itself.
 */
export function startUpgradeReminder({ bridge, extensionVersion, refreshBadge, openSettings }: Options) {
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T,>(action: () => Promise<T>): Promise<T> => {
    const next = queue.catch(() => {}).then(action); queue = next; return next;
  };
  const token = async () => ((await browser.storage.local.get("preferences")).preferences as { token?: string } | undefined)?.token;
  const permission = async () => { try { return await browser.notifications.getPermissionLevel(); } catch { return "unavailable"; } };

  /** Applies a status to the icon; `notify` shows the system notification once per release. */
  const apply = (status: UpgradeStatus, notify: boolean) => serial(async () => {
    const version = remindedVersion(extensionVersion(), status);
    const stored = await browser.storage.local.get([UPGRADE_BADGE_KEY, NOTIFIED_KEY]);
    if (stored[UPGRADE_BADGE_KEY] !== (version ?? undefined)) {
      if (version) await browser.storage.local.set({ [UPGRADE_BADGE_KEY]: version });
      else await browser.storage.local.remove(UPGRADE_BADGE_KEY);
      await refreshBadge();
    }
    if (!version) { await browser.notifications.clear(notificationId).catch(() => {}); return; }
    if (stored[NOTIFIED_KEY] === version) return;
    // Record first so a restarting worker never shows the same release twice.
    await browser.storage.local.set({ [NOTIFIED_KEY]: version });
    if (!notify || await permission() !== "granted") return;
    try {
      await browser.notifications.create(notificationId, { type: "basic", iconUrl: browser.runtime.getURL("/icon/128.png"),
        title: `QC-Reframe ${version} 可用`, message: "可在设置中心升级，项目、图片与配对都会保留。",
        buttons: [{ title: "查看并升级" }, { title: "跳过此版本" }], priority: 0, requireInteraction: false });
    } catch { /* The icon keeps saying NEW when the system cannot show a notification. */ }
  });

  const check = async () => {
    const saved = await token();
    if (!saved) return;
    let status: unknown;
    try { status = await bridge("/upgrade?check=auto", saved); }
    catch { return; } // A stopped service is not woken for a check; any earlier reminder stays.
    if (isUpgradeStatus(status)) await apply(status, true);
  };
  const skip = async () => {
    const { [UPGRADE_BADGE_KEY]: version } = await browser.storage.local.get(UPGRADE_BADGE_KEY);
    const saved = await token();
    if (typeof version !== "string" || !saved) return;
    let status: unknown;
    try { status = await bridge("/upgrade/settings", saved, { skippedVersion: version }); }
    catch (error) { console.error("无法跳过此版本，可在设置中心重试", error); return; }
    if (isUpgradeStatus(status)) await apply(status, false);
  };
  const open = async () => {
    await browser.notifications.clear(notificationId).catch(() => {});
    await openSettings();
  };

  const pending = new Set<Promise<unknown>>();
  const track = (work: Promise<unknown>) => {
    const done = work.catch(error => console.error("新版本提醒失败", error)).finally(() => pending.delete(done));
    pending.add(done);
  };
  browser.alarms?.onAlarm.addListener(event => { if (event.name === alarm) track(check()); });
  browser.notifications?.onClicked.addListener(id => { if (id === notificationId) track(open()); });
  browser.notifications?.onButtonClicked?.addListener((id, index) => {
    if (id === notificationId) track(index === 0 ? open() : skip());
  });
  const ready = (async () => {
    // Re-creating an existing alarm would push the next check back every time the worker restarts.
    try { if (!await browser.alarms?.get(alarm)) await browser.alarms?.create(alarm, { periodInMinutes: PERIOD_MINUTES }); }
    catch { /* Opening the extension still checks for updates. */ }
    await check();
  })().catch(error => console.error("新版本提醒失败", error));

  return {
    ready,
    /** Resolves once the work started by alarms and notification clicks has finished. */
    async idle() { while (pending.size) await Promise.all(pending); },
    /** A status the user saw in the extension: the icon follows it and no system notification repeats it. */
    seen(status: unknown) { return isUpgradeStatus(status) ? apply(status, false) : Promise.resolve(); },
  };
}
