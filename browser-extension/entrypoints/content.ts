import { browser } from "wxt/browser";
import { getMotion, subscribeMotion } from "../lib/motion-preference";
import { registeredPagePanel } from "../lib/page-panel";
import panelCss from "./popup/style.css?inline";
import shellCss from "./popup/shell.css?inline";
import { request } from "../lib/client";
import { placeImageMenu, type MenuOffsets } from "../lib/image-menu-placement";
import { mountCollectionLiquid, liquidTiming } from "../lib/collection-liquid";
import { logo } from "../lib/brand";
import { imageActionEnvironment, placeImageAction, type ActionPlacement } from "../lib/image-action-placement";
import type { CollectionResult, ImageTarget } from "../lib/types";

type PickedImage = { element: Element; src: string };
type CollectionState = "idle" | "saving" | "saved" | "error";

export default defineContentScript({
  matches: ["http://*/*", "https://*/*"],
  main(ctx) {
    const host = document.createElement("div");
    host.style.cssText =
      "all:initial;position:fixed;z-index:2147483647;pointer-events:none;inset:0;";
    const shadow = host.attachShadow({ mode: "closed" });
    shadow.innerHTML = `<div class="pick-control"><div class="pick-liquid" aria-hidden="true"></div><button class="pick-toggle" type="button" aria-label="Reframe 图片操作" title="Reframe 图片操作" aria-haspopup="menu" aria-expanded="false" aria-controls="reframe-image-menu"><img src="${logo}" alt="" draggable="false"></button></div>
    <div class="pick-menu" id="reframe-image-menu" role="menu" aria-label="图片操作" hidden><button class="pick-action pick-open" type="button" role="menuitem" tabindex="-1" aria-label="立即逆向" title="立即逆向"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="9" cy="9" r="1.5"/><path d="m5 18 6-6 3 3 3-4 3 4"/></svg></button><button class="pick-action pick-collect" type="button" role="menuitem" tabindex="-1" aria-label="加入 Reframe" title="加入 Reframe" data-state="idle"><svg class="pick-add" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg><svg class="pick-done" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg><span class="pick-wait" aria-hidden="true"></span></button><button class="pick-action pick-workspace" type="button" role="menuitem" tabindex="-1" aria-label="打开工作台" title="打开工作台"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M9 9v11"/></svg></button></div>
    <section class="panel" role="dialog" aria-modal="false" aria-label="QC-Reframe 图片逆向" hidden><div class="bar"><span><img src="${logo}" alt="">QC-Reframe</span><button class="close" type="button" aria-label="关闭逆向面板">×</button></div><div class="panel-body"></div></section>
    <div class="notice" popover="manual" hidden><div class="notice-copy" role="status" aria-live="polite" aria-atomic="true"><strong></strong><span></span></div><div class="notice-actions"><button class="retry" type="button" hidden>重试</button><button class="refresh" type="button" hidden>刷新网页</button><button class="dismiss" type="button" aria-label="关闭收集提示">×</button></div></div>`;
    const styles = document.createElement("style");
    styles.textContent = panelCss + shellCss;
    shadow.prepend(styles);
    document.documentElement.append(host);
    const collectButton = shadow.querySelector<HTMLButtonElement>(".pick-collect")!;
    const control = shadow.querySelector<HTMLElement>(".pick-control")!;
    const trigger = shadow.querySelector<HTMLButtonElement>(".pick-toggle")!;
    const menu = shadow.querySelector<HTMLElement>(".pick-menu")!;
    const openButton = shadow.querySelector<HTMLButtonElement>(".pick-open")!;
    const workspaceButton = shadow.querySelector<HTMLButtonElement>(".pick-workspace")!;
    let liquid: ReturnType<typeof mountCollectionLiquid> | undefined;
    let menuOffsets: MenuOffsets = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }];
    let menuPointer = false;
    const updateLiquid = (instant = true) => {
      liquid?.update({ offsets: menuOffsets, open: !menu.hidden, instant: instant || getMotion().reduced });
    };
    let menuTarget: PickedImage | undefined;
    let menuAnimations: Animation[] = [];
    const actions = [openButton, collectButton, workspaceButton];
    let selecting = false;
    const closeMenu = (restoreFocus = false, animate = false) => {
      const wasOpen = !menu.hidden;
      menuAnimations.forEach(animation => animation.cancel());
      menu.hidden = true;
      menuTarget = undefined;
      if (wasOpen) updateLiquid(!animate);
      trigger.setAttribute("aria-expanded", "false");
      if (restoreFocus && control.getClientRects().length) trigger.focus({ preventScroll: true });
    };
    const panel = shadow.querySelector<HTMLElement>(".panel")!;
    const notice = shadow.querySelector<HTMLElement>(".notice")!;
    const closeButton = shadow.querySelector<HTMLButtonElement>(".close")!;
    const records = new WeakMap<Element, { src: string; state: CollectionState }>();
    const captures = new Map<string, PickedImage>();
    const hiddenCaptures = new Set<string>();
    let disposed = false;
    let noticeAnimation: Animation | undefined;
    let noticeTimer: ReturnType<typeof setTimeout> | undefined;
    let noticeRemaining = 0;
    let noticeStarted = 0;
    let retryTarget: PickedImage | undefined;
    const pauseNotice = () => {
      if (noticeTimer !== undefined) noticeRemaining = Math.max(1, noticeRemaining - (performance.now() - noticeStarted));
      clearTimeout(noticeTimer);
      noticeTimer = undefined;
    };
    const hideNotice = () => {
      pauseNotice();
      noticeRemaining = 0;
      noticeAnimation?.cancel();
      if ("hidePopover" in notice && notice.matches(":popover-open")) notice.hidePopover();
      notice.hidden = true;
      retryTarget = undefined;
    };
    const resumeNotice = () => {
      if (noticeTimer !== undefined || notice.hidden || document.hidden || notice.matches(":hover") || notice.contains(shadow.activeElement) || !noticeRemaining) return;
      noticeStarted = performance.now();
      noticeTimer = setTimeout(hideNotice, noticeRemaining);
    };
    const feedback = (state: Exclude<CollectionState, "idle">, created = true, error = "", pointer = true) => {
      if (disposed) return;
      // A slower successful save must not erase another image's retryable failure.
      if (state === "saved" && !notice.hidden && notice.dataset.state === "error") return;
      const wasHidden = notice.hidden;
      pauseNotice();
      notice.dataset.state = state;
      notice.querySelector("strong")!.textContent = state === "saving" ? "正在加入 Reframe…" : state === "error" ? "加入失败" : created ? "✓ 已加入 Reframe" : "✓ 这张图片已在 Reframe 中";
      notice.querySelector(".notice-copy > span")!.textContent = state === "error" ? error : state === "saving" ? "你可以继续浏览" : created ? "稍后在项目记录 · 待逆向中查看" : "可在项目记录中继续处理";
      const refresh = /刷新|扩展.*失效|重新加载扩展/.test(error);
      shadow.querySelector<HTMLElement>(".refresh")!.hidden = state !== "error" || !refresh;
      shadow.querySelector<HTMLElement>(".retry")!.hidden = state !== "error" || refresh || !retryTarget;
      notice.hidden = false;
      if ("showPopover" in notice && !notice.matches(":popover-open")) notice.showPopover();
      if (!pointer) noticeAnimation?.cancel();
      // Repeated saves update this notice in place, without replaying its entrance.
      if (wasHidden && pointer && !getMotion().reduced)
        noticeAnimation = notice.animate([{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], { duration: 160, easing: "cubic-bezier(.23,1,.32,1)" });
      noticeRemaining = state === "saved" ? 4000 : 0;
      resumeNotice();
    };
    notice.addEventListener("pointerenter", pauseNotice);
    notice.addEventListener("pointerleave", resumeNotice);
    notice.addEventListener("focusin", pauseNotice);
    notice.addEventListener("focusout", () => queueMicrotask(resumeNotice));
    ctx.addEventListener(document, "visibilitychange", () => { if (document.hidden) pauseNotice(); else resumeNotice(); });
    let opening: Animation | undefined;
    let pointerOpening = false;
    let returnFocus: HTMLElement | undefined;
    let unmountPanel: (() => void) | undefined;
    let panelLoading: Promise<void> | undefined;
    // The React panel is injected on first use so ordinary pages only carry collection code.
    const mountPanel = () => {
      if (unmountPanel || panelLoading) return;
      const body = shadow.querySelector(".panel-body")!;
      const injected = registeredPagePanel();
      if (injected) { unmountPanel = injected(body); return; }
      panelLoading = request({ type: "alchemy:panel-load" }).then(() => {
        panelLoading = undefined;
        const mount = registeredPagePanel();
        if (!mount) throw new Error("逆向面板未能加载，请刷新网页后重试");
        if (!disposed && !panel.hidden && !unmountPanel) unmountPanel = mount(body);
      }).catch(error => {
        panelLoading = undefined;
        if (disposed || panel.hidden) return;
        closePanel();
        retryTarget = undefined;
        feedback("error", false, error instanceof Error ? error.message : String(error));
        notice.querySelector("strong")!.textContent = "打开失败";
      });
    };
    const showPanel = () => {
      closeMenu();
      const wasHidden = panel.hidden;
      hideNotice();
      panel.hidden = false;
      mountPanel();
      position();
      if (wasHidden) {
        returnFocus ||= (shadow.activeElement || document.activeElement) as HTMLElement;
        closeButton.focus({ preventScroll: true });
        opening?.cancel();
        if (pointerOpening && !getMotion().reduced)
          opening = panel.animate([{ opacity: 0, transform: "translateX(18px)" }, { opacity: 1, transform: "none" }],
            { duration: 180, easing: "cubic-bezier(.23,1,.32,1)" });
      }
      pointerOpening = false;
    };
    const closePanel = () => {
      opening?.cancel();
      panel.hidden = true;
      unmountPanel?.();
      unmountPanel = undefined;
      position();
      if (returnFocus?.isConnected && returnFocus.getClientRects().length) returnFocus.focus({ preventScroll: true });
      returnFocus = undefined;
    };
    closeButton.addEventListener("click", closePanel);
    for (const type of ["pointerdown", "focusin"])
      panel.addEventListener(type, () => closeMenu());
    ctx.addEventListener(host, "keydown", (event) => {
      const key = (event as KeyboardEvent).key;
      if (!menu.hidden && (shadow.activeElement === trigger || actions.includes(shadow.activeElement as HTMLButtonElement))) {
        if (key === "Escape" || key === "Tab") {
          closeMenu(true);
          if (key === "Escape") { event.preventDefault(); event.stopPropagation(); }
          return;
        }
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(key)) {
          event.preventDefault();
          const index = actions.indexOf(shadow.activeElement as HTMLButtonElement);
          const next = key === "Home" ? 0 : key === "End" ? actions.length - 1 : (index + (key === "ArrowDown" ? 1 : -1) + actions.length) % actions.length;
          actions[next]!.focus({ preventScroll: true });
        }
      }
      if ((event as KeyboardEvent).key === "Escape" && !event.defaultPrevented && !panel.hidden) {
        event.preventDefault();
        event.stopPropagation();
        closePanel();
      }
    });
    // Isolate panel/menu shortcuts without cancelling native controls or touching page events.
    for (const type of ["click", "dblclick", "pointerdown", "pointerup", "keydown", "keyup", "keypress", "wheel"])
      ctx.addEventListener(host, type, event => event.stopPropagation());
    const applyMotion = () => {
      host.dataset.motion = getMotion().reduced ? "reduce" : "full";
      if (getMotion().reduced) { opening?.cancel(); noticeAnimation?.cancel(); menuAnimations.forEach(animation => animation.cancel()); updateLiquid(); }
    };
    const stopMotion = subscribeMotion(applyMotion);
    applyMotion();
    shadow.querySelector(".refresh")!.addEventListener("click", () => location.reload());
    shadow.querySelector(".dismiss")!.addEventListener("click", () => {
      const focused = notice.contains(shadow.activeElement);
      hideNotice();
      if (focused && trigger.getClientRects().length) trigger.focus({ preventScroll: true });
    });
    let selected: PickedImage | undefined;
    let placement: ActionPlacement | undefined;
    let anchor: DOMRect | undefined;
    let positioningFrame = 0;
    const sourceFor = (element: Element) => element instanceof HTMLImageElement ? element.currentSrc
      : getComputedStyle(element).backgroundImage.match(/^url\(["']?(.*?)["']?\)$/)?.[1];
    const updateCollection = () => {
      const record = selected && records.get(selected.element);
      const state = record?.src === selected?.src ? record?.state || "idle" : "idle";
      collectButton.setAttribute("aria-disabled", String(state === "saving"));
      collectButton.setAttribute("aria-busy", String(state === "saving"));
      collectButton.dataset.state = state;
      const label = state === "saving" ? "正在加入 Reframe…" : state === "saved" ? "已加入 Reframe" : state === "error" ? "重试加入 Reframe" : "加入 Reframe";
      collectButton.setAttribute("aria-label", label);
      collectButton.title = label;
    };
    const rect = (element: Element): ImageTarget["rect"] => {
      const r = element.getBoundingClientRect();
      return {
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        viewportWidth: innerWidth,
        viewportHeight: innerHeight,
      };
    };
    // Shadow-root controls are excluded by page hit-testing, so reserve their bounds explicitly.
    const actionEnvironment = (image: Element) => {
      const environment = imageActionEnvironment(image, host);
      for (const overlay of [panel, notice]) {
        if (!overlay.hidden) environment.obstacles.push(overlay.getBoundingClientRect());
      }
      return environment;
    };
    const position = () => {
      if (!selected?.element.isConnected || document.hidden || selecting) {
        control.style.display = "none";
        closeMenu();
        return;
      }
      const source = sourceFor(selected.element);
      if (!source) { control.style.display = "none"; closeMenu(); return; }
      if (source !== selected.src) {
        closeMenu();
        selected = { element: selected.element, src: source };
        placement = undefined;
        anchor = undefined;
        updateCollection();
      }
      const r = selected.element.getBoundingClientRect();
      if (r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) {
        control.style.display = "none";
        closeMenu();
        return;
      }
      const previous = placement && anchor ? {
        ...placement,
        left: placement.left + r.left - anchor.left, right: placement.right + r.left - anchor.left,
        top: placement.top + r.top - anchor.top, bottom: placement.bottom + r.top - anchor.top,
      } : undefined;
      const priorPlacement = placement;
      const { obstacles, isClear } = actionEnvironment(selected.element);
      placement = placeImageAction(r, { left: 0, top: 0, right: innerWidth, bottom: innerHeight }, { width: 40, height: 40 }, obstacles, previous, isClear);
      anchor = r;
      control.style.display = placement ? "inline-flex" : "none";
      const offsets = placement && placeImageMenu(r, { left: 0, top: 0, right: innerWidth, bottom: innerHeight }, placement, obstacles, menu.hidden ? undefined : isClear, menu.hidden ? undefined : menuOffsets);
      if (!placement || !offsets) {
        control.style.display = "none";
        closeMenu();
        return;
      }
      if (!menu.hidden && offsets.some((offset, index) => offset.x !== menuOffsets[index]!.x || offset.y !== menuOffsets[index]!.y)) closeMenu(true);
      // CSSOM rounds fractional pixels; compare geometry, not serialized styles.
      if (!menu.hidden && priorPlacement && (Math.abs(priorPlacement.left - placement.left) > .5 || Math.abs(priorPlacement.top - placement.top) > .5)) closeMenu(true);
      control.style.left = `${placement.left}px`;
      control.style.top = `${placement.top}px`;
      if (!liquid) {
        liquid = mountCollectionLiquid(shadow.querySelector<HTMLElement>(".pick-liquid")!);
        updateLiquid();
      }
    };
    const schedulePosition = () => {
      if (positioningFrame) return;
      positioningFrame = requestAnimationFrame(() => { positioningFrame = 0; position(); });
    };
    ctx.addEventListener(document, "pointermove", (event) => {
      if (event.composedPath().includes(host) || selecting) return;
      const elements = document.elementsFromPoint(event.clientX, event.clientY);
      let found: typeof selected;
      for (const el of elements) {
        if (el === document.body || el === document.documentElement) continue;
        const candidates =
          el instanceof HTMLImageElement
            ? [el]
            : [...el.querySelectorAll("img")].slice(0, 30);
        for (const img of candidates) {
          const r = img.getBoundingClientRect();
          if (
            r.width >= 80 &&
            r.height >= 80 &&
            event.clientX >= r.left &&
            event.clientX <= r.right &&
            event.clientY >= r.top &&
            event.clientY <= r.bottom &&
            img.currentSrc
          ) {
            found = { element: img, src: img.currentSrc };
            break;
          }
        }
        if (found) break;
        const r = el.getBoundingClientRect();
        const bg = getComputedStyle(el).backgroundImage.match(
          /^url\(["']?(.*?)["']?\)$/,
        )?.[1];
        if (bg && r.width >= 80 && r.height >= 80) {
          found = { element: el, src: bg };
          break;
        }
      }
      if (!found && (!menu.hidden || shadow.activeElement === trigger)) return;
      if (selected?.element !== found?.element || selected?.src !== found?.src) {
        // A new image gets only the logo; cancel the old menu before moving its anchor.
        closeMenu(menu.contains(shadow.activeElement));
        placement = undefined;
        anchor = undefined;
        selected = found;
        updateLiquid();
        updateCollection();
        schedulePosition();
      }
    });
    ctx.addEventListener(window, "scroll", () => { closeMenu(); schedulePosition(); }, {
      capture: true,
      passive: true,
    });
    ctx.addEventListener(window, "resize", () => { closeMenu(); schedulePosition(); });
    ctx.addEventListener(document, "visibilitychange", schedulePosition);
    ctx.addEventListener(document, "pointerleave", () => {
      if (menu.hidden && shadow.activeElement !== trigger) { selected = undefined; schedulePosition(); }
    });
    // Hover controls can be mounted late or animated without any pointer movement.
    ctx.setInterval(() => { if (selected && !document.hidden) schedulePosition(); }, 240);
    const collect = async (picked: PickedImage, pointer: boolean) => {
      const record = records.get(picked.element);
      if (record?.src === picked.src && record.state === "saving") return;
      const captureId = crypto.randomUUID();
      captures.set(captureId, picked);
      records.set(picked.element, { src: picked.src, state: "saving" });
      retryTarget = undefined;
      updateCollection();
      feedback("saving", true, "", pointer);
      try {
        const result = await request<CollectionResult>({ type: "alchemy:collect", target: { src: picked.src, rect: rect(picked.element), captureId } });
        if (disposed) return;
        if (records.get(picked.element)?.src === picked.src) records.set(picked.element, { src: picked.src, state: "saved" });
        feedback("saved", result.created !== false, "", pointer);
      } catch (error) {
        if (disposed) return;
        if (records.get(picked.element)?.src === picked.src) records.set(picked.element, { src: picked.src, state: "error" });
        retryTarget = picked;
        feedback("error", false, error instanceof Error ? error.message : String(error), pointer);
      } finally {
        captures.delete(captureId);
        hiddenCaptures.delete(captureId);
        host.style.visibility = hiddenCaptures.size ? "hidden" : "";
        if (!disposed) updateCollection();
      }
    };
    collectButton.addEventListener("click", (event) => {
      if (!event.isTrusted || !menuTarget || selecting) return;
      event.preventDefault(); event.stopPropagation();
      const picked = menuTarget;
      closeMenu(true, event.detail > 0);
      if (!picked.element.isConnected || sourceFor(picked.element) !== picked.src) {
        retryTarget = undefined;
        feedback("error", false, "图片已变化，请重新打开图片菜单");
        return;
      }
      void collect(picked, event.detail > 0);
    });
    const openMenu = (pointer: boolean) => {
      position();
      if (!selected || control.style.display === "none") return;
      const { obstacles, isClear } = actionEnvironment(selected.element);
      const offsets = placement && placeImageMenu(selected.element.getBoundingClientRect(), { left: 0, top: 0, right: innerWidth, bottom: innerHeight }, placement, obstacles, isClear);
      if (!offsets || !placement) {
        retryTarget = undefined;
        feedback("error", false, "图片内没有足够空间，请使用图片右键菜单");
        return;
      }
      menuOffsets = offsets;
      menuTarget = { ...selected };
      menuPointer = pointer;
      menu.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
      menu.style.left = `${placement.left}px`;
      menu.style.top = `${placement.top}px`;
      actions.forEach((action, index) => {
        action.style.left = `${offsets[index]!.x}px`;
        action.style.top = `${offsets[index]!.y}px`;
      });
      updateLiquid(!pointer);
      menuAnimations.forEach(animation => animation.cancel());
      menuAnimations = pointer && !getMotion().reduced ? actions.map((action, index) =>
        action.animate([{ opacity: 0, transform: `translate(${-offsets[index]!.x}px, ${-offsets[index]!.y}px) scale(0)` }, { opacity: 1, transform: "none" }], { duration: liquidTiming.duration, easing: liquidTiming.ease })) : [];
      openButton.focus({ preventScroll: true });
    };
    trigger.addEventListener("click", (event) => {
      if (!event.isTrusted || selecting) return;
      event.preventDefault(); event.stopPropagation();
      if (menu.hidden) openMenu(event.detail > 0); else closeMenu(true, event.detail > 0);
    });
    trigger.addEventListener("keydown", (event) => {
      if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); event.stopPropagation(); openMenu(false); if (event.key === "ArrowUp") actions[actions.length - 1]!.focus({ preventScroll: true }); }
    });
    ctx.addEventListener(document, "pointerdown", (event) => { if (!event.composedPath().includes(host)) closeMenu(false, menuPointer); });
    // Wait for the new focus target; focusout can run before activeElement is updated.
    ctx.addEventListener(document, "focusin", (event) => { if (!event.composedPath().includes(host)) closeMenu(); });
    workspaceButton.addEventListener("click", async (event) => {
      if (!event.isTrusted || menu.hidden) return;
      event.preventDefault(); event.stopPropagation();
      closeMenu(true, event.detail > 0);
      try {
        await request({ type: "alchemy:open-workspace" });
      } catch (error) {
        if (disposed) return;
        retryTarget = undefined;
        feedback("error", false, error instanceof Error ? error.message : String(error), event.detail > 0);
        notice.querySelector("strong")!.textContent = "打开工作台失败";
      }
    });
    openButton.addEventListener("click", async (event) => {
      if (!event.isTrusted || !menuTarget || selecting) return;
      event.preventDefault(); event.stopPropagation();
      const picked = menuTarget;
      closeMenu();
      if (!picked.element.isConnected || sourceFor(picked.element) !== picked.src) {
        retryTarget = undefined;
        feedback("error", false, "图片已变化，请重新打开图片菜单");
        return;
      }
      const captureId = crypto.randomUUID();
      captures.set(captureId, picked);
      selecting = true;
      pointerOpening = event.detail > 0;
      returnFocus = trigger;
      position();
      try {
        await request({ type: "alchemy:select", target: { src: picked.src, rect: rect(picked.element), captureId } });
      } catch (error) {
        if (!disposed) {
          retryTarget = undefined;
          feedback("error", false, error instanceof Error ? error.message : String(error), event.detail > 0);
          notice.querySelector("strong")!.textContent = "打开失败";
        }
      } finally {
        captures.delete(captureId);
        selecting = false;
        if (!disposed) position();
      }
    });
    shadow.querySelector(".retry")!.addEventListener("click", (event) => {
      if (retryTarget) void collect(retryTarget, (event as MouseEvent).detail > 0);
    });
    ctx.addEventListener(document, "contextmenu", (event) => { pointerOpening = event.button === 2; });
    const geometry = (
      message: { type: string; src: string; captureId?: string; hidden?: boolean; state?: "saving" | "saved" | "error"; created?: boolean; error?: string },
      _sender: unknown,
      reply: (r: unknown) => void,
    ) => {
      if (message.type === "alchemy:rect") {
        const picked = message.captureId ? captures.get(message.captureId) : selected;
        const unchanged = picked?.element.isConnected && picked.src === message.src && sourceFor(picked.element) === message.src;
        reply(unchanged ? rect(picked!.element) : null);
      }
      if (message.type === "alchemy:capture-visibility") {
        const id = message.captureId || "selection";
        if (message.hidden) hiddenCaptures.add(id); else hiddenCaptures.delete(id);
        host.style.visibility = hiddenCaptures.size ? "hidden" : "";
        if (message.hidden) {
          requestAnimationFrame(() => requestAnimationFrame(() => reply({ ok: true })));
          return true;
        }
        reply({ ok: true });
      }
      if (message.type === "alchemy:collect-feedback" && message.state) {
        retryTarget = undefined;
        feedback(message.state, message.created !== false, message.error);
        reply({ ok: true });
      }
      if (message.type === "alchemy:show") {
        showPanel();
        reply({ ok: true });
      }
      if (message.type === "alchemy:hide") {
        opening?.cancel();
        panel.hidden = true;
        hideNotice();
        schedulePosition();
        reply({ ok: true });
      }
    };
    browser.runtime.onMessage.addListener(geometry);
    ctx.onInvalidated(() => {
      disposed = true;
      stopMotion();
      clearTimeout(noticeTimer);
      noticeAnimation?.cancel();
      menuAnimations.forEach(animation => animation.cancel());
      captures.clear();
      opening?.cancel();
      cancelAnimationFrame(positioningFrame);
      liquid?.dispose();
      unmountPanel?.();
      host.remove();
      browser.runtime.onMessage.removeListener(geometry);
    });
  },
});
