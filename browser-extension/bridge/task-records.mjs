import { readFile, readdir, writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// Task records are the durable source for both project summaries and the task feed.
// Completion never needs a second write to project metadata.
export async function createTaskRecords({ dataDir, onCommit }) {
  const jobs = new Map();
  const uncommitted = new Map();
  let tail = Promise.resolve();
  const save = (job, { touch = true } = {}) => {
    if (touch) job.updatedAt = new Date().toISOString();
    const snapshot = JSON.stringify(job);
    const revision = Symbol();
    uncommitted.set(job.id, revision);
    const operation = tail.catch(() => {}).then(async () => {
      const path = join(dataDir, `${job.id}.json`);
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, snapshot, { mode: 0o600 });
        await rename(temporary, path);
      } finally { await rm(temporary, { force: true }).catch(() => {}); }
      jobs.set(job.id, job);
      if (uncommitted.get(job.id) === revision) uncommitted.delete(job.id);
      onCommit(job, JSON.parse(snapshot));
    });
    tail = operation;
    return operation;
  };
  for (const file of await readdir(dataDir)) {
    if (!/^[\da-f-]{36}\.json$/.test(file)) continue;
    let job;
    try { job = JSON.parse(await readFile(join(dataDir, file), "utf8")); }
    catch { continue; } // A damaged record must not hide unrelated recoverable tasks.
    if (!job || `${job.id}.json` !== file || typeof job.createdAt !== "string") continue;
    if (job.generations !== undefined && (!Array.isArray(job.generations) || job.generations.some(item => !item || typeof item !== "object"))) continue;
    let interrupted = false;
    if (job.status === "running") {
      Object.assign(job, { status: "failed", stage: "逆向中断", error: "本机服务已重启，请重新逆向" });
      interrupted = true;
    }
    if (job.autoGeneration?.status === "pending") {
      Object.assign(job.autoGeneration, { status: "failed", error: "本机服务已重启，请重新生成图片" });
      interrupted = true;
    }
    for (const generation of job.generations || []) {
      if (generation.status !== "running") continue;
      Object.assign(generation, { status: "failed", stage: "生图中断", error: "本机服务已重启，请重新生成图片" });
      interrupted = true;
    }
    // Failed recovery writes abort startup; never advertise an uncommitted recovery.
    if (interrupted) await save(job);
    else { jobs.set(job.id, job); onCommit(job, job); }
  }
  return { jobs, save, get canCollect() { return !uncommitted.size; } };
}
