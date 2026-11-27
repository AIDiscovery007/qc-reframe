import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withCodex } from "./codex-rpc.mjs";
import { assertModelContext, modelError, generationContextError } from "./model-context.mjs";
import { taskResources, taskSystemPrompt, referenceToolSpec, readReference } from "./skill-resources.mjs";

// Context sources a reverse or model check never needs: project and global skills, project AGENTS.md, environment and
// permission notes, apps, plugins, browsers, sub-agents, web search, shell, file image viewing, user questions and image
// generation. Unknown keys are ignored by older CLIs. The user's global AGENTS.md and the model's own code-mode tools have
// no switch and still reach the model.
const ISOLATION = {
  project_doc_max_bytes: 0, include_permissions_instructions: false, include_environment_context: false,
  include_collaboration_mode_instructions: false, include_apps_instructions: false, web_search: "disabled",
  agents: { enabled: false }, skills: { include_instructions: false, bundled: { enabled: false } },
  features: { apps: false, plugins: false, remote_plugin: false, computer_use: false, browser_use: false, browser_use_external: false,
    in_app_browser: false, goals: false, hooks: false, multi_agent_v2: false, shell_tool: false, sleep_tool: false, skill_search: false,
    tool_suggest: false, image_generation: false, view_image: false },
  tools: { experimental_request_user_input: { enabled: false } },
};

/** A fresh empty folder outside any project, so Codex finds no project instructions, skills or settings; removed afterwards. */
export async function withPrivateFolder(action) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "reframe-codex-")));
  try { return await action(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

const referenceTool = references => ({
  spec: { type: "function", ...referenceToolSpec, description: `${referenceToolSpec.description}\nWhen called via functions.exec, pass the returned text to text().` },
  call: async args => ({ success: true, contentItems: [{ type: "inputText", text: readReference(references, args) }] }),
});

/**
 * Codex app-server runner: one ephemeral read-only thread per call. Built-in generation keeps the bridge folder and the
 * user's Codex setup; reverse and model checks run isolated, with Reframe's prompt and skill snapshot as the base instructions.
 */
export async function runCodex(options) {
  if (options.generation) return runThread(options);
  return withPrivateFolder(async dir => {
    const { references, skillText } = await taskResources(options.input, dir, { probe: options.probe, label: "Codex" });
    return runThread({ ...options, cwd: dir, isolated: true, input: options.input.filter(item => item.type !== "skill"),
      instructions: options.probe ? options.instructions : taskSystemPrompt({ instructions: options.instructions, skillText, references, schemaRule: false }),
      dynamicTools: options.probe ? [] : [...options.dynamicTools || [], referenceTool(references)] });
  });
}

async function runThread({ input, schema, cwd, signal, onProgress = () => {}, instructions, generation = false, modelSettings, probe = false, dynamicTools = [], isolated = false }) {
  if (generation) dynamicTools = [];
  let threadId;
  let finalText = "";
  const images = [];
  let finish, fail;
  const completed = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
  completed.catch(() => {});
  const onNotification = (message) => {
    const p = message.params || {};
    if (threadId && p.threadId && p.threadId !== threadId) return;
    if (generation && message.method === "item/started" && p.item?.type === "commandExecution")
      onProgress({ stage: "正在读取 imagegen 技能…" });
    if (message.method === "item/started" && p.item?.type === "dynamicToolCall" && p.item.tool === referenceToolSpec.name)
      onProgress({ stage: "正在读取技能参考资料…" });
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
      const config = await assertModelContext(request, cwd, modelSettings);
      if (generation) {
        const capabilities = await request("modelProvider/capabilities/read", {});
        if (!capabilities.imageGeneration) throw new Error("当前账号或模型提供方未开放内置生图，请检查 Codex 登录与提供方。");
      }
      const started = await request("thread/start", {
        cwd, sandbox: "read-only", approvalPolicy: "never",
        ...(isolated ? { baseInstructions: instructions } : { developerInstructions: instructions }),
        model: modelSettings.model,
        modelProvider: modelSettings.provider,
        config: { model_reasoning_effort: modelSettings.reasoningEffort, ...(isolated ? { ...ISOLATION,
          // A table per server: names may contain dots, which a dotted override key would split.
          mcp_servers: Object.fromEntries(Object.keys(config.mcp_servers || {}).map(name => [name, { enabled: false }])) } : {}) },
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
