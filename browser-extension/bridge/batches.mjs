import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export const batchActive = item => item.status === 'queued' || item.status === 'running';

async function readBatches(path) {
  let batches = [];
  try { batches = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!Array.isArray(batches) || batches.some(batch => typeof batch.id !== 'string' || typeof batch.requestId !== 'string' || !/^[a-f0-9]{64}$/.test(batch.requestHash || '') || !Array.isArray(batch.items))) throw new Error('批量任务记录损坏，请保留数据并检查');
  return batches;
}

async function writeBatches(path, batches) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify(batches), { mode: 0o600 }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }).catch(() => {}); }
}

// Part of the existing project-deletion journal, before deleting any project files.
export async function removeBatchProjects(path, ids) {
  const deleted = new Set(ids), batches = await readBatches(path);
  if (!batches.some(batch => batch.items.some(item => deleted.has(item.projectId)))) return;
  await writeBatches(path, batches.map(batch => ({ ...batch, items: batch.items.filter(item => !deleted.has(item.projectId)) })));
}

// Call mutations under the bridge mutation lock. Publish only durable snapshots.
export async function createBatchStore(path, onChange) {
  let batches = await readBatches(path);
  const write = async (next, ids) => {
    await writeBatches(path, next);
    batches = next; onChange(ids);
  };
  const recovered = structuredClone(batches);
  let interrupted = false;
  for (const batch of recovered) for (const item of batch.items) if (batchActive(item)) {
    Object.assign(item, { status: 'failed', stage: '批量任务中断', error: '本机服务已重启，请重新发起任务' });
    interrupted = true;
  }
  if (interrupted) await write(recovered, recovered.flatMap(batch => batch.items.map(item => item.projectId)));
  return {
    get all() { return batches; },
    get active() { return batches.flatMap(batch => batch.items).filter(batchActive); },
    get assets() { return this.active.map(item => item.snapshot?.imageAsset).filter(Boolean); },
    hasProject(id) { return this.active.some(item => item.projectId === id); },
    async put(batch) { await write([...batches.filter(item => item.id !== batch.id), structuredClone(batch)], batch.items.map(item => item.projectId)); },
    async reload() {
      const ids = batches.flatMap(batch => batch.items.map(item => item.projectId));
      batches = await readBatches(path);
      onChange(ids);
    },
  };
}
