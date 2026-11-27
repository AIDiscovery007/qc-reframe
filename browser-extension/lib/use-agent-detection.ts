import { useEffect, useState } from "react";
import { query } from "./client";
import { pollWhileVisible } from "./visible-poll";
import { missingAgentCli, type AgentCatalog, type AgentId, type MissingAgentCli } from "./agents";

const MINUTE = 60_000;

/**
 * While setup is incomplete, asks the service to detect every Agent CLI on this machine (local inspection, no update
 * checks) so the notice can name installed alternatives. The user switches; failures and older services give no hint.
 */
export function useAgentDetection(enabled: boolean, agent: AgentId) {
  const [missing, setMissing] = useState<MissingAgentCli>();
  useEffect(() => {
    if (!enabled) { setMissing(undefined); return; }
    let cancelled = false;
    const stop = pollWhileVisible(async () => {
      try { const catalog = await query<AgentCatalog>("/agents?detect=1"); if (!cancelled) setMissing(missingAgentCli(catalog, agent)); }
      catch { if (!cancelled) setMissing(undefined); }
      return MINUTE;
    });
    return () => { cancelled = true; stop(); };
  }, [enabled, agent]);
  return missing?.agent === agent ? missing : undefined;
}
