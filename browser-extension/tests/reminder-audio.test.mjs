import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const compile = async path => ts.transpileModule(await readFile(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const tones = {};
runInNewContext(await compile('../lib/task-reminders.ts'), { exports: tones });
const audioCode = await compile('../entrypoints/reminder-audio/main.ts');
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness() {
  let listener, mode = 'success';
  const players = [], timers = new Set();
  class Audio {
    constructor(url) { this.url = url; players.push(this); }
    async play() {
      if (mode === 'blocked') throw new Error('autoplay');
      if (mode === 'error') queueMicrotask(() => this.onerror?.());
      if (mode === 'success') queueMicrotask(() => this.onended?.());
    }
    pause() { this.paused = true; }
    removeAttribute(name) { if (name === 'src') this.url = ''; }
    load() { this.released = true; }
  }
  const browser = { runtime: { id: 'test', getURL: path => `chrome-extension://test${path}`, onMessage: { addListener(fn) { listener = fn; } } } };
  runInNewContext(audioCode, { Audio, exports: {}, setTimeout: fn => { timers.add(fn); return fn; }, clearTimeout: fn => timers.delete(fn),
    require: name => name === 'wxt/browser' ? { browser } : tones });
  return { players, timers, setMode(next) { mode = next; }, listener: (...args) => listener(...args),
    send: (tone = 'calm', volume = 30) => new Promise((resolve, reject) => listener({ type: 'alchemy:reminder-audio', preferences: { tone, volume } }, { id: 'test' }, value => value.error ? reject(new Error(value.error)) : resolve(value))),
  };
}

test('all ten sounds ship unchanged in the build, with unique IDs and bounded playback gain', async () => {
  assert.equal(tones.REMINDER_TONES.length, 10);
  assert.equal(new Set(tones.REMINDER_TONES.map(tone => tone.id)).size, 10);
  for (const tone of tones.REMINDER_TONES) {
    const source = await readFile(new URL(`../public/sounds/akx/${tone.file}`, import.meta.url));
    assert.equal(source.subarray(0, 4).toString(), 'OggS');
    assert.deepEqual(await readFile(new URL(`../.output/chrome-mv3/sounds/akx/${tone.file}`, import.meta.url)), source);
    assert.ok(tone.gain > 0 && tone.gain <= 1);
  }
});

test('every choice plays its bundled file at user volume and releases its player', async () => {
  const h = harness();
  for (const tone of tones.REMINDER_TONES) {
    h.setMode('hold');
    const pending = h.send(tone.id, 60), player = h.players.at(-1);
    assert.equal(player.url, `chrome-extension://test/sounds/akx/${tone.file}`);
    assert.equal(player.volume, .6 * tone.gain);
    player.onended(); await pending;
    assert.equal(player.paused, true); assert.equal(player.released, true);
    assert.equal(player.onended, null); assert.equal(player.onerror, null);
    assert.equal(h.timers.size, 0);
  }
});

test('invalid inputs fail before any audio resource is created; foreign messages are ignored', async () => {
  const h = harness();
  for (const tone of ['../../private', 'https://example.com/a.ogg', '__proto__', null, {}]) await assert.rejects(h.send(tone), /无效/);
  for (const volume of [-1, 101, NaN, '30', 2.5]) await assert.rejects(h.send('calm', volume), /无效/);
  assert.equal(h.players.length, 0);
  assert.equal(h.listener({ type: 'alchemy:reminder-audio' }, { id: 'foreign' }, () => assert.fail()), undefined);
});

test('zero volume and concurrent requests stay silent without unlocking the active sound', async () => {
  const h = harness(); await h.send('calm', 0); assert.equal(h.players.length, 0);
  h.setMode('hold');
  const first = h.send(); await h.send('cloud'); await h.send('tech');
  assert.equal(h.players.length, 1);
  h.players[0].onended(); await first;
  h.setMode('success'); await h.send('tech'); assert.equal(h.players.length, 2);
});

for (const mode of ['blocked', 'error', 'timeout']) test(`${mode} releases resources and allows retry`, async () => {
  const h = harness(); h.setMode(mode);
  const pending = assert.rejects(h.send(), /阻止|读取失败|超时/);
  if (mode === 'timeout') { await tick(); for (const timer of h.timers) timer(); }
  await pending;
  assert.equal(h.players[0].released, true); assert.equal(h.timers.size, 0);
  h.setMode('success'); await h.send('glisten'); assert.equal(h.players.length, 2);
});
