// Startup calls collect after recovery; HTTP mutations already hold the mutation
// lock. Only idle cleanup acquires it here. Strict callers retain their failures.
export function createImageCollection({ images, thumbnails, runtime, records, batches, generationOutputs, jobs, acquireMutation }) {
  let pending = false;
  const collect = async () => {
    pending = true;
    if (runtime.count || !records.canCollect) return;
    // The image store scans durable project/task references and protects damaged
    // records. These additional roots cover accepted work and uncommitted output.
    await images.collect([...batches.assets, ...generationOutputs.assets]);
    await thumbnails.collect();
    pending = false;
  };
  return {
    collect,
    async afterInputCommit() {
      try { await collect(); }
      catch (error) { console.error("回收图片失败:", error.message); }
    },
    async onIdle() {
      await generationOutputs.prune(jobs);
      if (!pending) return;
      const release = await acquireMutation();
      try { await collect(); }
      catch (error) { console.error("回收图片失败:", error.message); }
      finally { release(); }
    },
  };
}
