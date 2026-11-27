import type { RecoverySection } from "./codex-status";

/** Reverse Agent ids come from the bridge registry (`/agents`); the extension only validates their shape. */
export type AgentId = string;
/** Installation facts from `/agents?detect=1`; `null` or absent means not detected (or an older service), never missing. */
export type AgentCli = { installed: boolean; version: string | null; source: string };
export type AgentCatalog = { selected: AgentId; agents: { id: AgentId; label: string; model: string | null; installable?: boolean; cli?: AgentCli | null }[] };
export type MissingAgentCli = { agent: AgentId; label: string; alternatives: string[] };

/** Records and services from before Agent selection used Codex. */
export const LEGACY_AGENT = "codex";
export const isAgentId = (value: unknown): value is AgentId => typeof value === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(value);
/** Codex keeps the bare route so services from before Agent selection still answer. */
export const agentQuery = (agent?: AgentId) => !agent || agent === LEGACY_AGENT ? "" : `?agent=${agent}`;
export const agentLabel = (catalog: AgentCatalog | undefined, id: AgentId) =>
  catalog?.agents.find(agent => agent.id === id)?.label ?? (id === LEGACY_AGENT ? "Codex" : id);

/**
 * The selected Agent's CLI when detection reported it missing, with the other Agents detected as installed.
 * An undetected CLI, a catalog for another selection or an older service yields nothing; nothing is switched here.
 */
export function missingAgentCli(catalog: AgentCatalog | undefined, selected: AgentId): MissingAgentCli | undefined {
  if (catalog?.selected !== selected) return;
  const current = catalog.agents.find(agent => agent.id === selected);
  if (!current || current.cli?.installed !== false) return;
  return { agent: selected, label: current.label, alternatives: catalog.agents.filter(agent => agent.id !== selected && agent.cli?.installed === true).map(agent => agent.label) };
}

const cliSections: Record<AgentId, RecoverySection> = { codex: "cli", pi: "pi-cli", claude: "claude-cli" };

/** The setup notice: installed alternatives lead to the Agent cards; otherwise the missing CLI's own management. */
export function setupNotice(missing: MissingAgentCli | undefined): { text: string; action: string; section: RecoverySection } {
  if (!missing) return { text: "先为 QC-Reframe 选择并验证模型", action: "选择模型", section: "models" };
  if (missing.alternatives.length)
    return { text: `未找到 ${missing.label} CLI，本机已安装 ${missing.alternatives.join("、")}，可在插件模型中切换`, action: "切换 Agent", section: "models" };
  return { text: `未找到 ${missing.label} CLI，请先完成安装`, action: `检查 ${missing.label}`, section: cliSections[missing.agent] ?? "models" };
}
