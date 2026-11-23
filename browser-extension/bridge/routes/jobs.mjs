import { readFile, lstat } from "node:fs/promises";
import sharp from "sharp";
import { bad, readBody } from "../http.mjs";
import { savedReferenceIndex } from "../image-order.mjs";

/** Reverse task and generation routes; POST /jobs itself stays with the request preamble because it is probed before the mutation lock. Returns true when the request was handled. */
export async function jobRoutes(request, app) {
  const { req, res, path, query, json, validateQuery, includeHidden, submission, readSessions, assertSessionRequestActive } = request;
  const { jobs, save, projects, runtime, images, thumbnails, storedImage, restoreSubjects, startGeneration, cancelJob, generationOutputs, imageAction } = app;
  if (req.method === "GET" && path === "/jobs") {
    validateQuery(["includeHidden"]);
    const showHidden = includeHidden();
    const activity = (job) => [job.createdAt, ...(job.generations || []).map(item => item.createdAt)].filter(value => typeof value === "string").sort().at(-1) || "";
    const recent = [...jobs.values()].filter((job) => showHidden || !projects.isHidden(job.projectId)).sort((a, b) => activity(b).localeCompare(activity(a)));
    let completed = 0;
    json(200, recent.filter(job => job.status === "running" || job.generations?.some(item => item.status === "running") || completed++ < 30));
    return true;
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
    return true;
  }
  const generationMatch = /^\/jobs\/([\da-f-]{36})\/generations(?:\/([\da-f-]{36})\/(image|reference|thumbnail|cancel|open|reveal|save))?$/.exec(path);
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
      return true;
    }
    if (req.method === "GET" && generationMatch[3] === "reference") {
      if (job.mode === "multi-reenact") {
        json(200, { image: await storedImage(job), subjects: await restoreSubjects(generation.subjects), referenceIndex: savedReferenceIndex(generation) });
        return true;
      }
      if (!["recreate", "session"].includes(job.mode) && !generation.subjectAsset && !generation.subjectExtension) throw bad("此生图记录没有保存主体图快照", 404);
      json(200, { image: await storedImage(["recreate", "session"].includes(job.mode) ? job : generation, !["recreate", "session"].includes(job.mode)), referenceIndex: savedReferenceIndex(generation) });
      return true;
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
      return true;
    }
    if (req.method === "POST" && generationMatch[3] === "save") {
      if (Object.keys(await readBody(req)).length) throw bad("重试保存不接受模型或图片参数");
      if (!generation.resultSavePending || generation.status !== "failed" || runtime.has(generation.id)) throw bad("此图片没有待恢复的保存任务", 409);
      runtime.reserve(generation.id, job.projectId);
      try { await generationOutputs.retry(job, generation, save); }
      finally { runtime.release(generation.id); }
      json(200, job);
      return true;
    }
    if (req.method === "POST" && generationMatch[3] === "cancel") {
      await runtime.cancel(job, generation);
      json(200, job);
      return true;
    }
    if (req.method !== "POST" || generationMatch[2]) throw bad("Not found", 404);
    await startGeneration(job, await readBody(req), { signal: submission.signal });
    json(202, job);
    return true;
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
      return true;
    }
    if (req.method === "POST" && idMatch[2] === "/cancel") {
      await cancelJob(job);
      json(200, job);
      return true;
    }
    if (req.method === "GET" && !idMatch[2]) {
      json(200, job);
      return true;
    }
  }
  return false;
}
