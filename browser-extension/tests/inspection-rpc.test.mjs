import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { withCodex } from "../bridge/codex-rpc.mjs";
import { runAgent } from "../bridge/agent.mjs";
import { runCodex } from "../bridge/codex-agent.mjs";
import { readModelCatalog } from "../bridge/models.mjs";
import { runGeneration } from "../bridge/generation.mjs";

async function fakeCodex(t, turnCode, initializeCode = "", config = {}) {
  const dir = await mkdtemp(join(tmpdir(), "alchemy-inspection-rpc-"));
  const file = join(dir, "codex");
  const log = join(dir, "calls.jsonl");
  await writeFile(file, `#!/usr/bin/env node
const fs = require('node:fs');
const send = x => process.stdout.write(JSON.stringify(x) + '\\n');
const done = () => {
  send({method:'item/completed',params:{threadId:'test',item:{type:'agentMessage',text:JSON.stringify({title:'test',observations:[],promptZh:'猫',promptEn:'cat',negativePrompt:'',uncertainties:[]})}}});
  send({method:'turn/completed',params:{threadId:'test',turn:{status:'completed'}}});
};
let start, expectedReplies = 1;
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({method:'process/started',cwd:process.cwd()})+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const m = JSON.parse(line); fs.appendFileSync(${JSON.stringify(log)},line+'\\n');
  if (m.id === undefined) return;
  if (!m.method) { if (--expectedReplies === 0) done(); return; }
  if (m.method === 'initialize') { ${initializeCode} }
  let result = {};
  if (m.method === 'account/read') result={account:{type:'chatgpt',email:'inspection@example.com',planType:'test'},requiresOpenaiAuth:true};
  if (m.method === 'config/read') result={config:{model_provider:'openai',...${JSON.stringify(config)}}};
  if (m.method === 'model/list') result={data:[{model:'vision',defaultReasoningEffort:'low',isDefault:true}],nextCursor:null};
  if (m.method === 'modelProvider/capabilities/read') result={imageGeneration:true};
  if (m.method === 'thread/start') { start=m.params; result={thread:{id:'test'},model:m.params.model,modelProvider:m.params.modelProvider}; }
  send({id:m.id,result});
  if (m.method === 'turn/start') { ${turnCode} }
});
`, { mode: 0o700 });
  const previous = process.env.CODEX_BIN;
  const previousPersistence = process.env.ALCHEMY_PERSIST_CODEX_SESSIONS;
  delete process.env.ALCHEMY_PERSIST_CODEX_SESSIONS;
  process.env.CODEX_BIN = file;
  t.after(async () => {
    if (previous === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = previous;
    if (previousPersistence === undefined) delete process.env.ALCHEMY_PERSIST_CODEX_SESSIONS; else process.env.ALCHEMY_PERSIST_CODEX_SESSIONS = previousPersistence;
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, calls: async () => (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse) };
}

test("runAgent registers input-scoped inspection and RPC delivers actual ordered image pixels and recoverable tool errors", async t => {
  const { dir, calls } = await fakeCodex(t, `
    expectedReplies = 3;
    send({method:'item/started',params:{threadId:'other',item:{type:'dynamicToolCall',tool:'alchemy_inspect_image',arguments:{image:99}}}});
    send({method:'item/started',params:{threadId:'test',item:{type:'dynamicToolCall',tool:'alchemy_inspect_image',arguments:{image:1}}}});
    send({method:'item/started',params:{threadId:'test',item:{type:'dynamicToolCall',tool:'alchemy_inspect_image',arguments:{image:2,bbox:{x:0,y:0,width:1,height:1},scale:3}}}});
    send({method:'item/completed',params:{threadId:'test',item:{type:'dynamicToolCall',tool:'alchemy_inspect_image',success:false,contentItems:[{type:'inputText',text:'invalid bbox'}]}}});
    send({id:'bad',method:'item/tool/call',params:{threadId:'test',turnId:'t',callId:'bad',tool:'alchemy_inspect_image',arguments:{image:3}}});
    send({id:'first',method:'item/tool/call',params:{threadId:'test',turnId:'t',callId:'first',tool:'alchemy_inspect_image',arguments:{image:1,bbox:{x:0,y:0,width:1,height:1},scale:2}}});
    send({id:'last',method:'item/tool/call',params:{threadId:'test',turnId:'t',callId:'last',tool:'alchemy_inspect_image',arguments:{image:2}}});
  `);
  const skillPath = join(dir, "SKILL.md");
  await writeFile(skillPath, "---\nname: alchemy\n---\nTest");
  const subjectImagePath = join(dir, "subject.png");
  const imagePath = join(dir, "reference.png");
  await sharp({ create: { width: 1, height: 1, channels: 3, background: "red" } }).png().toFile(subjectImagePath);
  await sharp({ create: { width: 1, height: 1, channels: 3, background: "blue" } }).png().toFile(imagePath);
  const catalog = await readModelCatalog(dir);
  const modelSettings = { ...catalog.models[0], accountKey: catalog.accountKey, provider: catalog.provider };
  const stages = [];
  const result = await runAgent({ run: runCodex, mode: "reenact", imagePath, subjectImagePath, basePrompt: "保留主体", skillPath, cwd: dir, modelSettings, onProgress: ({ stage }) => stages.push(stage) });
  assert.equal(result.promptEn, "cat");
  assert.ok(stages.includes("正在查看图 1整体…"));
  assert.ok(stages.includes("正在检查图 2局部 · 目标放大 3 倍…"));
  assert.ok(stages.includes("图片检查失败：invalid bbox"));
  assert.ok(stages.every(stage => !stage.includes("99")));
  const messages = await calls();
  assert.equal(messages.filter(m => m.method === "initialize").at(-1).params.capabilities.experimentalApi, true);
  const start = messages.find(m => m.method === "thread/start").params;
  assert.equal(start.sandbox, "read-only");
  assert.equal(start.approvalPolicy, "never");
  assert.equal(start.ephemeral, true);
  assert.deepEqual(start.dynamicTools.map(s => [s.name, s.type, s.inputSchema.properties.image?.maximum]), [["alchemy_inspect_image", "function", 2], ["alchemy_read_reference", "function", undefined]]);
  assert.equal(messages.find(m => m.id === "bad").result.success, false);
  for (const [id, rgb] of [["first", [255, 0, 0]], ["last", [0, 0, 255]]]) {
    const response = messages.find(m => m.id === id).result;
    assert.equal(response.success, true);
    const image = response.contentItems.find(c => c.type === "inputImage");
    const pixels = await sharp(Buffer.from(image.imageUrl.split(",")[1], "base64")).raw().toBuffer();
    assert.deepEqual([...pixels.subarray(0, 3)], rgb);
  }
});

// Only Reframe's task prompt, the selected skill snapshot, the task text, the chosen images and Reframe tools reach the model.
const CODEX_ISOLATION = {
  project_doc_max_bytes: 0, include_permissions_instructions: false, include_environment_context: false,
  include_collaboration_mode_instructions: false, include_apps_instructions: false, web_search: "disabled",
  agents: { enabled: false }, skills: { include_instructions: false, bundled: { enabled: false } },
  features: { apps: false, plugins: false, remote_plugin: false, computer_use: false, browser_use: false, browser_use_external: false,
    in_app_browser: false, goals: false, hooks: false, multi_agent_v2: false, shell_tool: false, sleep_tool: false, skill_search: false,
    tool_suggest: false, image_generation: false, view_image: false },
  tools: { experimental_request_user_input: { enabled: false } },
};

test("user's Codex reverse sees only the task prompt, skill snapshot, chosen images, task text and Reframe tools", async t => {
  // Given a skill with one reference, the user's own Codex MCP servers, and the bridge folder with its own Codex settings.
  const { dir, calls } = await fakeCodex(t, `
    expectedReplies = 2;
    send({method:'item/started',params:{threadId:'test',item:{type:'dynamicToolCall',tool:'alchemy_read_reference',arguments:{path:'references/style.md'}}}});
    send({id:'ref',method:'item/tool/call',params:{threadId:'test',turnId:'t',callId:'ref',tool:'alchemy_read_reference',arguments:{path:'references/style.md'}}});
    send({id:'escape',method:'item/tool/call',params:{threadId:'test',turnId:'t',callId:'escape',tool:'alchemy_read_reference',arguments:{path:'../SKILL.md'}}});
  `, "", { mcp_servers: { "computer-use": { command: "a" }, "team.docs": { command: "b" } } });
  await mkdir(join(dir, "skill/references"), { recursive: true });
  const skillPath = join(dir, "skill/SKILL.md"), imagePath = join(dir, "reference.png");
  await writeFile(skillPath, "---\nname: alchemy\n---\n技能正文");
  await writeFile(join(dir, "skill/references/style.md"), "风格参考");
  await sharp({ create: { width: 1, height: 1, channels: 3, background: "blue" } }).png().toFile(imagePath);
  const catalog = await readModelCatalog(dir);
  const modelSettings = { ...catalog.models[0], accountKey: catalog.accountKey, provider: catalog.provider };
  // When the user reverses one reference image with an extra instruction.
  const stages = [];
  const result = await runAgent({ run: runCodex, mode: "recreate", imagePath, instruction: "用户附加要求", skillPath, cwd: dir, modelSettings, onProgress: ({ stage }) => stages.push(stage) });
  // Then Codex runs in a private empty folder with Reframe's prompt in place of its own and every optional context source off.
  assert.equal(result.promptEn, "cat");
  const messages = await calls();
  const start = messages.find(m => m.method === "thread/start").params, turn = messages.find(m => m.method === "turn/start").params;
  assert.ok(!start.cwd.startsWith(dir));
  assert.equal(messages.filter(m => m.method === "process/started").at(-1).cwd, start.cwd);
  assert.equal(messages.filter(m => m.method === "config/read").at(-1).params.cwd, start.cwd);
  await assert.rejects(access(start.cwd), { code: "ENOENT" });
  assert.equal(start.developerInstructions, undefined);
  assert.match(start.baseInstructions, /^仅分析用户选中的图片[\s\S]*技能正文[\s\S]*alchemy_read_reference[\s\S]*references\/style\.md/);
  assert.deepEqual(start.config, { model_reasoning_effort: "low", ...CODEX_ISOLATION,
    mcp_servers: { "computer-use": { enabled: false }, "team.docs": { enabled: false } } });
  assert.deepEqual(start.dynamicTools.map(tool => tool.name), ["alchemy_inspect_image", "alchemy_read_reference"]);
  assert.deepEqual(turn.input.filter(item => item.type !== "text"), [{ type: "localImage", path: imagePath }]);
  assert.ok(turn.input.some(item => item.type === "text" && item.text.includes("用户附加要求")));
  // And it reads only the selected skill's references.
  assert.deepEqual(messages.find(m => m.id === "ref").result, { success: true, contentItems: [{ type: "inputText", text: "风格参考" }] });
  const escape = messages.find(m => m.id === "escape").result;
  assert.equal(escape.success, false);
  assert.match(escape.contentItems[0].text, /仅允许读取本次技能的参考文档/);
  assert.ok(stages.includes("正在读取技能参考资料…"));
});

test("user's Codex model list and model check ignore the bridge folder, while built-in generation keeps its setup", async t => {
  // Given a verified model.
  const { dir, calls } = await fakeCodex(t, "done();");
  const catalog = await readModelCatalog(dir);
  const modelSettings = { ...catalog.models[0], accountKey: catalog.accountKey, provider: catalog.provider };
  // When the model is checked and an image is generated.
  await runCodex({ cwd: dir, input: [{ type: "text", text: "仅回复 OK。" }], instructions: "连接检查", modelSettings, probe: true });
  await runCodex({ cwd: dir, input: [], instructions: "生图规则", modelSettings, generation: true });
  // Then listing and checking run in private folders with only the check prompt, and generation keeps image generation.
  const messages = await calls();
  assert.ok(!messages.find(m => m.method === "config/read").params.cwd.startsWith(dir));
  const [probe, generation] = messages.filter(m => m.method === "thread/start").map(m => m.params);
  assert.ok(!probe.cwd.startsWith(dir));
  assert.equal(probe.baseInstructions, "连接检查");
  assert.equal(probe.developerInstructions, undefined);
  assert.deepEqual(probe.config, { model_reasoning_effort: "low", ...CODEX_ISOLATION, mcp_servers: {} });
  assert.equal(generation.cwd, dir);
  assert.equal(generation.baseInstructions, undefined);
  assert.equal(generation.developerInstructions, "生图规则");
  assert.deepEqual(generation.config, { model_reasoning_effort: "low" });
});

test("user's Codex reverse stops without a model call when the skill snapshot cannot be read", async t => {
  // Given a skill path that no longer exists.
  const { dir, calls } = await fakeCodex(t, "done();");
  const catalog = await readModelCatalog(dir);
  const modelSettings = { ...catalog.models[0], accountKey: catalog.accountKey, provider: catalog.provider };
  // When a reverse task starts, Then it fails before any Codex thread starts.
  await assert.rejects(runCodex({ cwd: dir, modelSettings, instructions: "规则", input: [{ type: "skill", name: "alchemy", path: join(dir, "missing/SKILL.md") }] }), { code: "ENOENT" });
  assert.ok(!(await calls()).some(m => m.method === "thread/start"));
});

test("generation and probe never register inspection or opt into experimental tool APIs", async t => {
  const { dir, calls } = await fakeCodex(t, "done();");
  const catalog = await readModelCatalog(dir);
  const modelSettings = { ...catalog.models[0], accountKey: catalog.accountKey, provider: catalog.provider };
  const dynamicTools = [{ spec: { name: "alchemy_inspect_image" }, call() { assert.fail("unexpected dispatch"); } }];
  for (const options of [{ generation: true }, { probe: true }])
    await runCodex({ cwd: dir, input: [], modelSettings, dynamicTools, ...options });
  const messages = await calls();
  assert.ok(messages.filter(m => m.method === "initialize").every(m => m.params.capabilities === undefined));
  assert.ok(messages.filter(m => m.method === "thread/start").every(m => m.params.dynamicTools === undefined && m.params.sandbox === "read-only" && m.params.approvalPolicy === "never"));
  assert.ok(messages.filter(m => m.method === "thread/start").every(m => m.params.ephemeral === true));
});

test("explicit session debugging keeps task history but model probes remain ephemeral", async t => {
  const { dir, calls } = await fakeCodex(t, "done();");
  const catalog = await readModelCatalog(dir);
  const modelSettings = { ...catalog.models[0], accountKey: catalog.accountKey, provider: catalog.provider };
  process.env.ALCHEMY_PERSIST_CODEX_SESSIONS = "1";
  for (const options of [{}, { generation: true }, { probe: true }])
    await runCodex({ cwd: dir, input: [], modelSettings, ...options });
  assert.deepEqual((await calls()).filter(m => m.method === "thread/start").map(m => m.params.ephemeral), [false, false, true]);
});

for (const source of ["base64", "savedPath"]) test(`ephemeral generation returns real image bytes from ${source} without reading thread history`, async t => {
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer();
  const { dir, calls } = await fakeCodex(t, `
    if (!start.ephemeral) throw Error('expected ephemeral thread');
    send({method:'item/completed',params:{threadId:'test',item:{type:'imageGeneration',status:'completed',
      ${source === "savedPath" ? "savedPath:process.env.CODEX_HOME+'/generated_images/test.png'" : `result:${JSON.stringify(png.toString("base64"))}`}
    }}});
    done();
  `);
  const previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = dir;
  t.after(() => { if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome; });
  await mkdir(join(dir, "generated_images"));
  await writeFile(join(dir, "generated_images/test.png"), png);
  const skillPath = join(dir, "SKILL.md");
  await writeFile(skillPath, "---\nname: imagegen\n---\nTest");
  const catalog = await readModelCatalog(dir);
  const modelSettings = { ...catalog.models[0], accountKey: catalog.accountKey, provider: catalog.provider };
  const result = await runGeneration({ prompt: "red square", skillPath, cwd: dir, modelSettings });
  assert.deepEqual(result.bytes, png);
  assert.equal(result.extension, "png");
  assert.ok((await calls()).every(m => !["thread/read", "thread/resume"].includes(m.method)));
});

for (const outcome of ["failed", "cancelled"]) test(`a ${outcome} task does not fall back to a persistent thread`, async t => {
  const { dir, calls } = await fakeCodex(t, `send({method:'turn/completed',params:{threadId:'test',turn:{status:'failed',error:{message:'test failure'}}}});`);
  const catalog = await readModelCatalog(dir);
  const modelSettings = { ...catalog.models[0], accountKey: catalog.accountKey, provider: catalog.provider };
  const controller = new AbortController();
  await assert.rejects(runCodex({ cwd: dir, input: [], modelSettings, signal: controller.signal,
    onProgress: ({ threadId }) => { if (threadId && outcome === "cancelled") controller.abort(); },
  }), outcome === "cancelled" ? /取消/ : /test failure/);
  assert.deepEqual((await calls()).filter(m => m.method === "thread/start").map(m => m.params.ephemeral), [true]);
});

for (const [label, method, params] of [
  ["unregistered tools", "item/tool/call", { threadId: "test", tool: "other" }],
  ["another thread", "item/tool/call", { threadId: "other", tool: "alchemy_inspect_image" }],
  ["namespaced tools", "item/tool/call", { threadId: "test", namespace: "other", tool: "alchemy_inspect_image" }],
  ["approval requests", "item/permissions/requestApproval", { threadId: "test" }],
]) test(`RPC continues rejecting ${label}`, async t => {
  const { dir } = await fakeCodex(t, `send({id:'forbidden',method:${JSON.stringify(method)},params:${JSON.stringify(params)}});`);
  const tool = { spec: { type: "function", name: "alchemy_inspect_image", description: "test", inputSchema: {} }, call() { assert.fail("must not execute"); } };
  await assert.rejects(withCodex({ cwd: dir, dynamicTools: [tool] }, async request => {
    await request("thread/start", { dynamicTools: [tool.spec] });
    await request("turn/start", { threadId: "test" });
    await new Promise(() => {});
  }), /交互式操作/);
});

test("cancelling RPC aborts an active handler and prevents subsequent work and tool responses", async t => {
  const { dir, calls } = await fakeCodex(t, `send({id:'active',method:'item/tool/call',params:{threadId:'test',tool:'alchemy_inspect_image',arguments:{image:1}}});`);
  const controller = new AbortController();
  const started = Promise.withResolvers();
  const stopped = Promise.withResolvers();
  let nextStage = false, toolSignal;
  const tool = {
    spec: { type: "function", name: "alchemy_inspect_image", description: "test", inputSchema: {} },
    async call(args, { signal }) {
      toolSignal = signal;
      started.resolve();
      try {
        await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
        signal.throwIfAborted();
        nextStage = true;
      } finally { stopped.resolve(); }
    },
  };
  const running = withCodex({ cwd: dir, signal: controller.signal, dynamicTools: [tool] }, async request => {
    await request("thread/start", { dynamicTools: [tool.spec] });
    await request("turn/start", { threadId: "test" });
    await new Promise(() => {});
  });
  const rejected = assert.rejects(running, /取消/);
  await started.promise;
  controller.abort();
  await rejected;
  await stopped.promise;
  assert.equal(toolSignal.aborted, true);
  assert.equal(nextStage, false);
  assert.ok((await calls()).every(m => m.id !== "active"));
});

async function pendingRpc(t, initializeCode) {
  const { dir } = await fakeCodex(t, `send({method:'test/ready'});`,
    `send({method:'test/pid',params:{pid:process.pid}}); ${initializeCode}`);
  const controller = new AbortController(), spawned = Promise.withResolvers(), started = Promise.withResolvers();
  // Startup is real I/O; advance the operation clock explicitly after the chosen handshake.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const running = withCodex({ cwd: dir, signal: AbortSignal.any([controller.signal, t.signal]), timeoutMs: 1500,
    onNotification(message) {
      if (message.method === "test/pid") spawned.resolve(message.params.pid);
      if (message.method === "test/ready") started.resolve();
    },
  }, async request => {
    await request("turn/start", {});
    await new Promise(() => {});
  });
  const ready = Promise.race([started.promise, running]);
  ready.catch(() => {});
  t.after(async () => {
    controller.abort();
    await running.catch(() => {});
    t.mock.timers.reset();
  });
  return { running, ready, spawned: Promise.race([spawned.promise, running]), cancel: () => controller.abort() };
}

