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

document.documentElement.classList.add("embedded", "workspace-page");
ReactDOM.createRoot(document.getElementById("root")!).render(<GenerationEffectContext value={GenerationEffect}><LoadingEffectContext value={LoadingEffect}><App workspace /></LoadingEffectContext></GenerationEffectContext>);
import "../popup/settings-center.css";

import "./gallery.css";
