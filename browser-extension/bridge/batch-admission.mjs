import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

const bad = (message, status = 400) => Object.assign(new Error(message), { status });

function validateProjects(body, allowed) {
  if (!Array.isArray(body.projects) || !body.projects.length || body.projects.length > 100 || body.projects.some(item =>
    !item || typeof item.projectId !== "string" || !/^[a-f0-9]{64}$/.test(item.projectId) || !Number.isSafeInteger(item.inputRevision) || item.inputRevision < 0)) throw bad("请选择 1–100 个有效项目和输入版本");
  if (new Set(body.projects.map(item => item.projectId)).size !== body.projects.length) throw bad("批量任务包含重复项目");
  const selected = body.projects.map(({ projectId, inputRevision }) => ({ projectId, inputRevision }));
  if (Object.keys(body).some(key => !allowed.includes(key))) throw bad("批量启动仅支持完整复刻和自动生图");
  return selected;
}

// Both entry points run under the bridge mutation lock, including the durable commit.
// Generation policies are shared with single tasks; the scheduler owns execution and
// releases batchGenerationSettings on terminal persistence or service shutdown.
export function createBatchAdmission({
  batches, projects, runtime, agents, cliBusy, storedImage, skillPath, requireFeature,
  generation, batchGenerationSettings,
}) {
  const inspectProject = async item => {
    const project = projects.summary(item.projectId);
    if (!project) throw bad("项目不存在", 404);
    if (item.inputRevision !== project.inputRevision) throw bad("项目输入已更新，请重新预检", 409);
    if (batches.hasProject(project.id) || projects.get(project.id).jobs.some(job => runtime.has(job.id) || job.status === "running" || job.generations?.some(generation => runtime.has(generation.id) || generation.status === "running"))) throw bad("项目已有任务，请等待完成", 409);
    const input = projects.input(project.id, "recreate");
    await storedImage(project);
    if (input.instruction !== undefined && (typeof input.instruction !== "string" || input.instruction.length > 20000)) throw bad("项目任务指令无效");
    return { imageAsset: project.imageAsset, instruction: input.instruction, referenceIndex: 0, sourceUrl: project.sourceUrl, capture: project.capture, inputRevision: project.inputRevision };
  };

  const prepare = async (body, selected, signal) => {
    if (cliBusy()) throw bad("Agent CLI 正在安装或更新，请等待完成。", 409);
    if (agents.busy) throw bad("正在验证模型，请稍候", 409);
    const modelSettings = agents.selection(), generationModelSettings = await generation.selection(signal);
    generation.validateSize(body, generationModelSettings);
    const sizeSnapshot = generation.sizeSnapshot(generationModelSettings, body.imageSize);
    await Promise.all([...(agents.selected === "codex" ? [requireFeature("reverse")] : []), generation.check(generationModelSettings, signal), readFile(skillPath)]);
    const items = [];
    for (const selectedItem of selected) {
      const title = projects.summary(selectedItem.projectId)?.title || "项目不存在";
      try {
        const snapshot = await inspectProject(selectedItem);
        items.push({ ...selectedItem, title, eligible: true, snapshot });
      } catch (error) { items.push({ ...selectedItem, title, eligible: false, error: error.message }); }
    }
    signal.throwIfAborted();
    return { modelSettings, generationModelSettings, sizeSnapshot, items };
  };

  return {
    async preview(body, signal) {
      const selected = validateProjects(body, ["projects"]);
      const { modelSettings, items } = await prepare(body, selected, signal);
      return { model: modelSettings.model, items: items.map(({ snapshot, ...item }) => item) };
    },
    async admit(body, signal) {
      const selected = validateProjects(body, ["projects", "requestId", "language", "aspectRatio", "imageSize"]);
      if (typeof body.requestId !== "string" || !/^[\w-]{1,100}$/.test(body.requestId)) throw bad("批量请求编号无效");
      generation.validateOptions(body);
      const requestHash = createHash("sha256").update(JSON.stringify({ projects: selected, language: body.language,
        ...(body.aspectRatio ? { aspectRatio: { width: body.aspectRatio.width, height: body.aspectRatio.height } } : {}),
        ...(body.imageSize ? { imageSize: { width: body.imageSize.width, height: body.imageSize.height } } : {}),
      })).digest("hex");
      // Recovery must not depend on current CLI/model readiness or project eligibility.
      const existing = batches.all.find(batch => batch.requestId === body.requestId);
      if (existing) {
        if (existing.requestHash !== requestHash) throw bad("同一批量请求编号不能用于不同输入或选项", 409);
        return existing;
      }
      const { modelSettings, generationModelSettings, sizeSnapshot, items } = await prepare(body, selected, signal);
      const batch = { id: randomUUID(), requestId: body.requestId, requestHash, createdAt: new Date().toISOString(), modelSettings,
        generationModelSettings: Object.fromEntries(Object.entries(generationModelSettings).filter(([key]) => key !== "apiKey")),
        language: body.language, ...(body.aspectRatio ? { aspectRatio: body.aspectRatio } : {}), ...sizeSnapshot,
        items: items.map(({ eligible, inputRevision, ...item }) => ({ ...item, status: eligible ? "queued" : "rejected", stage: eligible ? "等待启动" : "未受理", ...(eligible ? { jobId: randomUUID() } : {}) })),
      };
      batchGenerationSettings.set(batch.id, generationModelSettings);
      // Once persistence begins, request cancellation cannot undo durable acceptance.
      // Dispatch remains with the server after it releases the mutation lock.
      try { await batches.put(batch); }
      catch (error) { batchGenerationSettings.delete(batch.id); throw error; }
      return batch;
    },
  };
}
