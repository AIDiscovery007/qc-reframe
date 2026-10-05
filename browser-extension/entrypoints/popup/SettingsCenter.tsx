import ServiceRestart from "./ServiceRestart";
import { ReminderSettings } from "./TaskReminders";
import { showMotionDialog } from "../../lib/motion-dialog";
import { pollWhileVisible } from "../../lib/visible-poll";
import { useEffect, useRef, useState } from "react";
import { query, request } from "../../lib/client";
import ModelSettings from "./ModelSettings";
import SelectField from "./SelectField";
import InlineHelp from "./InlineHelp";
import { useMotion } from "../../lib/use-motion";
import { setMotionPreference, type MotionPreference } from "../../lib/motion-preference";
import { logo } from "../../lib/brand";

// Mirrors the authenticated bridge status; command is for display only.
type CliStatus = {
  installed: boolean;
  version: string | null;
  latestVersion: string | null;
  executable: string | null;
  source: "npm" | "homebrew" | "standalone" | "app" | "custom" | "missing";
  canUpdate: boolean;
  updateAvailable: boolean;
  checkedAt: string | null;
  detectedAt?: string | null;
  checkError?: string | null;
  reason?: string | null;
  command?: string | null;
  operation?: { status: "running" | "completed" | "failed"; stage: string; error?: string; startedAt: string; finishedAt?: string } | null;
};
const sections = { reminders: "任务提醒", appearance: "界面与动效", models: "插件模型", cli: "Codex 与更新", connection: "本机连接", storage: "本地数据" };
const sources = { npm: "npm", homebrew: "Homebrew", standalone: "独立安装版", app: "Codex App 内置", custom: "自定义安装", missing: "未检测到" };

