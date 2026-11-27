import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, access, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { runClaude, readClaudeCatalog, verifyClaudeModel } from "../bridge/claude-agent.mjs";

// A stand-in for `claude`: answers --version, auth status, the initialize handshake and one stream-json user turn.
const fake = `
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const cfg = JSON.parse(process.env.TEST_CLAUDE || '{}');
const args = process.argv.slice(2);
const out = m => process.stdout.write(JSON.stringify(m) + '\\n');
const flag = name => args[args.indexOf(name) + 1];
const has = name => args.includes(name);
if (args[0] === '--version') { console.log('2.1.0 (Claude Code)'); process.exit(0); }
if (args[0] === 'auth') {
  const auth = cfg.auth || { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'person@example.test', orgId: 'org-1', subscriptionType: 'pro' };
  console.log(JSON.stringify(auth, null, 2));
  process.exit(auth.loggedIn ? 0 : 1);
}
const record = value => { if (cfg.capture) fs.writeFileSync(cfg.capture, JSON.stringify(value)); };
function handle(m) {
  if (m.type === 'control_request') return out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { models: cfg.models || [] } } });
  if (m.type !== 'user') return;
  const mcp = has('--mcp-config') ? JSON.parse(fs.readFileSync(flag('--mcp-config'), 'utf8')) : null;
  let served = null;
  if (mcp && cfg.probeMcp) {
    const server = mcp.mcpServers.reframe;
    const requests = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'alchemy_inspect_image', arguments: { image: 1 } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'alchemy_read_reference', arguments: { path: 'references/style.md' } } },
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'alchemy_read_reference', arguments: { path: '../SKILL.md' } } },
    ];
    const result = spawnSync(server.command, server.args, { input: requests.map(r => JSON.stringify(r)).join('\\n') + '\\n', encoding: 'utf8' });
    served = result.stdout.trim().split('\\n').filter(Boolean).map(line => JSON.parse(line)).sort((a, b) => a.id - b.id);
  }
  record({ args, message: m, cwd: process.cwd(), system: fs.readFileSync(flag('--system-prompt-file'), 'utf8'), mcp, served,
    manifest: mcp ? JSON.parse(fs.readFileSync(mcp.mcpServers.reframe.args[1], 'utf8')) : null,
    env: process.env });
  const tools = cfg.tools || [...(has('--json-schema') ? ['StructuredOutput'] : []), ...(mcp ? ['mcp__reframe__alchemy_inspect_image', 'mcp__reframe__alchemy_read_reference'] : [])];
  out({ type: 'system', subtype: 'init', tools, mcp_servers: mcp ? [{ name: 'reframe', status: cfg.mcpStatus || 'connected' }] : [] });
  for (const event of cfg.events || []) out(JSON.parse(JSON.stringify(event).replaceAll('$MODEL', flag('--model'))));
}
let buffer = '';
process.stdin.on('data', chunk => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\\n')) >= 0) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (line.trim()) handle(JSON.parse(line)); }
});
process.stdin.on('end', () => process.exit(0));
`;

const success = (output = { title: "完成" }) => [
  { type: "assistant", message: { model: "$MODEL", content: [{ type: "tool_use", name: "mcp__reframe__alchemy_inspect_image", input: { image: 2, bbox: { x: 0, y: 0, width: 4, height: 4 } } }] } },
  { type: "assistant", message: { model: "$MODEL", content: [{ type: "text", text: "整理" }] } },
  { type: "result", subtype: "success", is_error: false, result: "", structured_output: output },
];
const selected = { model: "claude-test-1", reasoningEffort: "high" };

