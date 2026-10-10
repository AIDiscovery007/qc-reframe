import { randomUUID } from 'node:crypto';
import { mkdir, lstat, readdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

const saveError = () => Object.assign(new Error('图片已生成但未能保存。请保持本机服务运行，修复数据目录后重试保存；不会再次请求模型。'), { code: 'generation-save-pending' });
const idPattern = /^[\da-f-]{36}$/;
const recoveryError = () => new Error('生图恢复记录损坏或无法核验，请修复数据目录后重启；图片尚未回收。');
const outputMetadata = output => ({ extension: output.extension, revisedPrompt: output.revisedPrompt,
  gatewayReportedModel: output.gatewayReportedModel, outputSize: output.outputSize });

// Commit an independent association before image bytes, and remove it only after the task commits.
export function createGenerationOutputs(images, { directory, recordsDir } = {}) {
  const pending = new Map(), durable = new Map();
  const file = id => join(directory, `${id}.json`);
  const metadata = generation => {
    const output = pending.get(generation.id) || durable.get(generation.id);
    if (output) Object.assign(generation, { extension: output.extension, revisedPrompt: output.revisedPrompt,
      ...(generation.provider === 'magpie' ? { gatewayReportedModel: output.gatewayReportedModel, outputSize: output.outputSize } : {}) });
  };
  const forget = async id => {
    if (directory) await rm(file(id), { force: true });
    durable.delete(id);
    pending.delete(id);
  };
  const settled = async generation => {
    if (generation.status === 'completed' || generation.status === 'cancelled') {
      // A stale association is safe: startup checks the durable task status before recovery.
      try { await forget(generation.id); }
      catch { console.error('生图恢复记录清理失败，将在重启后重试'); }
    }
  };
  const markPending = generation => {
    if (!pending.has(generation.id) && !durable.has(generation.id) && !generation.imageAsset) return;
    metadata(generation);
    Object.assign(generation, { resultSavePending: true, error: saveError().message });
  };
  const write = async (generation, jobId) => {
    const output = pending.get(generation.id);
    if (!output && !generation.imageAsset) throw new Error('未保存的图片已不在内存中，无法重试保存；本次未请求模型。');
    try {
      if (output) {
        if (directory) {
          if (!idPattern.test(generation.id) || !idPattern.test(jobId)) throw recoveryError();
          const record = { id: generation.id, jobId, imageAsset: images.assetFor(output), ...outputMetadata(output) };
          const temporary = join(directory, `.${randomUUID()}.tmp`);
          try {
            await writeFile(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
            await rename(temporary, file(generation.id));
          } finally { await rm(temporary, { force: true }); }
          durable.set(generation.id, record);
        }
        generation.imageAsset = await images.put(output);
      } else await images.read(generation.imageAsset);
      metadata(generation);
    } catch {
      markPending(generation);
      throw saveError();
    }
  };
  return {
    has: generation => pending.has(generation.id) || durable.has(generation.id),
    get assets() { return [...durable.values()].map(record => record.imageAsset); },
    remember(generation, output) { pending.set(generation.id, output); },
    markPending, write, settled,
    async recover(jobs, save) {
      if (!directory) return;
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if (!(await lstat(directory)).isDirectory()) throw recoveryError();
      // Validate the whole journal before any cleanup. Corruption stops startup before image GC.
      try {
        for (const name of await readdir(directory)) {
          if (!name.endsWith('.json')) continue;
          const path = join(directory, name);
          if (!(await lstat(path)).isFile()) throw recoveryError();
          const record = JSON.parse(await readFile(path, 'utf8'));
          if (!record || !idPattern.test(record.id) || !idPattern.test(record.jobId) || name !== `${record.id}.json` ||
            !['png', 'jpeg', 'webp'].includes(record.extension) || !record.imageAsset?.endsWith(`.${record.extension}`) ||
            ['revisedPrompt', 'gatewayReportedModel'].some(key => record[key] !== undefined && typeof record[key] !== 'string') ||
            (record.outputSize !== undefined && (!record.outputSize || !['width', 'height'].every(key => Number.isSafeInteger(record.outputSize[key]) && record.outputSize[key] > 0)))) throw recoveryError();
          images.path(record.imageAsset);
          durable.set(record.id, record);
        }
        for (const record of durable.values()) {
          const job = jobs.get(record.jobId);
          if (!job) {
            // A skipped damaged task is not a deleted task.
            try { await lstat(join(recordsDir, `${record.jobId}.json`)); }
            catch (error) { if (error.code === 'ENOENT') { await forget(record.id); continue; } throw error; }
            throw recoveryError();
          }
          const generation = job.generations?.find(item => item.id === record.id);
          if (!generation || (generation.imageAsset && generation.imageAsset !== record.imageAsset)) throw recoveryError();
          if (['completed', 'cancelled'].includes(generation.status)) { await forget(record.id); continue; }
          try { await images.read(record.imageAsset); }
          catch (error) { if (error.code === 'ENOENT') { await forget(record.id); continue; } throw error; }
          Object.assign(generation, { imageAsset: record.imageAsset, status: 'failed', stage: '图片等待保存' });
          markPending(generation);
          await save(job);
        }
      } catch { throw recoveryError(); }
    },
    async prune(jobs) {
      const ids = new Set([...jobs.values()].flatMap(job => (job.generations || []).map(generation => generation.id)));
      for (const id of new Set([...pending.keys(), ...durable.keys()])) if (!ids.has(id)) await forget(id);
    },
    async retry(job, generation, save) {
      await write(generation, job.id);
      Object.assign(generation, { status: 'completed', stage: '图片已生成' });
      delete generation.resultSavePending;
      delete generation.error;
      delete generation.code;
      try { await save(job); }
      catch {
        Object.assign(generation, { status: 'failed', stage: '任务保存失败' });
        markPending(generation);
        await save(job).catch(() => {});
        throw saveError();
      }
      await settled(generation);
    },
  };
}
