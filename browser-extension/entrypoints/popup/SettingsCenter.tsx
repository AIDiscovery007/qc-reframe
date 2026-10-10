import { RecoveryContext } from "./RecoveryAction";
import { type CliStatus } from "../../lib/codex-status";
import ServiceRestart from "./ServiceRestart";
import { ReminderSettings } from "./TaskReminders";
import { showMotionDialog } from "../../lib/motion-dialog";
import { pollWhileVisible } from "../../lib/visible-poll";
import { useEffect, useRef, useState } from "react";
import { query } from "../../lib/client";
import AgentSettings from "./AgentSettings";
import ImageGenerationSettings from "./ImageGenerationSettings";
import SelectField from "./SelectField";
import InlineHelp from "./InlineHelp";
import { useMotion } from "../../lib/use-motion";
import { setMotionPreference, type MotionPreference } from "../../lib/motion-preference";
import { logo } from "../../lib/brand";

const sections = { reminders: "任务提醒", appearance: "界面与动效", models: "插件模型", generation: "生图渠道", connection: "本机连接", storage: "本地数据" };
export type SettingsSection = keyof typeof sections | "cli" | "pi-cli";

export default function SettingsCenter({ section: selectedSection, onSectionChange: setSection, connected, serviceBusy, onClose, onConnected }: {
  section?: SettingsSection;
  onSectionChange(section: SettingsSection): void;
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
  const section = (selectedSection === "cli" || selectedSection === "pi-cli") ? "models" : selectedSection || "models";
  const [cli, setCli] = useState<CliStatus>();
  const updating = cli?.operation?.status === "running";

  useEffect(() => {
    return showMotionDialog(dialog.current!);
  }, []);
  useEffect(() => {
    if (!connected) { setCli(undefined); return; }
    let cancelled = false;
    const poll = async () => {
      try {
        const status = await query<CliStatus>("/cli/status");
        if (!cancelled) setCli(status);
      } catch { /* Agent management displays detection failures. */ }
      return 3000;
    };
    const stop = pollWhileVisible(poll);
    return () => { cancelled = true; stop(); };
  }, [connected]);

  return <RecoveryContext.Provider value={setSection}><dialog ref={dialog} className="settings-center" aria-labelledby="settings-center-title" onCancel={(e) => { e.preventDefault(); onClose(); }}>
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
        {section === "models" && <section aria-label="模型设置">{connected ? <AgentSettings onManualTarget={() => setSection("models")} manageAgent={selectedSection === "cli" ? "codex" : selectedSection === "pi-cli" ? "pi" : undefined} loginCommand={cli?.instructions?.loginCommand} serviceBusy={serviceBusy || updating} /> : <><h3>选择创作模型</h3><div className="settings-info">本机服务未连接，恢复后将自动接入。</div><button className="primary" onClick={() => setSection("connection")}>检查本机服务</button></>}</section>}
        {section === "generation" && (connected ? <ImageGenerationSettings serviceBusy={serviceBusy || updating} onCheckCli={() => setSection("cli")} loginCommand={cli?.instructions?.loginCommand} /> : <section><h3>生图渠道</h3><p className="settings-info">本机服务未连接，恢复后将自动接入。</p><button className="primary" onClick={() => setSection("connection")}>检查本机服务</button></section>)}
        <div hidden={section !== "connection"}><ServiceRestart connected={connected} busy={serviceBusy || updating} onConnected={onConnected} /></div>
        {section === "storage" && <section aria-labelledby="storage-title">
          <h3 id="storage-title">本地数据</h3>
          <dl className="settings-facts"><div><dt>图片</dt><dd><code>.local/images/</code></dd></div><div><dt>项目与任务</dt><dd><code>.local/records/</code></dd></div><div><dt>配对与设置</dt><dd><code>.local/config/</code></dd></div><div><dt>运行文件</dt><dd><code>.local/logs/ · .local/runtime/</code></dd></div></dl>
        </section>}
      </div>
    </div>
  </dialog></RecoveryContext.Provider>;
}
