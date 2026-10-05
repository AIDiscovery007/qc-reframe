import { useEffect, useRef, useState } from "react";
import TaskOrchestration, { type TaskPhase } from "./TaskOrchestration";
import { simulateLocalExport } from "../../lib/export-simulation";
import { logo } from "../../lib/brand";

/** Served only on localhost by the explicit ?demo=task preview route. */
export default function TaskOrchestrationDemo() {
  const active = useRef<AbortController | undefined>(undefined);
  const startButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const [phase, setPhase] = useState<TaskPhase>("idle");
  const [progress, setProgress] = useState(0);
  const [files, setFiles] = useState(0);
  const [instant, setInstant] = useState(false);
  const cancel = (keyboard = false) => {
    if (!active.current) return;
    const controller = active.current; active.current = undefined; controller.abort();
    setInstant(keyboard); setPhase("cancelled");
    if (document.activeElement === cancelButton.current) startButton.current?.focus();
  };
  useEffect(() => {
    const hide = () => { if (document.hidden) cancel(true); };
    document.addEventListener("visibilitychange", hide);
    return () => { document.removeEventListener("visibilitychange", hide); active.current?.abort(); active.current = undefined; };
  }, []);
  const start = async (keyboard: boolean) => {
    active.current?.abort();
    const controller = new AbortController(); active.current = controller;
    setInstant(keyboard); setPhase("running"); setProgress(0); setFiles(0);
    try {
      const result = await simulateLocalExport(controller.signal, value => { if (active.current === controller) setProgress(value); });
      if (active.current !== controller) return;
      active.current = undefined; setFiles(result.files); setPhase("success");
      if (document.activeElement === cancelButton.current) startButton.current?.focus();
    } catch { if (active.current === controller) { active.current = undefined; setPhase("error"); } }
  };
  return <main className="app task-demo" onPointerDownCapture={() => setInstant(false)} onKeyDownCapture={() => setInstant(true)} onKeyDown={event => { if (event.key === "Escape" && active.current) { event.preventDefault(); cancel(true); } }}>
    <header><img src={logo} alt="QC-Reframe" /><a href="/workspace.html?state=session&sessions=many&sessionIndex=partial">返回会话工作台</a></header>
    <div className="task-demo-content"><p className="task-demo-eyebrow">交互验证 · 本地模拟</p><h1>任务编排</h1><p className="task-demo-intro">从开始到完成，始终知道任务进行到了哪里。</p>
      <TaskOrchestration phase={phase} title={phase === "running" ? "正在模拟导出" : phase === "success" ? "模拟导出已完成" : phase === "cancelled" ? "已取消模拟" : phase === "error" ? "模拟未完成" : "准备好导出"}
        detail={phase === "running" ? `正在整理 3 份设计笔记 · ${progress}%` : phase === "success" ? `${files} 份设计笔记已就绪 · 未生成真实文件` : phase === "cancelled" ? "任务已停止，可以随时重新开始。" : "3 份设计笔记 · 不读取会话，不下载文件"}
        progress={progress} progressLabel="模拟导出进度" instant={instant} actions={<>
          <button ref={startButton} className="task-action-primary" onClick={event => void start(event.detail === 0)}>{phase === "running" ? "重新开始" : phase === "idle" ? "开始模拟导出" : "重播模拟"}</button>
          <button ref={cancelButton} className="task-action-secondary" disabled={phase !== "running"} onClick={event => cancel(event.detail === 0)}>取消模拟</button>
        </>} />
      <p className="task-demo-note">模拟任务 1.2 秒 · 状态过渡 240ms · 完成勾选 280ms</p><p className="task-demo-note">支持 Enter / Space 操作、Esc 取消。离开页面停止模拟，减少动态效果时保留文字与进度。</p>
    </div>
  </main>;
}
