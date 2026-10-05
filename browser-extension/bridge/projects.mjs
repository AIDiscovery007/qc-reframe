import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";

export const projectIdFor = (bytes) => createHash("sha256").update(bytes).digest("hex");
const newestFirst = (a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);
const inputFor = (job) => {
  const instruction = job.instruction ?? job.reenact?.basePrompt;
  const subjectAsset = job.generations?.findLast((generation) => generation.subjectAsset)?.subjectAsset || job.subjectAsset;
  const subjects = job.generations?.findLast((generation) => generation.subjects)?.subjects || job.reenact?.subjects;
  return { ...(instruction !== undefined ? { instruction } : {}), ...(subjectAsset ? { subjectAsset } : {}), ...(subjects ? { subjects } : {}), ...(job.sessionContext ? { sessions: job.sessionContext.sources } : {}) };
};

// Finish interrupted deletions before legacy jobs can recreate their projects.
export async function recoverProjectDeletion(dataDir, legacyDir = dataDir) {
  const path = join(dataDir, ".project-deletion.json");
  let files;
  try { files = JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  if (!Array.isArray(files) || files.some((file) => typeof file !== "string" ||
    !/^(?:project-[a-f0-9]{64}|[a-f0-9-]{36}(?:-subject|-session-context)?|[\w-]+-generated)[.](?:json|png|jpeg|webp)$/.test(file)))
    throw new Error("项目删除记录无效，已停止清理");
  for (const file of files) await rm(join(file.endsWith(".json") ? dataDir : legacyDir, file), { force: true });
  await rm(path);
}

export async function createProjectStore({ dataDir, legacyDir = dataDir, jobs, readReference, images }) {
  const records = new Map();
  const pending = new Map();
  const indexedJobs = new Map();
  const jobProjects = new Map();
  const summaries = new Map();
  const revisions = new Map();
  const epoch = randomUUID();
  let sequence = 0;
  let ordered;
  let visibleOrdered;
  const revision = () => `${epoch}:${sequence}`;
  const invalidate = (id) => {
    sequence++;
    revisions.set(id, revision());
    summaries.delete(id);
    ordered = undefined;
    visibleOrdered = undefined;
  };
  const updateJob = (job) => {
    const previous = jobProjects.get(job.id);
    if (previous && previous !== job.projectId) {
      indexedJobs.get(previous)?.delete(job.id);
      invalidate(previous);
    }
    jobs.set(job.id, job);
    if (!indexedJobs.has(job.projectId)) indexedJobs.set(job.projectId, new Map());
    indexedJobs.get(job.projectId).set(job.id, job);
    jobProjects.set(job.id, job.projectId);
    invalidate(job.projectId);
  };
  let editTail = Promise.resolve();
  const edit = (operation) => (editTail = editTail.catch(() => {}).then(operation));
  let saveTail = Promise.resolve();
  const save = (project) => {
    saveTail = saveTail.catch(() => {}).then(async () => {
      const path = join(dataDir, `project-${project.id}.json`);
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(project), { mode: 0o600 });
      await rename(temporary, path);
    });
    return saveTail;
  };
  for (const file of await readdir(dataDir)) {
    const match = /^project-([a-f0-9]{64})\.json$/.exec(file);
    if (!match) continue;
    try {
      const project = JSON.parse(await readFile(join(dataDir, file), "utf8"));
      if (project.id === match[1] && typeof project.createdAt === "string" && typeof project.updatedAt === "string") records.set(project.id, { ...project, hidden: project.hidden === true });
    } catch { /* A damaged project must not hide its recoverable job records. */ }
  }

  async function register({ bytes, extension }, meta = {}) {
    const id = projectIdFor(bytes);
    if (pending.has(id)) return pending.get(id);
    const operation = (async () => {
      const existing = records.get(id);
      if (existing) return existing;
      const createdAt = meta.createdAt || new Date().toISOString();
      const project = { id, hidden: false, createdAt, updatedAt: createdAt, sourceUrl: meta.sourceUrl || "", capture: meta.capture === "screenshot" ? "screenshot" : "original" };
      project.extension = extension;
      project.imageAsset = await images.put({ bytes, extension });
      await save(project);
      records.set(id, project);
      invalidate(id);
      return project;
    })();
    pending.set(id, operation);
    try { return await operation; } finally { pending.delete(id); }
  }

  const recoveredProjects = new Set();
  for (const job of [...jobs.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    let project = records.get(job.projectId);
    if (/^[a-f0-9]{64}$/.test(job.projectId || "") && (!project || recoveredProjects.has(job.projectId))) {
      project = { ...(project || { id: job.projectId, hidden: false, createdAt: job.createdAt, sourceUrl: job.sourceUrl || "", capture: job.capture === "screenshot" ? "screenshot" : "original" }), updatedAt: job.createdAt };
      try {
        const reference = await readReference(job.id);
        project.imageAsset = await images.put(reference);
        project.extension = reference.extension;
      } catch { /* Recover identity even when every historical image is missing. */ }
      await save(project);
      records.set(project.id, project);
      recoveredProjects.add(project.id);
    }
    try {
      project ||= await register(await readReference(job.id), job);
    } catch {
      // Preserve incomplete legacy records even when their source image was removed.
      const id = /^[a-f0-9]{64}$/.test(job.projectId || "") && records.has(job.projectId)
        ? job.projectId : projectIdFor(`missing-reference:${job.id}`);
      project = records.get(id) || { id, hidden: false, createdAt: job.createdAt, updatedAt: job.createdAt, sourceUrl: job.sourceUrl || "", capture: job.capture === "screenshot" ? "screenshot" : "original" };
      await save(project);
      records.set(id, project);
    }
    if (job.projectId !== project.id) {
      job.projectId = project.id;
      await writeFile(join(dataDir, `${job.id}.json`), JSON.stringify(job), { mode: 0o600 });
    }
    updateJob(job);
  }

  const projectJobs = (id) => [...(indexedJobs.get(id)?.values() || [])].sort(newestFirst);
  function summary(project) {
    if (summaries.has(project.id)) return summaries.get(project.id);
    const history = projectJobs(project.id);
    const modes = {};
    let cover, coverDate = "";
    let updatedAt = project.updatedAt;
    for (const job of history) {
      if (["style", "recreate", "reenact", "multi-reenact", "session"].includes(job.mode) && !modes[job.mode]) {
        modes[job.mode] = { status: job.status, hasImage: Boolean(job.generations?.some((generation) => generation.status === "completed")) };
      }
      if (job.createdAt > updatedAt) updatedAt = job.createdAt;
      for (const generation of job.generations || []) {
        if (generation.createdAt > updatedAt) updatedAt = generation.createdAt;
        if (generation.status === "completed" && (!cover || generation.createdAt > coverDate ||
          (generation.createdAt === coverDate && generation.id < cover.generationId))) {
          cover = { jobId: job.id, generationId: generation.id, ...(generation.imageAsset ? { imageAsset: generation.imageAsset } : {}) };
          coverDate = generation.createdAt;
        }
      }
    }
    const item = { id: project.id, hidden: project.hidden, title: history.find((job) => job.result?.title)?.result.title || "未命名模板项目", createdAt: project.createdAt, updatedAt, sourceUrl: project.sourceUrl, capture: project.capture, jobCount: history.length,
      busy: history.some((job) => job.status === "running" || job.generations?.some((item) => item.status === "running")), modes,
      revision: revisions.get(project.id) || `${epoch}:0`, inputRevision: project.inputRevision || 0, inputVersions: project.inputVersions || {}, ...(project.imageAsset ? { imageAsset: project.imageAsset } : {}), ...(cover ? { cover } : {}) };
    summaries.set(project.id, item);
    return item;
  }
  const list = ({ includeHidden = false } = {}) => {
    ordered ||= [...records.values()].map(summary).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    return includeHidden ? ordered : visibleOrdered ||= ordered.filter((item) => !item.hidden);
  };
  return {
    register,
    saveInput(id, { image, mode, input, referenceJobId }) { return edit(async () => {
      const previous = records.get(id);
      const imageAsset = image ? await images.put(image) : previous.imageAsset;
      const referenceChanged = imageAsset !== previous.imageAsset;
      const history = projectJobs(id);
      const currentJob = (mode) => history.find((job) => job.mode === mode && (previous.inputVersions?.[mode] === undefined || job.id === previous.inputVersions[mode]));
      const inputs = { ...previous.inputs };
      for (const mode of ["style", "recreate", "reenact", "multi-reenact", "session"]) {
        const job = currentJob(mode);
        if (!Object.hasOwn(inputs, mode) && job) inputs[mode] = inputFor(job);
      }
      const arrangementChanged = (mode === "multi-reenact" && JSON.stringify(input.subjects || []) !== JSON.stringify(inputs[mode]?.subjects || [])) ||
        (mode === "session" && JSON.stringify(input.sessions || []) !== JSON.stringify(inputs[mode]?.sessions || []));
      const previousJob = currentJob(mode);
      const historical = referenceJobId !== undefined && referenceJobId !== (previous.inputVersions?.[mode] ?? previousJob?.id);
      const instruction = inputs[mode]?.instruction;
      const inputVersions = { ...previous.inputVersions };
      if (referenceChanged) for (const mode of ["style", "recreate", "reenact", "multi-reenact", "session"]) inputVersions[mode] = "new";
      else if (historical || arrangementChanged || (instruction !== undefined && input.instruction !== instruction)) inputVersions[mode] = "new";
      else inputVersions[mode] ??= previousJob?.id || "new";
      const project = { ...previous, imageAsset, extension: image?.extension || previous.extension,
        inputs: { ...inputs, [mode]: input }, inputVersions, inputRevision: (previous.inputRevision || 0) + 1, updatedAt: new Date().toISOString() };
      await save(project);
      records.set(id, project);
      invalidate(id);
      return project;
    }); },
    selectInputVersion(id, job, preserveInput = false) { return edit(async () => {
      const previous = records.get(id);
      const input = inputFor(job);
      const project = { ...previous, ...(!preserveInput ? { inputs: { ...previous.inputs, [job.mode]: input }, inputRevision: (previous.inputRevision || 0) + 1 } : {}), inputVersions: { ...previous.inputVersions, [job.mode]: job.id } };
      await save(project);
      records.set(id, project);
      invalidate(id);
    }); },
    updateJob,
    get revision() { return revision(); },
    isHidden(id) { return records.get(id)?.hidden === true; },
    get hiddenProjectIds() { return [...records.values()].filter((project) => project.hidden).map((project) => project.id); },
    setHidden(ids, hidden) {
      // Check state inside the queue so concurrent windows cannot claim the same change.
      return edit(async () => {
        const updatedIds = [];
        for (const id of ids) {
          const project = records.get(id);
          if (!project || project.hidden === hidden) continue;
          await save({ ...project, hidden });
          project.hidden = hidden;
          invalidate(id);
          updatedIds.push(id);
        }
        return updatedIds;
      });
    },
    async remove(ids) {
      const history = ids.flatMap(projectJobs);
      const images = (prefix) => ["png", "jpeg", "webp"].map((extension) => `${prefix}.${extension}`);
      const files = ids.flatMap((id) => [`project-${id}.json`, ...images(`project-${id}`)]);
      for (const job of history) {
        files.push(`${job.id}.json`, `${job.id}-session-context.json`, ...images(job.id), ...images(`${job.id}-subject`));
        for (const generation of job.generations || []) {
          if (/^[\w-]+$/.test(generation.id)) files.push(...images(`${generation.id}-generated`));
          if (/^[a-f0-9-]{36}$/.test(generation.id)) files.push(...images(`${generation.id}-subject`));
        }
      }
      const journal = join(dataDir, ".project-deletion.json");
      await writeFile(`${journal}.tmp`, JSON.stringify(files), { mode: 0o600 });
      await rename(`${journal}.tmp`, journal);
      await recoverProjectDeletion(dataDir, legacyDir);
      for (const job of history) { jobs.delete(job.id); jobProjects.delete(job.id); }
      for (const id of ids) {
        records.delete(id);
        indexedJobs.delete(id);
        invalidate(id);
        revisions.delete(id);
      }
      return ids;
    },
    list,
    page({ page = 1, limit = 24, q = "", status, includeHidden = false }) {
      const query = q.trim().toLocaleLowerCase();
      const matching = list({ includeHidden }).filter((item) => (status !== "unstarted" || item.jobCount === 0) &&
        (!query || `${item.title} ${item.sourceUrl}`.toLocaleLowerCase().includes(query)));
      page = Math.min(page, Math.max(1, Math.ceil(matching.length / limit)));
      return { items: matching.slice((page - 1) * limit, page * limit), total: matching.length, page, pageSize: limit, revision: revision() };
    },
    summary(id) {
      const project = records.get(id);
      return project && summary(project);
    },
    get(id) {
      const project = records.get(id);
      if (!project) return;
      const history = projectJobs(id);
      return { ...summary(project), jobs: history };
    },
    async reference(id) {
      const project = records.get(id);
      if (!project || !["png", "jpeg", "webp"].includes(project.extension)) return;
      try {
        const bytes = project.imageAsset ? await images.read(project.imageAsset)
          : await readFile(join(legacyDir, `project-${id}.${project.extension}`));
        const imageFor = async (asset) => `data:image/${asset.split(".")[1]};base64,${(await images.read(asset)).toString("base64")}`;
        const inputs = {};
        for (const [mode, input] of Object.entries(project.inputs || {})) {
          const { subjectAsset, subjects, ...rest } = input;
          const restored = { ...rest };
          const subjectImage = async (asset) => {
            try { return await imageFor(asset); }
            catch { restored.subjectError = "主体图已不存在或损坏，请重新上传主体图。"; return ""; }
          };
          if (subjectAsset) restored.subjectImage = await subjectImage(subjectAsset);
          if (subjects) restored.subjects = await Promise.all(subjects.map(async ({ subjectAsset, ...subject }) => ({ ...subject, subjectImage: await subjectImage(subjectAsset) })));
          inputs[mode] = restored;
        }
        return { id: project.inputRevision ? `${id}:${project.inputRevision}` : id, projectId: id, image: `data:image/${project.extension};base64,${bytes.toString("base64")}`, sourceUrl: project.sourceUrl, capture: project.capture,
          inputRevision: project.inputRevision || 0, inputVersions: project.inputVersions || {}, ...(project.inputs ? { inputs } : {}) };
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    },
    touch(id) { return edit(async () => {
      const previous = records.get(id);
      if (!previous) return;
      const project = { ...previous, updatedAt: new Date().toISOString() };
      await save(project);
      records.set(id, project);
      invalidate(id);
    }); },
  };
}
