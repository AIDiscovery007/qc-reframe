/** Reverse Agent ids come from the bridge registry (`/agents`); the extension only validates their shape. */
export type AgentId = string;
export type AgentCatalog = { selected: AgentId; agents: { id: AgentId; label: string; model: string | null; installable?: boolean }[] };

/** Records and services from before Agent selection used Codex. */
export const LEGACY_AGENT = "codex";
export const isAgentId = (value: unknown): value is AgentId => typeof value === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(value);
/** Codex keeps the bare route so services from before Agent selection still answer. */
export const agentQuery = (agent?: AgentId) => !agent || agent === LEGACY_AGENT ? "" : `?agent=${agent}`;
export const agentLabel = (catalog: AgentCatalog | undefined, id: AgentId) =>
  catalog?.agents.find(agent => agent.id === id)?.label ?? (id === LEGACY_AGENT ? "Codex" : id);
