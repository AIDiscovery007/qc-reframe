import { useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { request } from '../../lib/client';
import { newReminderState, REMINDER_TONES, reconcileToast, reminderSummary, type ReminderPreferences, type TaskNotice } from '../../lib/task-reminders';
import { isReminderVisible } from '../../lib/reminder-visibility';
import SelectField from './SelectField';

export type ReminderView = { unread: TaskNotice[]; preferences: ReminderPreferences; desktop: string; audioSupported: boolean; connectionError: string; audioError: string; toast?: TaskNotice[] };
export function useTaskReminders(root: RefObject<HTMLDivElement | null>) {
  const [value, setValue] = useState<ReminderView>({ unread: [], preferences: newReminderState().preferences, desktop: '', audioSupported: true, connectionError: '', audioError: '' });
  const [toast, setToast] = useState<TaskNotice[]>([]);
  const toastRef = useRef(toast); toastRef.current = toast;
  useEffect(() => {
    const viewId = crypto.randomUUID();
    let stopped = false, inFlight = false;
    const refresh = async () => {
      if (inFlight || stopped) return;
      inFlight = true;
      const visible = !document.hidden && document.hasFocus() && !!root.current?.getClientRects().length;
      const dialogs = [...(root.current?.querySelectorAll<HTMLDialogElement>('dialog[open]') || [])];
      // A gallery original is the visible result; other modal contents still obscure result surfaces.
      const scope = dialogs.length ? dialogs.length === 1 && dialogs[0]!.matches('.gallery-preview') ? dialogs[0] : null : root.current;
      const seen = visible ? [...(scope?.querySelectorAll<HTMLElement>('[data-reminder-task]') || [])].filter(isReminderVisible).map(element => element.dataset.reminderTask!).filter(Boolean) : [];
      try {
        const next = await request<ReminderView>({ type: 'alchemy:reminder-view', viewId, visible, seen });
        if (!stopped && next) {
          setValue(next);
          setToast(current => reconcileToast(current, next.toast, next.unread, seen));
        }
      } catch { /* Existing connection feedback remains authoritative. */ }
      finally { inFlight = false; }
    };
    const timer = setInterval(() => { if (!document.hidden && document.hasFocus() || toastRef.current.length) void refresh(); }, 1000);
    document.addEventListener('visibilitychange', refresh); window.addEventListener('focus', refresh); window.addEventListener('blur', refresh);
    void refresh();
    return () => {
      stopped = true; clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh); window.removeEventListener('focus', refresh); window.removeEventListener('blur', refresh);
      void request({ type: 'alchemy:reminder-view', viewId, visible: false, seen: [] }).catch(() => {});
    };
  }, [root]);
  return { ...value, toast, dismiss: () => setToast([]) };
}

export function ReminderToast({ notices, onClose, onOpen, container }: { container?: Element | null; notices: TaskNotice[]; onClose(): void; onOpen(notice?: TaskNotice): void }) {
  const element = useRef<HTMLDivElement>(null);
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const node = element.current!;
    node.showPopover?.();
    let remaining = 5000, previous = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      if (!document.hidden && document.hasFocus() && !node.matches(':hover') && !node.contains((node.getRootNode() as Document | ShadowRoot).activeElement)) remaining -= now - previous;
      previous = now;
      if (remaining <= 0) close.current();
    }, 100);
    return () => { clearInterval(timer); node.hidePopover?.(); };
  }, [notices, container]);
  const content = <div ref={element} popover="manual" className="reminder-toast">
    <span role="status" aria-live="polite">{reminderSummary(notices)}</span>
    <button className="text-button" onClick={() => { onOpen(notices.length === 1 ? notices[0] : undefined); onClose(); }}>查看</button>
    <button className="quiet-button" aria-label="关闭任务提醒" onClick={onClose}>×</button>
  </div>;
  return container ? createPortal(content, container) : content;
}

export function ReminderSettings() {
  const [value, setValue] = useState<ReminderView>();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    let stopped = false;
    void request<ReminderView>({ type: 'alchemy:reminder-get' }).then(next => { if (!stopped) setValue(next); }, error => { if (!stopped) setError(error.message); });
    return () => { stopped = true; };
  }, []);
  const change = async (preferences: ReminderPreferences) => {
    setBusy(true); setError('');
    try { setValue(await request<ReminderView>({ type: 'alchemy:reminder-settings', preferences })); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  };
  const test = async () => {
    setBusy(true); setError('');
    try { setValue(await request<ReminderView>({ type: 'alchemy:reminder-test' })); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  };
  return <section aria-labelledby="reminder-title"><h3 id="reminder-title">任务提醒</h3>
    <p className="fine">完成后保留未读标记；离开 Reframe 时，发送一次静默桌面提醒。</p>
    {value && <>
      <div className="settings-row"><span>界面与未读标记</span><span className="settings-label">默认开启</span></div>
      <div className="settings-row"><span>桌面提醒</span><span className="settings-label">{value.desktop === 'granted' ? '已允许' : value.desktop === 'denied' ? '系统已关闭' : '此浏览器暂不支持'}</span></div>
      {value.desktop !== 'granted' && <p className="fine">界面提醒仍然可用。可在浏览器与系统通知设置中检查 Reframe 的权限。</p>}
      <label className="settings-row reminder-switch"><span>完成提示音</span><input type="checkbox" role="switch" checked={value.preferences.sound} disabled={busy || !value.audioSupported} onChange={event => void change({ ...value.preferences, sound: event.target.checked })} /></label>
      {value.preferences.sound && <div className="reminder-sound-controls">
        <SelectField label="提示音" value={value.preferences.tone} disabled={busy} onChange={event => void change({ ...value.preferences, tone: event.target.value as ReminderPreferences['tone'] })}>{REMINDER_TONES.map(tone => <option key={tone.id} value={tone.id}>{tone.label}</option>)}</SelectField>
        <SelectField label="音量" value={String(value.preferences.volume)} disabled={busy} onChange={event => void change({ ...value.preferences, volume: Number(event.target.value) })}><option value="15">轻 · 15%</option><option value="30">适中 · 30%</option><option value="60">清晰 · 60%</option><option value="100">最大 · 100%</option></SelectField>
        <button className="outline-button" disabled={busy} onClick={() => void test()}>试听</button>
        <p className="fine">查看当前结果时不响；多个任务接连完成只提示一次。</p>
      </div>}
      {!value.audioSupported && <p className="fine">此浏览器暂不支持后台提示音。</p>}
      {(value.connectionError || value.audioError) && <p className="settings-info" role="status">{value.connectionError || value.audioError}</p>}
    </>}
    {error && <p className="error" role="alert">{error}</p>}
  </section>;
}
