import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { createBridge } from "../bridge/server.mjs";
import { connectionOrigins, extensionOrigin } from "../bridge/connection.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const id = path => createHash("sha256").update(path, process.platform === "win32" ? "utf16le" : "utf8")
  .digest("hex").slice(0, 32).replace(/[0-9a-f]/g, value => String.fromCharCode(97 + parseInt(value, 16)));
const origin = `chrome-extension://${id(join(root, ".output/chrome-mv3").replace(/^[a-z]:/, value => value.toUpperCase()))}`;

async function setup(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "reframe-connection-"));
  const token = "existing-private-token";
  await writeFile(join(dir, "token"), token);
  await writeFile(join(dir, "preserved-note.txt"), "user data");
  const app = await createBridge({ dataDir: dir, skillPath: join(dir, "missing-skill"), extensionId: "", ...options });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const url = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const connect = (headers = {}, path = "/connection", method = "POST", body = "{}") => fetch(url + path, {
    method, headers: { Origin: origin, "Content-Type": "application/json", ...headers },
    ...(method === "POST" ? { body } : {}),
  });
  return { dir, token, url, connect };
}

test("user opens their installed extension and connects automatically without CLI or skill readiness", async t => {
  // Given a running service with an existing token and no skill or configured model.
  const { dir, token, url, connect } = await setup(t);
  // When the extension from this installation asks to connect.
  const response = await connect();
  // Then it receives only the unchanged credential, privately, and can use normal authentication.
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { token });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("access-control-allow-origin"), origin);
  assert.equal((await readFile(join(dir, "config/token"), "utf8")).trim(), token);
  assert.equal(await readFile(join(dir, "preserved-note.txt"), "utf8"), "user data");
  const health = await fetch(url + "/health", { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ready, false);
  for (const agent of ["codex", "pi"]) {
    const selected = await fetch(url + "/agents/select", { method: "POST", headers: {
      Authorization: `Bearer ${token}`, "Content-Type": "application/json",
    }, body: JSON.stringify({ agent }) });
    assert.equal(selected.status, 200);
  }
  assert.equal((await fetch(url + "/health")).status, 401);
});

test("user browsing webpages or another extension cannot disclose local connection credentials", async t => {
  // Given the default installation allowlist, when callers differ from its exact origin or Host.
  const { token, url, connect } = await setup(t);
  for (const headers of [{ Origin: "https://example.com" }, { Origin: "null" }, { Origin: "" },
    { Origin: "chrome-extension://" + "a".repeat(32) }, { Origin: origin + ".evil" },
    { Origin: origin + "/" }]) {
    const response = await connect(headers);
    assert.equal(response.status, 403, JSON.stringify(headers));
    assert.ok(!(await response.text()).includes(token));
  }
  const rebound = await new Promise((resolve, reject) => {
    httpRequest(url + "/connection", { method: "POST", headers: {
      Host: "attacker.example", Origin: origin, "Content-Type": "application/json",
    } }, response => { response.resume(); resolve(response.statusCode); }).on("error", reject).end("{}");
  });
  assert.equal(rebound, 403);
  // Then GET/query/body registration tricks also fail instead of enrolling the caller.
  for (const [path, method, body, expected] of [["/connection", "GET", undefined, 405],
    ["/connection?origin=other", "POST", "{}", 400], ["/connection", "POST", '{"extensionId":"other"}', 400]]) {
    const response = await connect({}, path, method, body);
    assert.equal(response.status, expected);
    assert.ok(!(await response.text()).includes(token));
  }
  assert.equal((await connect({ Origin: "chrome-extension://" + "a".repeat(32) }, "/connection", "OPTIONS")).status, 403);
  assert.equal((await connect({}, "/connection", "OPTIONS")).status, 204);
});

test("connection allowlist follows Chromium native-path IDs and rejects invalid installer configuration", () => {
  assert.equal(extensionOrigin("/tmp/Reframe/.output/chrome-mv3", "darwin"), "chrome-extension://ijmgcjhkdnlbghhnkknoigbncehabgeb");
  for (const drive of ["C", "c"])
    assert.equal(extensionOrigin(`${drive}:\\Reframe\\.output\\chrome-mv3`, "win32"), "chrome-extension://leamincedapbjdlhfjhmlhemaeeaachl");
  assert.equal(extensionOrigin("C:\\测试\\.output\\chrome-mv3", "win32"), "chrome-extension://ikgmmmpopmcchmaogcobcnaebchmidhc");
  for (const invalid of ["*", "a".repeat(31), "chrome-extension://" + "a".repeat(32), "a".repeat(32) + "," + "b".repeat(32)])
    assert.throws(() => connectionOrigins("/tmp/reframe", invalid), /ALCHEMY_EXTENSION_ID/);
});

test("user loads a separately installed ZIP after its exact extension ID was approved locally", async t => {
  // Given an explicitly approved ZIP ID, when that extension connects.
  const extensionId = "b".repeat(32);
  const { token, connect } = await setup(t, { extensionId });
  const response = await connect({ Origin: `chrome-extension://${extensionId}` });
  // Then it shares the existing connection; other IDs remain rejected.
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { token });
  assert.equal((await connect()).status, 200);
  assert.equal((await connect({ Origin: "chrome-extension://" + "c".repeat(32) })).status, 403);
});
