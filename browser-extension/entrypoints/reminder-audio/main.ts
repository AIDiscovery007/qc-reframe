import { browser } from 'wxt/browser';
import { reminderTone } from '../../lib/task-reminders';

let playing = false;
browser.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== browser.runtime.id || message?.type !== 'alchemy:reminder-audio') return;
  void (async () => {
    let audio: HTMLAudioElement | undefined, timeout: ReturnType<typeof setTimeout> | undefined;
    let ownsPlayback = false;
    try {
      const { volume } = message.preferences || {};
      const tone = reminderTone(message.preferences?.tone);
      if (!tone || !Number.isInteger(volume) || volume < 0 || volume > 100) throw new Error('无效提示音');
      if (!playing && volume > 0) {
        playing = ownsPlayback = true;
        audio = new Audio(browser.runtime.getURL(`/sounds/akx/${tone.file}`));
        audio.volume = volume / 100 * tone.gain;
        const player = audio;
        await new Promise<void>((resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('提示音播放超时，请重试试听。')), 10_000);
          player.onended = () => resolve();
          player.onerror = () => reject(new Error('提示音读取失败，请重新加载扩展后重试。'));
          void (async () => {
            try { await player.play(); }
            catch { reject(new Error('浏览器阻止了声音播放，请在设置中重试试听。')); }
          })();
        });
      }
      reply({ ok: true });
    } catch (error) { reply({ error: (error as Error).message }); }
    finally {
      clearTimeout(timeout);
      if (audio) { audio.onended = null; audio.onerror = null; audio.pause(); audio.removeAttribute('src'); audio.load(); }
      if (ownsPlayback) playing = false;
    }
  })();
  return true;
});
