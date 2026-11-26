import { requestedImageSize } from "../lib/image-size.mjs";
import { createGenerationPreparation, validateGenerationOptions } from "./generation-preparation.mjs";
import { createImageCollection } from "./image-collection.mjs";
import { createBatchStore } from "./batches.mjs";
import { createBatchScheduler } from "./batch-scheduler.mjs";
import { createBatchAdmission } from "./batch-admission.mjs";
import { referencePosition, savedReferenceIndex } from "./image-order.mjs";
import { createSessionStore, sessionIds } from "./sessions.mjs";
import { prepareRestart } from "./restart.mjs";
import { createTaskFeed } from "./task-feed.mjs";
import { createTaskRecords } from "./task-records.mjs";
import { createTaskRuntime } from "./task-runtime.mjs";
import { createGenerationOutputs } from "./generation-output.mjs";
import { createServer } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent } from "./agent.mjs";
import { runGeneration, imagegenSkillPath, readGenerationSettings } from "./generation.mjs";
import { createProjectStore, recoverProjectDeletion } from "./projects.mjs";
import { inspectMagpie } from "./magpie.mjs";
import { createImageSettingsStore } from "./image-settings.mjs";
import { runImageApi } from "./image-api.mjs";
import { builtinAgents, createAgentRegistry, LEGACY_AGENT } from "./agents.mjs";
import { createCompatibilityChecker, assertFeatureSupported } from "./compatibility.mjs";
import { createImageStore } from "./images.mjs";
import { createThumbnailStore } from "./thumbnails.mjs";
import { createGalleryStore } from "./gallery.mjs";
import { openGeneratedImage } from "./image-actions.mjs";
import { migrateStorage } from "./storage.mjs";
import { connectionOrigins } from "./connection.mjs";
import { serviceRoutes } from "./routes/service.mjs";
import { projectRoutes } from "./routes/projects.mjs";
import { jobRoutes } from "./routes/jobs.mjs";
import { bad, readBody, decodeImage, decodeSubjects, sourceUrlFor } from "./http.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const defaultCompatibility = createCompatibilityChecker();
export { decodeImage } from "./http.mjs";

