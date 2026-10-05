import { createContext, useContext } from "react";
import { recoverySection, type RecoverySection } from "../../lib/codex-status";

export const RecoveryContext = createContext<((section: RecoverySection) => void) | null>(null);
export default function RecoveryAction({ error, currentSection }: { error?: string; currentSection?: RecoverySection }) {
  const open = useContext(RecoveryContext);
  const section = recoverySection(error);
  return open && section && section !== currentSection ? <button type="button" className="text-button" onClick={() => { open(section); }}>{({ cli: "检查 Codex", models: "检查模型与登录", connection: "检查本机连接" })[section]}</button> : null;
}
