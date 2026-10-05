import type { Mode } from './types';

export type TaskNotice = { id: string; jobId: string; projectId: string; mode: Mode; generationId?: string; status: 'running' | 'completed' | 'failed' | 'cancelled'; createdAt: string; hidden: boolean };
// Original audio stays unchanged; playback trims limit RMS/peaks before user volume.
export const REMINDER_TONES = [
  { id: 'calm', label: '静谧', file: 'Calm.ogg', gain: 1 },
  { id: 'cloud', label: '云朵', file: 'Cloud.ogg', gain: .627 },
  { id: 'chord', label: '和弦', file: 'Chord2.ogg', gain: .548 },
  { id: 'flute', label: '轻笛', file: 'Flit_Flute.ogg', gain: 1 },
  { id: 'glisten', label: '微光', file: 'Glisten.ogg', gain: 1 },
  { id: 'knock', label: '轻叩', file: 'Information_Block.ogg', gain: .589 },
  { id: 'koto', label: '琴弦', file: 'Koto.ogg', gain: .414 },
  { id: 'modular', label: '星点', file: 'Modular.ogg', gain: .716 },
  { id: 'taptap', label: '双拍', file: 'Taptap.ogg', gain: .281 },
  { id: 'tech', label: '轻讯', file: 'Tech.ogg', gain: .538 },
] as const;
export const reminderTone = (value: unknown) => REMINDER_TONES.find(tone => tone.id === (value === 'soft' ? 'calm' : value === 'bell' ? 'glisten' : value));
export type ReminderPreferences = { sound: boolean; tone: typeof REMINDER_TONES[number]['id']; volume: number };
export type ReminderState = {
  since: number; known: Record<string, string>; unread: TaskNotice[]; pending: string[]; due: number;
  preferences: ReminderPreferences; lastSound: number;
};
export const newReminderState = (now = Date.now()): ReminderState => ({ since: now, known: {}, unread: [], pending: [], due: 0, lastSound: 0, preferences: { sound: false, tone: 'calm', volume: 30 } });
export const noticeLabel = (notice: TaskNotice) => notice.status === 'failed' ? (notice.generationId ? '图片生成未完成' : '提示词逆向未完成') : notice.generationId ? '图片已生成' : '提示词已就绪';
export const reminderSummary = (notices: TaskNotice[]) => notices.length === 1 ? noticeLabel(notices[0]!) : `${notices.length} 项任务已有结果${notices.some(item => item.status === 'failed') ? '，有任务需要处理' : ''}`;

export function reconcileReminders(state: ReminderState, tasks: TaskNotice[], now: number): ReminderState {
  const current = new Map(tasks.map(task => [task.id, task]));
  const added = tasks.filter(task => ['completed', 'failed'].includes(task.status) && state.known[task.id] !== task.status
    && (state.known[task.id] === 'running' || !state.known[task.id] && Date.parse(task.createdAt) >= state.since));
  const unread = state.unread.flatMap(task => {
    const next = current.get(task.id);
    return next && ['completed', 'failed'].includes(next.status) ? [next] : [];
  });
  for (const task of added) if (!unread.some(item => item.id === task.id)) unread.push(task);
  const pending = [...new Set([...state.pending.filter(id => current.has(id)), ...added.filter(task => !task.hidden).map(task => task.id)])];
  return { ...state, known: Object.fromEntries(tasks.map(task => [task.id, task.status])), unread, pending,
    due: pending.length ? state.due || now + 5000 : 0 };
}

export function markRemindersRead(state: ReminderState, ids: string[]): ReminderState {
  const read = new Set(ids);
  const pending = state.pending.filter(id => !read.has(id));
  return { ...state, unread: state.unread.filter(task => !read.has(task.id)), pending, due: pending.length ? state.due : 0 };
}

// Keep the same array while its contents are unchanged so polling cannot restart the toast timer.
export function reconcileToast(current: TaskNotice[], incoming: TaskNotice[] | undefined, unread: TaskNotice[], seen: string[]): TaskNotice[] {
  const valid = new Set(unread.filter(item => !item.hidden && !seen.includes(item.id)).map(item => item.id));
  const next = (incoming?.length ? incoming : current).filter(item => valid.has(item.id));
  return next.length === current.length && next.every((item, index) => item.id === current[index]!.id && item.status === current[index]!.status) ? current : next;
}
