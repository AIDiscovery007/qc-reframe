import { batchActive } from "./batches.mjs";
import { LEGACY_AGENT } from "./agents.mjs";

/**
 * Batch view and scheduler.
 * `kick()` coalesces calls into one pass under the mutation lock: it first reconciles running items with their
 * committed jobs, then, only while the service is idle, starts queued items (one task per project, at most two
 * running tasks and two running batch items). Each item starts from the snapshot frozen at admission.
 */
export function createBatchScheduler({ batches, jobs, projects, runtime, generation, batchGenerationSettings, storedImage, startJob, acquireMutation, stopped, idle }) {
  const batchItems = batch => batch.items.map(({ snapshot, ...item }) => {
    const job = item.jobId && jobs.get(item.jobId);
    if (!job) { delete item.jobId; return item; }
    if (item.status !== 'running') return item;
    const generation = job.generations?.find(value => value.id === job.autoGeneration?.generationId);
    return { ...item, stage: generation?.stage || (job.status === 'completed' && job.autoGeneration?.status === 'pending' ? '正在准备自动生图…' : job.stage), ...(generation ? { generationId: generation.id } : {}) };
  });
  const view = (batch, visible = () => true) => ({ id: batch.id, createdAt: batch.createdAt, language: batch.language,
    ...(batch.aspectRatio ? { aspectRatio: batch.aspectRatio } : {}), ...(batch.imageSize ? { imageSize: batch.imageSize } : {}), ...(batch.sizeRule ? { submittedImageSize: batch.submittedImageSize, sizeRule: batch.sizeRule } : {}), provider: batch.generationModelSettings?.imageProvider || "codex", agent: batch.modelSettings.agent ?? LEGACY_AGENT, model: batch.modelSettings.model,
    items: batchItems(batch).filter(item => visible(item.projectId)) });
  let pending = false, again = false, closed = false;
  const kick = () => {
    if (closed) return;
    if (pending) { again = true; return; }
    pending = true;
    setImmediate(async () => {
      const release = await acquireMutation();
      try {
        if (closed || stopped()) return;
        for (const batch of [...batches.all]) {
          const next = structuredClone(batch);
          let changed = false;
          for (const item of next.items) {
            const job = jobs.get(item.jobId);
            const generation = job?.generations?.find(value => value.id === job.autoGeneration?.generationId);
            if (item.status !== 'running' && !(item.status === 'failed' && generation?.status === 'completed')) continue;
            if (runtime.has(item.jobId)) continue;
            if (!job) {
              Object.assign(item, { status: 'failed', stage: '启动失败', error: '任务未能创建，请重新发起' });
              changed = true; continue;
            }
            if (job.generations?.some(generation => runtime.has(generation.id))) continue;
            item.status = generation?.status || (job.autoGeneration?.status === 'cancelled' ? 'cancelled' : 'failed');
            item.stage = generation?.stage || (job.status === 'completed' ? item.status === 'cancelled' ? '已取消' : '自动生图失败' : job.stage);
            item.error = generation?.error || job.autoGeneration?.error || job.error;
            if (generation) item.generationId = generation.id;
            changed = true;
          }
          if (changed) await batches.put(next);
          if (!next.items.some(batchActive)) batchGenerationSettings.delete(next.id);
        }
        if (!idle()) return;
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
              const { modelSettings: generationModelSettings, sizeSnapshot } = generation.restoreBatch(next, batchGenerationSettings.get(next.id) || next.generationModelSettings);
              await startJob({ projectId: item.projectId, inputRevision: item.snapshot.inputRevision, mode: 'recreate',
                image: await storedImage(item.snapshot), instruction: item.snapshot.instruction, referenceIndex: item.snapshot.referenceIndex,
                sourceUrl: item.snapshot.sourceUrl, capture: item.snapshot.capture,
                generation: { language: next.language, ...(next.aspectRatio ? { aspectRatio: next.aspectRatio } : {}), ...(next.imageSize ? { imageSize: next.imageSize } : {}) } },
              { frozen: { modelSettings: next.modelSettings, generationModelSettings, jobId: item.jobId, sizeSnapshot } });
            } catch (error) {
              item.status = 'failed'; item.stage = '启动失败'; item.error = error.message;
              await batches.put(next);
            }
          }
        }
      } catch (error) { console.error('批量任务调度失败:', error.message); }
      finally {
        pending = false; release();
        if (again) { again = false; kick(); }
      }
    });
  };
  return { view, kick, close() { closed = true; } };
}
