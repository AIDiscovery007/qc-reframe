import { readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { withCodex } from "./codex-rpc.mjs";
import { readModelContext } from "./model-context.mjs";
import { runCodex } from "./agent.mjs";

const effortOptions = (item) => item.supportedReasoningEfforts?.length ? item.supportedReasoningEfforts
  : item.reasoningEffort ? [{ reasoningEffort: item.reasoningEffort }] : [];

export async function readModelCatalog(cwd) {
  return withCodex({ cwd, timeoutMs: 45_000 }, async (request) => {
    const context = await readModelContext(request, cwd);
    const models = [];
    const cursors = new Set();
    let cursor;
    do {
      const page = await request("model/list", { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
      for (const item of page.data || []) {
        if (item.hidden || !(item.inputModalities || ["text", "image"]).includes("image") || models.some((m) => m.model === item.model)) continue;
        models.push({ model: item.model, label: item.displayName || item.model,
          reasoningEffort: item.defaultReasoningEffort, supportedReasoningEfforts: item.supportedReasoningEfforts, isDefault: item.isDefault });
      }
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error("Codex 模型列表分页异常，请更新 CLI 后重试。");
      cursors.add(cursor);
    } while (cursor);
    return { ...context, models };
  });
}

export async function verifyModel({ cwd, selection, signal }) {
  const result = await runCodex({ cwd, signal, modelSettings: selection, probe: true,
    instructions: "这是模型连接检查。仅按用户要求回复文字，不调用任何工具，不读取文件，不执行其他任务。",
    input: [{ type: "text", text: "仅回复 OK。" }],
  });
  if (!result.text.trim()) throw new Error("Codex 未返回有效响应，请重新验证。");
}

export async function createModelStore({ dataDir, cwd, readCatalog = readModelCatalog, verify = verifyModel, filename = "model-settings.json" }) {
  const path = join(dataDir, filename);
  let selected;
  try { selected = JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
  let catalog;
  let loading;
  let verification;
  let controller;
  const failures = new Map();
  const current = () => !catalog || selected?.accountKey === catalog.accountKey ? selected : null;
  const view = () => ({ accountLabel: catalog?.accountLabel, selected: current()?.model || null,
    reasoningEffort: current()?.reasoningEffort, verifiedAt: current()?.verifiedAt, verification,
    models: (catalog?.models || []).map((item) => ({ model: item.model, label: item.label, isDefault: item.isDefault,
      defaultReasoningEffort: item.reasoningEffort, supportedReasoningEfforts: effortOptions(item),
      status: failures.has(item.model) ? "unavailable" : current()?.model === item.model ? "verified" : "unverified" })),
  });
  const refresh = async () => {
    if (controller) return view();
    loading ||= readCatalog(cwd).then(async (next) => {
      if (catalog?.accountKey !== next.accountKey) { failures.clear(); verification = undefined; }
      catalog = next;
      if (selected && (!current() || !catalog.models.some((m) => m.model === selected.model))) {
        selected = undefined;
        await writeFile(path, "null", { mode: 0o600 });
      }
      return view();
    }).finally(() => { loading = undefined; });
    return loading;
  };
  return {
    get busy() { return !!controller || !!loading; },
    get selectedModel() { return current()?.model || null; },
    async list() { return catalog ? view() : refresh(); },
    refresh,
    async reset() {
      selected = undefined;
      catalog = undefined;
      failures.clear();
      verification = undefined;
      await writeFile(path, "null", { mode: 0o600 });
      return refresh();
    },
    selection() {
      if (!selected?.model) throw Object.assign(new Error("请在连接设置中选择模型，并点击「验证并使用」。"), { status: 409 });
      return { ...selected };
    },
    async start(model, reasoningEffort) {
      if (controller) throw Object.assign(new Error("正在验证模型，请稍候。"), { status: 409 });
      await refresh();
      if (controller) throw Object.assign(new Error("正在验证模型，请稍候。"), { status: 409 });
      const item = catalog.models.find((m) => m.model === model);
      if (!item) throw Object.assign(new Error("请选择当前列表中的图像输入模型。"), { status: 400 });
      if (reasoningEffort !== undefined && !effortOptions(item).some((option) => option.reasoningEffort === reasoningEffort))
        throw Object.assign(new Error("请选择当前模型支持的推理强度，刷新列表后重试。"), { status: 400 });
      const next = { model, reasoningEffort: reasoningEffort ?? item.reasoningEffort, provider: item.provider ?? catalog.provider, accountKey: catalog.accountKey };
      controller = new AbortController();
      const signal = controller.signal;
      verification = { model, reasoningEffort: next.reasoningEffort, status: "running" };
      void (async () => {
        try {
          await verify({ cwd, selection: next, signal });
          if (signal.aborted) throw new Error("模型验证已取消。");
          const saved = { ...next, verifiedAt: new Date().toISOString() };
          await writeFile(path + ".tmp", JSON.stringify(saved), { mode: 0o600 });
          await rename(path + ".tmp", path);
          selected = saved;
          failures.delete(model);
          verification = { model, reasoningEffort: next.reasoningEffort, status: "completed" };
        } catch (error) {
          if (error.modelUnavailable) {
            failures.set(model, true);
            if (selected?.model === model) { selected = undefined; await writeFile(path, "null", { mode: 0o600 }).catch(() => {}); }
          }
          verification = { model, reasoningEffort: next.reasoningEffort, status: "failed", error: error.message };
        } finally { controller = undefined; }
      })();
      return view();
    },
    async invalidate(selection, error) {
      if ((!error.modelUnavailable && !error.modelContextChanged) || selected?.model !== selection?.model || selected?.accountKey !== selection?.accountKey) return;
      if (error.modelUnavailable) failures.set(selected.model, true);
      selected = undefined;
      await writeFile(path, "null", { mode: 0o600 });
    },
    close() { controller?.abort(); },
  };
}
