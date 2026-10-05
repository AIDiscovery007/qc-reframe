// Each transition reads the currently painted bounds before cancelling its predecessor.
export function createEditorMotion(element: HTMLElement) {
  let active: Animation | undefined;
  let complete: (() => void) | undefined;
  function settle() {
    active?.cancel();
    active = undefined;
    const done = complete;
    complete = undefined;
    done?.();
  }
  return {
    settle,
    run(change: () => void, immediate: boolean, done?: () => void) {
      const from = element.getBoundingClientRect();
      active?.cancel();
      active = undefined;
      complete = done;
      change();
      const to = element.getBoundingClientRect();
      if (immediate || !from.width || !from.height || !to.width || !to.height) { settle(); return; }
      const animation = element.animate([
        { translate: `${from.left - to.left}px ${from.top - to.top}px`, scale: `${from.width / to.width} ${from.height / to.height}` },
        { translate: '0px 0px', scale: '1 1' },
      ], { duration: 320, easing: 'cubic-bezier(.32,.72,0,1)' });
      active = animation;
      animation.onfinish = () => { if (active === animation) settle(); };
    },
  };
}
