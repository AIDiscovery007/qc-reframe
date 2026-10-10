import { createBatchStore, batchActive } from "./batches.mjs";
import { referencePosition, savedReferenceIndex } from "./image-order.mjs";
import { createSessionStore, sessionIds } from "./sessions.mjs";
import { prepareRestart } from "./restart.mjs";
import { createTaskFeed } from "./task-feed.mjs";
import { createTaskRecords } from "./task-records.mjs";
import { createTaskRuntime } from "./task-runtime.mjs";
import { createServer } from "node:http";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, lstat } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent } from "./agent.mjs";
import { runGeneration, imagegenSkillPath } from "./generation.mjs";
import { createProjectStore, projectIdFor, recoverProjectDeletion } from "./projects.mjs";
import { createImageSettingsStore } from "./image-settings.mjs";
import { runImageApi } from "./image-api.mjs";
import { createModelStore } from "./models.mjs";
import { createAgentStore } from "./agents.mjs";
import { readPiCatalog, runPi } from "./pi-agent.mjs";
import { createCliManager } from "./cli.mjs";
import { createPiCliManager } from "./pi-cli.mjs";
import { createCompatibilityChecker, assertFeatureSupported } from "./compatibility.mjs";
import { createImageStore } from "./images.mjs";
import { createThumbnailStore } from "./thumbnails.mjs";
import { createGalleryStore } from "./gallery.mjs";
import { openGeneratedImage } from "./image-actions.mjs";
import sharp from "sharp";
import { migrateStorage } from "./storage.mjs";
import { connectionOrigins } from "./connection.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const defaultCompatibility = createCompatibilityChecker();
const MAX_IMAGE = 8 * 1024 * 1024;
const MAX_BODY = 24 * 1024 * 1024;
const bad = (message, status = 400) =>
  Object.assign(new Error(message), { status });

function validateGenerationOptions(body) {
  if (!["zh", "en"].includes(body.language)) throw bad("无效提示词语言");
  const { aspectRatio } = body;
  if (aspectRatio !== undefined && (!aspectRatio || typeof aspectRatio !== "object" || Array.isArray(aspectRatio)
    || Object.keys(aspectRatio).some(key => !["width", "height"].includes(key))
    || ![aspectRatio.width, aspectRatio.height].every(value => Number.isInteger(value) && value >= 1 && value <= 10000)
    || aspectRatio.width / aspectRatio.height < 1 / 20 || aspectRatio.width / aspectRatio.height > 20))
    throw bad("宽高须为 1–10000 的整数，比例须在 1:20 至 20:1 之间");
}

function sourceUrlFor(value) {
  try {
    const url = new URL(value);
    if (["http:", "https:"].includes(url.protocol)) {
      url.search = "";
      url.hash = "";
      return url.href;
    }
  } catch {}
  return "";
}

async function readBody(req) {
  if (!req.headers["content-type"]?.startsWith("application/json")) throw bad("Content-Type must be application/json", 415);
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw bad("请求过大", 413);
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw bad("无效 JSON"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw bad("无效请求");
  return body;
}

export function decodeImage(dataUrl) {
  if (typeof dataUrl !== "string" || dataUrl.length > MAX_BODY)
    throw bad("图片过大，最多 8 MB");
  const match =
    /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match) throw bad("仅支持 PNG、JPEG、WebP 图片");
  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.length || bytes.length > MAX_IMAGE)
    throw bad("图片为空或超过 8 MB");
  const signatures = {
    png: bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    jpeg: bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255,
    webp:
      bytes.toString("ascii", 0, 4) === "RIFF" &&
      bytes.toString("ascii", 8, 12) === "WEBP",
  };
  if (!signatures[match[1]]) throw bad("图片内容与格式不匹配");
  return { bytes, extension: match[1] };
}

function decodeSubjects(subjects, referenceBytes, draft = false) {
  if (!Array.isArray(subjects) || subjects.length < (draft ? 0 : 2) || subjects.length > 6)
    throw bad("多图重演需要 2–6 张主体图");
  const ids = new Set();
  const decoded = subjects.map((subject) => {
    if (!subject || typeof subject.id !== "string" || !/^[\w-]{1,100}$/.test(subject.id) || ids.has(subject.id))
      throw bad("主体编号无效或重复");
    ids.add(subject.id);
    if (!["自动", "人物", "物品", "服饰", "场景", "细节"].includes(subject.role) || typeof subject.detail !== "string" || subject.detail.length > 2000)
      throw bad("主体职责无效，补充要求最多 2000 字符");
    const image = decodeImage(subject.subjectImage);
    if (image.bytes.length > 2 * 1024 * 1024) throw bad("每张主体图最多 2 MB，请压缩后重试");
    return { id: subject.id, role: subject.role, detail: subject.detail.trim(), ...image };
  });
  if (referenceBytes > 4 * 1024 * 1024 || decoded.reduce((total, item) => total + item.bytes.length, referenceBytes) > 16 * 1024 * 1024)
    throw bad("参考图最多 4 MB，全部图片合计最多 16 MB");
  return decoded;
}

