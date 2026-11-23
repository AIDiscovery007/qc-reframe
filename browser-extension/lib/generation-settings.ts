import type { ImageSettings } from "./types";

export type GenerationHealth = { generationProvider?: string; generationReady?: boolean; generationModel?: string | null; model?: string };
/** The image channel as the UI may act on it: only accepted health snapshots change it. */
export type GenerationChannel = { magpie: boolean; model?: string; ready: boolean; pending: boolean; error: string; revision: number };
export type ChannelToken = { readonly saving: boolean };

export const initialGenerationChannel: GenerationChannel = { magpie: false, ready: false, pending: false, error: "", revision: 0 };

/**
 * Serializes image-settings writes against health polling. Every poll captures a token before it
 * reads; a write replaces the token, so polls started before or during the write are discarded.
 */
export function createGenerationSettings(io: {
  request<T>(message: Record<string, unknown>): Promise<T>;
  query<T>(path: string): Promise<T>;
  publish(update: (channel: GenerationChannel) => GenerationChannel): void;
}) {
  let sync: ChannelToken = { saving: false };
  const set = (patch: Partial<GenerationChannel>) => io.publish(channel => ({ ...channel, ...patch }));
  const apply = (health: GenerationHealth, token: ChannelToken) => {
    if (token !== sync || token.saving) return false;
    set({
      magpie: health.generationProvider === "magpie",
      model: health.generationModel || undefined,
      ready: health.generationReady ?? !!(health.generationModel === undefined ? health.model : health.generationModel),
      pending: false, error: "",
    });
    return true;
  };
  return {
    token: () => sync,
    /** Whether a failure observed under this token may still report the channel offline. */
    current: (token: ChannelToken) => token === sync && !token.saving,
    apply,
    async save(settings: Record<string, unknown>) {
      if (sync.saving) throw new Error("生图设置正在保存，请稍候。");
      const saving = { saving: true };
      sync = saving;
      set({ pending: true, ready: false, error: "" });
      try {
        const saved = await io.request<ImageSettings>({ type: "alchemy:image-settings-save", settings });
        io.publish(channel => ({ ...channel, revision: channel.revision + 1 }));
        return saved;
      } finally {
        if (sync === saving) {
          const refreshing = { saving: false };
          sync = refreshing;
          try { apply(await io.query<GenerationHealth>("/health"), refreshing); }
          catch {
            if (sync === refreshing) set({ pending: false, error: "无法确认生图渠道状态，请检查本机服务；连接恢复后将自动刷新。" });
          }
        }
      }
    },
  };
}
