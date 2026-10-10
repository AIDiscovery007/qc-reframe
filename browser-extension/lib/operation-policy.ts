type Source = "extension" | "content";
type Operation = { source: "ui" | Source; transport: "message" | "port" };
const ui = { source: "ui", transport: "message" } as const;
const connected = { source: "ui", transport: "port" } as const;
const session = { source: "extension", transport: "port" } as const;

// This catalog describes UI requests, not notifications or reminder messages.
export const uiOperations: Readonly<Record<string, Operation>> = {
  "alchemy:batch-preview": session,
  "alchemy:batch-start": session,
  "alchemy:batches": { source: "extension", transport: "message" },
  "alchemy:batch-cancel": session,
  "alchemy:get-motion-preference": ui,
  "alchemy:set-motion-preference": ui,
  "alchemy:show-hidden-projects": ui,
  "alchemy:set-project-hidden": ui,
  "alchemy:gallery": ui,
  "alchemy:projects": ui,
  "alchemy:project": ui,
  "alchemy:project-thumbnail": ui,
  "alchemy:generation-thumbnail": ui,
  "alchemy:quick-draft": ui,
  "alchemy:open-workspace": ui,
  "alchemy:upload-reference": ui,
  "alchemy:update-project-input": connected,
  "alchemy:service-restart": ui,
  "alchemy:cli-check": ui,
  "alchemy:cli-update": ui,
  "alchemy:cli-install": ui,
  "alchemy:image-models": { source: "extension", transport: "message" },
  "alchemy:image-settings": { source: "extension", transport: "message" },
  "alchemy:image-settings-save": { source: "extension", transport: "message" },
  "alchemy:agent-select": { source: "extension", transport: "message" },
  "alchemy:models-refresh": ui,
  "alchemy:model-verify": ui,
  "alchemy:project-views": ui,
  "alchemy:save-project-view": ui,
  "alchemy:state": ui,
  "alchemy:connect": ui,
  "alchemy:mode": ui,
  "alchemy:query": ui,
  "alchemy:cancel": ui,
  "alchemy:reference": ui,
  "alchemy:project-reference": ui,
  "alchemy:open-project": ui,
  "alchemy:ensure-project": ui,
  "alchemy:delete-projects": ui,
  "alchemy:start": connected,
  "alchemy:save-prompt": ui,
  "alchemy:generate": ui,
  "alchemy:generation-cancel": ui,
  "alchemy:generation-reference": ui,
  "alchemy:generation-image": ui,
  "alchemy:generation-file-action": ui,
  "alchemy:workspace-handoff": { source: "extension", transport: "message" },
  "alchemy:sessions-list": session,
  "alchemy:sessions-index": session,
  "alchemy:select": { source: "content", transport: "message" },
  "alchemy:collect": { source: "content", transport: "message" },
};

export function operationFor(type: unknown): Operation | undefined {
  return typeof type === "string" && Object.hasOwn(uiOperations, type) ? uiOperations[type] : undefined;
}

// One-shot requests remain accepted for older extension pages. A port may only
// invoke the operations whose bridge deadline, rather than a UI race, is final.
export function allowsOperation(operation: Operation | undefined, source: Source | undefined, transport = "message") {
  return !!operation && !!source && (operation.source === "ui" || operation.source === source)
    && (transport === "message" || operation.transport === transport);
}

export function messageSource(sender: { id?: string; url?: string; frameId?: number; tab?: { id?: number; url?: string } } | undefined, extensionId: string, extensionUrl: string): Source | undefined {
  if (sender?.id !== extensionId) return;
  if (sender.url?.startsWith(extensionUrl)) return "extension";
  if (sender.tab?.id != null && sender.frameId === 0 && /^https?:/.test(sender.url || sender.tab.url || "")) return "content";
}

export const UI_RESPONSE_TIMEOUT = 35_000;
export const PORT_KEEP_ALIVE = 20_000;
export function bridgeTimeout(path: string) {
  return path.startsWith("/sessions") || path.startsWith("/batches") || path.endsWith("/input") || path === "/jobs" ? 120_000
    : path.startsWith("/models") || path.startsWith("/cli") ? 30_000 : 15_000;
}
