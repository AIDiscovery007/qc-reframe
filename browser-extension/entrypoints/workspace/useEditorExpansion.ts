import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createEditorMotion } from './editor-motion';

// Both editors keep their content, selection and focus in the same DOM container.
export default function useEditorExpansion(ref: RefObject<HTMLElement | null>, reduced: boolean, scope: string, slot?: RefObject<HTMLElement | null>) {
  const [expanded, setExpanded] = useState(false);
  const desired = useRef(false);
  const motion = useRef<ReturnType<typeof createEditorMotion> | null>(null);
  const preference = useRef(reduced);
  preference.current = reduced;
  function position() {
    const el = ref.current, workspace = el?.closest('.workspace-body');
    if (!el || !workspace) return;
    const rect = workspace.getBoundingClientRect(), style = getComputedStyle(workspace);
    el.style.setProperty('--editor-left', `${rect.left + parseFloat(style.paddingLeft)}px`);
    el.style.setProperty('--editor-width', `${rect.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)}px`);
    el.style.setProperty('--editor-bottom', `${Math.max(0, innerHeight - rect.bottom)}px`);
  }
  function release() {
    const el = ref.current;
    if (!el || !slot) return;
    const focused = el.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
    if (el.matches(':popover-open')) el.hidePopover();
    el.removeAttribute('popover');
    delete el.dataset.restoring;
    focused?.focus({ preventScroll: true });
  }
  function change(next: boolean, immediate = false) {
    const el = ref.current;
    if (!el) return;
    desired.current = next;
    setExpanded(next);
    motion.current ??= createEditorMotion(el);
    motion.current.run(() => {
      position();
      el.dataset.expanded = String(next);
      if (!slot) return;
      if (next) {
        delete el.dataset.restoring;
        el.popover = 'manual';
        if (!el.matches(':popover-open')) el.showPopover();
      } else if (el.matches(':popover-open') && slot.current) {
        const rect = slot.current.getBoundingClientRect();
        el.dataset.restoring = 'true';
        for (const [key, value] of Object.entries({ left: rect.left, top: rect.top, width: rect.width, height: rect.height })) el.style.setProperty(`--inline-${key}`, `${value}px`);
      }
    }, immediate || preference.current, !next ? release : undefined);
  }
  useLayoutEffect(() => {
    position();
    const el = ref.current;
    const settle = () => { motion.current?.settle(); position(); };
    const visibility = () => { if (document.hidden) settle(); };
    const observer = new ResizeObserver(settle);
    const workspace = el?.closest('.workspace-body');
    if (workspace) observer.observe(workspace);
    window.addEventListener('resize', settle);
    window.addEventListener('blur', settle);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      motion.current?.settle();
      release();
      observer.disconnect();
      window.removeEventListener('resize', settle);
      window.removeEventListener('blur', settle);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, []);
  useLayoutEffect(() => { change(false, true); }, [scope]);
  useLayoutEffect(() => { if (reduced) motion.current?.settle(); }, [reduced]);
  return { expanded, change, toggle: (immediate = false) => change(!desired.current, immediate), settle: () => motion.current?.settle() };
}
