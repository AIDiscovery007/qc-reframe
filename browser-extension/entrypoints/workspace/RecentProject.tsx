import { useEffect, useRef, useState } from "react";
import { request } from "../../lib/client";
import type { Mode, ProjectSummary } from "../../lib/types";

export default function RecentProject({ project, active, disabled, onOpen, currentMode }: { currentMode?: Mode; project: ProjectSummary; active: boolean; disabled: boolean; onOpen(): void }) {
  const button = useRef<HTMLButtonElement>(null);
  const [image, setImage] = useState("");
  useEffect(() => {
    let stopped = false;
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      void request<{ image: string }>({ type: "alchemy:project-thumbnail", id: project.id, reference: true }).then(value => { if (!stopped) setImage(value.image || ""); }, () => {});
    });
    if (button.current) observer.observe(button.current);
    return () => { stopped = true; observer.disconnect(); };
  }, [project.id]);
  const mode = active ? currentMode : Object.keys(project.modes)[0];
  const label = !project.jobCount ? "待逆向" : mode ? ({ style: "提取风格", recreate: "完整复刻", reenact: "主体重演", "multi-reenact": "多图重演", session: "会话创作" }[mode] || "待创作") : "待创作";
  return <button ref={button} className={`project-button ${active ? "active" : ""}`} title={project.title} aria-label={`打开项目：${project.title}`} aria-current={active ? "page" : undefined} disabled={disabled} onClick={onOpen}>{image ? <img src={image} alt="" /> : <span className="recent-image-placeholder" />}<span><strong>{project.title}</strong><small>{project.busy ? "● 任务执行中" : label}{project.hidden ? " · 已隐藏" : ""}</small></span></button>;
}
