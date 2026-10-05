export type ServiceHealth = {
  service: string; version: string; ready: boolean; managed?: boolean; canRestart?: boolean;
  instanceId?: string; restartId?: string; active?: number; cliBusy?: boolean; modelBusy?: boolean;
};
export type RestartTicket = { previousInstanceId: string; restartId: string };

export async function waitForServiceRestart(ticket: RestartTicket, read: () => Promise<ServiceHealth>, signal: AbortSignal,
  timeout = 45_000, pause = () => new Promise<void>(resolve => setTimeout(resolve, 750))) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    try {
      const health = await read();
      signal.throwIfAborted();
      if (health.service === "qc-alchemy" && health.ready && health.instanceId && health.instanceId !== ticket.previousInstanceId
        && health.restartId === ticket.restartId) return health;
    } catch { signal.throwIfAborted(); }
    await pause();
  }
  throw new Error("未能确认新服务已启动。请在插件目录运行 npm run status；若已停止，运行 npm start，并查看 .local/logs/bridge.log。");
}
