import { useEffect, useLayoutEffect, useRef, type ReactNode, type PointerEvent as ReactPointerEvent } from 'react';
import useEditorExpansion from './useEditorExpansion';

type Props = {
  contextKey: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  returnFocus: () => HTMLElement | null;
  reduced: boolean;
};
type Drag = { id: number; origin: number; base: number; y: number; samples: { y: number; t: number }[] };

export default function PromptSheet({ contextKey, open, onOpenChange, children, returnFocus, reduced }: Props) {
  const sheet = useRef<HTMLElement>(null);
  const expansion = useEditorExpansion(sheet, reduced, contextKey);
  const handle = useRef<HTMLButtonElement>(null);
  const animation = useRef<Animation | null>(null);
  const drag = useRef<Drag | null>(null);
  const opened = useRef(false);
  const suppressClick = useRef(false);
  const keyboard = useRef(false);
  const mounted = useRef(true);
  const focusFrame = useRef(0);
  const latest = useRef({ onOpenChange, returnFocus, reduced });
  latest.current = { onOpenChange, returnFocus, reduced };

  function freeze() {
    const el = sheet.current!;
    const y = new DOMMatrixReadOnly(getComputedStyle(el).transform).m42;
    animation.current?.cancel();
    animation.current = null;
    el.style.transform = `translateY(${y}px)`;
    return y;
  }
  function releaseCapture() {
    const active = drag.current;
    drag.current = null;
    if (active && handle.current?.hasPointerCapture(active.id)) handle.current.releasePointerCapture(active.id);
  }
  function move(next: boolean, immediate = false, spring = false, velocity = 0) {
    const el = sheet.current;
    if (!el) return;
    expansion.settle();
    if (next && !el.matches(':popover-open')) el.showPopover();
    const from = freeze();
    const wasOpen = opened.current;
    const restore = !next && el.contains(document.activeElement);
    releaseCapture();
    opened.current = next;
    el.inert = !next;
    el.setAttribute('aria-hidden', String(!next));
    el.style.visibility = 'visible';
    if (next && !wasOpen) handle.current?.focus({ preventScroll: true });
    cancelAnimationFrame(focusFrame.current);
    if (restore) focusFrame.current = requestAnimationFrame(() => {
      // Wait for the parent to reveal the composer and clear inert before restoring focus.
      if (mounted.current && !opened.current && (el.contains(document.activeElement) || document.activeElement === document.body)) {
        latest.current.returnFocus()?.focus({ preventScroll: true });
      }
    });
    const target = next ? 0 : el.offsetHeight + 32;
    el.style.transform = `translateY(${target}px)`;
    if (immediate || latest.current.reduced) {
      el.style.visibility = next ? 'visible' : 'hidden';
      if (!next && el.matches(':popover-open')) el.hidePopover();
      return;
    }
    const frames = spring ? Array.from({ length: 43 }, (_, i) => {
      const t = i / 100;
      const y = i === 42 ? 0 : Math.exp(-18 * t) * (from * Math.cos(24 * t) + (velocity * 1000 + 18 * from) / 24 * Math.sin(24 * t));
      return { transform: `translateY(${y}px)`, offset: i / 42 };
    }) : [{ transform: `translateY(${from}px)` }, { transform: `translateY(${target}px)` }];
    const active = el.animate(frames, { duration: spring ? 420 : next ? 300 : 220, easing: spring ? 'linear' : 'cubic-bezier(.32,.72,0,1)' });
    animation.current = active;
    active.onfinish = () => {
      if (animation.current !== active) return;
      animation.current = null;
      el.style.visibility = opened.current ? 'visible' : 'hidden';
      if (!opened.current && el.matches(':popover-open')) el.hidePopover();
    };
  }
  function close(immediate = false) {
    move(false, immediate);
    latest.current.onOpenChange(false);
  }
  function cancelDrag(immediate = false) {
    if (!drag.current) return;
    suppressClick.current = true;
    move(true, immediate, true);
  }
  function down(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.button !== 0 || !event.isPrimary || drag.current || !opened.current) return;
    expansion.settle();
    const position = freeze();
    const base = position < 0 ? 160 * Math.log(Math.max(.001, 1 + position / 80)) : position;
    suppressClick.current = false;
    drag.current = { id: event.pointerId, origin: event.clientY, base, y: position, samples: [{ y: event.clientY, t: event.timeStamp }] };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus({ preventScroll: true });
  }
  function track(event: ReactPointerEvent<HTMLButtonElement>) {
    const active = drag.current;
    if (!active || event.pointerId !== active.id) return;
    const offset = event.clientY - active.origin;
    if (Math.abs(offset) > 3) suppressClick.current = true;
    const raw = active.base + offset;
    active.y = raw < 0 ? -80 * (1 - Math.exp(raw / 160)) : raw;
    sheet.current!.style.transform = `translateY(${active.y}px)`;
    active.samples = [...active.samples.filter(sample => event.timeStamp - sample.t < 100), { y: event.clientY, t: event.timeStamp }];
  }
  function up(event: ReactPointerEvent<HTMLButtonElement>) {
    const active = drag.current;
    if (!active || event.pointerId !== active.id) return;
    track(event);
    const first = active.samples[0]!;
    const velocity = (event.clientY - first.y) / Math.max(1, event.timeStamp - first.t);
    if (!suppressClick.current) { releaseCapture(); return; }
    if (active.y > 60 || (active.y > 12 && velocity > .5 && event.clientY > first.y)) close();
    else move(true, false, true, velocity);
  }

  useLayoutEffect(() => {
    if (open !== opened.current) move(open, keyboard.current);
  }, [open]);
  useLayoutEffect(() => {
    if (reduced) { cancelDrag(true); move(opened.current, true); }
  }, [reduced]);
  useEffect(() => {
    mounted.current = true;
    let outside: { id: number; x: number; y: number } | undefined;
    const isOutside = (event: Event) => !event.composedPath().includes(sheet.current!);
    const pointer = (event: PointerEvent) => {
      keyboard.current = false;
      outside = opened.current && event.isPrimary && event.button === 0 && isOutside(event)
        ? { id: event.pointerId, x: event.clientX, y: event.clientY } : undefined;
    };
    const clearOutside = () => { outside = undefined; };
    const click = (event: MouseEvent) => {
      keyboard.current = event.detail === 0;
      const start = outside;
      outside = undefined;
      if (opened.current && start && isOutside(event) && (!('pointerId' in event) || event.pointerId === start.id)
        && Math.hypot(event.clientX - start.x, event.clientY - start.y) < 6) close();
    };
    const key = (event: KeyboardEvent) => {
      keyboard.current = true;
      if (event.key !== 'Escape' || !opened.current || event.defaultPrevented) return;
      event.preventDefault();
      if (drag.current) cancelDrag(true); else close(true);
    };
    const settle = () => {
      cancelDrag(true);
      move(opened.current, true);
    };
    const visibility = () => { if (document.hidden) settle(); };
    window.addEventListener('pointerdown', pointer, true);
    window.addEventListener('click', click, true);
    window.addEventListener('pointercancel', clearOutside, true);
    window.addEventListener('keydown', key);
    window.addEventListener('blur', settle);
    window.addEventListener('resize', settle);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      mounted.current = false;
      cancelAnimationFrame(focusFrame.current);
      animation.current?.cancel();
      animation.current = null;
      releaseCapture();
      window.removeEventListener('pointerdown', pointer, true);
      window.removeEventListener('click', click, true);
      window.removeEventListener('pointercancel', clearOutside, true);
      if (sheet.current?.matches(':popover-open')) sheet.current.hidePopover();
      window.removeEventListener('keydown', key);
      window.removeEventListener('blur', settle);
      window.removeEventListener('resize', settle);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, []);

  return <section ref={sheet} id="workspace-prompt-sheet" className="canvas-prompt-sheet" popover="manual" aria-label="提示词面板" aria-hidden={!open} inert={!open} style={{ visibility: 'hidden', transform: 'translateY(110%)' }}>
    <button ref={handle} type="button" className="canvas-prompt-handle" aria-label="收起提示词面板" aria-expanded={open}
      onPointerDown={down} onPointerMove={track} onPointerUp={up}
      onPointerCancel={event => { if (drag.current?.id === event.pointerId) cancelDrag(); }}
      onLostPointerCapture={event => { if (drag.current?.id === event.pointerId) cancelDrag(); }}
      onClick={event => {
        if (suppressClick.current && event.detail !== 0) { suppressClick.current = false; return; }
        close(event.detail === 0);
      }}
      onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); close(true); } }}><span /></button>
    <div className="canvas-prompt-heading"><span>提示词</span><button type="button" className="quiet-button canvas-editor-expand" aria-expanded={expansion.expanded} onClick={event => expansion.toggle(event.detail === 0)}>{expansion.expanded ? "恢复大小" : "放大编辑"}</button></div>
    {children}
  </section>;
}
