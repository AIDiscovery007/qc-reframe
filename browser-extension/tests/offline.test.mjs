import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
// Single-file runs (`node --test tests/x.test.mjs`) load the guard here; `npm test` loads it for every file.
import "./support/offline.mjs";

// Scenario: user's own test runs never use up a real service's quota
//   Given product tests start bridges that may check Codex or QC-Reframe releases
//   When `npm test` runs on a machine with a real Codex installation and network access
//   Then any request to a non-loopback host fails at once with a clear message, so no GitHub, npm or Homebrew quota is spent
//   And requests to local test servers keep working
test("npm test loads the offline guard for every test file", async () => {
  const { scripts } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(scripts.test, /^node --import \.\/tests\/support\/offline\.mjs --test /);
});

test("user's test runs refuse real external services and still reach local test servers", async t => {
  for (const url of ["https://api.github.com/repos/openai/codex/releases/latest", "https://registry.npmjs.org/@openai%2fcodex/latest", new URL("https://formulae.brew.sh/api/cask/codex.json")])
    await assert.rejects(fetch(url), /测试不得访问外部服务/);
  await assert.rejects(fetch(new Request("https://api.github.com/rate_limit")), /测试不得访问外部服务/);
  const server = createServer((_, response) => response.end("ok")).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  for (const host of ["127.0.0.1", "localhost"]) assert.equal(await (await fetch(`http://${host}:${server.address().port}/`)).text(), "ok");
});