export default function SettingsCenter({ connected, serviceBusy, onClose, onConnected }: {
  connected: boolean;
  serviceBusy: boolean;
  onClose(): void;
  onConnected(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { preference, reduced } = useMotion();
  const [savingMotion, setSavingMotion] = useState(false);
  const [motionError, setMotionError] = useState("");
  const changeMotion = async (value: MotionPreference) => {
    setSavingMotion(true);
    setMotionError("");
    try { await setMotionPreference(value); }
    catch { setMotionError("动效设置保存失败，请重试。"); }
    finally { setSavingMotion(false); }
  };
  const revision = useRef(0);
  const [section, setSection] = useState<keyof typeof sections>(connected ? "cli" : "connection");
  const [cli, setCli] = useState<CliStatus>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loadError, setLoadError] = useState("");
  const [pending, setPending] = useState<"check" | "update" | "connect" | null>(null);
  const [token, setToken] = useState("");
  const [pairError, setPairError] = useState("");
  const updating = cli?.operation?.status === "running";

  useEffect(() => {
    return showMotionDialog(dialog.current!);
  }, []);
  useEffect(() => {
    if (!connected) { setCli(undefined); return; }
    let cancelled = false;
    const poll = async () => {
      const current = revision.current;
      try {
        const status = await query<CliStatus>("/cli/status");
        if (!cancelled && current === revision.current) { setCli(status); setLoadError(""); }
      } catch (e) {
        if (!cancelled && current === revision.current) setLoadError((e as Error).message === "Not found" ? "请更新并重启本机服务，以启用 CLI 管理。" : (e as Error).message);
      }
      return 3000;
    };
    const stop = pollWhileVisible(poll);
    return () => { cancelled = true; stop(); };
  }, [connected]);

  const act = async (action: "check" | "update") => {
    if (pending || updating || (action === "update" && serviceBusy)) return;
    revision.current++;
    setPending(action);
    setError("");
    setNotice("");
    try {
      const next = await request<CliStatus>({ type: action === "check" ? "alchemy:cli-check" : "alchemy:cli-update" });
      setCli(next);
      if (action === "check") setNotice(next.checkError ? "本机安装检测完成，但检查更新失败。" : !next.command
        ? `检测完成：${sources[next.source]}。${next.reason || "请通过原安装方式更新。"}`
        : next.updateAvailable ? `检测完成：可升级至 ${next.latestVersion}。` : `检测完成：当前版本 ${next.version}，未发现更新。`);
    }
    catch (e) { setError((e as Error).message); }
    finally { revision.current++; setPending(null); }
  };
  const connect = async () => {
    if (pending || !token.trim()) return;
    setPending("connect");
    setPairError("");
    try {
      await request({ type: "alchemy:connect", token: token.trim() });
      setToken("");
      onConnected();
      setSection("cli");
    } catch (e) { setPairError((e as Error).message); }
    finally { setPending(null); }
  };
  const blocked = !!pending || updating;
  const status = !connected ? "本机服务未连接" : !cli ? "正在检测" : updating ? "正在升级" : cli.operation?.status === "failed" ? "升级未完成" : !cli.installed ? "需要安装 CLI" : cli.updateAvailable ? "有新版本" : cli.operation?.status === "completed" ? "升级完成" : cli.source === "app" ? "由桌面 App 管理" : cli.latestVersion ? "已是最新版本" : "已安装";

  return <dialog ref={dialog} className="settings-center" aria-labelledby="settings-center-title" onCancel={(e) => { e.preventDefault(); onClose(); }}>
    <div className="settings-center-heading"><img src={logo} alt="" /><h2 id="settings-center-title">设置中心</h2><button className="settings-close" aria-label="关闭设置" onClick={onClose}>×</button></div>
    <div className="settings-center-body">
      <nav className="settings-center-nav" aria-label="设置分类">
        {Object.entries(sections).map(([key, label]) => <button key={key} aria-current={section === key ? "page" : undefined} onClick={() => setSection(key as keyof typeof sections)}>{label}</button>)}
      </nav>
      <div className="settings-center-content">
        {section === "reminders" && <ReminderSettings />}
        {section === "appearance" && <section aria-labelledby="appearance-title">
          <h3 id="appearance-title">界面与动效</h3>
          <SelectField label="减少动态效果" value={preference} disabled={savingMotion} onChange={event => void changeMotion(event.target.value as MotionPreference)}>
            <option value="system">跟随系统</option>
            <option value="reduce">开启</option>
            <option value="full">关闭</option>
          </SelectField>
          <InlineHelp label="动效说明">开启后，加载、图片揭晓、弹窗和按钮反馈改为静态显示。设置自动保存，应用于工作台与网页浮层，不影响任务执行。</InlineHelp>
          <p className="fine" role="status">{savingMotion ? "正在保存…" : preference === "system" ? `当前：${reduced ? "减少动态效果" : "完整动效"}` : ""}</p>
          {motionError && <div className="settings-info settings-error" role="alert">{motionError}</div>}
        </section>}
        {section === "cli" && <section aria-labelledby="cli-title">
          <h3 id="cli-title">Codex CLI</h3>
          <span className={`settings-chip ${connected && cli?.installed ? "good" : "attention"}`}>{!connected ? "无法检测" : cli ? sources[cli.source] : "检测中"}</span>
          <div className="settings-update-card">
            <div className="settings-update-top"><strong>{status}</strong>{cli?.updateAvailable && <span className="settings-chip attention">稳定版</span>}</div>
            {cli?.installed && <div className="settings-version-pair">{cli.updateAvailable && cli.latestVersion ? <><span>{cli.version}</span><span>→</span><strong>{cli.latestVersion}</strong></> : <strong>{cli.version || "版本未知"}</strong>}</div>}
            <p className="settings-operation-status" role="status">{!connected ? "启动本机服务并连接后，才能检测和管理 Codex。" : !cli ? "正在检测本机安装…" : updating ? `${cli.operation?.stage || "正在升级…"} 关闭设置后仍会继续。` : serviceBusy ? "请等待当前逆向、生图或模型验证完成后升级。" : cli.reason || (cli.source === "app" ? "此 CLI 随桌面 App 更新。请在对应 App 中检查更新。" : !cli.installed ? "安装并登录 Codex CLI 后重新检测。" : cli.operation?.status === "completed" ? "版本检查通过，可前往插件模型刷新列表并验证。" : "")}</p>
            {cli?.operation?.status === "failed" && <div className="settings-info settings-error" role="alert">{cli.operation.error || cli.operation.stage}</div>}
            {!connected ? <button className="primary" onClick={() => setSection("connection")}>前往连接</button> : cli?.updateAvailable && cli.canUpdate ? <button className="primary" disabled={blocked || serviceBusy} onClick={() => void act("update")}>{updating || pending === "update" ? "正在升级…" : `一键升级至 ${cli.latestVersion}`}</button> : <button className="primary" disabled={blocked || !cli} onClick={() => void act("check")}>{pending === "check" ? "正在检测…" : updating ? "正在升级…" : "重新检测"}</button>}
          </div>
          {cli && <>
            <div className="settings-row"><span>自动检查更新</span><span className="settings-label">{cli.command ? "每天一次" : "由原安装方式管理"}</span></div>
            <details className="settings-detail"><summary>安装与检查详情</summary>
              <p className="fine">最近检测安装：{cli.detectedAt ? new Date(cli.detectedAt).toLocaleString() : "尚未检测"}</p>
              <p className="fine">{cli.command ? (cli.checkedAt ? `最近检查更新：${new Date(cli.checkedAt).toLocaleString()}` : "尚未检查更新") : "此安装方式暂不支持在插件内检查和升级。"}</p>
              <code>{cli.executable || "未检测到可执行文件"}</code>
              {cli.command && <code>{cli.command}</code>}
              {cli.updateAvailable && cli.canUpdate && <button className="text-button" disabled={blocked} onClick={() => void act("check")}>{pending === "check" ? "正在检测…" : "重新检测"}</button>}
            </details>
            {cli.checkError && <div className="settings-info settings-error" role="alert">检查更新失败：{cli.checkError}</div>}
          </>}
          <p className="settings-check-notice fine" role="status">{notice}</p>
          {(error || loadError) && <div className="settings-info settings-error" role="alert">{error || loadError}</div>}
        </section>}
        {section === "models" && <section aria-label="模型设置">{connected ? <ModelSettings wide onCheckCli={() => setSection("cli")} key={cli?.operation?.finishedAt || "initial"} serviceBusy={serviceBusy || updating || !!pending} /> : <><h3>选择创作模型</h3><div className="settings-info">连接本机服务后，可选择并验证模型。</div><button className="primary" onClick={() => setSection("connection")}>前往连接</button></>}</section>}
        {section === "connection" && <section aria-labelledby="connection-title">
          <h3 id="connection-title">连接你的电脑</h3>
          <span className={`settings-chip ${connected ? "good" : "attention"}`}>{connected ? "本机服务已连接" : "服务未连接"}</span>
          <div className="settings-row settings-service-row"><span className="settings-label">服务地址</span><code>127.0.0.1:43187</code></div>
          <div className="settings-row"><span className="settings-label">Codex 安装</span><span>{!connected ? "连接后检测" : cli?.installed ? `已检测到 ${cli.version || "CLI"}` : "尚未找到可用 CLI"}</span></div>
          <form onSubmit={(e) => { e.preventDefault(); void connect(); }}>
            <label className="settings-pair-label">{connected ? "重新配对" : "配对码"}<input type="password" autoComplete="off" spellCheck={false} value={token} placeholder="粘贴本机服务提供的配对码" onChange={(e) => setToken(e.target.value)} /></label>
            <button className="primary" disabled={!!pending || !token.trim()}>{pending === "connect" ? "正在连接…" : "连接 Codex"}</button>
          </form>
          {pairError && <div className="settings-info settings-error" role="alert">{pairError}</div>}
          <details className="settings-detail" open={!connected}><summary>如何启动本机服务？</summary><p className="fine">在插件目录打开终端，启动服务，再获取配对码。</p><code>npm start<br />npm run pair</code></details>
        </section>}
        <div hidden={section !== "connection"}><ServiceRestart connected={connected} busy={serviceBusy || updating || !!pending} onConnected={onConnected} /></div>
        {section === "storage" && <section aria-labelledby="storage-title">
          <h3 id="storage-title">本地数据</h3>
          <dl className="settings-facts"><div><dt>图片</dt><dd><code>.local/images/</code></dd></div><div><dt>项目与任务</dt><dd><code>.local/records/</code></dd></div><div><dt>配对与设置</dt><dd><code>.local/config/</code></dd></div><div><dt>运行文件</dt><dd><code>.local/logs/ · .local/runtime/</code></dd></div></dl>
        </section>}
      </div>
    </div>
  </dialog>;
}
