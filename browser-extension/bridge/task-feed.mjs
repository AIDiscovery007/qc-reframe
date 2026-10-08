import { randomUUID } from 'node:crypto';

// Only committed task metadata enters this feed; no prompts, paths or image bytes.
export function createTaskFeed() {
  const records = new Map(), listeners = new Set();
  const epoch = randomUUID();
  let revision = 0;
  const touch = () => { revision++; for (const resolve of [...listeners]) resolve(); };
  return {
    update(job) {
      const tasks = [...(job.autoGeneration?.status === "started" ? [] : [job]), ...(job.generations || [])].map(task => ({
        id: task.id, jobId: job.id, projectId: job.projectId, mode: job.mode,
        generationId: task === job ? undefined : task.id,
        status: task === job && job.autoGeneration ? ({ pending: "running", failed: "failed", cancelled: "cancelled" }[job.autoGeneration.status] || task.status) : task.status,
        ...(task === job && job.autoGeneration ? { autoGeneration: true } : {}),
        createdAt: task.createdAt,
      }));
      if (JSON.stringify(records.get(job.id)) === JSON.stringify(tasks)) return;
      records.set(job.id, tasks); touch();
    },
    touch,
    snapshot(jobs, projects) {
      return { revision: `${epoch}:${revision}`, tasks: [...records.entries()]
        .filter(([id]) => jobs.has(id)).flatMap(([, tasks]) => tasks.map(task => ({ ...task, hidden: projects.isHidden(task.projectId) }))) };
    },
    async wait(cursor, response, timeout = 10_000) {
      if (cursor !== `${epoch}:${revision}` || response.destroyed) return;
      await new Promise(resolve => {
        const finish = () => { clearTimeout(timer); listeners.delete(finish); response.off('close', finish); resolve(); };
        const timer = setTimeout(finish, timeout);
        listeners.add(finish); response.once('close', finish);
      });
    },
    close() { for (const resolve of [...listeners]) resolve(); },
  };
}
