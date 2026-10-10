import { useEffect, useRef, useState } from "react";
import { query, request } from "../../lib/client";
import { cliLabel, compatibilityMessage, type CliStatus } from "../../lib/codex-status";
import { pollWhileVisible } from "../../lib/visible-poll";

const sources = { managed: "Reframe 管理", npm: "npm", homebrew: "Homebrew", standalone: "独立安装版", app: "App 内置", custom: "自定义安装", missing: "未检测到" };

export default function AgentCliSettings({ agent, serviceBusy, onBusyChange, onUpdated }: {
  agent: "codex" | "pi"; serviceBusy: boolean; onBusyChange(busy: boolean): void; onUpdated(): void;
}) {
  const [cli, setCli] = useState<CliStatus>();
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState<"check" | "install" | "update" | null>(null);
  const mounted = useRef(false);
  const revision = useRef(0);
  const acting = useRef(false);
  const completed = useRef<string | undefined>(undefined);
  const label = agent === "pi" ? "Pi" : "Codex";
  const updating = cli?.operation?.status === "running";
  const blocked = !!pending || updating || serviceBusy;
  const accept = (value: CliStatus) => {
    setCli(value);
    const finished = value.operation?.status === "completed" ? value.operation.finishedAt : undefined;
    if (finished && completed.current !== finished) { completed.current = finished; onUpdated(); }
  };
  useEffect(() => {
    mounted.current = true;
    const poll = async () => {
      if (acting.current) return 1000;
      const current = revision.current;
      try {
        const value = await query<CliStatus>(agent === "pi" ? "/cli/status?agent=pi" : "/cli/status");
        if (mounted.current && current === revision.current) { accept(value); setLoadError(""); }
      } catch (e) {
        if (mounted.current && current === revision.current) setLoadError((e as Error).message === "Not found" ? "请更新并重启本机服务，以启用 Agent 管理。" : (e as Error).message);
      }
      return 1500;
    };
    const stop = pollWhileVisible(poll);
    return () => { mounted.current = false; revision.current++; stop(); };
  }, [agent]);
  useEffect(() => { onBusyChange(!!pending || !!updating); return () => onBusyChange(false); }, [pending, updating, onBusyChange]);
  const act = async (action: "check" | "install" | "update") => {
    if (acting.current || blocked) return;
    acting.current = true;
    revision.current++;
    setPending(action); setError(""); setNotice("");
    try {
      const value = await request<CliStatus>({ type: `alchemy:cli-${action}`, agent });
      if (!mounted.current) return;
      accept(value);
      if (action === "check") setNotice(value.checkError ? "本机检测完成，但检查更新失败。" : !value.installed ? `未检测到 ${label}，请安装后重新检测。` : value.updateAvailable ? `检测完成：可升级至 ${value.latestVersion}。` : `检测完成：${value.version || "版本未知"}。${value.latestVersion ? "当前渠道无更新。" : "尚未确认最新版本。"}`);
    } catch (e) { if (mounted.current) setError((e as Error).message); }
    finally { acting.current = false; revision.current++; if (mounted.current) setPending(null); }
  };
  const compatibility = cli?.installed ? cli.compatibility?.error || (Object.values(cli.compatibility?.features || {}).some(feature => feature.status !== "supported") ? compatibilityMessage(cli.compatibility) : "") : "";
  const unsupported = Object.values(cli?.compatibility?.features || {}).some(feature => feature.status === "unsupported");
  return <section className="agent-cli-settings" aria-label={`${label} 管理`} aria-busy={!!pending || updating}>
    <div className="settings-cli-heading"><h3>{label} CLI</h3><span className="settings-chip">{cli ? sources[cli.source] : loadError ? "检测失败" : "检测中"}</span></div>
    <div className="settings-update-card">
      <div className="settings-update-top"><strong>{cli ? cliLabel(cli) : error || loadError ? "检测未完成" : "正在检测"}</strong>{cli?.updateAvailable && <span className="settings-chip attention">{cli.comparisonReference ? "稳定版参考" : "稳定版"}</span>}</div>
      {cli?.installed && <div className="settings-version-pair">{cli.updateAvailable && cli.latestVersion ? <><span>{cli.version}</span><span>→</span><strong>{cli.latestVersion}</strong></> : <strong>{cli.version || "版本未知"}</strong>}</div>}
      <p className="settings-operation-status" role="status">{updating ? "关闭设置后仍会继续，完成后将重新检测。" : pending === "install" ? "正在启动安装…" : pending === "update" ? "正在启动升级…" : pending === "check" ? "正在检测本机安装与更新…" : serviceBusy ? "请等待当前任务或模型操作完成。" : cli?.reason || cli?.instructions?.message || "检测本机安装与更新状态。"}</p>
      <div className="settings-cli-actions">
      {cli && !cli.installed && cli.canInstall ? <button className="primary" disabled={serviceBusy} aria-disabled={blocked} onClick={() => void act("install")}>{pending === "install" || updating ? "正在安装…" : `一键安装 ${label}`}</button>
        : cli && !cli.installed && cli.instructions?.url ? <a className="text-button" href={cli.instructions.url} target="_blank" rel="noreferrer">查看 {label} 安装说明</a>
        : cli?.updateAvailable && cli.canUpdate ? <button className="primary" disabled={serviceBusy} aria-disabled={blocked} onClick={() => void act("update")}>{pending === "update" || updating ? "正在升级…" : `一键升级至 ${cli.latestVersion}`}</button> : null}
      <button className="text-button" disabled={serviceBusy} aria-disabled={blocked} onClick={() => void act("check")}>{pending === "check" ? "正在检测…" : "重新检测并检查更新"}</button>
      </div>
      {notice && <p className="settings-check-notice fine" role="status">{notice}</p>}
      {(error || loadError || cli?.checkError) && <div className="settings-info settings-error" role="alert">{error || loadError || `检查更新失败：${cli?.checkError}`}</div>}
      {cli?.operation?.status === "failed" && <div className="settings-info settings-error" role="alert">{cli.operation.error || cli.operation.stage}</div>}
    </div>
    {compatibility && <p className={unsupported ? "settings-info settings-error" : "fine"} role="status">{compatibility}</p>}
    {cli && <details className="settings-detail" open={!cli.installed || !!cli.comparisonReference || cli.operation?.status === "failed"}>
      <summary>安装与检查详情</summary>
      <p className="fine">最近检测安装：{cli.detectedAt ? new Date(cli.detectedAt).toLocaleString() : "尚未检测"}</p>
      <p className="fine">最近检查更新：{cli.checkedAt ? new Date(cli.checkedAt).toLocaleString() : "尚未完成"}</p>
      <p className="fine">可执行文件</p><code>{cli.executable || "未检测到可执行文件"}</code>
      {(cli.instructions?.command || cli.command) && <><p className="fine">{cli.installed ? "手动更新命令" : "安装命令"}</p><code>{cli.instructions?.command || cli.command}</code></>}
      {cli.instructions?.loginCommand && <><p className="fine">需要登录时，在终端运行：</p><code>{cli.instructions.loginCommand}</code></>}
      {cli.instructions?.url && <a href={cli.instructions.url} target="_blank" rel="noreferrer">安装与更新说明</a>}
      {cli.executable && <p className="fine">更新或登录后重新检测，确认 Reframe 使用的是上方这份 CLI。</p>}
    </details>}
  </section>;
}
