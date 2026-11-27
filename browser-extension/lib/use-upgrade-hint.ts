import { useEffect, useState } from "react";
import { browser } from "wxt/browser";
import { request } from "./client";
import { pollWhileVisible } from "./visible-poll";
import { upgradeHint, type UpgradeStatus } from "./service-upgrade";

const HOUR = 3_600_000;

/**
 * The workspace's upgrade hint. Each visit asks for the automatic check; the service contacts GitHub at most once a
 * day and only while automatic checks are on. The settings page pushes its newer answers through `update`.
 */
export function useUpgradeHint(enabled: boolean) {
  const [status, setStatus] = useState<UpgradeStatus>();
  useEffect(() => {
    if (!enabled) { setStatus(undefined); return; }
    let cancelled = false;
    const stop = pollWhileVisible(async () => {
      try { const next = await request<UpgradeStatus>({ type: "alchemy:upgrade-status", check: "auto" }); if (!cancelled) setStatus(next); }
      catch { if (!cancelled) setStatus(undefined); }
      return HOUR;
    });
    return () => { cancelled = true; stop(); };
  }, [enabled]);
  return { hint: upgradeHint(browser.runtime.getManifest().version, status), update: setStatus };
}
