import { readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { createModelStore } from "./models.mjs";
import { createCliManager } from "./cli.mjs";
import { createPiCliManager } from "./pi-cli.mjs";
import { runCodex } from "./codex-agent.mjs";
import { runPi, readPiCatalog, verifyPiModel } from "./pi-agent.mjs";

/** Records and batches created before Agent selection existed were reversed by Codex. */
export const LEGACY_AGENT = "codex";
export const AGENT_ID = /^[a-z][a-z0-9-]{0,31}$/;

const unsupported = () => Object.assign(new Error("请选择支持的 Agent。"), { status: 400 });

/**
 * Built-in reverse Agent adapters. Each adapter is
 *   { id, label, models, cli?, run, compatibility? }
 * - models: model store ({ busy, selectedModel, list, refresh, start, selection, invalidate, reset, close })
 * - cli: optional CLI manager ({ busy, status, check, update?, install?, close })
 * - run: runner described in agent.mjs (`runAgent`)
 * - compatibility: true when the Agent runs through the Codex app-server and is gated by its compatibility report.
 * A new local Agent joins by adding an adapter here; HTTP routes, admission and UI read the registry.
 */
export async function builtinAgents({ cwd, dataDir, configDir, compatibility, resetSessions = () => {}, overrides = {} }) {
  const codexModels = overrides.codex?.models || await createModelStore({ dataDir: configDir, cwd });
  const piModels = overrides.pi?.models || await createModelStore({ dataDir: configDir, cwd, filename: "pi-model-settings.json",
    readCatalog: dir => readPiCatalog(dir, dataDir), verify: options => verifyPiModel({ ...options, dataDir }) });
  const codexCli = overrides.codex?.cli || createCliManager({ onUpdated: async () => {
    try {
      await codexModels.reset();
      const report = await compatibility.getCompatibility({ force: true });
      if (report.error) throw new Error(report.error);
    } finally { resetSessions(); }
  } });
  const piCli = overrides.pi?.cli || createPiCliManager({ dataDir, onUpdated: () => piModels.reset() });
  return [
    { id: "codex", label: "Codex", models: codexModels, cli: codexCli, run: runCodex, compatibility: true },
    { id: "pi", label: "Pi", models: piModels, cli: piCli, run: runPi },
  ];
}

/** Selected reverse Agent plus lookup by id; the selection persists in agent-settings.json. */
export async function createAgentRegistry({ dataDir, adapters }) {
  if (!adapters.length || adapters.some(adapter => !AGENT_ID.test(adapter.id) || typeof adapter.run !== "function" || !adapter.models))
    throw new Error("Agent 适配器无效");
  const byId = new Map(adapters.map(adapter => [adapter.id, adapter]));
  if (byId.size !== adapters.length) throw new Error("Agent 适配器 ID 重复");
  const path = join(dataDir, "agent-settings.json");
  let selected = adapters[0].id;
  try {
    const saved = JSON.parse(await readFile(path, "utf8"));
    if (!byId.has(saved.selected)) throw new Error("逆向 Agent 配置无效，请检查 agent-settings.json；原文件已保留。");
    selected = saved.selected;
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const get = (id = selected) => {
    const adapter = typeof id === "string" ? byId.get(id) : undefined;
    if (!adapter) throw unsupported();
    return adapter;
  };
  const view = () => ({ selected, agents: adapters.map(({ id, label, models, cli }) => ({
    id, label, model: models.selectedModel, installable: typeof cli?.install === "function",
  })) });
  return {
    get, view,
    /** Adapter that owns a frozen snapshot; snapshots without `agent` keep the legacy Codex meaning. */
    frozen: settings => get(settings?.agent ?? LEGACY_AGENT),
    get selected() { return selected; },
    get busy() { return adapters.some(adapter => adapter.models.busy); },
    get cliBusy() { return adapters.some(adapter => adapter.cli?.busy); },
    selection() { return { ...get().models.selection(), agent: selected }; },
    async select(id) {
      if (typeof id !== "string") throw unsupported();
      get(id);
      await writeFile(path + ".tmp", JSON.stringify({ selected: id }), { mode: 0o600 });
      await rename(path + ".tmp", path);
      selected = id;
      return view();
    },
    close() {
      for (const adapter of adapters) { adapter.cli?.close?.(); adapter.models.close?.(); }
    },
  };
}
