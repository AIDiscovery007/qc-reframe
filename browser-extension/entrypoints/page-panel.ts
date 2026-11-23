import { createElement } from "react";
import { createRoot } from "react-dom/client";
import App from "./popup/App";
import { registerPagePanel } from "../lib/page-panel";

// Injected by the background only when the user opens the panel on a page.
export default defineUnlistedScript(() => {
  registerPagePanel(container => {
    const root = createRoot(container);
    root.render(createElement(App, { embedded: true }));
    return () => root.unmount();
  });
});
