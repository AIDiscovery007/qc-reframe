import { createContext, useContext } from "react";
import { recoverySection, type RecoverySection } from "../../lib/codex-status";

export const RecoveryContext = createContext<((section: RecoverySection) => void) | null>(null);
export default function RecoveryAction({ error, currentSection }: { error?: string; currentSection?: RecoverySection }) {
  const open = useContext(RecoveryContext);
  const section = recoverySection(error);
  return open && section && section !== currentSection ? <button type="button" className="text-button" onClick={() => { open(section); }}>{({ cli: "管理 Codex CLI", "pi-cli": "管理 Pi CLI", models: "检查模型与登录", generation: "配置生图渠道", connection: "检查本机连接" })[section]}</button> : null;
}
