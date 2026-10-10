import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, access, copyFile, symlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import sharp from "sharp";
import { runPi, readPiCatalog } from "../bridge/pi-agent.mjs";

async function fixture(t, body) {
  const dir = await mkdtemp(join(tmpdir(), "reframe-pi-test-"));
  const bin = join(dir, "pi");
  const capture = join(dir, "capture.json");
  await writeFile(bin, `#!${process.execPath}\n${body}`, { mode: 0o700 });
  const previous = process.env.PI_BIN;
  process.env.PI_BIN = bin;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_BIN; else process.env.PI_BIN = previous;
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, capture };
}

test("user receives Pi results with ordered images, isolated instructions and cleaned temporary files", async t => {
  // Given two ordered images, task instructions and a successful Pi stub.
  // When the user runs image analysis with the selected model.
  // Then the adapter preserves input order and isolation, returns final text and removes task files.
  const { dir, capture } = await fixture(t, `
const fs = require('node:fs');
let input = '';
process.stdin.on('data', data => input += data);
process.stdin.on('end', () => {
  fs.writeFileSync(process.env.TEST_PI_CAPTURE, JSON.stringify({args:process.argv.slice(2),input,manifest:process.env.REFRAME_PI_MANIFEST,cwd:process.cwd()}));
  console.log(JSON.stringify({type:'reframe_tools_ready'}));
  console.log(JSON.stringify({type:'message_end',message:{role:'assistant',provider:'test',model:'vision',stopReason:'stop',content:[{type:'text',text:'{"title":"完成"}'}]}}));
});`);
  process.env.TEST_PI_CAPTURE = capture;
  t.after(() => { delete process.env.TEST_PI_CAPTURE; });
  const a = join(dir, "a.png"), b = join(dir, "b.png");
  await writeFile(a, "a"); await writeFile(b, "b");
  const result = await runPi({ cwd: dir, instructions: "只做图片分析", schema: { type: "object" },
    modelSettings: { model: "test/vision", reasoningEffort: "high" },
    input: [{ type: "text", text: "任务提示词" }, { type: "localImage", path: b }, { type: "localImage", path: a }] });
  assert.deepEqual(result, { text: '{"title":"完成"}', images: [] });
  const captured = JSON.parse(await readFile(capture, "utf8"));
  assert.deepEqual(captured.args.filter(arg => arg.startsWith("@")), [`@${b}`, `@${a}`]);
  assert.ok(captured.input.includes("任务提示词"));
  for (const flag of ["--no-session", "--no-extensions", "--no-context-files", "--no-approve", "--offline"]) assert.ok(captured.args.includes(flag));
  assert.equal(captured.args[captured.args.indexOf("--tools") + 1], "alchemy_inspect_image,alchemy_read_reference");
  assert.notEqual(captured.cwd, dir);
  await assert.rejects(access(captured.cwd), { code: "ENOENT" });
});

test("user must select a Pi model before running a task", async () => {
  // Given no explicit model selection.
  // When the user attempts a Pi connection probe.
  // Then the adapter rejects the request with model-selection guidance.
  await assert.rejects(runPi({ input: [], probe: true }), /选择.*模型/);
});

test("user sees a Pi model error even when the CLI exits successfully", async t => {
  // Given a Pi stub that reports a model error and exits with status zero.
  // When the user probes the selected model.
  // Then the model error is surfaced instead of returning partial output.
  await fixture(t, `process.stdin.resume(); process.stdin.on('end', () => console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'error',errorMessage:'model unavailable',content:[{type:'text',text:'partial'}]}})));`);
  await assert.rejects(runPi({ input: [], probe: true, modelSettings: { model: "test/vision" } }), /model unavailable/);
});

test("user can cancel a ready Pi task and release its temporary resources", async t => {
  // Given a Pi stub that records its task directory and signals readiness.
  // When the user cancels after that readiness event.
  // Then the task rejects as cancelled and its temporary directory no longer exists.
  const { capture } = await fixture(t, `require('node:fs').writeFileSync(process.env.TEST_PI_CAPTURE, process.cwd()); console.log(JSON.stringify({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'ready'}})); setInterval(()=>{},1000);`);
  process.env.TEST_PI_CAPTURE = capture;
  t.after(() => { delete process.env.TEST_PI_CAPTURE; });
  const controller = new AbortController();
  let markReady, timer;
  const ready = new Promise((resolve, reject) => {
    markReady = resolve;
    timer = setTimeout(() => reject(new Error("Pi test child did not become ready within 15 seconds")), 15_000);
  });
  const result = runPi({ input: [], probe: true, modelSettings: { model: "test/vision" }, signal: controller.signal,
    onProgress: event => { if (event.stage === "Pi 正在整理提示词…") markReady(); } });
  result.catch(() => {});
  let dir;
  try {
    await Promise.race([ready, result.then(() => { throw new Error("Pi test child exited before cancellation"); })]);
    dir = await readFile(capture, "utf8");
  } finally {
    clearTimeout(timer);
    controller.abort();
    await assert.rejects(result, /取消/);
  }
  assert.ok(dir);
  await assert.rejects(access(dir), { code: "ENOENT" });
});

