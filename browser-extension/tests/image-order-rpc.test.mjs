import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { runAgent } from "../bridge/agent.mjs";
import { runGeneration } from "../bridge/generation.mjs";
import { readModelCatalog } from "../bridge/models.mjs";

test("real agent and generation entries pass custom order through RPC and inspection", async t => {
  const dir = await mkdtemp(join(tmpdir(), "reframe-order-rpc-"));
  const executable = join(dir, "codex"), log = join(dir, "calls.jsonl"), skillPath = join(dir, "SKILL.md");
  const previous = process.env.CODEX_BIN;
  t.after(async () => {
    if (previous === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = previous;
    await rm(dir, { recursive: true, force: true });
  });
  const imagePath = join(dir, "reference.png"), subjectImagePath = join(dir, "subject.png"), secondSubjectPath = join(dir, "second.png");
  for (const [path, background] of [[imagePath, "blue"], [subjectImagePath, "red"], [secondSubjectPath, "green"]])
    await sharp({ create: { width: 1, height: 1, channels: 3, background } }).png().toFile(path);
  const imageBytes = await readFile(imagePath);
  await writeFile(skillPath, "---\nname: alchemy\n---\nTest");
  await writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const send = message => process.stdout.write(JSON.stringify(message) + '\\n');
const done = () => {
  send({method:'item/completed',params:{threadId:'test',item:{type:'imageGeneration',status:'completed',result:${JSON.stringify(imageBytes.toString("base64"))}}}});
  send({method:'item/completed',params:{threadId:'test',item:{type:'agentMessage',text:JSON.stringify({title:'test',observations:[],promptZh:'猫',promptEn:'cat',negativePrompt:'',uncertainties:[]})}}});
  send({method:'turn/completed',params:{threadId:'test',turn:{status:'completed'}}});
};
let start;
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const message = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(log)}, line + '\\n');
  if (message.id === undefined) return;
  if (!message.method) { done(); return; }
  let result = {};
  if (message.method === 'account/read') result={account:{type:'chatgpt',email:'order@example.com',planType:'test'},requiresOpenaiAuth:true};
  if (message.method === 'config/read') result={config:{model_provider:'openai'}};
  if (message.method === 'model/list') result={data:[{model:'vision',defaultReasoningEffort:'low',isDefault:true}],nextCursor:null};
  if (message.method === 'modelProvider/capabilities/read') result={imageGeneration:true};
  if (message.method === 'thread/start') { start=message.params; result={thread:{id:'test'},model:start.model,modelProvider:start.modelProvider}; }
  send({id:message.id,result});
  if (message.method === 'turn/start') {
    if (start.dynamicTools?.length) send({id:'inspect-first',method:'item/tool/call',params:{threadId:'test',turnId:'t',callId:'inspect-first',tool:'alchemy_inspect_image',arguments:{image:1}}});
    else done();
  }
});
`, { mode: 0o700 });
  process.env.CODEX_BIN = executable;
  const catalog = await readModelCatalog(dir);
  const modelSettings = { ...catalog.models[0], accountKey: catalog.accountKey, provider: catalog.provider };
  const common = { imagePath, skillPath, cwd: dir, modelSettings, instruction: "按图号融合", prompt: "确认的提示词", negativePrompt: "" };
  const cases = [
    { mode: "reenact", subjectImagePath, referenceIndex: 0, paths: [imagePath, subjectImagePath], firstPixel: [0, 0, 255] },
    { mode: "style", subjectImagePath, referenceIndex: 1, paths: [subjectImagePath, imagePath], firstPixel: [255, 0, 0] },
    { mode: "multi-reenact", subjectImagePaths: [subjectImagePath, secondSubjectPath], subjects: [{ id: "person", role: "人物", detail: "身份" }, { id: "bag", role: "物品", detail: "手持" }], referenceIndex: 1,
      paths: [subjectImagePath, imagePath, secondSubjectPath], firstPixel: [255, 0, 0] },
  ];
  for (const options of cases) {
    await writeFile(log, "");
    assert.equal((await runAgent({ ...common, ...options })).promptEn, "cat");
    assert.deepEqual((await runGeneration({ ...common, ...options })).bytes, imageBytes);
    const messages = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const turns = messages.filter(message => message.method === "turn/start");
    assert.equal(turns.length, 2);
    for (const turn of turns) assert.deepEqual(turn.params.input.filter(item => item.type === "localImage").map(item => item.path), options.paths);
    const inspected = messages.find(message => message.id === "inspect-first" && message.result).result.contentItems.find(item => item.type === "inputImage");
    const pixels = await sharp(Buffer.from(inspected.imageUrl.split(",")[1], "base64")).raw().toBuffer();
    assert.deepEqual([...pixels.subarray(0, 3)], options.firstPixel);
  }
});
