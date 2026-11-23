import type { Generation } from "./types";

type Drawer = { open: boolean; pending: boolean; error: string; seen: string };
export type ResultDrawers = Record<string, Drawer>;
export type ResultDrawerAction = { key: string } & (
  | { type: "request" }
  | { type: "settled"; error?: string }
  | { type: "toggle"; open: boolean; seen: string }
);

// UI preferences are scoped to the selected project/path/version, never to a polling response.
export function resultDrawers(state: ResultDrawers, action: ResultDrawerAction): ResultDrawers {
  const previous = state[action.key] || { open: true, pending: false, error: "", seen: "" };
  const next = action.type === "request" ? { ...previous, open: true, pending: true, error: "" }
    : action.type === "settled" ? { ...previous, pending: false, error: action.error || "" }
    : { ...previous, open: action.open, seen: action.seen };
  return { ...state, [action.key]: next };
}

export function resultDrawerView(state: ResultDrawers, key: string, generations: Generation[] = []) {
  const preference = state[key];
  const completed = generations.filter(item => item.status === "completed").map(item => item.id).join(":");
  const running = generations.some(item => item.status === "running");
  const content = !!preference?.pending || !!preference?.error || generations.some(item => item.status !== "cancelled");
  const open = content && preference?.open !== false;
  return { content, open, completed, pending: !!preference?.pending, error: preference?.error || "",
    label: running || preference?.pending ? "正在生成" : !open && preference && completed !== preference.seen ? "新结果" : "查看结果" };
}
