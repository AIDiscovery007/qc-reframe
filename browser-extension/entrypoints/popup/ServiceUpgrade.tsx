import { useEffect, useRef, useState } from "react";
import { browser } from "wxt/browser";
import { request } from "../../lib/client";
import { pollWhileVisible } from "../../lib/visible-poll";
import { showMotionDialog } from "../../lib/motion-dialog";
import { logo } from "../../lib/brand";
import {
  upgradeHint, upgradeOutcomeMessage, waitForUpgrade, type UpgradeStatus, type UpgradeTicket,
} from "../../lib/service-upgrade";

type Phase = "idle" | "starting" | "waiting" | "reloading";
const DAY = 24 * 3_600_000;
const extensionVersion = browser.runtime.getManifest().version;
const date = (value: string) => new Date(value).toLocaleString();

/** Checks GitHub for a newer release and upgrades this installation in place; the service decides what is allowed. */
export default function ServiceUpgrade({ connected, busy, onStatus }: { connected: boolean; busy: boolean; onStatus?(status: UpgradeStatus): void }) {
  const [status, setStatus] = useState<UpgradeStatus>();
  const [loadError, setLoadError] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [target, setTarget] = useState("");
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const pending = useRef(false);
  const lifetime = useRef<AbortController | undefined>(undefined);
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const report = useRef(onStatus);
  report.current = onStatus;
  const accept = (next: UpgradeStatus) => { setStatus(next); setLoadError(""); report.current?.(next); };

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (!connected) { if (!pending.current) setStatus(undefined); return; }
    let cancelled = false;
    const stop = pollWhileVisible(async () => {
      if (!pending.current) {
        try { const next = await request<UpgradeStatus>({ type: "alchemy:upgrade-status" }); if (!cancelled && !pending.current) accept(next); }
        catch (e) { if (!cancelled && !pending.current) { setStatus(undefined); setLoadError((e as Error).message); } }
      }
      return 5000;
    });
    return () => { cancelled = true; stop(); };
  }, [connected]);
  useEffect(() => {
    if (!confirming) return;
    const close = showMotionDialog(dialog.current!);
    cancel.current?.focus({ preventScroll: true });
    return close;
  }, [confirming]);

  const running = phase !== "idle";
  const hint = upgradeHint(extensionVersion, status);
  const latest = status?.latest;
  const check = async () => {
    if (pending.current || checking) return;
    setChecking(true); setError(""); setNotice("");
    try {
      const next = await request<UpgradeStatus>({ type: "alchemy:upgrade-status", check: "manual" });
      accept(next);
      if (!next.checkError && !next.available) setNotice(`已是最新正式版本（${next.current}）。`);
    } catch (e) { setError((e as Error).message); }
    finally { setChecking(false); }
  };
  const changeAutoCheck = async (autoCheck: boolean) => {
    setSaving(true); setError("");
    try { accept(await request<UpgradeStatus>({ type: "alchemy:upgrade-settings", autoCheck })); }
    catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  };
  const reload = async () => {
    try { await request({ type: "alchemy:extension-reload" }); }
    catch (e) { setPhase("idle"); setError((e as Error).message); }
  };
  const upgrade = async () => {
    const version = latest?.version;
    if (pending.current || !version || !status?.canUpgrade) return;
    pending.current = true;
    setConfirming(false);
    const signal = lifetime.current!.signal;
    setTarget(version); setPhase("starting"); setError(""); setNotice("");
    try {
      const ticket = await request<UpgradeTicket>({ type: "alchemy:upgrade-start", version });
      signal.throwIfAborted();
      setPhase("waiting");
      const outcome = await waitForUpgrade(ticket, () => request<UpgradeStatus>({ type: "alchemy:upgrade-status" }), signal);
      accept(outcome.status);
      if (outcome.outcome === "upgraded") {
        setPhase("reloading");
        await reload();
        return;
      }
      setError(upgradeOutcomeMessage(outcome.outcome, outcome.result, version));
      setPhase("idle");
    } catch (e) { if (!signal.aborted) { setError((e as Error).message); setPhase("idle"); } }
    finally { pending.current = false; }
  };

  const last = status?.lastResult;
  const recent = last && Date.now() - Date.parse(last.at) < DAY ? last : undefined;
  const message = phase === "starting" ? `正在确认 ${target} 并启动升级…`
    : phase === "waiting" ? `正在升级到 ${target}：下载、校验并替换文件，本机服务会短暂停止。关闭设置后升级仍会继续。`
    : phase === "reloading" ? `已升级到 ${target}，正在重新加载扩展…`
    : !connected ? "连接本机服务后可检查更新。"
    : !status ? loadError || "正在读取版本信息…"
    : hint === "reload" ? `本机服务已是 ${status.current}，扩展仍在运行 ${extensionVersion}。重新加载扩展以完成升级。`
    : status.available && status.reason ? status.reason
    : status.available ? `${latest!.title} 已发布。升级会短暂停止本机服务，保留项目、图片、配对与设置。`
    : status.install === "source" && status.reason ? status.reason
    : status.checkedAt ? `已是最新正式版本。最近检查：${date(status.checkedAt)}。`
    : "尚未检查更新。";
  return <section className="settings-update-card" aria-label="升级 QC-Reframe" aria-busy={running || checking}>
    <div className="settings-update-top"><strong>QC-Reframe 版本</strong>{status?.available && <span className="settings-chip attention">新版本</span>}</div>
    {status && <div className="settings-version-pair">{status.available && latest ? <><span>{status.current}</span><span>→</span><strong>{latest.version}</strong></> : <strong>{status.current}</strong>}</div>}
    <p className="settings-operation-status" role="status">{message}</p>
    {status && <div className="settings-cli-actions">
      {hint === "reload" ? <button className="primary" disabled={running} onClick={() => void reload()}>重新加载扩展</button>
        : status.available && <button className="primary" disabled={running || busy || !status.canUpgrade} onClick={() => { setError(""); setConfirming(true); }}>
          {running ? "正在升级…" : `升级到 ${latest!.version}`}</button>}
      {latest && status.available && <a className="text-button" href={latest.url} target="_blank" rel="noreferrer">查看更新说明</a>}
      <button className="text-button" disabled={running || checking} onClick={() => void check()}>{checking ? "正在检查…" : "检查更新"}</button>
    </div>}
    {notice && <p className="fine" role="status">{notice}</p>}
    {recent?.outcome === "upgraded" && recent.version === status?.current && !running
      && <p className="fine" role="status">已于 {date(recent.at)} 从 {recent.from ?? "旧版本"} 升级到 {recent.version}。已打开的网页需刷新后才能继续选图。</p>}
    {recent && recent.outcome !== "upgraded" && !running && !error
      && <div className="settings-info settings-error" role="alert">{upgradeOutcomeMessage(recent.outcome, recent, recent.version)}</div>}
    {(error || status?.checkError) && <div className="settings-info settings-error" role="alert">{error || status?.checkError}</div>}
    {status && <label className="settings-row reminder-switch"><span>每天自动检查更新</span>
      <input type="checkbox" role="switch" checked={status.autoCheck} disabled={saving || running} onChange={event => void changeAutoCheck(event.target.checked)} /></label>}
    {status && <p className="fine">检查只向 GitHub 读取最新正式版本信息，不发送项目、图片或配对信息。</p>}
    <dialog ref={dialog} className="result-dialog modal dialog-small" aria-labelledby="upgrade-title" aria-describedby="upgrade-description"
      onCancel={event => { event.stopPropagation(); event.preventDefault(); setConfirming(false); }}
      onKeyDown={event => { if (event.key === "Escape") event.stopPropagation(); }}>
      <div className="modal-head"><img src={logo} alt="" /><h2 id="upgrade-title">升级到 {latest?.version}？</h2>
        <button className="close-btn" aria-label="关闭窗口" onClick={() => setConfirming(false)}>×</button></div>
      <div className="dialog-content">
        <p id="upgrade-description">本机服务会停止一到两分钟，完成后自动重新启动，扩展随后重新加载并回到这里。项目、图片、配对与设置都会保留；未保存的编辑会丢失，已打开的网页需刷新后才能继续选图。新版本无法启动时会自动恢复 {status?.current}。</p>
        <div className="dialog-actions">
          <button ref={cancel} className="secondary" onClick={() => setConfirming(false)}>取消</button>
          <button className="primary" disabled={!status?.canUpgrade || busy} onClick={() => void upgrade()}>开始升级</button>
        </div>
      </div>
    </dialog>
  </section>;
}