async function fixture(t, config = {}) {
  const dir = await mkdtemp(join(tmpdir(), "reframe-claude-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = join(dir, "claude"), capture = join(dir, "capture.json");
  await writeFile(bin, `#!${process.execPath}\n${fake}`, { mode: 0o700 });
  const env = cfg => ({ ...process.env, CLAUDE_BIN: bin, TEST_CLAUDE: JSON.stringify({ capture, ...cfg }) });
  return { dir, capture, env: env(config), withConfig: env, captured: async () => JSON.parse(await readFile(capture, "utf8")) };
}
async function accountKey(env) { return (await readClaudeCatalog(undefined, { env })).accountKey; }

test("user receives Claude Code results with ordered images, isolated flags, task-only tools and cleaned temporary files", async t => {
  // Given a wide reference image, a second image, task text and a skill with a reference.
  // When the user reverses with the verified model through documented `claude -p` flags.
  // Then images keep their order and fit Claude's limits, settings and built-in tools stay off, and task files disappear.
  const { dir, env, captured } = await fixture(t, { probeMcp: true, events: success() });
  const wide = join(dir, "wide.png"), small = join(dir, "small.png");
  await writeFile(wide, await sharp({ create: { width: 2400, height: 600, channels: 4, background: "#08f8" } }).png().toBuffer());
  await writeFile(small, await sharp({ create: { width: 8, height: 6, channels: 3, background: "red" } }).png().toBuffer());
  await mkdir(join(dir, "skill/references"), { recursive: true });
  await writeFile(join(dir, "skill/SKILL.md"), "技能正文");
  await writeFile(join(dir, "skill/references/style.md"), "风格参考");
  const stages = [];
  const result = await runClaude({ env, instructions: "只做图片分析", schema: { type: "object" }, dynamicTools: [{ spec: { name: "alchemy_inspect_image" } }],
    modelSettings: { ...selected, accountKey: await accountKey(env) }, onProgress: progress => stages.push(progress.stage),
    input: [{ type: "text", text: "任务提示词" }, { type: "localImage", path: wide }, { type: "localImage", path: small }, { type: "skill", name: "alchemy", path: join(dir, "skill/SKILL.md") }] });
  assert.deepEqual(result, { text: '{"title":"完成"}', images: [] });
  const run = await captured();
  const value = name => run.args[run.args.indexOf(name) + 1];
  assert.equal(run.args[0], "-p");
  for (const [name, expected] of [["--setting-sources", ""], ["--tools", ""], ["--permission-prompts", "none"], ["--model", "claude-test-1"], ["--effort", "high"],
    ["--input-format", "stream-json"], ["--output-format", "stream-json"], ["--json-schema", '{"type":"object"}'],
    ["--allowedTools", "mcp__reframe__alchemy_inspect_image,mcp__reframe__alchemy_read_reference"]]) assert.equal(value(name), expected, name);
  for (const name of ["--strict-mcp-config", "--no-session-persistence", "--disable-slash-commands", "--verbose"]) assert.ok(run.args.includes(name), name);
  assert.equal(run.env.DISABLE_AUTOUPDATER, "1");
  assert.equal(run.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
  const content = run.message.message.content;
  assert.deepEqual(content.map(block => block.type === "text" ? block.text : block.type), ["任务提示词", "图 1", "image", "图 2", "image"]);
  const sizes = await Promise.all([content[2], content[4]].map(block => sharp(Buffer.from(block.source.data, "base64")).metadata()));
  assert.deepEqual(sizes.map(({ width, height }) => [width, height]), [[2000, 500], [8, 6]]);
  assert.match(run.system, /只做图片分析[\s\S]*技能正文[\s\S]*references\/style\.md[\s\S]*mcp__reframe__alchemy_inspect_image/);
  assert.deepEqual(run.manifest, { images: [wide, small], references: { "references/style.md": "风格参考" } });
  const [initialized, listed, inspected, reference, refused] = run.served;
  assert.equal(initialized.result.serverInfo.name, "reframe");
  assert.deepEqual(listed.result.tools.map(tool => tool.name), ["alchemy_inspect_image", "alchemy_read_reference"]);
  assert.doesNotMatch(listed.result.tools[0].description, /functions\.exec/);
  assert.deepEqual(inspected.result.content.map(item => item.type), ["text", "image"]);
  assert.ok(JSON.parse(inspected.result.content[0].text).output.width <= 2000);
  assert.deepEqual(reference.result.content, [{ type: "text", text: "风格参考" }]);
  assert.equal(refused.result.isError, true);
  assert.ok(stages.some(stage => /检查图 2 的局部细节/.test(stage)));
  assert.notEqual(run.cwd, dir);
  await assert.rejects(access(run.cwd), { code: "ENOENT" });
});

test("user's Claude Code task does not inherit the Claude Code session that started the bridge", async t => {
  // Given a bridge started from inside a Claude Code session, plus the user's own login folder, API key, gateway, client certificate and proxy.
  const { dir, withConfig, captured } = await fixture(t);
  const host = { CLAUDECODE: "1", AI_AGENT: "claude-code_agent", CLAUDE_EFFORT: "xhigh", CLAUDE_PID: "1", CLAUDE_CODE_ENTRYPOINT: "claude-desktop",
    CLAUDE_CODE_USER_EMAIL: "host@example.test", CLAUDE_CODE_ACCOUNT_UUID: "host-account", CLAUDE_CODE_SESSION_ID: "host-session",
    CLAUDE_CODE_HOST_SESSION_ID: "host-session", CLAUDE_CODE_CHILD_NOTES_DIR: "/host/notes", CLAUDE_CODE_MESSAGING_SOCKET: "/host/socket",
    CLAUDE_CODE_MESSAGING_TOKEN: "host-token", CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL: "1", CLAUDE_AGENT_SDK_VERSION: "0.0.0", MCP_CONNECTION_NONBLOCKING: "1" };
  const own = { CLAUDE_CONFIG_DIR: join(dir, "claude-config"), ANTHROPIC_API_KEY: "sk-ant-own", ANTHROPIC_BASE_URL: "https://gateway.example.test",
    CLAUDE_CODE_CLIENT_CERT: join(dir, "client.pem"), HTTPS_PROXY: "http://proxy.example.test:8080" };
  // When a task runs with a model whose effort the user left to the CLI default.
  await runClaude({ env: { ...withConfig({ events: success() }), ...host, ...own }, input: [], schema: { type: "object" }, modelSettings: { model: "claude-test-1" } });
  // Then the CLI keeps the user's login, provider and network settings but receives no host identity, session link, effort or tool toggle.
  const run = await captured();
  for (const [key, value] of Object.entries(own)) assert.equal(run.env[key], value, key);
  for (const key of Object.keys(host)) assert.equal(run.env[key], undefined, key);
  assert.ok(!run.args.includes("--effort"));
});

test("user verifies a Claude Code model with a tool-free probe", async t => {
  // Given a selected model, When the user verifies it, Then no MCP server, schema or built-in tool is loaded.
  const { env, captured } = await fixture(t, { events: [{ type: "assistant", message: { model: "$MODEL", content: [{ type: "text", text: "OK" }] } },
    { type: "result", subtype: "success", is_error: false, result: "OK" }] });
  await verifyClaudeModel({ env, selection: { model: "claude-test-1", accountKey: await accountKey(env) } });
  const probe = await captured();
  assert.ok(!probe.args.includes("--mcp-config") && !probe.args.includes("--json-schema") && !probe.args.includes("--effort"));
  assert.deepEqual(probe.message.message.content, [{ type: "text", text: "仅回复 OK。" }]);
});

test("user must select a Claude Code model before running a task", async () => {
  // Given no selection, When a probe starts, Then the adapter asks for a model before touching the CLI.
  await assert.rejects(runClaude({ input: [], probe: true }), /选择.*Claude Code 模型/);
});

test("user sees login guidance and re-verification instead of a silent account switch", async t => {
  // Given a logged-out CLI, Then the task asks for `claude auth login`;
  // Given a selection verified for another account, Then the task stops before calling the model.
  const { env, withConfig } = await fixture(t, { events: success() });
  await assert.rejects(runClaude({ env: withConfig({ auth: { loggedIn: false } }), input: [], modelSettings: selected }), /未登录[\s\S]*claude auth login/);
  const key = await accountKey(env);
  const switched = withConfig({ auth: { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", email: "person@example.test", orgId: "org-2", subscriptionType: "pro" } });
  await assert.rejects(runClaude({ env: switched, input: [], modelSettings: { ...selected, accountKey: key } }), error => error.modelContextChanged === true && error.recovery === "models");
});

test("user must re-verify when Claude Code would bill another API key or cloud account from the environment", async t => {
  // Given an API-key login whose status names no account, and a model verified with key A.
  const { dir, withConfig } = await fixture(t, { events: success() });
  const apiKey = { loggedIn: true, authMethod: "api_key", apiProvider: "firstParty" };
  const base = withConfig({ auth: apiKey, events: success() });
  for (const name of Object.keys(base)) if (/^(ANTHROPIC_|CLAUDE_CODE_|AWS_|GOOGLE_|GCLOUD_|CLOUD_ML_)/.test(name)) delete base[name];
  const keyA = { ...base, ANTHROPIC_API_KEY: "sk-ant-key-a" };
  const verified = await accountKey(keyA);
  // Then the same key keeps its trust and the key never appears in what is saved.
  assert.equal(await accountKey(keyA), verified);
  assert.match(verified, /^[\da-f]{64}$/);
  // When the bridge restarts with key B, an auth token or an OAuth token instead, Then the task stops before calling the model.
  for (const env of [{ ...base, ANTHROPIC_API_KEY: "sk-ant-key-b" }, { ...keyA, ANTHROPIC_AUTH_TOKEN: "token" }, { ...base, CLAUDE_CODE_OAUTH_TOKEN: "oauth" }])
    await assert.rejects(runClaude({ env, input: [], modelSettings: { ...selected, accountKey: verified } }), error => error.modelContextChanged === true && error.recovery === "models");
  // Given Bedrock through a shared credentials file, When that file is replaced, Then the context changes too.
  const credentials = join(dir, "aws-credentials");
  await writeFile(credentials, "[default]\n");
  const bedrock = { ...base, CLAUDE_CODE_USE_BEDROCK: "1", AWS_PROFILE: "work", AWS_SHARED_CREDENTIALS_FILE: credentials, AWS_CONFIG_FILE: join(dir, "aws-config") };
  const before = await accountKey(bedrock);
  assert.notEqual(before, verified);
  await writeFile(credentials, "[default]\nother account\n");
  assert.notEqual(await accountKey(bedrock), before);
  assert.notEqual(await accountKey({ ...bedrock, AWS_PROFILE: "personal" }), before);
});

test("user sees an unavailable or substituted Claude model fail explicitly without fallback", async t => {
  // Given the API rejects the model, Then it is marked unavailable; Given another model answers, Then the task stops.
  const { withConfig } = await fixture(t);
  const unavailable = withConfig({ events: [
    { type: "assistant", error: "model_not_found", message: { model: "<synthetic>", content: [{ type: "text", text: "There's an issue with the selected model" }] } },
    { type: "result", subtype: "success", is_error: true, api_error_status: 404, result: "There's an issue with the selected model" }] });
  await assert.rejects(runClaude({ env: unavailable, input: [], modelSettings: selected }), error => error.modelUnavailable === true);
  const substituted = withConfig({ events: [{ type: "assistant", message: { model: "claude-other", content: [{ type: "text", text: "x" }] } }, ...success().slice(2)] });
  await assert.rejects(runClaude({ env: substituted, input: [], modelSettings: selected }), error => error.modelContextChanged === true && /不一致/.test(error.message));
  const dated = withConfig({ events: [{ type: "assistant", message: { model: "claude-test-1-20260101", content: [{ type: "text", text: "x" }] } }, ...success().slice(2)] });
  assert.equal((await runClaude({ env: dated, input: [], schema: { type: "object" }, modelSettings: selected })).text, '{"title":"完成"}');
});

test("user's task stops when Reframe tools are missing, extra tools load or no structured result arrives", async t => {
  // Given each broken Claude Code session, When the task runs, Then it fails with an explicit reason.
  const { withConfig } = await fixture(t);
  const input = [{ type: "text", text: "任务" }];
  await assert.rejects(runClaude({ env: withConfig({ mcpStatus: "failed", events: success() }), input, schema: { type: "object" }, modelSettings: selected }), /未加载 Reframe 图像工具/);
  await assert.rejects(runClaude({ env: withConfig({ tools: ["Bash", "mcp__reframe__alchemy_inspect_image", "mcp__reframe__alchemy_read_reference"], events: success() }), input, modelSettings: selected }), /预期之外的工具/);
  await assert.rejects(runClaude({ env: withConfig({ events: [{ type: "result", subtype: "success", is_error: false, result: "{}" }] }), input, schema: { type: "object" }, modelSettings: selected }), /未返回符合格式/);
  await assert.rejects(runClaude({ env: withConfig({ events: [] }), input, modelSettings: selected }), /未完成任务/);
  await assert.rejects(runClaude({ env: withConfig({ events: success() }), input, modelSettings: selected, dynamicTools: [{ spec: { name: "shell" } }] }), /不支持本次请求的工具/);
});

test("user sees the Claude Code model catalog without a model call or personal account details", async t => {
  // Given aliases, a model without effort levels and a malformed entry,
  // When the catalog loads, Then each model appears once with its own efforts and only the plan names the account.
  const { capture, withConfig } = await fixture(t);
  const efforts = ["low", "medium", "high", "max"];
  const env = withConfig({ models: [
    { value: "default", resolvedModel: "claude-test-1", displayName: "Default (recommended)", supportsEffort: true, supportedEffortLevels: efforts },
    { value: "best", resolvedModel: "claude-test-1", displayName: "Test 1", supportsEffort: true, supportedEffortLevels: efforts },
    { value: "claude-light", resolvedModel: "claude-light", displayName: "Light" },
    { value: "bad", resolvedModel: "../escape model" },
  ] });
  const catalog = await readClaudeCatalog(undefined, { env });
  assert.equal(catalog.provider, "claude");
  assert.equal(catalog.accountLabel, "Claude Pro");
  assert.doesNotMatch(JSON.stringify(catalog), /person@example\.test/);
  assert.deepEqual(catalog.models, [
    { model: "claude-test-1", label: "Test 1", reasoningEffort: "high", supportedReasoningEfforts: efforts.map(reasoningEffort => ({ reasoningEffort })), isDefault: true },
    { model: "claude-light", label: "Light", reasoningEffort: undefined, supportedReasoningEfforts: [], isDefault: false },
  ]);
  await assert.rejects(access(capture), { code: "ENOENT" });
  assert.equal((await readClaudeCatalog(undefined, { env })).accountKey, catalog.accountKey);
});