export async function createBridge({
  dataDir = resolve(process.env.ALCHEMY_DATA_DIR || join(root, ".local")),
  extensionId = process.env.ALCHEMY_EXTENSION_ID,
  skillPath = resolve(
    process.env.ALCHEMY_SKILL_PATH ||
      join(root, ".agents/skills/alchemy/SKILL.md"),
  ),
  agent = runAgent,
  generator = runGeneration,
  generationContext = readGenerationSettings,
  apiGenerator = runImageApi, magpieInspector = inspectMagpie,
  generationSkillPath = imagegenSkillPath(),
  allowShutdown = false,
  restart,
  restartId,
  imageAction = openGeneratedImage,
  models,
  piModels,
  cli,
  piCli,
  compatibility = defaultCompatibility,
  sessions,
  sessionReadTimeoutMs = 120_000,
} = {}) {
  const trustedConnections = connectionOrigins(extensionId);
  const instanceId = randomUUID();
  const paths = await migrateStorage(dataDir);
  sessions ||= createSessionStore({ cwd: root, dataDir: paths.records });
  const agents = await createAgentRegistry({ dataDir: paths.config, adapters: await builtinAgents({
    cwd: root, dataDir, configDir: paths.config, compatibility, resetSessions: () => sessions.resetReader?.(),
    overrides: { codex: { models, cli }, pi: { models: piModels, cli: piCli } },
  }) });
  // Codex also hosts session reading and built-in generation, so its CLI state is reported regardless of the reverse Agent.
  const codexHost = agents.get("codex");
  const imageSettings = await createImageSettingsStore({ dataDir: paths.config });
  const batchGenerationSettings = new Map(); // Secrets live only until the accepted batch settles.
  const requireFeature = async feature => {
    const report = await compatibility.getCompatibility();
    if (cliBusy()) throw bad("Agent CLI 正在安装或更新，请等待完成。", 409);
    assertFeatureSupported(report, feature);
  };
  await recoverProjectDeletion(paths.records, dataDir);
  const images = await createImageStore(dataDir, paths.records);
  await images.migrate();
  const thumbnails = await createThumbnailStore({ dataDir, images });
  const tokenPath = paths.token;
  let token;
  try {
    token = (await readFile(tokenPath, "utf8")).trim();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    token = randomBytes(32).toString("hex");
    await writeFile(tokenPath, token, { mode: 0o600 });
  }
  const taskFeed = createTaskFeed();
  let projects, batches;
  const records = await createTaskRecords({ dataDir: paths.records, onCommit: (job, committed) => {
    projects?.updateJob(job);
    taskFeed.update(committed);
  } });
  const { jobs, save } = records;
  const storedImage = async (record, subject = false, asPath = false) => {
    const asset = record[subject ? "subjectAsset" : "imageAsset"];
    if (asset !== undefined) {
      try {
        const bytes = await images.read(asset);
        const image = `data:image/${asset.split(".")[1]};base64,${bytes.toString("base64")}`;
        decodeImage(image);
        return asPath ? images.path(asset) : image;
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    } else {
      const old = await images.legacy(`${record.id}${subject ? "-subject" : ""}`);
      if (old) {
        const image = `data:image/${old.extension};base64,${old.bytes.toString("base64")}`;
        decodeImage(image);
        return asPath ? old.file : image;
      }
    }
    throw bad(subject ? "这条记录的主体图已不存在，请重新上传主体图。" : "这条历史记录的原图已不存在，请回到网页重新选择图片。", 404);
  };
  const restoreSubjects = async (subjects) => {
    if (!Array.isArray(subjects) || subjects.length < 2) throw bad("此记录没有保存多图主体快照", 404);
    return Promise.all(subjects.map(async ({ id, subjectAsset, role, detail }) => ({
      id, role, detail, subjectImage: await storedImage({ subjectAsset }, true),
    })));
  };
  const saveSubjects = (subjects) => Promise.all(subjects.map(async ({ id, role, detail, bytes, extension }) => ({
    id, role, detail, subjectAsset: await images.put({ bytes, extension }),
  })));
  projects = await createProjectStore({ dataDir: paths.records, legacyDir: dataDir, jobs, images, saveJob: save, batchBusy: id => !!batches?.hasProject(id), onBatchCleanup: () => batches.reload(), readReference: async (id) => decodeImage(await storedImage(jobs.get(id))) });
  for (const job of jobs.values()) taskFeed.update(job);
  const gallery = createGalleryStore({ projects, images });
  const runtime = createTaskRuntime({ save, onProgress: job => projects.updateJob(job),
    onIdle: async () => { scheduler.kick(); await imageCollection.onIdle(); }, onFailure: (settings, error) => settings?.imageProvider || settings?.codexGeneration ? Promise.resolve() : agents.frozen(settings).models.invalidate(settings, error) });
  const generationOutputs = createGenerationOutputs(images, { directory: join(dataDir, "generation-outputs"), recordsDir: paths.records });
  const codexBusy = () => runtime.busy || !!batches?.active.length || agents.busy || sessions.busy;
  let mutationTail = Promise.resolve();
  const acquireMutation = async () => {
    const previous = mutationTail;
    let release;
    mutationTail = new Promise((resolve) => { release = resolve; });
    await previous;
    return release;
  };
  const startGeneration = async (job, body, { modelSettings, promptResult = job.result, automatic = false, sizeSnapshot, signal } = {}) => {
    if (job.generations?.some(item => item.resultSavePending)) throw bad("已有生成图片尚未保存，请先重试保存，避免重复请求模型。", 409);
    if (job.status !== "completed" || !job.result) throw bad("请先完成提示词逆向", 409);
    if (job.mode === "style" && !job.reenact) throw bad("通用风格需要先补充主体图并重新逆向，才能生成图片");
    if (!automatic && job.autoGeneration?.status === "pending") throw bad("这条提示词正在准备自动生图，请等待完成或取消", 409);
    if (cliBusy()) throw bad("Agent CLI 正在安装或更新，请等待完成。", 409);
    if (agents.busy) throw bad("正在验证模型，请稍候", 409);
    if (job.generations?.some((item) => item.status === "running" || runtime.has(item.id)))
      throw bad("这条提示词仍在生图，请等待完成或取消", 409);
    validateGenerationOptions(body);
    const { aspectRatio } = body;
    if (job.mode === "recreate" && (body.subjectImage !== undefined || body.subjects !== undefined)) throw bad("完整复刻使用纯文生图，不接受主体图");
    if (job.mode === "session" && (body.subjectImage !== undefined || body.subjects !== undefined)) throw bad("会话创作不接受主体图");
    if (job.mode !== "multi-reenact" && body.subjects !== undefined) throw bad("此模式不接受多张主体图");
    if (job.mode === "multi-reenact" && body.subjectImage !== undefined) throw bad("多图重演需要主体图列表");
    const referenceIndex = savedReferenceIndex(job);
    if (body.referenceIndex !== undefined && body.referenceIndex !== referenceIndex) throw bad("图片顺序已变化，请重新生成提示词");
    const { negativePrompt } = promptResult;
    let prompt = body.language === "zh" ? promptResult.promptZh : promptResult.promptEn;
    if (!prompt?.trim() || /\[SUBJECT\]/i.test(prompt)) throw bad("提示词仍缺少主体，请补充后重新逆向");
    if (aspectRatio) prompt += body.language === "zh"
      ? `\n\n用户指定的输出画面宽高比例：${aspectRatio.width}:${aspectRatio.height}（宽:高）。此比例要求优先于原提示词及参考图中的画幅要求。请调整构图和背景以适应该比例，保持主体自然比例，不拉伸或压缩主体。`
      : `\n\nUser-requested output aspect ratio: ${aspectRatio.width}:${aspectRatio.height} (width:height). This ratio takes priority over framing requirements in the original prompt and reference images. Adapt the composition and background to this ratio while preserving natural subject proportions; do not stretch or compress the subject.`;
    ({ modelSettings, sizeSnapshot } = await generation.prepare(body, {
      frozen: modelSettings ? { modelSettings, sizeSnapshot } : undefined, signal,
    }));
    const imageSize = sizeSnapshot?.submittedImageSize || undefined;
    const imagePath = job.mode === "recreate" ? undefined : await storedImage(job, false, true);
    const multi = job.mode === "multi-reenact";
    const decodedSubjects = multi ? decodeSubjects(body.subjects !== undefined ? body.subjects : await restoreSubjects(job.reenact?.subjects), (await images.read(job.imageAsset)).length) : undefined;
    if (multi && JSON.stringify(decodedSubjects.map(subject => subject.id)) !== JSON.stringify(job.reenact?.subjects?.map(subject => subject.id)))
      throw bad("主体图片顺序已变化，请重新生成提示词");
    const subject = !multi && job.mode !== "recreate" && job.reenact
      ? decodeImage(body.subjectImage !== undefined ? body.subjectImage : await storedImage(job, true)) : undefined;
    if (subject?.bytes.length > 2 * 1024 * 1024) throw bad("主体图最多 2 MB，请压缩后重试");
    await generation.check(modelSettings, signal);
    const id = randomUUID();
    const subjectAsset = subject ? await images.put(subject) : undefined;
    const subjectImagePath = subjectAsset ? images.path(subjectAsset) : undefined;
    const subjects = multi ? await saveSubjects(decodedSubjects) : undefined;
    const subjectImagePaths = subjects?.map((item) => images.path(item.subjectAsset));
    referencePosition(referenceIndex, subjects?.length ?? (subject ? 1 : 0));
    signal?.throwIfAborted();
    const controller = runtime.reserve(id, job.projectId);
    const next = { id, referenceIndex, ...(modelSettings.imageProvider === "magpie" ? { sizeMode: imageSize ? "explicit" : "gateway-default", ...structuredClone(sizeSnapshot) } : {}), provider: modelSettings.imageProvider || "codex", ...(modelSettings.imageProvider ? { baseUrl: modelSettings.baseUrl } : {}), model: modelSettings.model, reasoningEffort: modelSettings.reasoningEffort, status: "running", stage: modelSettings.imageProvider ? "正在连接生图 API…" : "正在连接 Codex 生图…", createdAt: new Date().toISOString(), language: body.language, prompt, negativePrompt, ...(aspectRatio ? { aspectRatio } : {}), ...(subject ? { subjectExtension: subject.extension, subjectAsset } : {}), ...(subjects ? { subjects } : {}) };
    job.generations ||= [];
    job.generations.push(next);
    if (automatic) Object.assign(job.autoGeneration, { status: "started", generationId: id });
    try {
      await save(job);
    } catch (error) {
      runtime.release(id);
      job.generations.pop();
      if (automatic) { job.autoGeneration.status = "pending"; delete job.autoGeneration.generationId; }
      throw error;
    }
    if (signal?.aborted) { controller.abort(); Object.assign(next, { status: "cancelled", stage: "已取消" }); }
    void runtime.run(job, next, { modelSettings, completedStage: "图片已生成", failedStage: "生图失败",
      onSaveFailure: () => { if (next.status !== "cancelled") generationOutputs.markPending(next); },
      onSettled: () => generationOutputs.settled(next),
      execute: async ({ signal, progress }) => {
        const output = await (modelSettings.imageProvider ? apiGenerator : generator)({ ...(modelSettings.imageProvider ? { settings: modelSettings, aspectRatio, imageSize } : {}), mode: job.mode, imagePath, subjectImagePath, subjectImagePaths, subjects, referenceIndex, prompt, negativePrompt: next.negativePrompt,
          skillPath: generationSkillPath, cwd: root, signal, modelSettings, onProgress: progress });
        signal.throwIfAborted();
        if (!["png", "jpeg", "webp"].includes(output.extension)) throw new Error("生图返回了不支持的文件格式");
        generationOutputs.remember(next, output);
        const saved = { id: next.id, provider: next.provider };
        try { await generationOutputs.write(saved, job.id); }
        catch (error) { if (next.status === "running") generationOutputs.markPending(next); throw error; }
        return saved;
      },
    });
    return job;
  };
  const startJob = async (body, { readSessions, assertSessionRequestActive, frozen, signal } = {}) => {
    let generationModelSettings, sizeSnapshot;
    if (cliBusy()) throw bad("Agent CLI 正在安装或更新，请等待完成。", 409);
    if (agents.busy) throw bad("正在验证模型，请稍候", 409);
    if (body.generation !== undefined) {
      if (!body.generation || typeof body.generation !== "object" || Array.isArray(body.generation) || Object.keys(body.generation).some(key => !["language", "aspectRatio", "imageSize"].includes(key))) throw bad("无效自动生图参数");
      validateGenerationOptions(body.generation);
      if (body.mode === "style" && !body.reenact) throw bad("通用风格需要先补充主体图并重新逆向，才能生成图片");
      ({ modelSettings: generationModelSettings, sizeSnapshot } = await generation.prepare(body.generation, {
        frozen: frozen ? { modelSettings: frozen.generationModelSettings, sizeSnapshot: frozen.sizeSnapshot } : undefined, signal,
      }));
      body = { ...body, generation: { ...structuredClone(body.generation), imageSize: requestedImageSize(body.generation.imageSize) } };
      await generation.check(generationModelSettings, signal);
    }
    if (!["style", "recreate", "reenact", "multi-reenact", "session"].includes(body.mode)) throw bad("无效逆向模式");
    const submittedInstruction = body.instruction ?? body.reenact?.basePrompt;
    if (body.instruction === null || (submittedInstruction !== undefined && typeof submittedInstruction !== "string")) throw bad("任务指令必须是文本");
    if (submittedInstruction?.length > 20000) throw bad("任务指令最多 20000 字符");
    const instruction = submittedInstruction?.trim();
    let selectedSessions;
    if (body.mode === "session") {
      if (body.reenact !== undefined || body.subjectImage !== undefined || body.subjects !== undefined) throw bad("会话创作只使用一张参考图，不接受主体图");
      if (!instruction) throw bad("请填写会话创作目标");
      const ids = sessionIds(body.sessionIds, true);
      try { selectedSessions = await readSessions(signal => sessions.metadata(ids, signal)); }
      catch (error) { throw error.status ? error : bad("无法读取所选会话，请刷新后重试", 503); }
      if (agents.busy) throw bad("正在验证模型，请稍候", 409);
    } else if (body.sessionIds !== undefined) throw bad("当前模式不接受会话输入");
    const { bytes, extension } = decodeImage(body.image);
    let project;
    if (body.projectId !== undefined) {
      if (typeof body.projectId !== "string" || !/^[a-f0-9]{64}$/.test(body.projectId)) throw bad("项目编号无效");
      project = projects.summary(body.projectId);
      if (!project) throw bad("项目不存在", 404);
      if (body.inputRevision !== undefined && (!Number.isSafeInteger(body.inputRevision) || body.inputRevision < 0)) throw bad("项目输入版本无效");
      if (body.inputRevision !== undefined && body.inputRevision !== project.inputRevision && !frozen) throw bad("项目输入已在其他窗口更新，请重新打开项目", 409);
      const source = body.referenceJobId === undefined ? project : jobs.get(body.referenceJobId);
      if (!source || (body.referenceJobId !== undefined && source.projectId !== project.id)) throw bad("历史参考图不属于当前项目");
      const sourceBytes = frozen ? bytes : body.referenceJobId === undefined ? await images.read(source.imageAsset) : decodeImage(await storedImage(source)).bytes;
      if (!frozen && !bytes.equals(sourceBytes)) throw bad("参考图与项目不一致，请重新选择项目");
    } else if (body.referenceJobId !== undefined || body.inputRevision !== undefined) throw bad("请提供项目编号");
    let subject, reenact, decodedSubjects;
    const multi = body.mode === "multi-reenact";
    if (multi) {
      if (!body.reenact || !instruction)
        throw bad("多图重演需要任务指令，最多 20000 字符");
      decodedSubjects = decodeSubjects(body.reenact.subjects, bytes.length);
      reenact = { basePrompt: instruction };
    } else if (body.mode === "reenact" || (body.mode === "style" && body.reenact !== undefined)) {
      if (!body.reenact || !instruction)
        throw bad("双图任务需要主体图和任务指令");
      subject = decodeImage(body.reenact.subjectImage);
      // Keep the paired images within the extension's storage quota.
      if (bytes.length > 4 * 1024 * 1024 || subject.bytes.length > 2 * 1024 * 1024)
        throw bad("参考图最多 4 MB，主体图最多 2 MB，请压缩后重试");
      const promptSourceJobId = body.reenact.promptSourceJobId;
      if (promptSourceJobId !== undefined) {
        const source = jobs.get(promptSourceJobId);
        if (!source?.result || source.status !== "completed") throw bad("参考 Prompt 的来源任务不存在或尚未完成");
        if (!bytes.equals(decodeImage(await storedImage(source)).bytes))
          throw bad("参考图与 Prompt 的来源不一致，请重新选择历史记录");
      }
      reenact = { basePrompt: instruction, ...(promptSourceJobId ? { promptSourceJobId } : {}) };
    }
    const referenceIndex = referencePosition(body.referenceIndex, decodedSubjects?.length ?? (subject ? 1 : 0), 0);
    try {
      await readFile(skillPath);
    } catch {
      throw bad("找不到 Alchemy 技能，请设置 ALCHEMY_SKILL_PATH", 503);
    }
    const modelSettings = frozen?.modelSettings || agents.selection();
    signal?.throwIfAborted();
    const sourceUrl = sourceUrlFor(body.sourceUrl);
    if (selectedSessions) assertSessionRequestActive();
    project ||= await projects.register({ bytes, extension }, { sourceUrl, capture: body.capture });
    const imageAsset = await images.put({ bytes, extension });
    const currentJobId = project.inputVersions?.[body.mode] ?? projects.get(project.id).jobs.find((job) => job.mode === body.mode)?.id;
    const historical = body.referenceJobId !== undefined && body.referenceJobId !== currentJobId;
    const subjectAsset = subject ? await images.put(subject) : undefined;
    if (multi) reenact.subjects = await saveSubjects(decodedSubjects);
    if (selectedSessions) assertSessionRequestActive();
    signal?.throwIfAborted();
    const id = frozen?.jobId || randomUUID();
    runtime.reserve(id, project.id);
    const imagePath = images.path(imageAsset);
    const subjectImagePath = subjectAsset ? images.path(subjectAsset) : undefined;
    const job = {
      id,
      projectId: project.id,
      imageAsset,
      ...(subjectAsset ? { subjectAsset } : {}),
      mode: body.mode,
      referenceIndex,
      agent: modelSettings.agent ?? LEGACY_AGENT,
      provider: modelSettings.provider,
      model: modelSettings.model,
      reasoningEffort: modelSettings.reasoningEffort,
      status: "running",
      stage: `正在连接本机 ${agents.frozen(modelSettings).label}…`,
      createdAt: new Date().toISOString(),
      sourceUrl,
      capture: body.capture === "screenshot" ? "screenshot" : "original",
      ...(instruction !== undefined ? { instruction } : {}),
      ...(reenact ? { reenact } : {}),
      ...(body.generation ? { autoGeneration: { ...body.generation, ...structuredClone(sizeSnapshot), provider: generationModelSettings.imageProvider || "codex", status: "pending" } } : {}),
      ...(selectedSessions ? { sessionContext: { sources: selectedSessions } } : {}),
    };
    try {
      await save(job);
      if (imageAsset === project.imageAsset && !historical && (!frozen || body.inputRevision === project.inputRevision)) await projects.selectInputVersion(project.id, job);
      else if (project.inputVersions?.[body.mode] === undefined && jobs.has(currentJobId)) await projects.selectInputVersion(project.id, jobs.get(currentJobId), true);
    } catch (error) {
      Object.assign(job, { status: "failed", stage: "任务保存失败", error: "任务未启动，请重试" });
      if (job.autoGeneration) Object.assign(job.autoGeneration, { status: "failed", error: job.error });
      await save(job).catch((failure) => console.error("保存失败任务状态失败:", failure.message));
      projects.updateJob(job);
      runtime.release(id);
      throw error;
    }
    let promptSnapshot;
    void runtime.run(job, job, { modelSettings, onSettled: body.generation ? async ({ signal }) => {
      const release = await acquireMutation();
      try {
        if (job.autoGeneration.status !== "pending") return;
        if (job.status !== "completed" || signal.aborted) {
          Object.assign(job.autoGeneration, { status: job.status === "cancelled" || signal.aborted ? "cancelled" : "failed", error: job.error });
        } else {
          try {
            await startGeneration(job, body.generation, { modelSettings: generationModelSettings, promptResult: promptSnapshot, automatic: true, sizeSnapshot, signal });
            return;
          } catch (error) { Object.assign(job.autoGeneration, { status: "failed", error: error.message }); }
        }
        await save(job);
      } finally { release(); }
    } : undefined, completedStage: "逆向完成", failedStage: "逆向失败",
      execute: async ({ signal, progress }) => {
        let sessionContext;
        if (selectedSessions) {
          progress({ stage: "正在读取所选会话…" });
          sessionContext = await sessions.capture(selectedSessions, { jobId: id, signal });
          signal.throwIfAborted();
          const { sources, hash, capturedAt, messageCount, attachmentCount } = sessionContext;
          job.sessionContext = { sources, snapshotId: id, hash, capturedAt, messageCount, attachmentCount };
          await save(job);
        }
        signal.throwIfAborted();
        const result = await agent({ run: agents.frozen(modelSettings).run, sessionContext, imagePath, subjectImagePath,
          subjectImagePaths: reenact?.subjects?.map((item) => images.path(item.subjectAsset)),
          subjects: reenact?.subjects, referenceIndex, basePrompt: reenact?.basePrompt, instruction: job.instruction,
          mode: job.mode, skillPath, cwd: root, dataDir, signal, modelSettings, onProgress: progress });
        promptSnapshot = structuredClone(result);
        return { result };
      },
    });
    return job;
  };
  // Service-level flags that routes and the batch scheduler read and set.
  const state = { shuttingDown: false, deletionFailed: false, cliStarting: false };
  const cliBusy = () => state.cliStarting || agents.cliBusy;
  batches = await createBatchStore(join(paths.records, 'batches.json'), ids => { taskFeed.touch(); projects.touch(ids); });
  const generation = createGenerationPreparation({ imageSettings, generationContext, cwd: root, cliBusy, agents, magpieInspector, requireFeature, generationSkillPath });
  const imageCollection = createImageCollection({ images, thumbnails, runtime, records, batches, generationOutputs, jobs, acquireMutation });
  const batchAdmission = createBatchAdmission({
    batches, projects, runtime, agents, cliBusy, storedImage, skillPath, requireFeature, batchGenerationSettings, generation,
  });
  const cancelJob = async job => {
    if (job.autoGeneration?.status === 'pending') {
      job.autoGeneration.status = 'cancelled';
      if (job.status === 'running') await runtime.cancel(job); else await save(job);
    } else if (job.autoGeneration?.status === 'started') {
      const generation = job.generations?.find(item => item.id === job.autoGeneration.generationId);
      if (generation) await runtime.cancel(job, generation);
    } else await runtime.cancel(job);
  };
  const scheduler = createBatchScheduler({ batches, jobs, projects, runtime, generation, batchGenerationSettings, storedImage, startJob, acquireMutation,
    stopped: () => state.shuttingDown || state.deletionFailed, idle: () => !(cliBusy() || agents.busy || runtime.reading || sessions.busy) });
  const publicBatch = scheduler.view;
  await generationOutputs.recover(jobs, save);
  await imageCollection.collect();

  // Everything the route modules may use; `server` is attached once created.
  const app = { agents, allowShutdown, batchAdmission, batches, cancelJob, cliBusy, codexBusy, codexHost, compatibility, dataDir, gallery, generationOutputs, generationSkillPath, imageAction, imageCollection, imageSettings, images, instanceId, jobs, magpieInspector, projects, publicBatch, requireFeature, restart, restartId, restoreSubjects, root, runtime, save, saveSubjects, sessions, skillPath, startGeneration, state, storedImage, taskFeed, thumbnails, version };
  const server = createServer(async (req, res) => {
    const submission = new AbortController();
    const abortSubmission = () => submission.abort(bad("请求已取消", 499));
    res.once("close", abortSubmission);
    let releaseMutation, sessionReadController, sessionReadTimer;
    const abortSessionRead = () => sessionReadController?.abort(bad("会话请求已取消", 499));
    const assertSessionRequestActive = () => {
      if (res.destroyed || req.aborted) throw bad("会话请求已取消", 499);
      sessionReadController?.signal.throwIfAborted();
    };
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const json = (status, value) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
      });
      res.end(JSON.stringify(value));
    };
    try {
      if (!/^127\.0\.0\.1:\d+$/.test(req.headers.host || ""))
        throw bad("Invalid host", 403);
      const origin = req.headers.origin;
      if (origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin))
        throw bad("Origin not allowed", 403);
      const url = new URL(req.url, "http://127.0.0.1");
      const path = url.pathname;
      const query = url.searchParams;
      if (path === "/connection") {
        if (!trustedConnections.has(origin)) throw bad("Origin not allowed", 403);
        if (url.search) throw bad("无效查询参数");
      }
      if (origin) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
      }
      if (req.method === "OPTIONS") {
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader(
          "Access-Control-Allow-Headers",
          "Authorization, Content-Type",
        );
        res.writeHead(204);
        res.end();
        return;
      }
      if (path === "/connection") {
        if (req.method !== "POST") throw bad("Method not allowed", 405);
        if (Object.keys(await readBody(req)).length) throw bad("无效连接请求");
        json(200, { token });
        return;
      }
      const supplied = Buffer.from(
        (req.headers.authorization || "").replace(/^Bearer /, ""),
      );
      const expected = Buffer.from(token);
      if (
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)
      )
        throw bad("本机连接凭据已失效，请重新打开工作台自动连接", 401);
      const validateQuery = (allowed) => {
        for (const key of query.keys()) if (!allowed.includes(key) || query.getAll(key).length !== 1) throw bad("无效查询参数");
      };
      const includeHidden = () => {
        const value = query.get("includeHidden");
        if (value !== null && value !== "true" && value !== "false") throw bad("无效隐藏项目参数");
        return value === "true";
      };
      const submittedJob = req.method === "POST" && path === "/jobs" ? await readBody(req) : undefined;
      // Probe before taking the mutation lock; all task/revision checks still run under it.
      const feature = req.method !== "POST" ? undefined : path === "/jobs" ? (agents.get().compatibility ? "reverse" : submittedJob?.generation && imageSettings.view().provider === "codex" ? "generation" : undefined)
        : /^\/jobs\/[\da-f-]{36}\/generations$/.test(path) ? (imageSettings.view().provider === "codex" ? "generation" : undefined)
        : ["/models/refresh", "/models/verify"].includes(path) && agents.get(query.get("agent") ?? LEGACY_AGENT).compatibility ? "models" : undefined;
      if (feature) {
        if (cliBusy()) throw bad("Agent CLI 正在安装或更新，请等待完成。", 409);
        const controller = new AbortController();
        const abort = () => controller.abort(bad("请求已取消", 499));
        res.once("close", abort);
        const releaseReader = runtime.read();
        try {
          if (res.destroyed || req.aborted) abort();
          controller.signal.throwIfAborted();
          await Promise.race([Promise.all([requireFeature(feature), ...(submittedJob?.generation !== undefined && imageSettings.view().provider === "codex" ? [requireFeature("generation")] : [])]), new Promise((_, reject) => {
            controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
          })]);
        } finally {
          res.removeListener("close", abort);
          releaseMutation = await acquireMutation();
          releaseReader();
        }
        controller.signal.throwIfAborted();
        if (res.destroyed || req.aborted) throw bad("请求已取消", 499);
      }
      // Keep deletion and task setup from writing the same project concurrently.
      if (req.method === "POST") {
        releaseMutation ||= await acquireMutation();
        if (state.shuttingDown) throw bad("服务正在停止，请重新启动后再试。", 503);
        if (state.deletionFailed) throw bad("项目清理未完成，请重启本机服务后重试", 503);
      }
      const readSessions = async (action, check = true) => {
        const controller = sessionReadController = new AbortController();
        res.once("close", abortSessionRead);
        sessionReadTimer = setTimeout(() => controller.abort(bad("读取会话超时，请重试", 504)), sessionReadTimeoutMs);
        const releaseReader = runtime.read();
        releaseMutation?.(); releaseMutation = undefined;
        let result, abortCompatibility;
        try {
          assertSessionRequestActive();
          if (check) await Promise.race([requireFeature("sessions"), new Promise((_, reject) => {
            abortCompatibility = () => reject(controller.signal.reason);
            controller.signal.addEventListener("abort", abortCompatibility, { once: true });
          })]);
          assertSessionRequestActive();
          result = await action(controller.signal);
        }
        catch (error) { controller.signal.throwIfAborted(); throw error; }
        finally {
          if (abortCompatibility) controller.signal.removeEventListener("abort", abortCompatibility);
          releaseMutation = await acquireMutation();
          releaseReader();
        }
        assertSessionRequestActive();
        if (state.shuttingDown || state.deletionFailed) throw bad("服务状态已变化，请重新打开项目后重试", 503);
        if (cliBusy()) throw bad("Agent CLI 正在安装或更新，请等待完成。", 409);
        return result;
      };
      const request = { req, res, path, query, json, validateQuery, includeHidden, submission, readSessions, assertSessionRequestActive };
      if (await serviceRoutes(request, app) || await projectRoutes(request, app) || await jobRoutes(request, app)) return;
      if (req.method !== "POST" || path !== "/jobs")
        throw bad("Not found", 404);
      json(202, await startJob(submittedJob, { readSessions, assertSessionRequestActive, signal: submission.signal }));
    } catch (error) {
      if (!res.headersSent && !res.destroyed)
        json(error.status || 500, {
          error: error.status ? error.message : "本机服务异常，请检查终端日志",
          ...(error.recovery ? { recovery: error.recovery } : {}),
          ...(error.code ? { code: error.code } : {}),
        });
    } finally {
      clearTimeout(sessionReadTimer);
      res.off("close", abortSessionRead);
      res.off("close", abortSubmission);
      releaseMutation?.();
      scheduler.kick();
    }
  });
  app.server = server;
  server.on("close", () => {
    void sessions.close?.();
    scheduler.close();
    batchGenerationSettings.clear();
    taskFeed.close();
    agents.close();
    runtime.close();
  });
  return { server, token, tokenPath };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { server } = await createBridge({ allowShutdown: process.env.ALCHEMY_MANAGED === "1", restart: prepareRestart, restartId: process.env.ALCHEMY_RESTART_ID });
  const port = Number(process.env.ALCHEMY_PORT || 43187);
  server.on("error", (error) => {
    console.error(
      error.code === "EADDRINUSE"
        ? `端口 ${port} 已占用，请检查已启动的 bridge。`
        : error.message,
    );
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(
      `QC-Reframe ${version} 本机服务：http://127.0.0.1:${port}\n已批准的 Reframe 扩展将自动连接。\n通过已配置的本机 Agent 或生图 API 执行，按 Ctrl+C 停止。`,
    );
  });
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      server.close();
      server.closeAllConnections();
    });
}
