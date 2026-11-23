import type { Mode } from "./types";

/** User-facing creation path names, in picker order. */
export const modeLabels: Record<Mode, string> = { style: "提取风格", recreate: "完整复刻", reenact: "主体重演", "multi-reenact": "多图重演", session: "会话创作" };
