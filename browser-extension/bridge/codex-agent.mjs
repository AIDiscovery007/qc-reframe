import { withCodex } from "./codex-rpc.mjs";
import { assertModelContext, modelError, generationContextError } from "./model-context.mjs";

// Codex app-server runner: one ephemeral read-only thread per call, shared by reverse, model probes and built-in generation.
export async function runCodex({ input, schema, cwd, signal, onProgress = () => {}, instructions, generation = false, modelSettings, probe = false, dynamicTools = [] }) {
  if (generation || probe) dynamicTools = [];
  let threadId;
  let finalText = "";
  const images = [];
  let finish, fail;
  const completed = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
  completed.catch(() => {});
  const onNotification = (message) => {
    const p = message.params || {};
    if (threadId && p.threadId && p.threadId !== threadId) return;
    if (
      message.method === "item/started" &&
      p.item?.type === "commandExecution"
    )
      onProgress({ stage: generation ? "正在读取 imagegen 技能…" : "正在读取图片分析规则…" });
    if (message.method === "item/agentMessage/delta")
      onProgress({ stage: generation ? "Codex 正在处理生图任务…" : "正在整理提示词…" });
    if (p.item?.type === "dynamicToolCall" && p.item.tool === "alchemy_inspect_image") {
      if (message.method === "item/started") {
        const args = p.item.arguments || {};
        const label = Number.isInteger(args.image) ? `图 ${args.image}` : "图片";
        onProgress({ stage: args.bbox
          ? `正在检查${label}局部 · 目标放大 ${args.scale ?? 1} 倍…`
          : `正在查看${label}整体…` });
      }
      if (message.method === "item/completed" && p.item.success === false) {
        const reason = p.item.contentItems?.find(item => item.type === "inputText")?.text;
        onProgress({ stage: `图片检查失败${reason ? `：${reason.slice(0, 180)}` : "，正在处理…"}` });
      }
    }
    if (p.item?.type === "imageGeneration") {
      if (message.method === "item/started") onProgress({ stage: "正在生成图片…" });
      if (message.method === "item/completed") images.push(p.item);
    }
    if (
      message.method === "item/completed" &&
      p.item?.type === "agentMessage" &&
      p.item.phase !== "commentary"
    )
      finalText = p.item.text;
    if (message.method === "turn/completed") {
      if (p.turn.status === "completed") finish();
      else
        fail(
          new Error(
            p.turn.error?.message ||
              `Codex 任务${p.turn.status === "interrupted" ? "已中断" : "失败"}`,
          ),
        );
    }
    if (message.method === "error" && !p.willRetry)
      fail(new Error(p.error?.message || "Codex 请求失败"));
  };
  try {
    return await withCodex({ cwd, signal, onNotification, dynamicTools, timeoutMs: probe ? 90_000 : 600_000 }, async (request) => {
      await assertModelContext(request, cwd, modelSettings);
      if (generation) {
        const capabilities = await request("modelProvider/capabilities/read", {});
        if (!capabilities.imageGeneration) throw new Error("当前账号或模型提供方未开放内置生图，请检查 Codex 登录与提供方。");
      }
      const started = await request("thread/start", {
        cwd, sandbox: "read-only", approvalPolicy: "never",
        developerInstructions: instructions,
        model: modelSettings.model,
        modelProvider: modelSettings.provider,
        config: { model_reasoning_effort: modelSettings.reasoningEffort },
        ...(dynamicTools.length ? { dynamicTools: dynamicTools.map(tool => tool.spec) } : {}),
        ephemeral: probe || process.env.ALCHEMY_PERSIST_CODEX_SESSIONS !== "1",
      });
      if (started.model !== modelSettings.model || started.modelProvider !== modelSettings.provider)
        throw new Error(generation ? "Codex 未采用本次生图的执行模型或提供方，请检查 CLI 配置后重新提交。" : "Codex 未采用所选模型或提供方，请刷新模型列表后重试。");
      threadId = started.thread.id;
      onProgress({ threadId, model: started.model, stage: generation ? "Codex 正在准备生图…" : "Codex 正在观察图片…" });
      await request("turn/start", {
        threadId, input, model: modelSettings.model, effort: modelSettings.reasoningEffort,
        ...(schema ? { outputSchema: schema } : {}),
      });
      await completed;
      return { text: finalText, images };
    });
  } catch (error) {
    const failure = modelError(error, modelSettings?.model);
    throw generation ? generationContextError(failure) : failure;
  }
}
