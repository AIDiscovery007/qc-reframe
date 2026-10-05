import type { ReactNode } from "react";
import { useMotion } from "../../lib/use-motion";

export type TaskPhase = "idle" | "running" | "success" | "partial" | "error" | "cancelled";

/** Business state owns progress and completion; transitions only explain that state. */
export default function TaskOrchestration({ phase, title, detail, progress, progressLabel, instant = false, actions, children }: {
  phase: TaskPhase; title: string; detail: string; progress?: number; progressLabel: string;
  instant?: boolean; actions?: ReactNode; children?: ReactNode;
}) {
  const { reduced } = useMotion();
  return <section className="task-orchestration" data-state={phase} data-motion={reduced || instant ? "instant" : "full"} aria-label={progressLabel}>
    <div className="task-orchestration-head">
      <span className="task-orchestration-mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path className="task-check" pathLength="1" d="m5 12 4 4L19 6" />
          <g className="task-symbol">{phase === "error" || phase === "partial" ? <path d="M12 5v9m0 4h.01" /> : phase === "cancelled" ? <path d="m7 7 10 10M17 7 7 17" /> : <path d="M12 4v12m-4-4 4 4 4-4M5 17v3h14v-3" />}</g>
        </svg>
      </span>
      <div className="task-orchestration-copy"><strong role="status" aria-live="polite">{title}</strong><p>{detail}</p></div>
    </div>
    {phase === "running" && <div className="task-progress-track">
      <progress className="task-progress-semantic" max={100} value={progress} aria-label={progressLabel} />
      <span aria-hidden="true" style={{ transform: `scaleX(${Math.max(0, Math.min(100, progress ?? 0)) / 100})` }} />
    </div>}
    {children}
    {actions && <div className="task-orchestration-actions">{actions}</div>}
  </section>;
}
