import { useEffect, useId, useRef, useState } from "react";
import { request } from "../../lib/client";
import type { PluginInstructions } from "../../lib/types";
import InlineHelp from "./InlineHelp";

// The bridge stores the same normalized form, so an unchanged draft is never saved again.
const normalized = (value: string) => value.replace(/\r\n?/g, "\n").trim();

export default function PluginInstructionsSettings() {
  const id = useId();
  const [saved, setSaved] = useState<PluginInstructions>();
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<"" | "load" | "save">("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const alive = useRef(false);
  const busy = useRef(false);
  const load = async () => {
    const value = await request<PluginInstructions>({ type: "alchemy:plugin-instructions" });
    if (alive.current) { setSaved(value); setDraft(value.text); }
  };
  const run = async (kind: "load" | "save", action: () => Promise<void>) => {
    if (busy.current) return;
    busy.current = true; setPending(kind); setError(""); setNotice("");
    try { await action(); }
    catch (e) { if (alive.current) setError((e as Error).message === "Not found" ? "请更新并重启本机服务，以启用插件指令。" : (e as Error).message); }
    finally { busy.current = false; if (alive.current) setPending(""); }
  };
  useEffect(() => {
    alive.current = true;
    void run("load", load);
    return () => { alive.current = false; };
  }, []);
  const busyNow = pending !== "";
  const text = normalized(draft);
  const dirty = !!saved && text !== saved.text;
  const save = () => run("save", async () => {
    const value = await request<PluginInstructions>({ type: "alchemy:plugin-instructions-save", text: draft, revision: saved!.revision });
    if (!alive.current) return;
    setSaved(value); setDraft(value.text);
    setNotice(value.custom ? "已保存，用于之后提交的逆向任务；已受理的任务不受影响。" : "已恢复内置指令，之后随插件更新。");
  });
  const current = !saved ? "" : !saved.custom ? "内置指令（随插件更新）" : saved.text ? "自定义指令" : "已清空，逆向时不附加插件指令";

  return <section aria-labelledby={`${id}-title`} className="plugin-instructions">
    <h3 id={`${id}-title`}>插件指令</h3>
    <p id={`${id}-help`} className="fine">相当于 Reframe 自己的 AGENTS.md / CLAUDE.md。每次逆向都会附加给所选 Agent，引导观察角度与专业用词；本次任务指令优先。</p>
    <InlineHelp label="生效范围">适用于 Codex、Claude Code 与 Pi 的全部逆向路径，不用于生图。提交任务时冻结，修改只影响之后提交的任务。插件指令不能改变工具权限、图片顺序或输出格式。清空后逆向不附加插件指令。</InlineHelp>
    {saved && <p className="fine">当前：{current}{dirty ? " · 有未保存的修改" : ""}</p>}
    <form onSubmit={event => { event.preventDefault(); if (dirty) void save(); }}>
      <textarea aria-labelledby={`${id}-title`} aria-describedby={`${id}-help ${id}-count`} spellCheck={false} rows={16}
        maxLength={saved?.maxLength} value={draft} disabled={!saved || busyNow} onChange={event => { setDraft(event.target.value); setNotice(""); }} />
      <p id={`${id}-count`} className="fine plugin-instructions-count">{saved ? `${text.length} / ${saved.maxLength} 字符` : pending === "load" ? "正在读取插件指令…" : ""}</p>
      <div className="plugin-instructions-actions">
        <button className="primary" disabled={!dirty || busyNow}>{pending === "save" ? "正在保存…" : "保存插件指令"}</button>
        <button type="button" className="text-button" disabled={!saved || busyNow || text === saved.builtin} onClick={() => { setDraft(saved!.builtin); setNotice("已填入内置指令，保存后生效。"); }}>填入内置指令</button>
        {(dirty || error) && <button type="button" className="text-button" disabled={busyNow} onClick={() => void run("load", load)}>{dirty ? "放弃修改并重新读取" : "重新读取"}</button>}
      </div>
    </form>
    <p className="fine" role="status">{notice}</p>
    {error && <div className="settings-info settings-error" role="alert">{error}</div>}
  </section>;
}