export async function createBridge({
  dataDir = resolve(process.env.ALCHEMY_DATA_DIR || join(root, ".local")),
  extensionId = process.env.ALCHEMY_EXTENSION_ID,
  skillPath = resolve(
    process.env.ALCHEMY_SKILL_PATH ||
      join(root, ".agents/skills/alchemy/SKILL.md"),
  ),
  agent = runAgent,
  generator = runGeneration,
  apiGenerator = runImageApi,
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
  const trustedConnections = connectionOrigins(join(root, ".output/chrome-mv3"), extensionId);
  const instanceId = randomUUID();
  const paths = await migrateStorage(dataDir);
  sessions ||= createSessionStore({ cwd: root, dataDir: paths.records });
  models ||= await createModelStore({ dataDir: paths.config, cwd: root });
  piModels ||= await createModelStore({ dataDir: paths.config, cwd: root, filename: "pi-model-settings.json", readCatalog: cwd => readPiCatalog(cwd, dataDir),
    verify: async ({ cwd, selection, signal }) => {
      const result = await runPi({ cwd, dataDir, signal, modelSettings: selection, probe: true,
        instructions: "仅按用户要求回复文字，不调用工具。", input: [{ type: "text", text: "仅回复 OK。" }] });
      if (!result.text.trim()) throw new Error("Pi 未返回有效响应，请重新验证。");
    } });
  const agents = await createAgentStore({ dataDir: paths.config, models, piModels });
  const imageSettings = await createImageSettingsStore({ dataDir: paths.config });
  const generationSelection = () => {
    const selected = imageSettings.selection();
    return selected.provider === "codex" ? models.selection() : { ...selected, imageProvider: selected.provider };
  };
  const batchGenerationSettings = new Map(); // Secrets live only until the accepted batch settles.
  const checkGeneration = async settings => {
    if (settings.imageProvider) return;
    await requireFeature("generation");
    try { await readFile(generationSkillPath); } catch { throw bad("找不到 imagegen 技能，请设置 IMAGEGEN_SKILL_PATH", 503); }
  };
  cli ||= createCliManager({ onUpdated: async () => {
    try {
      await models.reset();
      const report = await compatibility.getCompatibility({ force: true });
      if (report.error) throw new Error(report.error);
    }
    finally { sessions.resetReader?.(); }
  } });
  piCli ||= createPiCliManager({ dataDir, onUpdated: () => piModels.reset() });
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
    onIdle: async () => { kickBatches(); await collectIdleImages(); }, onFailure: (settings, error) => settings?.imageProvider ? Promise.resolve() : agents.modelStore(settings?.agent || "codex").invalidate(settings, error) });
  const codexBusy = () => runtime.busy || !!batches?.active.length || agents.busy || sessions.busy;
  let mutationTail = Promise.resolve();
  let collectionPending = false;
  const acquireMutation = async () => {
    const previous = mutationTail;
    let release;
    mutationTail = new Promise((resolve) => { release = resolve; });
    await previous;
    return release;
  };
  const collectIdleImages = async () => {
    if (!collectionPending) return;
    const release = await acquireMutation();
    try {
      if (!runtime.count && records.canCollect) { await images.collect(batches?.assets); await thumbnails.collect(); collectionPending = false; }
    }
    catch (error) { console.error("回收图片失败:", error.message); }
    finally { release(); }
  };
  const startGeneration = async (job, body, { modelSettings = generationSelection(), promptResult = job.result, automatic = false, signal } = {}) => {
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
    const imagePath = job.mode === "recreate" ? undefined : await storedImage(job, false, true);
    const multi = job.mode === "multi-reenact";
    const decodedSubjects = multi ? decodeSubjects(body.subjects !== undefined ? body.subjects : await restoreSubjects(job.reenact?.subjects), (await images.read(job.imageAsset)).length) : undefined;
    if (multi && JSON.stringify(decodedSubjects.map(subject => subject.id)) !== JSON.stringify(job.reenact?.subjects?.map(subject => subject.id)))
      throw bad("主体图片顺序已变化，请重新生成提示词");
    const subject = !multi && job.mode !== "recreate" && job.reenact
      ? decodeImage(body.subjectImage !== undefined ? body.subjectImage : await storedImage(job, true)) : undefined;
    if (subject?.bytes.length > 2 * 1024 * 1024) throw bad("主体图最多 2 MB，请压缩后重试");
    await checkGeneration(modelSettings);
    const id = randomUUID();
    const subjectAsset = subject ? await images.put(subject) : undefined;
    const subjectImagePath = subjectAsset ? images.path(subjectAsset) : undefined;
    const subjects = multi ? await saveSubjects(decodedSubjects) : undefined;
    const subjectImagePaths = subjects?.map((item) => images.path(item.subjectAsset));
    referencePosition(referenceIndex, subjects?.length ?? (subject ? 1 : 0));
    signal?.throwIfAborted();
    const controller = runtime.reserve(id, job.projectId);
    const next = { id, referenceIndex, provider: modelSettings.imageProvider || "codex", ...(modelSettings.imageProvider ? { baseUrl: modelSettings.baseUrl } : {}), model: modelSettings.model, reasoningEffort: modelSettings.reasoningEffort, status: "running", stage: modelSettings.imageProvider ? "正在连接生图 API…" : "正在连接 Codex 生图…", createdAt: new Date().toISOString(), language: body.language, prompt, negativePrompt, ...(aspectRatio ? { aspectRatio } : {}), ...(subject ? { subjectExtension: subject.extension, subjectAsset } : {}), ...(subjects ? { subjects } : {}) };
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
      execute: async ({ signal, progress }) => {
        const output = await (modelSettings.imageProvider ? apiGenerator : generator)({ ...(modelSettings.imageProvider ? { settings: modelSettings, aspectRatio } : {}), mode: job.mode, imagePath, subjectImagePath, subjectImagePaths, subjects, referenceIndex, prompt, negativePrompt: next.negativePrompt,
          skillPath: generationSkillPath, cwd: root, signal, modelSettings, onProgress: progress });
        signal.throwIfAborted();
        if (!["png", "jpeg", "webp"].includes(output.extension)) throw new Error("生图返回了不支持的文件格式");
        const imageAsset = await images.put(output);
        return { extension: output.extension, imageAsset, revisedPrompt: output.revisedPrompt };
      },
    });
    return job;
  };
  const startJob = async (body, { readSessions, assertSessionRequestActive, frozen } = {}) => {
    const generationModelSettings = body.generation ? frozen?.generationModelSettings || generationSelection() : undefined;
    if (cliBusy()) throw bad("Agent CLI 正在安装或更新，请等待完成。", 409);
    if (agents.busy) throw bad("正在验证模型，请稍候", 409);
    if (body.generation !== undefined) {
      if (!body.generation || typeof body.generation !== "object" || Array.isArray(body.generation) || Object.keys(body.generation).some(key => !["language", "aspectRatio"].includes(key))) throw bad("无效自动生图参数");
      validateGenerationOptions(body.generation);
      if (body.mode === "style" && !body.reenact) throw bad("通用风格需要先补充主体图并重新逆向，才能生成图片");
      await checkGeneration(generationModelSettings);
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
    const sourceUrl = sourceUrlFor(body.sourceUrl);
    if (selectedSessions) assertSessionRequestActive();
    project ||= await projects.register({ bytes, extension }, { sourceUrl, capture: body.capture });
    const imageAsset = await images.put({ bytes, extension });
    const currentJobId = project.inputVersions?.[body.mode] ?? projects.get(project.id).jobs.find((job) => job.mode === body.mode)?.id;
    const historical = body.referenceJobId !== undefined && body.referenceJobId !== currentJobId;
    const subjectAsset = subject ? await images.put(subject) : undefined;
    if (multi) reenact.subjects = await saveSubjects(decodedSubjects);
    if (selectedSessions) assertSessionRequestActive();
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
      agent: modelSettings.agent || "codex",
      provider: modelSettings.provider,
      model: modelSettings.model,
      reasoningEffort: modelSettings.reasoningEffort,
      status: "running",
      stage: `正在连接本机 ${modelSettings.agent === "pi" ? "Pi" : "Codex"}…`,
      createdAt: new Date().toISOString(),
      sourceUrl,
      capture: body.capture === "screenshot" ? "screenshot" : "original",
      ...(instruction !== undefined ? { instruction } : {}),
      ...(reenact ? { reenact } : {}),
      ...(body.generation ? { autoGeneration: { ...body.generation, status: "pending" } } : {}),
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
            await startGeneration(job, body.generation, { modelSettings: generationModelSettings, promptResult: promptSnapshot, automatic: true, signal });
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
        const result = await agent({ sessionContext, imagePath, subjectImagePath,
          subjectImagePaths: reenact?.subjects?.map((item) => images.path(item.subjectAsset)),
          subjects: reenact?.subjects, referenceIndex, basePrompt: reenact?.basePrompt, instruction: job.instruction,
          mode: job.mode, skillPath, cwd: root, dataDir, signal, modelSettings, onProgress: progress });
        promptSnapshot = structuredClone(result);
        return { result };
      },
    });
    return job;
  };
  let deletionFailed = false;
  let shuttingDown = false;
  let cliStarting = false;
  const cliBusy = () => cliStarting || cli.busy || piCli.busy;
  batches = await createBatchStore(join(paths.records, 'batches.json'), ids => { taskFeed.touch(); projects.touch(ids); });
  const batchItems = batch => batch.items.map(({ snapshot, ...item }) => {
    const job = item.jobId && jobs.get(item.jobId);
    if (!job) { delete item.jobId; return item; }
    if (item.status !== 'running') return item;
    const generation = job.generations?.find(value => value.id === job.autoGeneration?.generationId);
    return { ...item, stage: generation?.stage || (job.status === 'completed' && job.autoGeneration?.status === 'pending' ? '正在准备自动生图…' : job.stage), ...(generation ? { generationId: generation.id } : {}) };
  });
  const publicBatch = (batch, visible = () => true) => ({ id: batch.id, createdAt: batch.createdAt, language: batch.language,
    ...(batch.aspectRatio ? { aspectRatio: batch.aspectRatio } : {}), agent: batch.modelSettings.agent || "codex", model: batch.modelSettings.model,
    items: batchItems(batch).filter(item => visible(item.projectId)) });
  const validateBatchProjects = body => {
    if (!Array.isArray(body.projects) || !body.projects.length || body.projects.length > 100 || body.projects.some(item =>
      !item || typeof item.projectId !== 'string' || !/^[a-f0-9]{64}$/.test(item.projectId) || !Number.isSafeInteger(item.inputRevision) || item.inputRevision < 0)) throw bad('请选择 1–100 个有效项目和输入版本');
    if (new Set(body.projects.map(item => item.projectId)).size !== body.projects.length) throw bad('批量任务包含重复项目');
    return body.projects.map(({ projectId, inputRevision }) => ({ projectId, inputRevision }));
  };
  const inspectBatchProject = async item => {
    const project = projects.summary(item.projectId);
    if (!project) throw bad('项目不存在', 404);
    if (item.inputRevision !== project.inputRevision) throw bad('项目输入已更新，请重新预检', 409);
    if (batches.hasProject(project.id) || projects.get(project.id).jobs.some(job => runtime.has(job.id) || job.status === 'running' || job.generations?.some(generation => runtime.has(generation.id) || generation.status === 'running'))) throw bad('项目已有任务，请等待完成', 409);
    const input = projects.input(project.id, 'recreate');
    await storedImage(project);
    if (input.instruction !== undefined && (typeof input.instruction !== 'string' || input.instruction.length > 20000)) throw bad('项目任务指令无效');
    return { imageAsset: project.imageAsset, instruction: input.instruction, referenceIndex: 0, sourceUrl: project.sourceUrl, capture: project.capture, inputRevision: project.inputRevision };
  };
  const cancelJob = async job => {
    if (job.autoGeneration?.status === 'pending') {
      job.autoGeneration.status = 'cancelled';
      if (job.status === 'running') await runtime.cancel(job); else await save(job);
    } else if (job.autoGeneration?.status === 'started') {
      const generation = job.generations?.find(item => item.id === job.autoGeneration.generationId);
      if (generation) await runtime.cancel(job, generation);
    } else await runtime.cancel(job);
  };
  let batchPumpPending = false, batchPumpAgain = false, batchesClosed = false;
  const kickBatches = () => {
    if (batchesClosed) return;
    if (batchPumpPending) { batchPumpAgain = true; return; }
    batchPumpPending = true;
    setImmediate(async () => {
      const release = await acquireMutation();
      try {
        if (batchesClosed || shuttingDown || deletionFailed) return;
        for (const batch of [...batches.all]) {
          const next = structuredClone(batch);
          let changed = false;
          for (const item of next.items) {
            if (item.status !== 'running') continue;
            const job = jobs.get(item.jobId);
            if (runtime.has(item.jobId)) continue;
            if (!job) {
              Object.assign(item, { status: 'failed', stage: '启动失败', error: '任务未能创建，请重新发起' });
              changed = true; continue;
            }
            if (job.generations?.some(generation => runtime.has(generation.id))) continue;
            const generation = job.generations?.find(value => value.id === job.autoGeneration?.generationId);
            item.status = generation?.status || (job.autoGeneration?.status === 'cancelled' ? 'cancelled' : 'failed');
            item.stage = generation?.stage || (job.status === 'completed' ? item.status === 'cancelled' ? '已取消' : '自动生图失败' : job.stage);
            item.error = generation?.error || job.autoGeneration?.error || job.error;
            if (generation) item.generationId = generation.id;
            changed = true;
          }
          if (changed) await batches.put(next);
          if (!next.items.some(batchActive)) batchGenerationSettings.delete(next.id);
        }
        if (cliBusy() || agents.busy || runtime.reading || sessions.busy) return;
        for (const batch of [...batches.all].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
          for (const candidate of batch.items) {
            if (candidate.status !== 'queued') continue;
            if (projects.get(candidate.projectId)?.jobs.some(job => runtime.has(job.id) || job.generations?.some(generation => runtime.has(generation.id)))) continue;
            if (runtime.count >= 2 || batches.active.filter(item => item.status === 'running').length >= 2) return;
            const next = structuredClone(batches.all.find(value => value.id === batch.id));
            const item = next.items.find(value => value.projectId === candidate.projectId);
            item.status = 'running'; item.stage = '正在准备完整复刻…';
            await batches.put(next);
            try {
              const generationModelSettings = batchGenerationSettings.get(next.id) || next.generationModelSettings;
              if (generationModelSettings.imageProvider && !generationModelSettings.apiKey) throw bad("批次生图凭据快照已失效，请重新提交", 409);
              await startJob({ projectId: item.projectId, inputRevision: item.snapshot.inputRevision, mode: 'recreate',
                image: await storedImage(item.snapshot), instruction: item.snapshot.instruction, referenceIndex: item.snapshot.referenceIndex,
                sourceUrl: item.snapshot.sourceUrl, capture: item.snapshot.capture,
                generation: { language: next.language, ...(next.aspectRatio ? { aspectRatio: next.aspectRatio } : {}) } },
              { frozen: { modelSettings: next.modelSettings, generationModelSettings, jobId: item.jobId } });
            } catch (error) {
              item.status = 'failed'; item.stage = '启动失败'; item.error = error.message;
              await batches.put(next);
            }
          }
        }
      } catch (error) { console.error('批量任务调度失败:', error.message); }
      finally {
        batchPumpPending = false; release();
        if (batchPumpAgain) { batchPumpAgain = false; kickBatches(); }
      }
    });
  };
  await images.collect(batches.assets);
  await thumbnails.collect();

  const server = createServer(async (req, res) => {
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
      const feature = req.method !== "POST" ? undefined : path === "/jobs" ? (agents.selected === "codex" ? "reverse" : submittedJob?.generation && imageSettings.view().provider === "codex" ? "generation" : undefined)
        : /^\/jobs\/[\da-f-]{36}\/generations$/.test(path) ? (imageSettings.view().provider === "codex" ? "generation" : undefined)
        : ["/models/refresh", "/models/verify"].includes(path) && query.get("agent") !== "pi" ? "models" : undefined;
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
        if (shuttingDown) throw bad("服务正在停止，请重新启动后再试。", 503);
        if (deletionFailed) throw bad("项目清理未完成，请重启本机服务后重试", 503);
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
        if (shuttingDown || deletionFailed) throw bad("服务状态已变化，请重新打开项目后重试", 503);
        if (cliBusy()) throw bad("Agent CLI 正在安装或更新，请等待完成。", 409);
        return result;
      };
      if (req.method === "GET" && path === "/health") {
        validateQuery(["includeHidden"]);
        const showHidden = includeHidden();
        let skill;
        try {
          skill = (await readFile(skillPath, "utf8"))
            .match(/^name:\s*(.+)$/m)?.[1]
            ?.trim();
        } catch {}
        void cli.status?.().catch(() => {});
        if (!cliBusy()) void compatibility.getCompatibility().catch(() => {});
        const cliState = cli.peek?.();
        const cliSummary = cliState ? Object.fromEntries(["installed", "version", "source", "updateAvailable", "latestVersion", "checkError", "reason", "comparisonReference"].map(key => [key, cliState[key]])) : null;
        json(200, {
          service: "qc-alchemy",
          version,
          projectsRevision: projects.revision,
          managed: allowShutdown,
          instanceId, restartId, canRestart: allowShutdown && !!restart,
          skill: skill || null,
          ready: Boolean(skill),
          serviceReady: true, skillReady: Boolean(skill), cli: cliSummary,
          compatibility: compatibility.snapshot(),
          active: runtime.count + batches.active.filter(item => item.status === "queued").length + Number(agents.busy) + Number(cliBusy()),
          visibleActive: runtime.visibleCount(id => showHidden || !projects.isHidden(id)) + batches.active.filter(item => item.status === "queued" && (showHidden || !projects.isHidden(item.projectId))).length + Number(agents.busy) + Number(cliBusy()),
          hiddenProjectIds: projects.hiddenProjectIds,
          cliBusy: cliBusy(),
          modelBusy: agents.busy,
          agent: agents.selected,
          model: agents.modelStore().selectedModel,
          generationModel: imageSettings.view().provider === "codex" ? models.selectedModel : (imageSettings.view().configs[imageSettings.view().provider].hasApiKey ? imageSettings.view().configs[imageSettings.view().provider].model : null),
          generationProvider: imageSettings.view().provider,
        });
        return;
      }
      if (req.method === "POST" && path === "/sessions/list") {
        if (cliBusy()) throw bad("Agent CLI 正在安装或更新，请等待完成。", 409);
        const body = await readBody(req);
        try { json(200, await readSessions(signal => sessions.list(body, signal))); }
        catch (error) { throw error.status ? error : bad("无法读取本机 Codex 会话，请检查 CLI 后重试", 503); }
        return;
      }
      if (req.method === "POST" && path === "/sessions/index") {
        if (cliBusy()) throw bad("Agent CLI 正在安装或更新，请等待完成。", 409);
        const body = await readBody(req);
        if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => key !== "action") || !["refresh", "clear", "status"].includes(body.action)) throw bad("无效的索引操作");
        try { json(200, await readSessions(() => sessions.index(body.action), body.action === "refresh")); }
        catch (error) { throw error.status ? error : bad("无法访问本地会话索引，请重试", 503); }
        return;
      }
      if (path === "/image-settings" && (req.method === "GET" || req.method === "POST")) {
        validateQuery([]);
        json(200, req.method === "GET" ? imageSettings.view() : await imageSettings.save(await readBody(req)));
        return;
      }
      if (req.method === "GET" && path === "/agents") { validateQuery([]); json(200, agents.view()); return; }
      if (req.method === "POST" && path === "/agents/select") {
        const body = await readBody(req);
        if (!body || Object.keys(body).some(key => key !== "agent")) throw bad("无效 Agent 设置");
        if (codexBusy() || cliBusy()) throw bad("请等待当前任务完成，再切换 Agent。", 409);
        json(200, await agents.select(body.agent)); return;
      }
      if (req.method === "GET" && path === "/models") {
        validateQuery(["agent"]);
        const store = agents.modelStore(query.get("agent") || "codex");
        if (cliBusy()) throw bad("Agent CLI 正在安装或更新，请等待完成。", 409);
        if (store === models) await requireFeature("models");
        try { json(200, await store.list()); } catch (error) { throw Object.assign(error, { status: error.status || 503 }); }
        return;
      }
      if (path.startsWith("/cli/") && (req.method === "GET" && path === "/cli/status" || req.method === "POST" && ["/cli/check", "/cli/update", "/cli/install"].includes(path))) {
        validateQuery(["agent"]);
        const target = query.has("agent") ? query.get("agent") : "codex";
        if (!["codex", "pi"].includes(target)) throw bad("无效 Agent");
        const manager = target === "pi" ? piCli : cli;
        if (req.method === "GET") {
          const status = await manager.status();
          json(200, { ...status, agent: target, ...(target === "codex" ? { compatibility: cliBusy() ? compatibility.snapshot() : await compatibility.getCompatibility() } : {}) });
          return;
        }
        const body = await readBody(req);
        if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length) throw bad("Agent 管理操作不接受命令或路径参数。");
        if (cliBusy()) throw bad("Agent CLI 正在安装或更新，请等待完成。", 409);
        if (path !== "/cli/check") {
          if (codexBusy()) throw bad("已有任务或模型验证正在执行，请等待完成或取消。", 409);
          const action = path.endsWith("/install") ? "install" : "update";
          if (!manager[action]) throw bad("此 Agent 请按官方安装说明安装后重新检测。", 409);
          cliStarting = true;
          try { json(202, { ...await manager[action](), agent: target }); }
          finally { cliStarting = false; }
        } else {
          const status = await manager.check();
          if (target === "pi") json(200, { ...status, agent: target });
          else {
            const report = cliBusy() ? compatibility.snapshot() : await compatibility.getCompatibility({ force: true });
            if (!cliBusy() && !runtime.reading && !sessions.busy) sessions.resetReader?.();
            json(200, { ...status, agent: target, compatibility: report });
          }
        }
        return;
      }
      if (req.method === "POST" && ["/models/refresh", "/models/verify"].includes(path)) {
        validateQuery(["agent"]);
        const store = agents.modelStore(query.get("agent") || "codex");
        if (cliBusy()) throw bad("Agent CLI 正在安装或更新，请等待完成。", 409);
        if (codexBusy()) throw bad("已有任务或模型验证正在执行，请等待完成或取消。", 409);
        const body = await readBody(req);
        if (path.endsWith("/verify") && (typeof body.model !== "string" || body.model.length > 200)) throw bad("请选择有效模型");
        try { json(path.endsWith("/verify") ? 202 : 200, path.endsWith("/verify") ? await store.start(body.model, body.reasoningEffort) : await store.refresh()); }
        catch (error) { throw Object.assign(error, { status: error.status || 503 }); }
        return;
      }
      if (req.method === "POST" && path === "/restart") {
        if (!allowShutdown || !restart) throw bad("此服务不支持插件内重启。请在原终端停止，再在插件目录运行 npm start。", 409);
        if (codexBusy() || cliBusy()) throw bad("任务、模型验证或 Agent CLI 操作执行中，请等待完成后再重启。", 409);
        const nextRestartId = randomUUID();
        let commit;
        try { commit = await restart({ root, dataDir, port: server.address().port, instanceId, restartId: nextRestartId, skillPath, generationSkillPath }); }
        catch { throw bad("重启准备失败，原服务仍在运行。请查看本机服务日志后重试。", 503); }
        shuttingDown = true;
        let committed = false;
        const finishRestart = () => {
          if (committed) return;
          committed = true;
          taskFeed.close();
          server.close();
          server.closeIdleConnections();
          commit();
        };
        res.once("finish", finishRestart);
        res.once("close", finishRestart);
        json(202, { previousInstanceId: instanceId, restartId: nextRestartId });
        if (res.destroyed) finishRestart();
        return;
      }
      if (req.method === "POST" && path === "/shutdown" && allowShutdown) {
        if (codexBusy() || cliBusy()) throw bad("任务或 Agent CLI 安装更新执行中，请等待完成后再停止服务。", 409);
        shuttingDown = true;
        json(200, { stopped: true });
        server.close();
        server.closeIdleConnections();
        return;
      }
      if (req.method === "GET" && path === "/gallery") {
        validateQuery(["offset", "limit", "search", "projectId", "ratio", "sort", "includeHidden"]);
        const integer = (key, fallback, minimum, maximum) => {
          const value = query.get(key);
          if (value === null) return fallback;
          if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < minimum || Number(value) > maximum) throw bad("无效画廊分页参数");
          return Number(value);
        };
        const search = query.get("search") || "", projectId = query.get("projectId") || undefined;
        const ratio = query.get("ratio") || "all", sort = query.get("sort") || "newest";
        if (search.length > 200 || (projectId && !/^[a-f0-9]{64}$/.test(projectId)) || !["all", "portrait", "landscape", "square"].includes(ratio) || !["newest", "oldest"].includes(sort)) throw bad("无效画廊筛选参数");
        json(200, await gallery.page({ offset: integer("offset", 0, 0, Number.MAX_SAFE_INTEGER), limit: integer("limit", 100, 1, 100), search, projectId, ratio, sort, includeHidden: includeHidden() }));
        return;
      }
      if (req.method === "GET" && path === "/projects") {
        validateQuery(["page", "limit", "q", "status", "includeHidden"]);
        const showHidden = includeHidden();
        if (!["page", "limit", "q", "status"].some((key) => query.has(key))) json(200, projects.list({ includeHidden: showHidden }));
        else {
          const integer = (key, fallback, maximum) => {
            const value = query.get(key);
            if (value === null) return fallback;
            if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > maximum) throw bad("无效分页参数");
            return Number(value);
          };
          const status = query.get("status");
          if (status !== null && status !== "unstarted") throw bad("无效项目状态");
          const q = query.get("q") || "";
          if (q.length > 200) throw bad("搜索词最多 200 字符");
          json(200, projects.page({ page: integer("page", 1, Number.MAX_SAFE_INTEGER), limit: integer("limit", 24, 100), q, status, includeHidden: showHidden }));
        }
        return;
      }
      if (req.method === 'GET' && path === '/batches') {
        validateQuery(['includeHidden']);
        const showHidden = includeHidden();
        const visible = id => !!projects.summary(id) && (showHidden || !projects.isHidden(id));
        let recent = 0;
        json(200, [...batches.all].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(batch => publicBatch(batch, visible))
          .filter(batch => batch.items.length && (batch.items.some(batchActive) || recent++ < 30)));
        return;
      }
      if (req.method === 'POST' && (path === '/batches/preview' || path === '/batches')) {
        const body = await readBody(req), selected = validateBatchProjects(body);
        const allowed = path.endsWith('/preview') ? ['projects'] : ['projects', 'requestId', 'language', 'aspectRatio'];
        if (Object.keys(body).some(key => !allowed.includes(key))) throw bad('批量启动仅支持完整复刻和自动生图');
        let requestHash, existing;
        if (path === '/batches') {
          if (typeof body.requestId !== 'string' || !/^[\w-]{1,100}$/.test(body.requestId)) throw bad('批量请求编号无效');
          validateGenerationOptions(body);
          requestHash = createHash('sha256').update(JSON.stringify({ projects: selected, language: body.language, ...(body.aspectRatio ? { aspectRatio: { width: body.aspectRatio.width, height: body.aspectRatio.height } } : {}) })).digest('hex');
          existing = batches.all.find(batch => batch.requestId === body.requestId);
          if (existing) {
            if (existing.requestHash !== requestHash) throw bad('同一批量请求编号不能用于不同输入或选项', 409);
            json(202, publicBatch(existing)); return;
          }
        }
        if (cliBusy()) throw bad('Agent CLI 正在安装或更新，请等待完成。', 409);
        if (agents.busy) throw bad('正在验证模型，请稍候', 409);
        const modelSettings = agents.selection(), generationModelSettings = generationSelection();
        await Promise.all([...(agents.selected === "codex" ? [requireFeature('reverse')] : []), checkGeneration(generationModelSettings), readFile(skillPath)]);
        const items = [];
        for (const selectedItem of selected) {
          const title = projects.summary(selectedItem.projectId)?.title || '项目不存在';
          try {
            const snapshot = await inspectBatchProject(selectedItem);
            items.push({ ...selectedItem, title, eligible: true, snapshot });
          } catch (error) { items.push({ ...selectedItem, title, eligible: false, error: error.message }); }
        }
        if (path.endsWith('/preview')) { json(200, { model: modelSettings.model, items: items.map(({ snapshot, ...item }) => item) }); return; }
        const batch = { id: randomUUID(), requestId: body.requestId, requestHash, createdAt: new Date().toISOString(), modelSettings, generationModelSettings: Object.fromEntries(Object.entries(generationModelSettings).filter(([key]) => key !== "apiKey")),
          language: body.language, ...(body.aspectRatio ? { aspectRatio: body.aspectRatio } : {}),
          items: items.map(({ eligible, inputRevision, ...item }) => ({ ...item, status: eligible ? 'queued' : 'rejected', stage: eligible ? '等待启动' : '未受理', ...(eligible ? { jobId: randomUUID() } : {}) })) };
        batchGenerationSettings.set(batch.id, generationModelSettings);
        try { await batches.put(batch); }
        catch (error) { batchGenerationSettings.delete(batch.id); throw error; }
        json(202, publicBatch(batch)); return;
      }
      const batchCancelMatch = /^\/batches\/([\da-f-]{36})\/cancel$/.exec(path);
      if (req.method === 'POST' && batchCancelMatch) {
        const batch = batches.all.find(value => value.id === batchCancelMatch[1]);
        if (!batch) throw bad('批量任务不存在', 404);
        const body = await readBody(req);
        if (Object.keys(body).some(key => key !== 'projectId') || (body.projectId !== undefined && !batch.items.some(item => item.projectId === body.projectId))) throw bad('请选择该批次中的项目');
        const next = structuredClone(batch);
        for (const item of next.items) {
          if (body.projectId ? item.projectId !== body.projectId : item.status !== 'queued') continue;
          if (item.status === 'running') {
            const job = jobs.get(item.jobId);
            if (job) await cancelJob(job);
            else Object.assign(item, { status: 'cancelled', stage: '已取消' });
          } else if (item.status === 'queued') Object.assign(item, { status: 'cancelled', stage: '已取消' });
        }
        await batches.put(next); json(200, publicBatch(next)); return;
      }
      if (req.method === "POST" && path === "/projects/visibility") {
        const { ids, hidden } = await readBody(req);
        if (!Array.isArray(ids) || !ids.length || ids.length > 1000 || ids.some((id) => typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id)) || typeof hidden !== "boolean")
          throw bad("请选择有效项目和隐藏状态");
        const unique = [...new Set(ids)];
        if (unique.some((id) => !projects.summary(id))) throw bad("项目不存在，请刷新后重试", 404);
        const updatedIds = await projects.setHidden(unique, hidden);
        taskFeed.touch();
        json(200, { updatedIds, hidden, revision: projects.revision });
        return;
      }
      if (req.method === "POST" && path === "/projects/delete") {
        const { ids } = await readBody(req);
        if (!Array.isArray(ids) || !ids.length || ids.length > 1000 || ids.some((id) => typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id)))
          throw bad("请选择有效项目");
        const unique = [...new Set(ids)];
        const history = unique.flatMap((id) => projects.get(id)?.jobs || []);
        if (unique.some(id => batches.hasProject(id)) || history.some((job) => job.status === "running" || runtime.has(job.id) || job.generations?.some((item) => item.status === "running" || runtime.has(item.id))))
          throw bad("所选项目仍在逆向或生图，请完成或取消任务后再删除", 409);
        try {
          const deletedIds = await projects.remove(unique);
          taskFeed.touch();
          if (!runtime.count && records.canCollect) { await images.collect(batches?.assets); await thumbnails.collect(); }
          else collectionPending = true;
          json(200, { deletedIds });
        }
        catch (error) { deletionFailed = true; throw error; }
        return;
      }
      if (req.method === "POST" && path === "/projects") {
        const body = await readBody(req);
        const decoded = decodeImage(body.image);
        const created = !projects.summary(projectIdFor(decoded.bytes));
        const project = await projects.register(decoded, { sourceUrl: sourceUrlFor(body.sourceUrl), capture: body.capture });
        json(200, { ...projects.get(project.id), created });
        return;
      }
      const inputMatch = /^\/projects\/([a-f0-9]{64})\/input$/.exec(path);
      if (req.method === "POST" && inputMatch) {
        const project = projects.summary(inputMatch[1]);
        if (!project) throw bad("项目不存在", 404);
        const body = await readBody(req);
        if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) throw bad("项目输入版本无效");
        if (body.expectedRevision !== project.inputRevision) throw bad("项目输入已在其他窗口更新，请重新打开项目", 409);
        if (!["style", "recreate", "reenact", "multi-reenact", "session"].includes(body.mode)) throw bad("无效逆向模式");
        if (body.referenceJobId !== undefined && jobs.get(body.referenceJobId)?.projectId !== project.id) throw bad("历史参考图不属于当前项目");
        if (typeof body.instruction !== "string" || body.instruction.length > 20000) throw bad("任务指令必须是文本且最多 20000 字符");
        const image = body.image === undefined ? undefined : decodeImage(body.image);
        const referenceBytes = image?.bytes.length ?? (await images.read(project.imageAsset)).length;
        if (referenceBytes > 4 * 1024 * 1024) throw bad("参考图最多 4 MB，请压缩后重试");
        const input = { instruction: body.instruction };
        if (body.mode === "session") {
          if (cliBusy()) throw bad("Agent CLI 正在安装或更新，请等待完成。", 409);
          const ids = sessionIds(body.sessionIds ?? []);
          try { input.sessions = ids.length ? await readSessions(signal => sessions.metadata(ids, signal)) : []; }
          catch (error) { throw error.status ? error : bad("无法读取所选会话，请刷新后重试", 503); }
        } else if (body.sessionIds !== undefined) throw bad("当前模式不接受会话输入");
        if (body.mode === "multi-reenact") {
          if (body.subjectImage !== undefined) throw bad("多图重演请使用主体列表");
          input.subjects = await saveSubjects(decodeSubjects(body.subjects ?? [], referenceBytes, true));
        } else {
          if (body.subjects !== undefined || (["recreate", "session"].includes(body.mode) && body.subjectImage)) throw bad("当前模式不支持此主体输入");
          if (body.subjectImage) {
            const subject = decodeImage(body.subjectImage);
            if (referenceBytes > 4 * 1024 * 1024 || subject.bytes.length > 2 * 1024 * 1024) throw bad("参考图最多 4 MB，主体图最多 2 MB，请压缩后重试");
            input.subjectAsset = await images.put(subject);
          } else if (body.subjectImage !== undefined && body.subjectImage !== "") throw bad("主体图片无效");
        }
        input.referenceIndex = referencePosition(body.referenceIndex, input.subjects?.length ?? (input.subjectAsset ? 1 : 0), 0);
        if (projects.summary(project.id)?.inputRevision !== body.expectedRevision) throw bad("项目输入已在其他窗口更新，请重新打开项目", 409);
        if (body.mode === "session") assertSessionRequestActive();
        await projects.saveInput(project.id, { image, mode: body.mode, input, referenceJobId: body.referenceJobId, expectedRevision: body.expectedRevision });
        collectionPending = true;
        if (!runtime.count && records.canCollect) {
          try { await images.collect(batches?.assets); await thumbnails.collect(); collectionPending = false; }
          catch (error) { console.error("回收图片失败:", error.message); }
        }
        taskFeed.touch();
        json(200, await projects.reference(project.id));
        return;
      }
      const projectMatch = /^\/projects\/([a-f0-9]{64})(\/(?:reference|thumbnail))?$/.exec(path);
      if (req.method === "GET" && projectMatch) {
        validateQuery(projectMatch[2] === "/thumbnail" ? ["reference"] : projectMatch[2] ? [] : ["revision"]);
        if (query.has("reference") && query.get("reference") !== "1") throw bad("无效缩略图参数");
        if (query.has("revision") && (!query.get("revision") || query.get("revision").length > 100)) throw bad("无效版本参数");
        const project = projects.summary(projectMatch[1]);
        if (!project) throw bad("项目不存在", 404);
        if (projectMatch[2] === "/thumbnail") {
          if (!query.has("reference") && project.cover?.imageAsset) {
            try {
              json(200, { ...await thumbnails.read(project.cover.imageAsset), source: { kind: "generation", jobId: project.cover.jobId, generationId: project.cover.generationId } });
              return;
            }
            catch { /* A missing generated cover can still show the source template. */ }
          }
          if (!project.imageAsset) throw bad("这个项目的参考模板已不存在，请回到网页重新选择图片。", 404);
          json(200, { ...await thumbnails.read(project.imageAsset), source: { kind: "reference" } });
        } else if (projectMatch[2]) {
          const reference = await projects.reference(project.id);
          if (!reference) throw bad("这个项目的参考模板已不存在，请回到网页重新选择图片。", 404);
          decodeImage(reference.image);
          json(200, reference);
        } else json(200, query.get("revision") === project.revision ? { unchanged: true, revision: project.revision } : projects.get(project.id));
        return;
      }
      if (req.method === "GET" && path === "/task-feed") {
        validateQuery(["revision"]);
        const cursor = query.get("revision") || "";
        if (cursor.length > 100) throw bad("无效版本参数");
        await taskFeed.wait(cursor, res);
        if (!res.destroyed) {
          const snapshot = taskFeed.snapshot(jobs, projects);
          json(200, cursor === snapshot.revision ? { revision: cursor, unchanged: true } : snapshot);
        }
        return;
      }
      if (req.method === "GET" && path === "/jobs") {
        validateQuery(["includeHidden"]);
        const showHidden = includeHidden();
        const activity = (job) => [job.createdAt, ...(job.generations || []).map(item => item.createdAt)].filter(value => typeof value === "string").sort().at(-1) || "";
        const recent = [...jobs.values()].filter((job) => showHidden || !projects.isHidden(job.projectId)).sort((a, b) => activity(b).localeCompare(activity(a)));
        let completed = 0;
        json(200, recent.filter(job => job.status === "running" || job.generations?.some(item => item.status === "running") || completed++ < 30));
        return;
      }
      const promptMatch = /^\/jobs\/([\da-f-]{36})\/prompt$/.exec(path);
      if (req.method === "POST" && promptMatch) {
        const body = await readBody(req);
        const job = jobs.get(promptMatch[1]);
        if (!job) throw bad("任务不存在", 404);
        if (job.status !== "completed" || !job.result) throw bad("请先完成提示词逆向", 409);
        const edits = {};
        for (const key of ["promptZh", "promptEn", "negativePrompt"]) {
          if (typeof body[key] !== "string" || body[key].length > 20000 || (key !== "negativePrompt" && !body[key].trim()))
            throw bad("中英文提示词不能为空，每项最多 20000 字符");
          edits[key] = body[key];
        }
        job.result = { ...job.result, ...edits };
        await save(job);
        json(200, job);
        return;
      }
      const generationMatch = /^\/jobs\/([\da-f-]{36})\/generations(?:\/([\da-f-]{36})\/(image|reference|thumbnail|cancel|open|reveal))?$/.exec(path);
      if (generationMatch) {
        const job = jobs.get(generationMatch[1]);
        if (!job) throw bad("任务不存在", 404);
        const generation = job.generations?.find((item) => item.id === generationMatch[2]);
        if (generationMatch[2] && !generation) throw bad("生图记录不存在", 404);
        if (req.method === "GET" && generationMatch[3] === "thumbnail") {
          validateQuery([]);
          if (generation.status !== "completed") throw bad("图片尚未生成", 409);
          try {
            json(200, { ...await thumbnails.readGeneration(generation), source: { kind: "generation", jobId: job.id, generationId: generation.id } });
          } catch (error) { if (error.code === "ENOENT") throw bad("生成图片已不存在，请重新生成", 404); throw error; }
          return;
        }
        if (req.method === "GET" && generationMatch[3] === "reference") {
          if (job.mode === "multi-reenact") {
            json(200, { image: await storedImage(job), subjects: await restoreSubjects(generation.subjects), referenceIndex: savedReferenceIndex(generation) });
            return;
          }
          if (!["recreate", "session"].includes(job.mode) && !generation.subjectAsset && !generation.subjectExtension) throw bad("此生图记录没有保存主体图快照", 404);
          json(200, { image: await storedImage(["recreate", "session"].includes(job.mode) ? job : generation, !["recreate", "session"].includes(job.mode)), referenceIndex: savedReferenceIndex(generation) });
          return;
        }
        const fileAction = req.method === "POST" && ["open", "reveal"].includes(generationMatch[3]);
        if (fileAction || (req.method === "GET" && generationMatch[3] === "image")) {
          if (fileAction && Object.keys(await readBody(req)).length) throw bad("图片操作不接受路径或命令参数");
          if (generation.status !== "completed" || !["png", "jpeg", "webp"].includes(generation.extension)) throw bad("图片尚未生成", 409);
          const imagePath = images.generationPath(generation);
          let bytes;
          try {
            if (generation.imageAsset !== undefined) bytes = await images.read(generation.imageAsset);
            else {
              if (!(await lstat(imagePath)).isFile()) throw bad("图片文件无效");
              bytes = await readFile(imagePath);
            }
          }
          catch (error) { if (error.code === "ENOENT") throw bad("生成图片已不存在，请重新生成", 404); throw error; }
          const metadata = await sharp(bytes).metadata().catch(() => { throw bad("图片内容无效，请重新生成"); });
          if (metadata.format !== generation.extension) throw bad("图片内容与格式不匹配");
          if (fileAction) {
            try { await imageAction(imagePath, generationMatch[3]); }
            catch (error) { throw bad(error.message, 503); }
            json(200, { ok: true });
          } else json(200, { image: `data:image/${generation.extension};base64,${bytes.toString("base64")}`, path: imagePath, width: metadata.autoOrient.width, height: metadata.autoOrient.height });
          return;
        }
        if (req.method === "POST" && generationMatch[3] === "cancel") {
          await runtime.cancel(job, generation);
          json(200, job);
          return;
        }
        if (req.method !== "POST" || generationMatch[2]) throw bad("Not found", 404);
        await startGeneration(job, await readBody(req));
        json(202, job);
        return;
      }
      const idMatch = /^\/jobs\/([\da-f-]{36})(\/(?:cancel|reference))?$/.exec(path);
      if (idMatch) {
        const job = jobs.get(idMatch[1]);
        if (!job) throw bad("任务不存在", 404);
        if (req.method === "GET" && idMatch[2] === "/reference") {
          const image = await storedImage(job);
          let reenact, subjectError, generationSubjectImage;
          const latestSubjects = job.generations?.findLast((item) => item.subjects);
          if (job.mode === "multi-reenact") {
            const subjects = latestSubjects?.subjects || job.reenact?.subjects;
            reenact = { ...job.reenact, subjects: (subjects || []).map(({ subjectAsset, ...item }) => ({ ...item, subjectImage: "" })) };
            try { reenact.subjects = await restoreSubjects(subjects); }
            catch (error) {
              if (error.status !== 404) throw error;
              subjectError = error.message;
            }
          } else if (job.reenact) {
            reenact = { ...job.reenact, subjectImage: "" };
            try {
              reenact.subjectImage = await storedImage(job, true);
            } catch (error) {
              if (error.status !== 404) throw error;
              subjectError = error.message;
            }
          }
          const latestSubject = job.generations?.findLast((item) => /^[\da-f-]{36}$/.test(item.id) && ["png", "jpeg", "webp"].includes(item.subjectExtension));
          if (latestSubject) {
            try { generationSubjectImage = await storedImage(latestSubject, true); }
            catch (error) {
              if (error.status !== 404) throw error;
              generationSubjectImage = "";
              subjectError = error.message;
            }
          }
          json(200, { id: job.id, jobId: job.id, projectId: job.projectId, referenceIndex: savedReferenceIndex(latestSubjects || latestSubject || job), image, sourceUrl: job.sourceUrl, capture: job.capture, instruction: job.instruction ?? job.reenact?.basePrompt, ...(job.sessionContext ? { sessions: job.sessionContext.sources } : {}), reenact, subjectError, generationSubjectImage });
          return;
        }
        if (req.method === "POST" && idMatch[2] === "/cancel") {
          await cancelJob(job);
          json(200, job);
          return;
        }
        if (req.method === "GET" && !idMatch[2]) {
          json(200, job);
          return;
        }
      }
      if (req.method !== "POST" || path !== "/jobs")
        throw bad("Not found", 404);
      json(202, await startJob(submittedJob, { readSessions, assertSessionRequestActive }));
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
      releaseMutation?.();
      kickBatches();
    }
  });
  server.on("close", () => {
    void sessions.close?.();
    batchesClosed = true;
    batchGenerationSettings.clear();
    taskFeed.close();
    cli.close();
    piCli.close();
    models.close();
    piModels.close();
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
