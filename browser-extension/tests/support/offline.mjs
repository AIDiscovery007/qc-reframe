// Loaded by `npm test` before every test file: tests talk only to servers they start on this machine.
// A real Codex installation makes bridges check GitHub for Codex releases, which used up the network's
// unauthenticated GitHub quota (60 an hour) in a single regression run.
const loopback = new Set(["127.0.0.1", "localhost", "[::1]"]);
const fetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!loopback.has(url.hostname)) throw new TypeError(`测试不得访问外部服务：${url.origin}。请改用本机假服务或注入的 fetch。`);
  return fetch(input, init);
};