async function assertChildExited(pid) {
  assert.ok(Number.isInteger(pid) && pid > 0, "fixture must identify its actual child");
  for (let attempt = 0; attempt < 100; attempt++) {
    try { process.kill(pid, 0); }
    catch (error) { assert.equal(error.code, "ESRCH"); return; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail("Codex child survived the operation");
}

for (const outcome of ["cancel", "timeout"]) test(`RPC ${outcome} terminates its actual child process`, { timeout: 10_000 }, async t => {
  const rpc = await pendingRpc(t, `setTimeout(() => send({id:m.id,result:{}}), 1700); return;`);
  const pid = await rpc.spawned;
  await rpc.ready;
  const rejected = assert.rejects(rpc.running, outcome === "cancel" ? /取消/ : /超时/);
  if (outcome === "cancel") rpc.cancel();
  else t.mock.timers.tick(1500);
  await rejected;
  t.mock.timers.reset();
  await assertChildExited(pid);
});

for (const outcome of ["failed", "unready"]) test(`RPC ${outcome} initialization ends readiness waiting and cleans its child`, { timeout: 10_000 }, async t => {
  const rpc = await pendingRpc(t, outcome === "failed" ? `send({id:m.id,error:{message:'fixture initialization failed'}}); return;` : "return;");
  const pid = await rpc.spawned;
  if (outcome === "unready") t.mock.timers.tick(1500);
  const error = await rpc.running.catch(error => error);
  assert.match(error.message, outcome === "failed" ? /fixture initialization failed/ : /Codex 请求超时/);
  await assert.rejects(rpc.ready, failure => failure === error);
  t.mock.timers.reset();
  await assertChildExited(pid);
});
