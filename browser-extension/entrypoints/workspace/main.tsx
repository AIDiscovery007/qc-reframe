import ReactDOM from "react-dom/client";
import App from "../popup/App";
import { GenerationEffectContext } from "../popup/GenerationPanel";
import GenerationEffect from "./GenerationEffect";
import LoadingEffect from "./LoadingEffect";
import { LoadingEffectContext } from "../popup/LoadingPlaceholder";
import "../popup/style.css";
import "./workspace.css";
import "./project-library.css";
import "./results.css";
import "./canvas-workspace.css";
import "./session-picker.css";
import "./task-orchestration.css";

document.documentElement.classList.add("embedded", "workspace-page");
const root = ReactDOM.createRoot(document.getElementById("root")!);
if (location.protocol === "http:" && location.hostname === "127.0.0.1" && new URLSearchParams(location.search).get("demo") === "task") {
  void import("./TaskOrchestrationDemo").then(({ default: Demo }) => root.render(<Demo />));
} else root.render(<GenerationEffectContext value={GenerationEffect}><LoadingEffectContext value={LoadingEffect}><App workspace /></LoadingEffectContext></GenerationEffectContext>);
import "../popup/settings-center.css";

import "./gallery.css";