test("user sees only safe image-model metadata in the Pi catalog", async t => {
  // Given Pi catalog entries for image and text-only models, including a synthetic secret.
  // When the user loads the model catalog.
  // Then only the image model, qualified identifier and safe selection metadata are returned.
  await fixture(t, `let input=''; process.stdin.on('data', chunk=>{input+=chunk; let i; while((i=input.indexOf('\\n'))>=0){const q=JSON.parse(input.slice(0,i));input=input.slice(i+1);console.log(JSON.stringify({type:'response',id:q.id,success:true,data:q.id==='models'?{models:[{provider:'test',id:'vision',name:'Vision',input:['text','image'],reasoning:true,apiKey:'must-not-leak'},{provider:'test',id:'text',input:['text']}]}:{model:{provider:'test',id:'vision'}}}));}});`);
  const catalog = await readPiCatalog();
  assert.deepEqual(catalog.models.map(model => model.model), ["test/vision"]);
  assert.equal(catalog.models[0].isDefault, true);
  assert.ok(catalog.accountKey);
  assert.ok(!JSON.stringify(catalog).includes("must-not-leak"));
});

test("user cannot accept output from a different Pi model", async t => {
  // Given a Pi stub returning success from a model other than the selected one.
  // When the user probes the selected model.
  // Then the adapter rejects the model mismatch.
  await fixture(t, `process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({type:'message_end',message:{role:'assistant',provider:'test',model:'other',stopReason:'stop',content:[{type:'text',text:'OK'}]}})));`);
  await assert.rejects(runPi({ input: [], probe: true, modelSettings: { model: "test/vision" } }), /模型.*不一致/);
});

test("user must reverify a changed Pi context before a task starts", async t => {
  // Given a saved account fingerprint that no longer matches the current context.
  // When the user attempts a connection probe.
  // Then the adapter reports a context change before starting inference.
  await fixture(t, `process.exit(93)`);
  await assert.rejects(runPi({ input: [], probe: true, modelSettings: { model: "test/vision", accountKey: "stale" } }), error => error.modelContextChanged === true);
});

