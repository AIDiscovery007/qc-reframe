import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createReframeTools, serve } from "../bridge/claude-mcp.mjs";

function session(handlers) {
  const input = new PassThrough(), output = new PassThrough(), replies = [];
  let buffer = "";
  output.on("data", chunk => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop();
    replies.push(...lines.filter(Boolean).map(line => JSON.parse(line)));
  });
  serve(handlers, input, output);
  const send = message => input.write((typeof message === "string" ? message : JSON.stringify({ jsonrpc: "2.0", ...message })) + "\n");
  const reply = async id => {
    for (let i = 0; i < 200; i++) { const found = replies.find(message => message.id === id); if (found) return found; await new Promise(resolve => setTimeout(resolve, 5)); }
    assert.fail(`no reply for ${id}`);
  };
  return { send, reply, replies };
}

test("user's Claude task server answers only MCP tool requests and reports tool failures as tool errors", async () => {
  // Given a task server with one tool that fails.
  const tools = [{ name: "probe", inputSchema: { type: "object" } }];
  const { send, reply, replies } = session({ tools, call: async () => { throw new Error("拒绝"); } });
  // When Claude Code sends protocol, malformed and unknown requests.
  send({ id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } });
  send({ id: 2, method: "ping" });
  send({ method: "notifications/initialized" });
  send("{not json");
  send({ id: 3, method: "resources/list" });
  send({ id: 4, method: "tools/call", params: { name: "probe", arguments: {} } });
  // Then the server echoes the protocol, ignores notifications and never turns a tool failure into a protocol failure.
  assert.deepEqual((await reply(1)).result, { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "reframe", version: "1.0.0" } });
  assert.deepEqual((await reply(2)).result, {});
  assert.equal((await reply(null)).error.code, -32700);
  assert.equal((await reply(3)).error.code, -32601);
  assert.deepEqual((await reply(4)).result, { content: [{ type: "text", text: "拒绝" }], isError: true });
  assert.equal(replies.length, 5);
});

test("user's cancelled Claude tool call stops without a late reply", async () => {
  // Given a tool call that waits for cancellation.
  let aborted;
  const { send, reply, replies } = session({ tools: [], call: (_name, _args, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => { aborted = true; reject(new Error("cancelled")); });
  }) });
  send({ id: 7, method: "tools/call", params: { name: "slow", arguments: {} } });
  // When Claude Code cancels it, Then the tool sees the abort and no reply is sent for that request.
  await new Promise(resolve => setTimeout(resolve, 10));
  send({ method: "notifications/cancelled", params: { requestId: 7 } });
  send({ id: 8, method: "ping" });
  await reply(8);
  assert.equal(aborted, true);
  assert.equal(replies.some(message => message.id === 7), false);
});

test("user's Claude task server refuses references outside the task and an unreadable task manifest", async () => {
  // Given a task with one reference, When other paths or argument shapes are requested, Then they are refused.
  const { call } = createReframeTools({ images: [], references: { "references/a.md": "A" } });
  for (const args of [{ path: "references/b.md" }, { path: "references/a.md", extra: 1 }, null, ["references/a.md"]])
    await assert.rejects(call("alchemy_read_reference", args), /仅允许读取本次技能的参考文档/);
  await assert.rejects(call("Bash", {}), /未知工具/);
  // Given no readable manifest, When Claude Code starts the server, Then it exits without exposing tools.
  const server = fileURLToPath(new URL("../bridge/claude-mcp.mjs", import.meta.url));
  const started = spawnSync(process.execPath, [server, "/nonexistent/reframe-task.json"], { input: "", encoding: "utf8" });
  assert.equal(started.status, 1);
  assert.match(started.stderr, /无法读取 Reframe 任务资料/);
  assert.equal(started.stdout, "");
});
