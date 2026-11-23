import { bad, readBody, decodeImage, decodeSubjects, sourceUrlFor } from "../http.mjs";
import { batchActive } from "../batches.mjs";
import { projectIdFor } from "../projects.mjs";
import { referencePosition } from "../image-order.mjs";
import { sessionIds } from "../sessions.mjs";

/** Project, gallery, batch and task-feed routes. Returns true when the request was handled. */
export async function projectRoutes(request, app) {
  const { req, res, path, query, json, validateQuery, includeHidden, submission, readSessions, assertSessionRequestActive } = request;
  const { state, cliBusy, sessions, projects, batches, batchAdmission, publicBatch, cancelJob, jobs, runtime, images, thumbnails, gallery, saveSubjects, generationOutputs, imageCollection, taskFeed } = app;
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
    return true;
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
    return true;
  }
  if (req.method === 'GET' && path === '/batches') {
    validateQuery(['includeHidden']);
    const showHidden = includeHidden();
    const visible = id => !!projects.summary(id) && (showHidden || !projects.isHidden(id));
    let recent = 0;
    json(200, [...batches.all].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(batch => publicBatch(batch, visible))
      .filter(batch => batch.items.length && (batch.items.some(batchActive) || recent++ < 30)));
    return true;
  }
  if (req.method === 'POST' && (path === '/batches/preview' || path === '/batches')) {
    const body = await readBody(req);
    if (path.endsWith('/preview')) json(200, await batchAdmission.preview(body, submission.signal));
    else json(202, publicBatch(await batchAdmission.admit(body, submission.signal)));
    return true;
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
    await batches.put(next); json(200, publicBatch(next)); return true;
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
    return true;
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
      await generationOutputs.prune(jobs);
      taskFeed.touch();
      await imageCollection.collect();
      json(200, { deletedIds });
    }
    catch (error) { state.deletionFailed = true; throw error; }
    return true;
  }
  if (req.method === "POST" && path === "/projects") {
    const body = await readBody(req);
    const decoded = decodeImage(body.image);
    const created = !projects.summary(projectIdFor(decoded.bytes));
    const project = await projects.register(decoded, { sourceUrl: sourceUrlFor(body.sourceUrl), capture: body.capture });
    json(200, { ...projects.get(project.id), created });
    return true;
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
    await imageCollection.afterInputCommit();
    taskFeed.touch();
    json(200, await projects.reference(project.id));
    return true;
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
          return true;
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
    return true;
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
    return true;
  }
  return false;
}
