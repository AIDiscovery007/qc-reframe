// Own task occupancy until execution and final persistence have actually settled.
export function createTaskRuntime({ save, onProgress, onIdle, onFailure }) {
  const controllers = new Map();
  let readers = 0;
  return {
    get count() { return controllers.size; },
    get busy() { return controllers.size > 0 || readers > 0; },
    get reading() { return readers > 0; },
    visibleCount(visible) { return [...controllers.values()].filter(item => visible(item.projectId)).length; },
    has(id) { return controllers.has(id); },
    read() {
      readers++;
      let released = false;
      return () => { if (!released) { released = true; readers--; } };
    },
    reserve(id, projectId) {
      if (controllers.has(id)) throw new Error("任务已经在执行");
      const controller = new AbortController();
      controllers.set(id, { controller, projectId });
      return controller;
    },
    release(id) { controllers.delete(id); },
    async cancel(job, task = job) {
      if (task.status !== "running") return;
      Object.assign(task, { status: "cancelled", stage: "已取消" });
      controllers.get(task.id)?.controller.abort();
      await save(job);
    },
    async run(job, task, { execute, modelSettings, completedStage, failedStage, onSettled, onSaveFailure }) {
      const { controller } = controllers.get(task.id);
      const progress = update => {
        if (task.status !== "running") return;
        Object.assign(task, update);
        onProgress(job);
      };
      try {
        controller.signal.throwIfAborted();
        const result = await execute({ signal: controller.signal, progress });
        if (task.status === "running") Object.assign(task, result, { status: "completed", stage: completedStage });
      } catch (error) {
        if (task.status === "running") Object.assign(task, {
          status: "failed", stage: failedStage, error: error.message, recovery: error.recovery, code: error.code,
        });
        await onFailure(modelSettings, error).catch(failure => console.error("保存模型状态失败:", failure.message));
      } finally {
        try { await save(job); }
        catch (error) {
          // Never leave a successful-looking result when its record could not commit.
          if (task.status === "completed") Object.assign(task, { status: "failed", stage: "任务保存失败", error: "任务结果未能保存，请检查本机数据目录后重试" });
          onSaveFailure?.();
          onProgress(job);
          await save(job).catch(failure => console.error("保存任务失败:", failure.message));
        }
        try { await onSettled?.({ signal: controller.signal }); }
        catch (error) { console.error("后续任务保存失败:", error.message); }
        finally { controllers.delete(task.id); await onIdle(); }
      }
    },
    close() { for (const { controller } of controllers.values()) controller.abort(); },
  };
}