async function extensionFixture(t, blockImages = false) {
  const dir = await mkdtemp(join(tmpdir(), "reframe-pi-tools-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await copyFile(new URL("../bridge/pi-extension.mjs", import.meta.url), join(dir, "extension.mjs"));
  await symlink(fileURLToPath(new URL("../bridge/inspection.mjs", import.meta.url)), join(dir, "inspection.mjs"));
  const sdk = join(dir, "node_modules", "@earendil-works", "pi-coding-agent");
  await mkdir(sdk, { recursive: true });
  await writeFile(join(sdk, "package.json"), '{"type":"module","exports":"./index.js"}');
  await writeFile(join(sdk, "index.js"), `export const SettingsManager = { create: () => ({getBlockImages:()=>${blockImages}}) };`);
  const image = join(dir, "image.png");
  await sharp({ create: { width: 4, height: 3, channels: 3, background: "red" } }).png().toFile(image);
  const manifest = join(dir, "task.json");
  await writeFile(manifest, JSON.stringify({ images: [image], references: { "references/workflow.md": "snapshot instructions" } }));
  return { dir, manifest };
}

test("user can inspect task images while Pi references remain restricted", async t => {
  // Given one synthetic image and an explicit snapshot of allowed skill references.
  // When the registered Pi tools inspect pixels, read references or receive invalid inputs.
  // Then the tools return actual pixels and allowed text, rejecting other paths, image numbers and cancellation.
  const { dir, manifest } = await extensionFixture(t);
  const previous = process.env.REFRAME_PI_MANIFEST;
  process.env.REFRAME_PI_MANIFEST = manifest;
  t.after(() => { if (previous === undefined) delete process.env.REFRAME_PI_MANIFEST; else process.env.REFRAME_PI_MANIFEST = previous; });
  const tools = new Map();
  const { default: register } = await import(pathToFileURL(join(dir, "extension.mjs")));
  await register({ registerTool: tool => tools.set(tool.name, tool) });
  assert.deepEqual([...tools.keys()], ["alchemy_inspect_image", "alchemy_read_reference"]);
  const result = await tools.get("alchemy_inspect_image").execute("1", { image: 1, bbox: { x: 1, y: 0, width: 2, height: 2 }, scale: 2 });
  assert.equal(result.content[1].type, "image");
  const pixels = await sharp(Buffer.from(result.content[1].data, "base64")).metadata();
  assert.equal(pixels.width, 4); assert.equal(pixels.height, 4);
  await assert.rejects(tools.get("alchemy_inspect_image").execute("2", { image: 2 }), /编号/);
  const read = tools.get("alchemy_read_reference");
  assert.equal((await read.execute("3", { path: "references/workflow.md" })).content[0].text, "snapshot instructions");
  for (const path of ["../../auth.json", "/etc/passwd", "__proto__", "references/missing.md"])
    await assert.rejects(read.execute("4", { path }), /仅允许/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(read.execute("5", { path: "references/workflow.md" }, controller.signal));
});

test("user receives a Pi image-blocking error before tools become ready", async t => {
  // Given Pi settings with blockImages enabled.
  // When the trusted extension starts in a synthetic subprocess.
  // Then it exits with the blocking error and emits no readiness signal.
  const { dir, manifest } = await extensionFixture(t, true);
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `import register from ${JSON.stringify(pathToFileURL(join(dir, "extension.mjs")).href)}; await register({registerTool(){throw new Error('must not register')}});`],
    { env: { ...process.env, REFRAME_PI_MANIFEST: manifest }, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /blockImages/);
  assert.doesNotMatch(result.stdout, /reframe_tools_ready/);
});

test("user receives a missing Pi CLI error without agent fallback", async t => {
  // Given a configured Pi binary path that does not exist.
  // When the user probes the selected model.
  // Then the adapter reports the missing CLI.
  const { dir } = await fixture(t, "");
  process.env.PI_BIN = join(dir, "missing-pi");
  await assert.rejects(runPi({ input: [], probe: true, modelSettings: { model: "test/vision" } }), /找不到 Pi CLI/);
});

test("user cannot accept oversized or truncated Pi output", async t => {
  // Given Pi responses with excessive final text or a length stop reason.
  // When the user probes the selected model.
  // Then the adapter rejects each incomplete or oversized result.
  for (const stopReason of ["stop", "length"]) {
    await fixture(t, `process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({type:'message_end',message:{role:'assistant',provider:'test',model:'vision',stopReason:${JSON.stringify(stopReason)},content:[{type:'text',text:'x'.repeat(1024*1024+1)}]}})));`);
    await assert.rejects(runPi({ input: [], probe: true, modelSettings: { model: "test/vision" } }), /大小限制|截断/);
  }
});


test("user must reverify Pi when authentication rotates during verification", async t => {
  // Given a selected model and the fingerprint of synthetic authentication data.
  // When verification succeeds with unchanged data or rotates that data while responding.
  // Then unchanged context succeeds and rotated context requires refresh and reverification.
  const { dir } = await fixture(t, `
const fs = require('node:fs');
let input='';
if (process.argv.includes('rpc')) {
  process.stdin.on('data', chunk=>{input+=chunk;let i;while((i=input.indexOf('\\n'))>=0){const q=JSON.parse(input.slice(0,i));input=input.slice(i+1);console.log(JSON.stringify({type:'response',id:q.id,success:true,data:q.id==='models'?{models:[{provider:'test',id:'vision',input:['image']}]}:{model:{provider:'test',id:'vision'}}}));}});
} else {
  process.stdin.on('data', chunk=>input+=chunk);
  process.stdin.on('end', ()=>{
    if (input==='rotate') fs.writeFileSync(require('node:path').join(process.env.PI_CODING_AGENT_DIR,'auth.json'), '{"synthetic":"rotated credential fixture"}');
    console.log(JSON.stringify({type:'message_end',message:{role:'assistant',provider:'test',model:'vision',stopReason:'stop',content:[{type:'text',text:'OK'}]}}));
  });
}`);
  const config = join(dir, "config");
  await mkdir(config);
  await writeFile(join(config, "auth.json"), '{"synthetic":"initial fixture"}');
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = config;
  t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; });
  const { accountKey } = await readPiCatalog();
  const modelSettings = { model: "test/vision", accountKey };
  assert.equal((await runPi({ input: [{ type: "text", text: "unchanged" }], probe: true, modelSettings })).text, "OK");
  await assert.rejects(runPi({ input: [{ type: "text", text: "rotate" }], probe: true, modelSettings }),
    error => error.modelContextChanged === true && error.recovery === "models" && /已更新.*刷新.*验证/.test(error.message));
});
