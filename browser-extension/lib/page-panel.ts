// The page overlay only collects images on every visited page. The React panel is a
// separate bundle that the background injects into the same isolated world on demand;
// the bundle registers its mount function under a realm-shared symbol.
export type MountPagePanel = (container: Element) => () => void;

export const pagePanelFile = "/page-panel.js";
const key = Symbol.for("qc-reframe.page-panel");

export function registerPagePanel(mount: MountPagePanel) {
  (globalThis as Record<symbol, unknown>)[key] = mount;
}

export function registeredPagePanel(): MountPagePanel | undefined {
  const mount = (globalThis as Record<symbol, unknown>)[key];
  return typeof mount === "function" ? mount as MountPagePanel : undefined;
}
