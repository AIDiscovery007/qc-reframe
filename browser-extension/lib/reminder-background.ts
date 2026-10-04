import { browser } from 'wxt/browser';
import { bridge } from './bridge';
import { markRemindersRead, newReminderState, reconcileReminders, reminderSummary, type ReminderState, type TaskNotice } from './task-reminders';

const key = 'taskReminders';
const alarm = 'reframe-task-reminders';
const notificationId = 'reframe-tasks';

export function startReminderService() {
  let queue: Promise<unknown> = Promise.resolve();
  let watching = false, again = false, projectsRevision = 0;
  let flushTimer: ReturnType<typeof setTimeout>;
  let creatingAudio: Promise<void> | undefined;
  const audioSupported = !!browser.offscreen?.createDocument && !!browser.runtime.getContexts;
  const views = new Map<string, { at: number; visible: boolean; seen: string[]; toast?: TaskNotice[] }>();
  const serial = <T,>(action: () => Promise<T>): Promise<T> => {
    const next = queue.catch(() => {}).then(action); queue = next; return next;
  };
  const read = async (): Promise<ReminderState> => {
    const value = (await browser.storage.local.get(key))[key] as ReminderState | undefined;
    if (value) return value;
    const initial = newReminderState();
    await browser.storage.local.set({ [key]: initial });
    return initial;
  };
  const shown = async (items: TaskNotice[]) => {
    const showHidden = (await browser.storage.session.get('showHiddenProjects')).showHiddenProjects === true;
    return items.filter(item => showHidden || !item.hidden);
  };
  const save = async (state: ReminderState) => {
    await browser.storage.local.set({ [key]: state });
    const unread = await shown(state.unread);
    await browser.action.setBadgeText({ text: unread.length ? String(Math.min(unread.length, 99)) : '' });
    await browser.action.setBadgeBackgroundColor({ color: unread.some(item => item.status === 'failed') ? '#b64a3d' : '#ffd440' });
    await browser.action.setTitle({ title: unread.length ? `Reframe · ${unread.length} 项结果未查看` : '打开 QC-Reframe' });
  };
  const audio = async (preferences: ReminderState['preferences']) => {
    if (!audioSupported) throw new Error('此浏览器暂不支持后台声音，界面提醒仍然可用。');
    const url = browser.runtime.getURL('/reminder-audio.html');
    const contexts = await browser.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] });
    if (!contexts.length) {
      creatingAudio ||= browser.offscreen.createDocument({ url, reasons: ['AUDIO_PLAYBACK'], justification: '播放用户主动开启的任务完成提示音' });
      try { await creatingAudio; } finally { creatingAudio = undefined; }
    }
    const reply = await browser.runtime.sendMessage({ type: 'alchemy:reminder-audio', preferences });
    if (!reply?.ok) throw new Error(reply?.error || '提示音播放失败，请检查声音输出。');
  };
  const permission = async () => {
    try { return await browser.notifications.getPermissionLevel(); } catch { return 'unavailable'; }
  };
  const deliver = async (state: ReminderState) => {
    if (!state.pending.length) return state;
    if (Date.now() < state.due) { schedule(state); return state; }
    const focused = [...views.values()].filter(view => view.visible && Date.now() - view.at < 4000);
    state = markRemindersRead(state, focused.flatMap(view => view.seen));
    const notices = await shown(state.unread.filter(item => !item.hidden && state.pending.includes(item.id)));
    state.pending = []; state.due = 0;
    // Persist consumption first: worker restarts must never replay a sound burst.
    const shouldSound = notices.length && state.preferences.sound && Date.now() - state.lastSound >= 10_000;
    if (shouldSound) state.lastSound = Date.now();
    await save(state);
    if (!notices.length) return state;
    if (focused.length) focused[0]!.toast = notices;
    else if (await permission() === 'granted') {
      try {
        await browser.storage.session.set({ reminderTarget: notices.map(item => item.id) });
        await browser.notifications.create(notificationId, { type: 'basic', iconUrl: browser.runtime.getURL('/icon/128.png'),
          title: 'Reframe', message: `${reminderSummary(notices)} · 点击查看`, priority: 0, silent: true, requireInteraction: false });
      } catch { /* The durable badge remains when the OS cannot show a notification. */ }
    }
    if (shouldSound) {
      try { await audio(state.preferences); await browser.storage.local.remove('reminderAudioError'); }
      catch (error) { await browser.storage.local.set({ reminderAudioError: (error as Error).message }); }
    }
    return state;
  };
  const schedule = (state: ReminderState) => {
    clearTimeout(flushTimer);
    if (state.pending.length) flushTimer = setTimeout(() => void wake(), Math.max(0, state.due - Date.now()));
  };
  const openWorkspace = async (params: URLSearchParams, sourceTab?: number) => {
    const base = browser.runtime.getURL('/workspace.html');
    const tabs = (await browser.tabs.query({ url: `${base}*` })).filter(tab =>
      (tab.pendingUrl || tab.url)?.split(/[?#]/)[0] === base && tab.id != null);
    tabs.sort((a, b) => Number(b.id === sourceTab) - Number(a.id === sourceTab)
      || Number(b.active) - Number(a.active) || (b.lastAccessed || 0) - (a.lastAccessed || 0));
    const tab = tabs[0];
    if (!tab) { await browser.tabs.create({ url: `${base}?${params}` }); return; }
    // Only change the fragment: keep the live React tree and any unsaved drafts.
    params.set('request', crypto.randomUUID());
    await browser.tabs.update(tab.id!, { active: true, url: `${(tab.pendingUrl || tab.url)!.split('#')[0]}#reminder=${params}` });
    await browser.windows.update(tab.windowId, { focused: true });
  };
  const open = async (id: string, sourceTab?: number) => {
    if (id === 'all') {
      await openWorkspace(new URLSearchParams({ tasks: 'unread' }), sourceTab);
      return;
    }
    const state = await read();
    const target = (await shown(state.unread)).find(item => item.id === id);
    if (!target) throw new Error('这条提醒已查看或项目已隐藏，请在任务中心查看。');
    const params = new URLSearchParams({ task: target.jobId, ...(target.generationId ? { generation: target.generationId } : {}) });
    await openWorkspace(params, sourceTab);
  };
  const wake = async () => {
    if (watching) { again = true; return; }
    watching = true;
    let cursor = '', active = false, pending = false;
    clearTimeout(flushTimer);
    try {
      // Persist the first-seen cutoff, but never schedule stored pending before a fresh snapshot.
      await serial(read);
      do {
        again = false;
        const { preferences } = await browser.storage.local.get('preferences') as { preferences?: { token?: string } };
        if (!preferences?.token) break;
        const revision = projectsRevision;
        const snapshot = await bridge<{ revision: string; tasks?: TaskNotice[] }>(`/task-feed${cursor ? `?revision=${encodeURIComponent(cursor)}` : ''}`, preferences.token);
        cursor = snapshot.revision;
        if (snapshot.tasks) {
          active = snapshot.tasks.some(task => task.status === 'running');
          await serial(async () => {
            if (revision !== projectsRevision) { cursor = ''; again = true; return; }
            const state = reconcileReminders(await read(), snapshot.tasks!, Date.now());
            await save(state);
            pending = (await deliver(state)).pending.length > 0;
          });
        }
        await browser.storage.local.remove('reminderConnectionError');
      // A due timer fetches a fresh snapshot before delivery. Do not hold a long poll across it.
      } while ((again || active) && !pending);
    } catch (error) {
      clearTimeout(flushTimer);
      await browser.storage.local.set({ reminderConnectionError: (error as Error).message === 'Not found' ? '请更新并重启本机服务，以启用后台完成提醒。' : '本机服务连接中断，恢复后将同步任务结果。' });
    } finally { watching = false; if (again) void wake(); }
  };
  browser.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== browser.runtime.id || !['alchemy:reminder-get', 'alchemy:reminder-view', 'alchemy:reminder-read', 'alchemy:reminder-settings', 'alchemy:reminder-test', 'alchemy:reminder-open'].includes(message?.type)) return;
    const extension = sender.url?.startsWith(browser.runtime.getURL('/'));
    const content = sender.tab?.id != null && sender.frameId === 0 && /^https?:/.test(sender.url || '');
    if (!extension && !content) return;
    void serial(async () => {
      let state = await read();
      if (message.type === 'alchemy:reminder-settings') {
        const value = message.preferences;
        if (!value || typeof value.sound !== 'boolean' || !['soft', 'bell'].includes(value.tone) || !Number.isInteger(value.volume) || value.volume < 0 || value.volume > 100) throw new Error('无效提醒设置');
        state.preferences = { sound: value.sound, tone: value.tone, volume: value.volume };
        await save(state);
      }
      if (message.type === 'alchemy:reminder-read') {
        if (!Array.isArray(message.ids) || message.ids.some((id: unknown) => typeof id !== 'string')) throw new Error('无效任务');
        const allowed = new Set((await shown(state.unread)).map(item => item.id));
        state = markRemindersRead(state, message.ids.filter((id: string) => allowed.has(id))); await save(state);
      }
      let toast: TaskNotice[] | undefined;
      if (message.type === 'alchemy:reminder-view') {
        if (typeof message.viewId !== 'string' || message.viewId.length > 100 || typeof message.visible !== 'boolean' || !Array.isArray(message.seen) || message.seen.length > 100 || message.seen.some((id: unknown) => typeof id !== 'string' || id.length > 100)) throw new Error('无效界面状态');
        const id = `${sender.tab?.id ?? 'popup'}:${message.viewId}`;
        toast = views.get(id)?.toast;
        views.set(id, { at: Date.now(), visible: message.visible, seen: message.seen, ...(!message.visible && toast ? { toast } : {}) });
        for (const [key, view] of views) if (Date.now() - view.at > 30_000) views.delete(key);
        if (message.visible) {
          const seen = (await shown(state.unread)).filter(item => message.seen.includes(item.id)).map(item => item.id);
          if (seen.length) { state = markRemindersRead(state, seen); await save(state); }
        } else toast = undefined;
      }
      if (toast) toast = toast.filter(item => state.unread.some(unread => unread.id === item.id && !unread.hidden));
      if (message.type === 'alchemy:reminder-test') { await audio(state.preferences); await browser.storage.local.remove('reminderAudioError'); }
      if (message.type === 'alchemy:reminder-open') { if (typeof message.id !== 'string') throw new Error('无效任务'); await open(message.id, sender.tab?.id); }
      const errors = await browser.storage.local.get(['reminderConnectionError', 'reminderAudioError']);
      return { unread: await shown(state.unread), preferences: state.preferences, desktop: await permission(), audioSupported,
        connectionError: errors.reminderConnectionError || '', audioError: errors.reminderAudioError || '', toast };
    }).then(value => reply({ ok: true, value }), error => reply({ error: error.message }));
    return true;
  });
  browser.notifications?.onClicked.addListener(id => {
    if (id !== notificationId) return;
    void serial(async () => {
      const { reminderTarget = [] } = await browser.storage.session.get('reminderTarget');
      const state = await read();
      const targets = (await shown(state.unread)).filter(item => Array.isArray(reminderTarget) && reminderTarget.includes(item.id));
      if (targets.length === 1) await open(targets[0]!.id);
      else if (targets.length) await open('all');
      await browser.notifications.clear(id);
    }).catch(console.error);
  });
  browser.alarms?.onAlarm.addListener(event => { if (event.name === alarm) void wake(); });
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.preferences) void wake();
    if (area === 'session' && changes.showHiddenProjects) void serial(async () => save(await read())).catch(console.error);
  });
  void (async () => {
    try { await browser.alarms?.create(alarm, { periodInMinutes: 1 }); } catch { /* Task starts can still wake unsupported hosts. */ }
    await wake();
  })().catch(console.error);
  const projectsChanged = (ids: string[], hidden?: boolean) => serial(async () => {
    projectsRevision++;
    const state = await read(), changed = new Set(ids);
    state.unread = state.unread.flatMap(item => !changed.has(item.projectId) ? [item] : hidden === undefined ? [] : [{ ...item, hidden }]);
    state.pending = state.pending.filter(id => state.unread.some(item => item.id === id && !item.hidden));
    if (!state.pending.length) state.due = 0;
    await save(state); schedule(state);
  });
  return { wake, projectsChanged };
}
