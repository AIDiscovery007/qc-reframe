import { createHash } from 'node:crypto';
// Initial reviewed selection boundary. Everything else is collected in shadow and falls back full.
export const reliableSources = [
  'browser-extension/lib/generation-session.ts',
  'browser-extension/lib/operation-policy.ts',
  'browser-extension/bridge/task-runtime.mjs',
  'browser-extension/bridge/task-records.mjs',
];
export const coreNode = [
  'generation-session', 'task-runtime', 'task-records', 'project-inputs', 'project-selection',
  'image-order', 'reverse-cancel', 'storage', 'operation-policy', 'extension',
].map(name => `browser-extension/tests/${name}.test.mjs`);
export const coreBrowser = [
  'creation-context', 'end-to-end-context', 'end-to-end-phase-cancel', 'end-to-end-keyboard-workspace-cancel',
  'example-image-viewer-result-short', 'example-image-viewer-result-popup', 'example-native-controls',
  'image-order-keyboard-late', 'image-order-keyboard-failure', 'settings-recovery',
  'end-to-end-reverse-failed', 'end-to-end-generation-failed', 'example-image-viewer-portrait',
].map(id => `browser:${id}`);
// Only these reviewed direct imports may use V8 without blanket dependencies.
// New tests, anonymous execution and missing source maps remain conservative by default.
const directNode = ['generation-session', 'image-order', 'operation-policy', 'task-records', 'task-runtime']
  .map(name => `browser-extension/tests/${name}.test.mjs`);
export function withConservativeDependencies(item, sources = reliableSources, browserIsolated = false) {
  const uncertain = item.unknown?.length || (!item.id.startsWith('browser:') && !directNode.includes(item.id));
  const conservative = browserIsolated && item.id.startsWith('browser:') ? sources.filter(source => !source.startsWith('browser-extension/bridge/')) : sources;
  return { ...item, dependencies: [...new Set([...(item.dependencies || []), ...(item.id.startsWith('browser:') ? ['browser-extension/lib/operation-policy.ts'] : []), ...(uncertain ? conservative : [])])].sort(), conservative: !!uncertain };
}

// Reviewed preview never starts the production bridge. Bind this exclusion to the
// exact execution domain: any frontend/fixture/tool/dependency drift disables it.
export function browserDomain(files) {
  const selected = Object.entries(files).filter(([file]) => /^browser-extension\/(entrypoints|lib|assets|public|docs\/gallery)\//.test(file)
    || (file.startsWith('agent-tool/') && file.endsWith('.mjs') && !file.endsWith('.test.mjs') && file !== 'agent-tool/test-policy.mjs')
    || /^browser-extension\/tests\/.*\.browser\.js$/.test(file)
    || ['agent-tool/preview.mjs','agent-tool/gallery-preview.mjs','browser-extension/bridge/image-order.mjs','browser-extension/package.json','browser-extension/package-lock.json','browser-extension/wxt.config.ts'].includes(file));
  return createHash('sha256').update(JSON.stringify(selected.sort(([a],[b])=>a.localeCompare(b,'en')))).digest('hex');
}
export const reviewedBrowserDomain = "f2451bf697ba33760be92261407319f5117e266afd323dae39210e83639622a2";
