import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

export async function createAgentStore({ dataDir, models, piModels }) {
  const path = join(dataDir, 'agent-settings.json');
  const stores = { codex: models, pi: piModels };
  let selected = 'codex';
  try {
    const saved = JSON.parse(await readFile(path, 'utf8'));
    if (!Object.hasOwn(stores, saved.selected)) throw new Error('逆向 Agent 配置无效，请检查 agent-settings.json；原文件已保留。');
    selected = saved.selected;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const modelStore = (id = selected) => {
    if (!Object.hasOwn(stores, id)) throw Object.assign(new Error('请选择支持的 Agent。'), { status: 400 });
    return stores[id];
  };
  const view = () => ({ selected, agents: [
    { id: 'codex', label: 'Codex', model: models.selectedModel },
    { id: 'pi', label: 'Pi', model: piModels.selectedModel },
  ] });
  return {
    view, modelStore,
    get busy() { return models.busy || piModels.busy; },
    get selected() { return selected; },
    selection() { return { ...modelStore().selection(), agent: selected }; },
    async select(id) {
      if (typeof id !== 'string') throw Object.assign(new Error('请选择支持的 Agent。'), { status: 400 });
      modelStore(id);
      await writeFile(path + '.tmp', JSON.stringify({ selected: id }), { mode: 0o600 });
      await rename(path + '.tmp', path);
      selected = id;
      return view();
    },
  };
}
