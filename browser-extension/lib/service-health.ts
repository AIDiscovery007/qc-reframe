import type { CliStatus } from "./codex-status";
import type { ChannelToken, GenerationHealth } from "./generation-settings";
import type { Project } from "./types";

type Ref<T> = { current: T };
export type ServiceHealth = GenerationHealth & {
  agent?: string; ready: boolean; serviceReady?: boolean; skill: string; active: number; visibleActive?: number;
  hiddenProjectIds?: string[]; projectsRevision?: string; modelBusy?: boolean; cliBusy?: boolean; cli?: CliStatus | null;
};
/** What the surface shows about the local service, its reverse Agent and model. */
export type ServiceStatus = {
  connected: boolean; connectionText: string; cliBusy: boolean; cliStatus?: CliStatus | null;
  modelBusy: boolean; reverseAgent: string; selectedModel: string | null;
};
export const initialServiceStatus: ServiceStatus = {
  connected: false, connectionText: "正在连接本机服务…", cliBusy: false, modelBusy: false, reverseAgent: "codex", selectedModel: null,
};

/**
 * Polls bridge health while the surface is visible and refetches the open project whenever the bridge's
 * project revision moves. A health read under a superseded image-settings token is discarded whole;
 * activity and project updates are fenced by `projectRevision`, so an older poll never overwrites a
 * local mutation that started after it. Returns the effect cleanup.
 */
export function pollServiceHealth(env: {
  query<T>(path: string): Promise<T>;
  request<T>(message: Record<string, unknown>): Promise<T>;
  pollWhileVisible(poll: () => Promise<number>): () => void;
  generation: { token(): ChannelToken; apply(health: GenerationHealth, token: ChannelToken): boolean; current(token: ChannelToken): boolean };
  projectRevision: Ref<number>; deletingProjects: Ref<boolean>; project: Ref<Project | undefined>;
  setStatus(patch: Partial<ServiceStatus>): void;
  setPaired(): void;
  setActivity(activity: { busy: boolean; active: number; hiddenProjectIds: string[] }): void;
  setDataRevision(revision: string): void;
  setProject(project: Project): void;
}, projectId?: string) {
  let cancelled = false;
  let fetchedRevision: string | undefined;
  const stop = env.pollWhileVisible(async () => {
    const revision = env.projectRevision.current;
    const token = env.generation.token();
    let delay = 10_000;
    try {
      const health = await env.query<ServiceHealth>("/health");
      if (cancelled || !env.generation.apply(health, token)) return delay;
      env.setPaired();
      if (revision === env.projectRevision.current)
        env.setActivity({ busy: health.active > 0, active: health.visibleActive ?? health.active, hiddenProjectIds: health.hiddenProjectIds || [] });
      env.setStatus({ connected: health.serviceReady ?? true, cliBusy: !!health.cliBusy, cliStatus: health.cli, modelBusy: !!health.modelBusy,
        reverseAgent: health.agent || "codex", selectedModel: health.model || null,
        connectionText: health.ready ? `已连接 · ${health.skill}` : "未找到图片逆向技能" });
      delay = health.active || health.modelBusy || health.cliBusy ? 2000 : 10_000;
      // An older bridge must report an upgrade need instead of silently showing an empty library.
      const nextRevision = health.projectsRevision || "legacy";
      if (!env.deletingProjects.current) env.setDataRevision(nextRevision);
      if (projectId && !env.deletingProjects.current && (nextRevision !== fetchedRevision || nextRevision === "legacy")) {
        const saved = env.project.current;
        const value = await env.request<Project | { unchanged: true; revision: string }>({ type: "alchemy:project", id: projectId,
          revision: saved?.id === projectId ? saved.revision : undefined });
        if (!cancelled && revision === env.projectRevision.current) {
          if (!("unchanged" in value)) env.setProject(value);
          fetchedRevision = nextRevision;
        }
      }
    } catch (e) {
      if (!cancelled && revision === env.projectRevision.current && env.generation.current(token))
        env.setStatus({ connected: false, connectionText: (e as Error).message });
    }
    return delay;
  });
  return () => { cancelled = true; stop(); };
}
