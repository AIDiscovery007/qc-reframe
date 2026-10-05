/** Local demonstration only. Does not read conversations or create/download files. */
export function simulateLocalExport(signal: AbortSignal, onProgress: (progress: number) => void): Promise<{ files: number }> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const timers: ReturnType<typeof setTimeout>[] = [];
    const clean = () => { timers.forEach(clearTimeout); signal.removeEventListener("abort", cancel); };
    const cancel = () => { clean(); reject(signal.reason); };
    signal.addEventListener("abort", cancel, { once: true });
    onProgress(0);
    if (signal.aborted) return;
    for (let step = 1; step <= 6; step++) timers.push(setTimeout(() => {
      if (signal.aborted) return;
      onProgress(Math.round(step / 6 * 100));
      if (step === 6) { clean(); resolve({ files: 3 }); }
    }, step * 200));
  });
}
