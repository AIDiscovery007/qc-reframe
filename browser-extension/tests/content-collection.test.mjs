import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { placeImageAction } from "../lib/image-action-placement.ts";
import { placeImageMenu } from "../lib/image-menu-placement.ts";

const compiled = ts.transpileModule(await readFile(new URL("../entrypoints/content.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

// Model only the DOM operations used by collection; no browser shadow-root access.
class Element {
  style = {};
  dataset = {};
  hidden = false;
  isConnected = true;
  listeners = new Map();
  animations = [];
  hovered = false;
  children = new Map();
  bounds = { x: 10, y: 20, left: 10, top: 20, right: 210, bottom: 220, width: 200, height: 200 };
  addEventListener(type, fn) { this.listeners.set(type, [...(this.listeners.get(type) || []), fn]); }
  emit(type, event = {}) {
    for (const fn of this.listeners.get(type) || []) fn({ isTrusted: true, detail: 1, preventDefault() {}, stopPropagation() {}, ...event });
  }
  querySelector(selector) { return this.children.get(selector); }
  setAttribute(name, value) { this[name] = value; }
  getBoundingClientRect() { return { ...this.bounds }; }
  getClientRects() { return [this.bounds]; }
  matches(selector) { return selector === ":hover" && this.hovered; }
  contains(node) { return node != null && node === this.contained; }
  animate(frames, options) {
    const animation = { frames, options, cancelled: 0, cancel() { this.cancelled++; } };
    this.animations.push(animation);
    return animation;
  }
  prepend() {}
  append() {}
  remove() { this.isConnected = false; }
}
class ImageElement extends Element {
  constructor(src, x = 10) {
    super();
    this.currentSrc = src;
    Object.assign(this.bounds, { x, left: x, right: x + 200 });
  }
}

function setup(t, { reducedMotion = true, allowPanel = false, realPlacement = false } = {}) {
  const shadow = new Element(), host = new Element(), document = new Element();
  const selectors = [".pick-collect", ".pick-control", ".pick-toggle", ".pick-liquid", ".pick-menu", ".pick-open", ".pick-workspace", ".panel", ".notice", ".close", ".refresh", ".dismiss", ".retry", ".panel-body"];
  for (const selector of selectors) shadow.children.set(selector, new Element());
  for (const element of shadow.children.values()) element.focus = () => { shadow.activeElement = element; };
  const menu = shadow.querySelector(".pick-menu"), trigger = shadow.querySelector(".pick-toggle"), openButton = shadow.querySelector(".pick-open");
  menu.hidden = true;
  menu.contained = openButton;
  const collectButton = shadow.querySelector(".pick-collect"), notice = shadow.querySelector(".notice"), retry = shadow.querySelector(".retry");
  shadow.querySelector(".panel").hidden = notice.hidden = retry.hidden = true;
  shadow.querySelector(".panel").bounds = { x: 568, y: 12, left: 568, top: 12, right: 988, bottom: 788, width: 420, height: 776 };
  notice.bounds = { x: 20, y: 700, left: 20, top: 700, right: 400, bottom: 780, width: 380, height: 80 };
  notice.children.set("strong", new Element());
  notice.children.set(".notice-copy > span", new Element());
  host.attachShadow = () => shadow;
  document.createElement = tag => tag === "div" ? host : new Element();
  document.documentElement = new Element();
  document.body = new Element();
  let hit, messageHandler, invalidate;
  document.elementsFromPoint = () => hit ? [hit] : [];
  const requests = [], timers = new Map(), liquidStates = [], frames = new Map(), intervals = [];
  let liquidDisposed = false;
  const motion = Object.assign(new Element(), { matches: reducedMotion });
  let nextTimer = 0;
  const modules = {
    "../lib/motion-preference": {
      getMotion: () => ({ reduced: motion.matches }),
      subscribeMotion: fn => {
        motion.addEventListener("change", fn);
        return () => motion.listeners.set("change", motion.listeners.get("change").filter(listener => listener !== fn));
      },
    },
    "wxt/browser": { browser: { runtime: { onMessage: { addListener(fn) { messageHandler = fn; }, removeListener() {} } } } },
    "../lib/page-panel": { registeredPagePanel() { assert.ok(allowPanel, "collection must not open the panel"); return pagePanel.mount; } },
    "./popup/style.css?inline": { default: "" },
    "./popup/shell.css?inline": { default: "" },
    "../lib/collection-liquid": { liquidTiming: { duration: 240, ease: "ease-out" }, mountCollectionLiquid: () => ({ update(state) { liquidStates.push({ ...state }); }, dispose() { liquidDisposed = true; } }) },
    "../lib/image-menu-placement": { placeImageMenu },
    "../lib/brand": { logo: "test-logo" },
    "../lib/client": { request(message) { return new Promise((resolve, reject) => requests.push({ message, resolve, reject })); } },
    "../lib/image-action-placement": {
      imageActionEnvironment: () => ({ obstacles: [], isClear: () => true }),
      placeImageAction: realPlacement ? placeImageAction : bounds => ({ left: bounds.left + 10, top: bounds.top + 10, right: bounds.left + 50, bottom: bounds.top + 50, compact: false }),
    },
  };
  // Tests opening the panel start with the bundle already injected unless they model lazy loading.
  const pagePanel = { mounts: 0, unmounts: 0, mount: undefined };
  pagePanel.mount = container => { assert.equal(container, shadow.querySelector(".panel-body")); pagePanel.mounts++; return () => { pagePanel.unmounts++; }; };
  const exports = {};
  runInNewContext(compiled, {
    exports, require: name => { assert.ok(name in modules, `unexpected import: ${name}`); return modules[name]; },
    defineContentScript: value => value,
    document, window: new Element(), HTMLImageElement: ImageElement, innerWidth: 1000, innerHeight: 800,
    getComputedStyle: () => ({ backgroundImage: "none" }),
    matchMedia: () => motion,
    crypto, performance, queueMicrotask, Error,
    setTimeout: fn => { const id = ++nextTimer; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id),
    requestAnimationFrame: fn => { const id = ++nextTimer; frames.set(id, fn); return id; }, cancelAnimationFrame: id => frames.delete(id),
  });
  exports.default.main({
    addEventListener: (target, type, fn) => target.addEventListener(type, fn),
    setInterval(fn) { intervals.push(fn); }, onInvalidated: fn => { invalidate = fn; },
  });
  t.after(() => invalidate());
  return {
    tick() { intervals.forEach(fn => fn()); const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn()); },
    liquidStates, pagePanel, get liquidDisposed() { return liquidDisposed; },
    requests, notice, retry, timers, document, shadow, host, menu, trigger, openButton, collectButton, workspaceButton: shadow.querySelector(".pick-workspace"), motion, dispose: () => invalidate(),
    hover(image) { hit = image; document.emit("pointermove", { composedPath: () => [], clientX: image.bounds.x + 5, clientY: image.bounds.y + 5 }); },
    click(detail = 1) { trigger.emit("click", { detail }); collectButton.emit("click", { detail }); },
    geometry(message) { let value; messageHandler(message, {}, reply => { value = reply; }); return value; },
  };
}
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

test("the logo trigger opens all three actions without collecting, with Escape restoring focus", t => {
  const ui = setup(t, { reducedMotion: false });
  ui.hover(new ImageElement("https://example.com/a.png"));
  ui.trigger.emit("click");
  assert.equal(ui.requests.length, 0);
  assert.equal(ui.menu.hidden, false);
  assert.equal(ui.trigger["aria-expanded"], "true");
  assert.equal(ui.shadow.activeElement, ui.openButton);
  assert.equal(ui.openButton.animations.length, 1);
  ui.host.emit("keydown", { key: "Escape" });
  assert.equal(ui.menu.hidden, true);
  assert.equal(ui.trigger["aria-expanded"], "false");
  assert.equal(ui.shadow.activeElement, ui.trigger);
  assert.equal(ui.openButton.animations[0].cancelled, 1);
  ui.trigger.emit("keydown", { key: "ArrowDown" });
  assert.equal(ui.menu.hidden, false);
  assert.equal(ui.openButton.animations.length, 1, "keyboard opening is immediate");
  ui.host.emit("keydown", { key: "Tab" });
  assert.equal(ui.menu.hidden, true);
});

test("immediate reverse uses the image that opened the menu and never sends collect", async t => {
  const ui = setup(t), first = new ImageElement("https://example.com/a.png");
  ui.hover(first); ui.trigger.emit("click", { detail: 0 });
  ui.openButton.emit("click", { detail: 0 });
  assert.equal(ui.menu.hidden, true);
  assert.equal(ui.requests.length, 1);
  assert.equal(ui.requests[0].message.type, "alchemy:select");
  assert.equal(ui.requests[0].message.target.src, first.currentSrc);
  const target = ui.requests[0].message.target;
  assert.equal(ui.geometry({ type: "alchemy:rect", ...target }).x, first.bounds.x);
  ui.requests[0].reject(new Error("扩展已失效，请刷新网页"));
  await settle();
  assert.equal(ui.notice.querySelector("strong").textContent, "打开失败");
  assert.equal(ui.geometry({ type: "alchemy:rect", ...target }), null);
});

test("moving to another image collapses the menu, cancels entry and retargets only after reopening", t => {
  for (const [reducedMotion, detail] of [[false, 1], [false, 0], [true, 1]]) {
    const ui = setup(t, { reducedMotion });
    const first = new ImageElement("https://example.com/a.png"), second = new ImageElement("https://example.com/b.png", 400);
    ui.hover(first); ui.trigger.emit("click", { detail });
    ui.hover(first);
    assert.equal(ui.menu.hidden, false, "moving within the same image keeps actions reachable");
    ui.document.emit("pointermove", { composedPath: () => [ui.host], clientX: 410, clientY: 30 });
    assert.equal(ui.menu.hidden, false, "moving into extension controls does not retarget");
    ui.hover(second); ui.tick();
    assert.equal(ui.menu.hidden, true);
    assert.equal(ui.trigger["aria-expanded"], "false");
    assert.equal(ui.shadow.activeElement, ui.trigger, "focus leaves the hidden menu");
    assert.equal(ui.liquidStates.at(-1).open, false);
    assert.equal(ui.liquidStates.at(-1).instant, true);
    assert.ok(ui.openButton.animations.every(animation => animation.cancelled > 0));
    ui.openButton.emit("click", { detail });
    ui.collectButton.emit("click", { detail });
    assert.equal(ui.requests.length, 0, "stale menu actions cannot submit the previous image");
    ui.trigger.emit("click", { detail });
    ui.collectButton.emit("click", { detail });
    assert.equal(ui.requests.length, 1);
    assert.equal(ui.requests[0].message.target.src, second.currentSrc);
    assert.equal(ui.requests[0].message.target.rect.x, second.bounds.x);
  }
});

test("outside clicks dismiss the menu and a reused image cannot submit its old reference", t => {
  const ui = setup(t), image = new ImageElement("https://example.com/a.png");
  ui.hover(image); ui.trigger.emit("click");
  assert.equal(ui.openButton.animations.length, 0, "reduced motion skips entry");
  ui.document.emit("pointerdown", { composedPath: () => [] });
  assert.equal(ui.menu.hidden, true);
  ui.trigger.emit("click");
  image.currentSrc = "https://example.com/reused.png";
  ui.openButton.emit("click");
  assert.equal(ui.requests.length, 0);
});

test("a slower successful collection preserves another image's error and retry target", async t => {
  const ui = setup(t);
  const first = new ImageElement("https://example.com/a.png"), second = new ImageElement("https://example.com/b.png", 300);
  ui.hover(first); ui.click();
  ui.hover(second); ui.click();
  ui.requests[1].reject(new Error("图片 B 保存失败"));
  await settle();
  ui.requests[0].resolve({ projectId: "a", created: true });
  await settle();
  assert.equal(ui.notice.dataset.state, "error");
  assert.equal(ui.notice.querySelector(".notice-copy > span").textContent, "图片 B 保存失败");
  assert.equal(ui.retry.hidden, false);
  assert.equal(ui.timers.size, 0, "a later success must not schedule dismissal of the failure");
  ui.retry.emit("click");
  assert.equal(ui.requests.length, 3);
  assert.equal(ui.requests[2].message.target.src, second.currentSrc);
});

test("clicking after a virtualized image changes source collects the current source without pointer movement", t => {
  const ui = setup(t), image = new ImageElement("https://example.com/old.png");
  ui.hover(image);
  image.currentSrc = "https://example.com/new.png";
  ui.click();
  assert.equal(ui.requests.length, 1);
  assert.equal(ui.requests[0].message.type, "alchemy:collect");
  assert.equal(ui.requests[0].message.target.src, image.currentSrc);
});

test("capture geometry stays bound to the clicked element after hovering a duplicate source", async t => {
  const ui = setup(t);
  const first = new ImageElement("https://example.com/same.png"), second = new ImageElement(first.currentSrc, 400);
  ui.hover(first); ui.click();
  const { captureId, src } = ui.requests[0].message.target;
  assert.ok(captureId);
  ui.hover(second);
  const message = { type: "alchemy:rect", src, captureId };
  assert.equal(ui.geometry(message).x, first.bounds.x);
  first.currentSrc = "https://example.com/reused.png";
  assert.equal(ui.geometry(message), null, "reused original elements must not fall back to another matching image");
  first.currentSrc = src;
  ui.requests[0].resolve({ projectId: "a", created: true });
  await settle();
  assert.equal(ui.geometry(message), null, "completed captures must release their element mapping");
});


test("pointer collection animates the notice once across consecutive saves and cancels when reduced motion changes", async t => {
  const ui = setup(t, { reducedMotion: false });
  ui.hover(new ImageElement("https://example.com/a.png")); ui.click();
  assert.equal(ui.notice.animations.length, 1);
  ui.hover(new ImageElement("https://example.com/b.png", 300)); ui.click();
  ui.requests[0].resolve({ projectId: "a", created: true });
  ui.requests[1].resolve({ projectId: "b", created: true });
  await settle();
  assert.equal(ui.notice.animations.length, 1, "updating a visible notice must not replay its entrance");
  ui.motion.matches = true;
  ui.motion.emit("change");
  assert.equal(ui.notice.animations[0].cancelled, 1);
});

test("keyboard collection and reduced motion skip notice entrance animation", async t => {
  for (const [reducedMotion, detail] of [[false, 0], [true, 1]]) {
    const ui = setup(t, { reducedMotion });
    ui.hover(new ImageElement("https://example.com/a.png")); ui.click(detail);
    ui.requests[0].resolve({ projectId: "a", created: true });
    await settle();
    assert.equal(ui.notice.animations.length, 0);
    assert.equal(ui.notice.dataset.state, "saved");
  }
});

test("successful notice pauses dismissal while hidden, hovered or focused and resumes afterwards", async t => {
  const ui = setup(t);
  ui.hover(new ImageElement("https://example.com/a.png")); ui.click();
  ui.requests[0].resolve({ projectId: "a", created: true });
  await settle();
  assert.equal(ui.timers.size, 1);
  ui.document.hidden = true; ui.document.emit("visibilitychange");
  assert.equal(ui.timers.size, 0);
  ui.document.hidden = false; ui.document.emit("visibilitychange");
  assert.equal(ui.timers.size, 1);
  ui.notice.hovered = true; ui.notice.emit("pointerenter");
  assert.equal(ui.timers.size, 0);
  ui.notice.hovered = false; ui.notice.emit("pointerleave");
  assert.equal(ui.timers.size, 1);
  ui.notice.contained = ui.retry; ui.shadow.activeElement = ui.retry;
  ui.notice.emit("focusin");
  assert.equal(ui.timers.size, 0);
  ui.document.emit("visibilitychange");
  assert.equal(ui.timers.size, 0, "visibility changes must not restart the timer while focus remains inside");
  ui.shadow.activeElement = null; ui.notice.emit("focusout");
  await settle();
  assert.equal(ui.timers.size, 1);
  [...ui.timers.values()][0]();
  assert.equal(ui.notice.hidden, true);
  assert.equal(ui.timers.size, 0);
});

test("invalidating the content context cancels notice animation and timer", async t => {
  const ui = setup(t, { reducedMotion: false });
  ui.hover(new ImageElement("https://example.com/a.png")); ui.click();
  ui.requests[0].resolve({ projectId: "a", created: true });
  await settle();
  assert.equal(ui.timers.size, 1);
  ui.dispose();
  assert.equal(ui.timers.size, 0);
  assert.equal(ui.notice.animations[0].cancelled, 1);
});


test("liquid actions reverse promptly, skip keyboard motion and dispose with the content", t => {
  const ui = setup(t, { reducedMotion: false });
  ui.hover(new ImageElement("https://example.com/a.png"));
  ui.trigger.emit("click");
  assert.equal(ui.liquidStates.at(-1).open, true);
  assert.equal(ui.liquidStates.at(-1).instant, false);
  ui.trigger.emit("click");
  assert.equal(ui.menu.hidden, true, "closing removes the action immediately while its surface returns");
  assert.equal(ui.liquidStates.at(-1).open, false);
  assert.equal(ui.liquidStates.at(-1).instant, false);
  ui.trigger.emit("click");
  assert.equal(ui.liquidStates.at(-1).open, true, "reopening interrupts the return without a timer lock");
  ui.motion.matches = true; ui.motion.emit("change");
  assert.equal(ui.liquidStates.at(-1).instant, true);
  ui.host.emit("keydown", { key: "Escape" });
  assert.equal(ui.liquidStates.at(-1).open, false);
  assert.equal(ui.liquidStates.at(-1).instant, true);
  ui.trigger.emit("keydown", { key: "ArrowDown" });
  assert.equal(ui.liquidStates.at(-1).instant, true);
  ui.dispose();
  assert.equal(ui.liquidDisposed, true);
});


test("the three menu actions support arrow navigation, Home, End and Escape", t => {
  const ui = setup(t);
  ui.hover(new ImageElement("https://example.com/a.png"));
  ui.trigger.emit("keydown", { key: "ArrowUp" });
  assert.equal(ui.shadow.activeElement, ui.workspaceButton);
  ui.host.emit("keydown", { key: "ArrowDown" });
  assert.equal(ui.shadow.activeElement, ui.openButton);
  ui.host.emit("keydown", { key: "ArrowDown" });
  assert.equal(ui.shadow.activeElement, ui.collectButton);
  ui.host.emit("keydown", { key: "ArrowDown" });
  assert.equal(ui.shadow.activeElement, ui.workspaceButton);
  ui.host.emit("keydown", { key: "End" });
  assert.equal(ui.shadow.activeElement, ui.workspaceButton);
  ui.host.emit("keydown", { key: "Home" });
  assert.equal(ui.shadow.activeElement, ui.openButton);
  ui.host.emit("keydown", { key: "Escape" });
  assert.equal(ui.shadow.activeElement, ui.trigger);
  assert.equal(ui.requests.length, 0);
});

test("collecting from the menu uses its pinned image and rejects a recycled source", t => {
  const ui = setup(t), first = new ImageElement("https://example.com/a.png");
  ui.hover(first); ui.trigger.emit("click");
  ui.collectButton.emit("click");
  assert.equal(ui.requests[0].message.target.src, first.currentSrc);
  assert.equal(ui.requests[0].message.type, "alchemy:collect");
  assert.equal(ui.shadow.activeElement, ui.trigger);
  ui.trigger.emit("click");
  first.currentSrc = "https://example.com/recycled.png";
  ui.collectButton.emit("click");
  assert.equal(ui.requests.length, 1);
});

test("closing the reverse panel keeps the liquid root available for the next menu", t => {
  const ui = setup(t, { allowPanel: true });
  ui.hover(new ImageElement("https://example.com/a.png"));
  ui.trigger.emit("click");
  ui.geometry({ type: "alchemy:show" });
  ui.shadow.querySelector(".close").emit("click");
  assert.equal(ui.liquidDisposed, false);
  ui.trigger.emit("click");
  assert.equal(ui.liquidStates.at(-1).open, true);
});


test("user opening the panel loads it on demand and keeps the page usable when loading fails", async t => {
  // Given a page without the panel bundle, When the panel opens, Then it requests the bundle once and mounts after it registers.
  const ui = setup(t, { allowPanel: true });
  const mount = ui.pagePanel.mount;
  ui.pagePanel.mount = undefined;
  ui.geometry({ type: "alchemy:show" });
  ui.geometry({ type: "alchemy:show" });
  assert.deepEqual(ui.requests.map(item => item.message.type), ["alchemy:panel-load"]);
  assert.equal(ui.shadow.querySelector(".panel").hidden, false);
  ui.pagePanel.mount = mount;
  ui.requests[0].resolve(); await settle();
  assert.equal(ui.pagePanel.mounts, 1);
  ui.shadow.querySelector(".close").emit("click");
  assert.equal(ui.pagePanel.unmounts, 1);
  ui.geometry({ type: "alchemy:show" });
  assert.equal(ui.requests.length, 1, "an injected bundle is reused without another request");
  assert.equal(ui.pagePanel.mounts, 2);

  // When injection fails, Then the panel closes and the notice offers a page refresh without a retry.
  const failing = setup(t, { allowPanel: true });
  failing.pagePanel.mount = undefined;
  failing.geometry({ type: "alchemy:show" });
  failing.requests[0].reject(new Error("逆向面板未能加载，请刷新网页后重试")); await settle(); await settle();
  assert.equal(failing.shadow.querySelector(".panel").hidden, true);
  assert.equal(failing.notice.querySelector("strong").textContent, "打开失败");
  assert.equal(failing.shadow.querySelector(".refresh").hidden, false);
  assert.equal(failing.retry.hidden, true);
  assert.equal(failing.pagePanel.mounts, 0);
});

test("position polling keeps the menu open when CSS rounds fractional coordinates", t => {
  const ui = setup(t, { reducedMotion: false });
  const image = new ImageElement("https://example.com/a.png", 263.328125);
  ui.hover(image); ui.tick(); ui.trigger.emit("click");
  const control = ui.shadow.querySelector(".pick-control");
  for (let poll = 0; poll < 4; poll++) {
    // CSSOM serializes the assigned coordinate with fewer decimal places.
    control.style.left = "273.328px";
    ui.tick();
    assert.equal(ui.menu.hidden, false, "a serialization difference is not movement");
  }
  assert.equal(ui.openButton.animations[0].cancelled, 0);
  image.bounds.left += 20;
  ui.tick();
  assert.equal(ui.menu.hidden, true, "actual image movement still invalidates menu placement");
});


test("focus transfer to collect does not dismiss the menu before its click", async t => {
  const ui = setup(t);
  ui.hover(new ImageElement("https://example.com/a.png"));
  ui.trigger.emit("click");
  ui.shadow.activeElement = null;
  ui.menu.emit("focusout", { relatedTarget: ui.collectButton });
  await settle();
  ui.shadow.activeElement = ui.collectButton;
  ui.collectButton.emit("click");
  assert.equal(ui.requests.length, 1);
  assert.equal(ui.requests[0].message.type, "alchemy:collect");
  assert.equal(ui.notice.dataset.state, "saving");
  ui.requests[0].resolve({ projectId: "collected", created: true });
  await settle();
  assert.equal(ui.notice.dataset.state, "saved");
});


test("workspace entry opens without capturing or collecting the hovered image", async t => {
  const ui = setup(t);
  ui.hover(new ImageElement("https://example.com/a.png"));
  ui.trigger.emit("click");
  ui.workspaceButton.emit("click", { isTrusted: false });
  assert.equal(ui.requests.length, 0);
  ui.workspaceButton.emit("click");
  ui.workspaceButton.emit("click");
  assert.equal(ui.requests.length, 1, "closed menu rejects duplicate clicks");
  assert.equal(JSON.stringify(ui.requests[0].message), '{"type":"alchemy:open-workspace"}');
  assert.equal(ui.menu.hidden, true);
  assert.equal(ui.shadow.activeElement, ui.trigger);
  ui.requests[0].resolve();
  await settle();
  assert.equal(ui.notice.hidden, true);
});

test("workspace opening errors show feedback without a collection retry", async t => {
  const ui = setup(t);
  ui.hover(new ImageElement("https://example.com/a.png"));
  ui.trigger.emit("click");
  ui.workspaceButton.emit("click");
  ui.requests[0].reject(new Error("无法打开标签页"));
  await settle();
  assert.equal(ui.notice.hidden, false);
  assert.equal(ui.notice.querySelector("strong").textContent, "打开工作台失败");
  assert.equal(ui.notice.querySelector(".notice-copy > span").textContent, "无法打开标签页");
  assert.equal(ui.retry.hidden, true);
});


test("an open non-modal panel keeps page image actions available and collection leaves it open", async t => {
  const ui = setup(t, { allowPanel: true, realPlacement: true });
  ui.geometry({ type: "alchemy:show" });
  ui.hover(new ImageElement("https://example.com/visible.png")); ui.tick();
  assert.equal(ui.shadow.querySelector(".pick-control").style.display, "inline-flex");
  ui.click();
  assert.equal(ui.requests[0].message.type, "alchemy:collect");
  ui.requests[0].resolve({ projectId: "collected", created: true }); await settle();
  assert.equal(ui.shadow.querySelector(".panel").hidden, false);
  let prevented = false;
  ui.document.emit("pointerdown", { composedPath: () => [], preventDefault() { prevented = true; } });
  assert.equal(prevented, false, "page controls keep their default behavior");
  assert.equal(ui.shadow.querySelector(".panel").hidden, false, "outside clicks do not dismiss the panel");
});

test("page entry and its menu avoid the open panel, and covered images do not expose an entry", t => {
  const ui = setup(t, { allowPanel: true, realPlacement: true });
  ui.geometry({ type: "alchemy:show" });
  ui.hover(new ImageElement("https://example.com/partial.png", 420)); ui.tick();
  const control = ui.shadow.querySelector(".pick-control");
  assert.equal(control.style.display, "inline-flex");
  assert.ok(parseFloat(control.style.left) + 40 < 568);
  ui.trigger.emit("click");
  assert.equal(ui.menu.hidden, false);
  for (const action of [ui.openButton, ui.collectButton, ui.workspaceButton])
    assert.ok(parseFloat(ui.menu.style.left) + parseFloat(action.style.left) + 40 < 568);
  ui.host.emit("keydown", { key: "Escape" });
  ui.shadow.activeElement = null;
  ui.hover(new ImageElement("https://example.com/covered.png", 650)); ui.tick();
  assert.equal(control.style.display, "none");
  ui.shadow.querySelector(".close").emit("click");
  assert.equal(control.style.display, "inline-flex", "closing the panel releases the reserved image area");
});

test("panel visibility polling invalidates an image menu that moves under the panel", t => {
  const ui = setup(t, { allowPanel: true, realPlacement: true });
  ui.geometry({ type: "alchemy:show" });
  const image = new ImageElement("https://example.com/moving.png");
  ui.hover(image); ui.tick(); ui.trigger.emit("click");
  Object.assign(image.bounds, { x: 650, left: 650, right: 850 });
  ui.tick();
  assert.equal(ui.menu.hidden, true);
  assert.equal(ui.shadow.querySelector(".pick-control").style.display, "none");
});

test("extension shortcuts do not bubble to the host site or cancel native field behavior", t => {
  const ui = setup(t);
  let stopped = false, prevented = false;
  ui.host.emit("keydown", { key: "ArrowLeft", stopPropagation() { stopped = true; }, preventDefault() { prevented = true; } });
  assert.equal(stopped, true);
  assert.equal(prevented, false);
});

for (const entry of ["pointerdown", "focusin"]) {
  test(`entering the panel via ${entry} dismisses the image menu without stealing textarea keys`, t => {
    const ui = setup(t, { allowPanel: true });
    ui.geometry({ type: "alchemy:show" });
    ui.hover(new ImageElement("https://example.com/a.png"));
    ui.trigger.emit("click");
    assert.equal(ui.menu.hidden, false);
    const panel = ui.shadow.querySelector(".panel"), textarea = new Element();
    textarea.focus = () => { ui.shadow.activeElement = textarea; };
    if (entry === "focusin") textarea.focus();
    panel.emit(entry, { target: textarea });
    assert.equal(ui.menu.hidden, true);
    assert.equal(ui.trigger["aria-expanded"], "false");
    if (entry === "pointerdown") textarea.focus();
    for (const key of ["ArrowUp", "ArrowDown", "Home", "End", "Tab"]) {
      let prevented = false;
      ui.host.emit("keydown", { key, preventDefault() { prevented = true; } });
      assert.equal(prevented, false, `${key} retains its native textarea behavior`);
      assert.equal(ui.shadow.activeElement, textarea, `${key} does not redirect focus to the image actions`);
    }
    assert.equal(panel.hidden, false);
  });
}

test("an open image menu only handles navigation when its trigger or actions have focus", t => {
  const ui = setup(t);
  ui.hover(new ImageElement("https://example.com/a.png"));
  ui.trigger.emit("click");
  ui.retry.focus();
  for (const key of ["ArrowUp", "ArrowDown", "Home", "End", "Tab"]) {
    let prevented = false;
    ui.host.emit("keydown", { key, preventDefault() { prevented = true; } });
    assert.equal(prevented, false);
    assert.equal(ui.shadow.activeElement, ui.retry, `${key} does not take focus from another extension control`);
  }
});
