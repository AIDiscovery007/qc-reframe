import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));
const extension = fileURLToPath(new URL("../", import.meta.url));
const tool = name => join(root, "agent-tool", name + ".mjs");
async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), "reframe-agent-tool-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
const run = (name, args = [], options = {}) => execute(process.execPath, [tool(name), ...args], { cwd: root, timeout: 15_000, ...options });

test("index benchmark uses synthetic data and cleans its temporary database from either cwd", async t => {
  const directory = await temporary(t);
  for (const cwd of [root, extension]) {
    const { stdout } = await run("benchmark-session-index", ["2"], { cwd, env: { ...process.env, TMPDIR: directory, TMP: directory, TEMP: directory } });
    const result = JSON.parse(stdout);
    assert.equal(result.sessions, 2);
    assert.equal(result.searchCount, 100);
    assert.ok(result.indexedCharacters > 0);
    assert.ok(result.dbMiB > 0);
    assert.ok(result.indexWrites.totalMs >= 0);
    assert.deepEqual(await readdir(directory), []);
  }
});

test("tools reject invalid arguments before launching a CLI", async () => {
  const env = { ...process.env, CODEX_BIN: join(root, "nonexistent-agent-tool-cli") };
  for (const [name, args] of [
    ["benchmark-session-index", ["0"]], ["benchmark-session-index", ["1001"]],
    ["benchmark-session-index", ["2", "extra"]], ["benchmark-session-index", ["1.5"]],
    ["benchmark-session-search", ["1"]], ["benchmark-session-search", ["21"]],
    ["benchmark-session-search", ["2", "extra"]], ["benchmark-session-search", ["NaN"]],
    ["preview", ["extra"]],
  ]) await assert.rejects(run(name, args, { env }), error => error.code === 1 && /Usage:/.test(error.stderr));
  for (const port of ["", "-1", "65536", "1.5", "bad"])
    await assert.rejects(run("preview", [], { env: { ...env, PREVIEW_PORT: port } }), error => error.code === 1 && /Usage:/.test(error.stderr));
});

test("original package preview entry works from the extension directory", { timeout: 15_000 }, async t => {
  const { scripts } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(scripts.preview, "node ../agent-tool/preview.mjs");
  const child = spawn(process.execPath, [scripts.preview.slice("node ".length)], {
    cwd: extension, env: { ...process.env, PREVIEW_PORT: "0" }, stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const stopped = once(child, "exit"); child.kill(); await stopped; } });
  const url = await new Promise((resolve, reject) => {
    let output = "", errors = "";
    child.stderr.on("data", chunk => { errors += chunk; });
    child.once("error", reject);
    child.once("exit", code => reject(new Error(`preview exited ${code}: ${errors}`)));
    child.stdout.on("data", chunk => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) resolve(match[0]);
    });
  });
  assert.equal((await fetch(`${url}/workspace.html`)).status, 200);
  assert.equal((await fetch(`${url}/preview.js`)).status, 200);
});

async function stub(t) {
  const directory = await temporary(t), binary = join(directory, "codex.mjs"), trace = join(directory, "trace.jsonl");
  await writeFile(binary, `#!${process.execPath}
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const record = event => appendFileSync(process.env.AGENT_TOOL_TRACE, JSON.stringify({ pid: process.pid, ...event }) + "\\n");
if (process.argv[2] === "--version") { console.log("codex isolated-test"); process.exit(0); }
if (process.argv[2] !== "app-server") process.exit(2);
record({ event: "start" });
process.on("SIGTERM", () => { record({ event: "stop" }); process.exit(0); });
createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line); record({ event: "rpc", method: message.method, params: message.params });
  if (message.method === "initialized") return;
  if (!["initialize", "thread/list"].includes(message.method)) process.exit(3);
  const fail = message.method === "thread/list" && process.env.AGENT_TOOL_FAIL === "1";
  console.log(JSON.stringify({ id: message.id, ...(fail ? { error: { code: -32000, message: "isolated fixture failure" } } :
    { result: message.method === "initialize" ? {} : { data: [{ id: "private-fixture-id", name: "private-fixture-title" }], nextCursor: null } }) }));
});
`, { mode: 0o700 });
  return { trace, env: { ...process.env, CODEX_BIN: binary, HOME: directory, CODEX_HOME: directory, AGENT_TOOL_TRACE: trace } };
}

test("search benchmark lists metadata only, reuses one process and closes all isolated children", async t => {
  const { trace, env } = await stub(t);
  const { stdout } = await run("benchmark-session-search", ["2"], { cwd: extension, env });
  const result = JSON.parse(stdout);
  assert.equal(result.cliVersion, "codex isolated-test");
  assert.equal(result.requestsPerStrategy, 2);
  assert.equal(result.old.processes, 2);
  assert.equal(result.reused.processes, 1);
  assert.equal(result.reused.requestTotalMs.length, 2);
  assert.doesNotMatch(stdout, /private-fixture/);
  const events = (await readFile(trace, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(events.filter(e => e.event === "start").length, 3);
  assert.deepEqual(events.filter(e => e.event === "stop").map(e => e.pid).sort(), events.filter(e => e.event === "start").map(e => e.pid).sort());
  const requests = events.filter(e => e.event === "rpc");
  assert.deepEqual([...new Set(requests.map(e => e.method))].sort(), ["initialize", "initialized", "thread/list"]);
  const lists = requests.filter(e => e.method === "thread/list");
  assert.equal(lists.length, 4);
  for (const request of lists) assert.deepEqual(request.params, {
    limit: 30, sortKey: "updated_at", modelProviders: [], sourceKinds: ["cli", "vscode", "appServer", "exec", "unknown"], archived: false,
  });
});

test("search benchmark fails clearly and closes its CLI on RPC failure", async t => {
  const { trace, env } = await stub(t);
  await assert.rejects(run("benchmark-session-search", ["2"], { env: { ...env, AGENT_TOOL_FAIL: "1" } }), error => error.code === 1 && /isolated fixture failure/.test(error.stderr));
  const events = (await readFile(trace, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(events.filter(e => e.event === "start").length, 1);
  assert.equal(events.filter(e => e.event === "stop").length, 1);
});
