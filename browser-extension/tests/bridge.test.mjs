import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { createBridge, decodeImage } from "../bridge/server.mjs";
import { agentInput, parseResult } from "../bridge/agent.mjs";
import { generationInput } from "../bridge/generation.mjs";
import sharp from "sharp";

const image =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=";
const result = {
  title: "测试",
  observations: ["观察"],
  promptZh: "[SUBJECT]，柔和的色块",
  promptEn: "[SUBJECT], soft blocks of color",
  negativePrompt: "",
  uncertainties: [],
};
async function setup(t, agent = async () => result, generator) {
  const dir = await mkdtemp(join(tmpdir(), "alchemy-test-"));
  const skillPath = join(dir, "SKILL.md");
  await writeFile(join(dir, "model-settings.json"), JSON.stringify({ model: "test-model", accountKey: "test" }));
  await writeFile(skillPath, "---\nname: alchemy\n---\nTest skill");
  const app = await createBridge({ dataDir: dir, skillPath, agent, generator, generationContext: async () => ({ model: 'test-model', provider: 'fixture', reasoningEffort: 'low', codexGeneration: true }), generationSkillPath: skillPath });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const url = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  return {
    ...app,
    dir,
    url,
    request: (path, options = {}) =>
      fetch(url + path, {
        ...options,
        headers: {
          Authorization: `Bearer ${app.token}`,
          "Content-Type": "application/json",
          ...options.headers,
        },
      }),
  };
}

async function waitGeneration(request, id, status) {
  for (let i = 0; i < 100; i++) {
    const job = await (await request(`/jobs/${id}`)).json();
    if (job.generations?.at(-1)?.status === status && !(await (await request("/health")).json()).active) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Generation did not reach ${status}`);
}

test("imagegen receives exact prompt, exclusions, explicit skill and ordered real images", () => {
  const args = { imagePath: "/reference.png", subjectImagePath: "/subject.png", prompt: "保留图 1 的睁眼表情", negativePrompt: "不改变双手姿态", skillPath: "/imagegen/SKILL.md" };
  const input = generationInput(args);
  assert.deepEqual(input.filter((x) => x.type === "localImage").map((x) => x.path), [args.subjectImagePath, args.imagePath]);
  assert.deepEqual(input.at(-1), { type: "skill", name: "imagegen", path: args.skillPath });
  assert.ok(input[0].text.includes(JSON.stringify({ prompt: args.prompt, negativePrompt: args.negativePrompt })));
  const textOnly = generationInput({ ...args, prompt: "一只猫，柔和的色块", imagePath: undefined, subjectImagePath: undefined });
  assert.deepEqual(textOnly.map((item) => item.type), ["text", "skill"]);
  assert.match(textOnly[0].text, /纯文生图/);
  assert.ok(textOnly[0].text.includes(JSON.stringify({ prompt: "一只猫，柔和的色块", negativePrompt: args.negativePrompt })));
  assert.throws(() => generationInput({ ...args, prompt: "Draw [SUBJECT]" }), /补充主体/);
});

test("custom reference positions keep attachment numbers and subject responsibilities aligned", () => {
  const subjects = [{ id: "person", role: "人物", detail: "发型" }, { id: "bag", role: "物品", detail: "手持" }];
  const args = { name: "alchemy", skillPath: "/skill.md", imagePath: "/template.png", subjectImagePaths: ["/person.png", "/bag.png"], subjects,
    instruction: "按图号融合", mode: "multi-reenact", prompt: "已确认的提示词", negativePrompt: "" };
  for (const referenceIndex of [0, 1, 2]) {
    const expected = [...args.subjectImagePaths];
    expected.splice(referenceIndex, 0, args.imagePath);
    for (const input of [agentInput({ ...args, referenceIndex }), generationInput({ ...args, referenceIndex })]) {
      assert.deepEqual(input.filter(item => item.type === "localImage").map(item => item.path), expected);
      assert.match(input[0].text, new RegExp(`图 ${referenceIndex + 1} 为参考模板`));
      for (const [index, subject] of subjects.entries())
        assert.ok(input.some(item => item.text?.includes(JSON.stringify({ image: expected.indexOf(args.subjectImagePaths[index]) + 1, ...subject }))));
    }
  }
  for (const mode of ["style", "reenact"]) for (const referenceIndex of [0, 1]) {
    const paired = { ...args, mode, subjects: undefined, subjectImagePaths: undefined, subjectImagePath: "/person.png", referenceIndex };
    const expected = referenceIndex ? ["/person.png", "/template.png"] : ["/template.png", "/person.png"];
    for (const input of [agentInput(paired), generationInput(paired)]) {
      assert.deepEqual(input.filter(item => item.type === "localImage").map(item => item.path), expected);
      assert.match(input[0].text, new RegExp(`图 ${referenceIndex + 1} (?:为风格参考模板|是风格参考图|是参考模板)`));
    }
  }
});

test("new jobs default to reference first and generation cannot override their snapshot order", async t => {
  const calls = [];
  const { request } = await setup(t, async () => ({ ...result, promptZh: "图 1 模板，图 2 主体" }), async args => {
    calls.push(args);
    return decodeImage(image);
  });
  for (const mode of ["reenact", "multi-reenact"]) for (const referenceIndex of [undefined, 1]) {
    const reenact = mode === "reenact" ? { subjectImage: image, basePrompt: "融合" }
      : { subjects: [{ id: "person", role: "人物", detail: "身份", subjectImage: image }, { id: "bag", role: "物品", detail: "手持", subjectImage: image }], basePrompt: "融合" };
    const created = await (await request("/jobs", submit({ mode, referenceIndex, reenact }))).json();
    const job = await waitFor(request, created.id, "completed");
    assert.equal(job.referenceIndex, referenceIndex ?? 0);
    assert.equal((await (await request(`/jobs/${job.id}/reference`)).json()).referenceIndex, referenceIndex ?? 0);
    const path = `/jobs/${job.id}/generations`;
    assert.equal((await request(path, { method: "POST", body: JSON.stringify({ language: "zh", referenceIndex: referenceIndex ? 0 : 1 }) })).status, 400);
    assert.equal((await request(path, { method: "POST", body: JSON.stringify({ language: "zh" }) })).status, 202);
    const generated = await waitGeneration(request, job.id, "completed");
    assert.equal(generated.generations[0].referenceIndex, referenceIndex ?? 0);
    assert.equal(calls.at(-1).referenceIndex, referenceIndex ?? 0);
    assert.equal((await (await request(`${path}/${generated.generations[0].id}/reference`)).json()).referenceIndex, referenceIndex ?? 0);
  }
  for (const referenceIndex of [-1, 2, 0.5, "0", null])
    assert.equal((await request("/jobs", submit({ mode: "reenact", referenceIndex, reenact: { subjectImage: image, basePrompt: "融合" } }))).status, 400);
});

for (const mode of ["style", "reenact", "recreate"]) test(`${mode} generates from saved inputs and preserves prompt and previous images`, async (t) => {
  const paired = mode !== "recreate";
  const finalResult = { ...result, promptZh: "中文生成提示词", promptEn: "English generation prompt", negativePrompt: "排除项" };
  const calls = [];
  const { request, dir, url } = await setup(t, async () => finalResult, async (args) => {
    calls.push(args);
    return { bytes: decodeImage(image).bytes, extension: "png", revisedPrompt: "actual image prompt" };
  });
  const created = await (await request("/jobs", submit({ mode, ...(paired ? { reenact: { subjectImage: image, basePrompt: "保留主体" } } : {}) }))).json();
  await waitFor(request, created.id, "completed");
  const path = `/jobs/${created.id}/generations`;
  assert.equal((await request(path, { method: "POST", body: JSON.stringify({ language: "other" }) })).status, 400);
  const generate = (language) => request(path, { method: "POST", body: JSON.stringify({ language, imagePath: "/ignored-user-path" }) });
  assert.equal((await generate("en")).status, 202);
  const first = await waitGeneration(request, created.id, "completed");
  assert.equal(calls[0].prompt, finalResult.promptEn);
  assert.equal(calls[0].negativePrompt, finalResult.negativePrompt);
  if (paired) assert.deepEqual(await readFile(calls[0].imagePath), decodeImage(image).bytes);
  else assert.equal(calls[0].imagePath, undefined, "recreate must send text only");
  assert.equal(!!calls[0].subjectImagePath, paired);
  if (paired) assert.deepEqual(await readFile(calls[0].subjectImagePath), decodeImage(image).bytes);
  const generated = first.generations[0];
  assert.equal(generated.aspectRatio, undefined);
  assert.equal(generated.prompt, finalResult.promptEn);
  assert.equal((await (await request(`${path}/${generated.id}/reference`)).json()).image, image);
  const imagePath = `${path}/${generated.id}/image`;
  assert.equal((await fetch(url + imagePath)).status, 401);
  assert.equal((await request(imagePath, { headers: { Origin: "https://example.com" } })).status, 403);
  const firstAsset = await (await request(imagePath)).json();
  assert.equal(firstAsset.image, image);
  assert.deepEqual([firstAsset.width, firstAsset.height], [1, 1]);
  assert.equal(firstAsset.path, join(dir, "images", generated.imageAsset));
  assert.deepEqual(await readFile(firstAsset.path), decodeImage(image).bytes);
  assert.equal((await generate("zh")).status, 202);
  const second = await waitGeneration(request, created.id, "completed");
  assert.equal(calls[1].prompt, finalResult.promptZh);
  assert.deepEqual(second.result, finalResult);
  assert.equal(second.generations.length, 2);
  assert.deepEqual(second.generations[0], first.generations[0]);
  assert.deepEqual(await (await request(imagePath)).json(), firstAsset, "older versions retain their own image and path");
  const secondAsset = await (await request(`${path}/${second.generations[1].id}/image`)).json();
  assert.equal(secondAsset.path, firstAsset.path, "identical results share one file while retaining separate generation records");
  assert.deepEqual(await readFile(secondAsset.path), decodeImage(image).bytes);
  assert.equal(JSON.parse(await readFile(join(dir, "records", `${created.id}.json`))).generations.length, 2);
  await rm(join(dir, "images", generated.imageAsset));
  assert.equal((await request(imagePath)).status, 404);
  assert.equal((await generate("zh")).status, paired ? 404 : 202);
  if (!paired) {
    await waitGeneration(request, created.id, "completed");
    assert.equal(calls[2].imagePath, undefined, "text-to-image works without the saved reference");
    assert.equal(calls[2].subjectImagePath, undefined);
    assert.deepEqual(generationInput(calls[2]).map((item) => item.type), ["text", "skill"]);
  }
  assert.equal(calls.length, paired ? 2 : 3);
});

test("generation ratios validate before execution and become immutable bilingual prompt snapshots", async (t) => {
  const finalResult = { ...result, promptZh: "方形画幅，一只猫", promptEn: "Square frame, a cat", negativePrompt: "模糊" };
  const calls = [];
  const bytes = await sharp({ create: { width: 120, height: 80, channels: 3, background: "red" } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const { request, dir } = await setup(t, async () => finalResult, async (args) => {
    calls.push(args);
    return { bytes, extension: "jpeg" };
  });
  const created = await (await request("/jobs", submit({ mode: "recreate" }))).json();
  await waitFor(request, created.id, "completed");
  const path = `/jobs/${created.id}/generations`;
  const generate = (aspectRatio, language = "zh") => request(path, { method: "POST", body: JSON.stringify({ language, aspectRatio }) });
  for (const ratio of [null, "16:9", [], {}, { width: 16 }, { width: "16", height: 9 }, { width: 0, height: 9 },
    { width: 1.5, height: 1 }, { width: 10001, height: 1000 }, { width: 1, height: 21 }, { width: 21, height: 1 },
    { width: 16, height: 9, prompt: "override" }]) {
    assert.equal((await generate(ratio)).status, 400, JSON.stringify(ratio));
  }
  assert.equal(calls.length, 0);
  for (const [index, [aspectRatio, language]] of [[{ width: 16, height: 9 }, "zh"], [{ width: 10000, height: 1000 }, "en"], [{ width: 1, height: 20 }, "zh"], [{ width: 20, height: 1 }, "en"]].entries()) {
    assert.equal((await generate(aspectRatio, language)).status, 202);
    const job = await waitGeneration(request, created.id, "completed");
    const generated = job.generations.at(-1);
    assert.deepEqual(generated.aspectRatio, aspectRatio);
    assert.equal(generated.prompt, calls[index].prompt);
    assert.ok(generated.prompt.startsWith(language === "zh" ? finalResult.promptZh : finalResult.promptEn));
    assert.ok(generated.prompt.includes(`${aspectRatio.width}:${aspectRatio.height}`));
    assert.match(generated.prompt, language === "zh" ? /优先于原提示词及参考图/ : /priority over.*original prompt and reference images/);
    assert.equal(calls[index].aspectRatio, undefined, "ratio is a prompt instruction, not an API parameter");
    assert.equal(calls[index].negativePrompt, finalResult.negativePrompt);
    assert.deepEqual(job.result, finalResult, "analysis prompt remains unchanged");
    const asset = await (await request(`${path}/${generated.id}/image`)).json();
    assert.deepEqual([asset.width, asset.height], [80, 120], "report actual oriented output dimensions even when ratio is not followed");
  }
  const saved = JSON.parse(await readFile(join(dir, "records", `${created.id}.json`)));
  assert.deepEqual(saved.generations[0].aspectRatio, { width: 16, height: 9 });
  assert.equal(saved.generations[0].prompt, calls[0].prompt);
});

test("generation rejects generic prompts, prevents duplicates and preserves cancelled jobs", async (t) => {
  let finish;
  const { request } = await setup(t, async () => ({ ...result, promptZh: "实际主体" }), () => new Promise((resolve) => { finish = resolve; }));
  const generic = await (await request("/jobs", submit())).json();
  await waitFor(request, generic.id, "completed");
  assert.equal((await request(`/jobs/${generic.id}/generations`, { method: "POST", body: '{"language":"zh"}' })).status, 400);
  const created = await (await request("/jobs", submit({ mode: "recreate" }))).json();
  await waitFor(request, created.id, "completed");
  const path = `/jobs/${created.id}/generations`;
  const body = { method: "POST", body: '{"language":"zh"}' };
  const responses = await Promise.all([request(path, body), request(path, body)]);
  assert.deepEqual(responses.map((x) => x.status).sort(), [202, 409]);
  assert.equal((await request("/jobs", submit())).status, 202, "analysis can run during generation");
  const job = await (await request(`/jobs/${created.id}`)).json();
  const generated = job.generations[0];
  assert.equal((await request(`${path}/${generated.id}/image`)).status, 409);
  const cancelled = await (await request(`${path}/${generated.id}/cancel`, { method: "POST" })).json();
  assert.equal(cancelled.generations[0].status, "cancelled");
  finish({ bytes: decodeImage(image).bytes, extension: "png" });
  const after = await waitGeneration(request, created.id, "cancelled");
  assert.equal(after.status, "completed");
  assert.equal(after.generations[0].extension, undefined);
});

test("generation failures preserve analysis and never invent an image", async (t) => {
  const { request } = await setup(t, async () => ({ ...result, promptZh: "确定的主体" }), async () => { throw new Error("当前 Codex 不支持内置生图"); });
  const created = await (await request("/jobs", submit({ mode: "recreate" }))).json();
  await waitFor(request, created.id, "completed");
  await request(`/jobs/${created.id}/generations`, { method: "POST", body: '{"language":"zh"}' });
  const failed = await waitGeneration(request, created.id, "failed");
  assert.equal(failed.status, "completed");
  assert.match(failed.generations[0].error, /不支持内置生图/);
  assert.equal(failed.generations[0].extension, undefined);
});
const submit = (extra) => ({
  method: "POST",
  body: JSON.stringify({ image, mode: "style", ...extra }),
});
async function waitFor(request, id, status) {
  for (let i = 0; i < 80; i++) {
    const job = await (await request(`/jobs/${id}`)).json();
    if (job.status === status && job.autoGeneration?.status !== "pending" && !(await (await request("/health")).json()).active) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Task did not reach ${status}`);
}

test("rejects unauthenticated, web-origin and DNS-rebinding requests", async (t) => {
  const { url, request } = await setup(t);
  assert.equal((await fetch(url + "/health")).status, 401);
  assert.equal(
    (await request("/health", { headers: { Origin: "https://pinterest.com" } }))
      .status,
    403,
  );
  const rebound = await new Promise((resolve) => {
    httpRequest(
      url + "/health",
      { headers: { Host: "attacker.example" } },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    ).end();
  });
  assert.equal(rebound, 403);
  const health = await request("/health", {
    headers: { Origin: "chrome-extension://" + "a".repeat(32) },
  });
  assert.equal(health.status, 200);
  assert.equal((await health.json()).skill, "alchemy");
});

test("validates image bytes and request shape before invoking agent", async (t) => {
  let calls = 0;
  const { request } = await setup(t, async () => {
    calls++;
    return result;
  });
  for (const body of [
    null,
    [],
    { image, mode: "bad" },
    { image: "data:image/png;base64,aGVsbG8=", mode: "style" },
  ]) {
    assert.equal(
      (await request("/jobs", { method: "POST", body: JSON.stringify(body) }))
        .status,
      400,
    );
  }
  assert.equal(calls, 0);
  assert.throws(() => decodeImage("data:image/svg+xml;base64,PHN2Zz4="));
});

test("sends actual image bytes to agent, persists result, strips URL query", async (t) => {
  let input;
  const { request, dir } = await setup(t, async (args) => {
    input = args;
    args.onProgress({ threadId: "test-thread" });
    return result;
  });
  const response = await request(
    "/jobs",
    submit({ sourceUrl: "https://example.com/pin/123?secret=value#fragment" }),
  );
  assert.equal(response.status, 202);
  const created = await response.json();
  const completed = await waitFor(request, created.id, "completed");
  assert.deepEqual(completed.result, result);
  assert.equal(completed.sourceUrl, "https://example.com/pin/123");
  assert.equal(completed.threadId, "test-thread");
  assert.equal(input.mode, "style");
  assert.deepEqual(await readFile(input.imagePath), decodeImage(image).bytes);
  // Persist finishes immediately after the in-memory transition.
  for (let i = 0; i < 80; i++) {
    try {
      if (
        JSON.parse(await readFile(join(dir, "records", `${created.id}.json`))).status ===
        "completed"
      )
        return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Result was not persisted");
});

test("parallel analyses keep progress, cancellation, failures and persisted results independent", async (t) => {
  const calls = [];
  const { request, dir } = await setup(t, (args) => new Promise((resolve, reject) => {
    calls.push({ ...args, resolve, reject });
    args.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
  }));
  const responses = await Promise.all([
    request("/jobs", submit()),
    request("/jobs", submit({ mode: "recreate" })),
    request("/jobs", submit({ image: "data:image/jpeg;base64,/9j/2Q==" })),
  ]);
  assert.ok(responses.every((response) => response.status === 202));
  const jobs = await Promise.all(responses.map((response) => response.json()));
  const inputs = jobs.map((job) => calls.find((call) => call.mode === job.mode && call.imagePath === join(dir, "images", job.imageAsset)));
  assert.equal((await (await request("/health")).json()).active, 3);
  inputs.forEach((input, index) => input.onProgress({ stage: `progress-${index}`, threadId: `thread-${index}` }));
  for (const [index, job] of jobs.entries()) {
    assert.equal((await (await request(`/jobs/${job.id}`)).json()).stage, `progress-${index}`);
    assert.equal(inputs[index].modelSettings.model, "test-model");
  }
  assert.equal((await request("/models/verify", { method: "POST", body: '{"model":"other"}' })).status, 409);
  assert.equal((await request("/projects/delete", { method: "POST", body: JSON.stringify({ ids: [jobs[0].projectId] }) })).status, 409);
  const cancelled = await (await request(`/jobs/${jobs[0].id}/cancel`, { method: "POST" })).json();
  assert.equal(cancelled.status, "cancelled");
  assert.equal(inputs[0].signal.aborted, true);
  assert.equal(inputs[1].signal.aborted, false);
  assert.equal(inputs[2].signal.aborted, false);
  inputs[2].reject(new Error("one task failed"));
  inputs[1].resolve({ ...result, title: "independent result" });
  for (const [index, status] of ["cancelled", "completed", "failed"].entries()) {
    const job = await waitFor(request, jobs[index].id, status);
    assert.deepEqual(JSON.parse(await readFile(join(dir, "records", `${job.id}.json`))), job);
  }
  assert.equal((await (await request(`/jobs/${jobs[1].id}`)).json()).result.title, "independent result");
  assert.equal((await (await request(`/jobs/${jobs[2].id}`)).json()).error, "one task failed");
});

test("generations from different prompt versions overlap analysis and cancel independently", async (t) => {
  const generations = new Map();
  let finishAnalysis;
  let holdAnalysis = false;
  const { request, dir } = await setup(t,
    () => holdAnalysis ? new Promise((resolve) => { finishAnalysis = resolve; }) : Promise.resolve({ ...result, promptZh: "实际主体", promptEn: "Actual subject" }),
    (args) => new Promise((resolve) => { generations.set(args.prompt, { ...args, resolve }); }),
  );
  const first = await (await request("/jobs", submit({ mode: "recreate" }))).json();
  const second = await (await request("/jobs", submit({ mode: "recreate" }))).json();
  await waitFor(request, second.id, "completed");
  holdAnalysis = true;
  const analysis = await (await request("/jobs", submit())).json();
  const responses = await Promise.all([first, second].map((job, index) => request(`/jobs/${job.id}/generations`, { method: "POST", body: JSON.stringify({ language: index ? "zh" : "en" }) })));
  assert.ok(responses.every((response) => response.status === 202));
  const jobs = await Promise.all(responses.map((response) => response.json()));
  assert.equal((await (await request("/health")).json()).active, 3);
  const cancelPath = `/jobs/${first.id}/generations/${jobs[0].generations[0].id}/cancel`;
  await request(cancelPath, { method: "POST" });
  const firstCall = generations.get("Actual subject");
  const secondCall = generations.get("实际主体");
  assert.equal(firstCall.signal.aborted, true);
  assert.equal(secondCall.signal.aborted, false);
  assert.equal((await (await request(`/jobs/${analysis.id}`)).json()).status, "running");
  secondCall.onProgress({ stage: "second generation" });
  assert.equal((await (await request(`/jobs/${second.id}`)).json()).generations[0].stage, "second generation");
  firstCall.resolve(decodeImage(image));
  secondCall.resolve(decodeImage(image));
  finishAnalysis(result);
  const cancelled = await waitGeneration(request, first.id, "cancelled");
  const completed = await waitGeneration(request, second.id, "completed");
  await waitFor(request, analysis.id, "completed");
  assert.equal(cancelled.generations[0].extension, undefined);
  for (const job of [cancelled, completed]) assert.deepEqual(JSON.parse(await readFile(join(dir, "records", `${job.id}.json`))), job);
  const asset = await (await request(`/jobs/${second.id}/generations/${completed.generations[0].id}/image`)).json();
  assert.equal(asset.image, image);
});

test("history restores the exact image for a new mode and preserves both results", async (t) => {
  const inputs = [];
  const { request, dir, url } = await setup(t, async ({ imagePath, mode }) => {
    inputs.push({ bytes: await readFile(imagePath), mode });
    return { ...result, title: mode };
  });
  const first = await (await request("/jobs", submit({ capture: "screenshot", sourceUrl: "https://example.com/art" }))).json();
  await waitFor(request, first.id, "completed");
  const path = `/jobs/${first.id}/reference`;
  assert.equal((await fetch(url + path)).status, 401);
  assert.equal((await request(path, { headers: { Origin: "https://example.com" } })).status, 403);
  const reference = await (await request(path)).json();
  assert.equal(reference.image, image);
  assert.equal(reference.capture, "screenshot");
  const second = await (await request("/jobs", submit({ ...reference, mode: "recreate" }))).json();
  await waitFor(request, second.id, "completed");
  assert.notEqual(first.id, second.id);
  assert.deepEqual(inputs.map(x => x.mode), ["style", "recreate"]);
  assert.deepEqual(inputs[0].bytes, inputs[1].bytes);
  const history = await (await request("/jobs")).json();
  assert.equal(history.length, 2);
  assert.equal(history.find(x => x.id === first.id).result.title, "style");
  assert.equal(history.find(x => x.id === second.id).result.title, "recreate");
  await rm(join(dir, "images", first.imageAsset));
  const missing = await request(path);
  assert.equal(missing.status, 404);
  assert.match((await missing.json()).error, /原图已不存在/);
  assert.equal((await request(`/jobs/${first.id}`)).status, 200);
});

test("reports agent failure without inventing a result", async (t) => {
  const { request } = await setup(t, async () => {
    throw new Error("Please log in to Codex");
  });
  const created = await (await request("/jobs", submit())).json();
  const failed = await waitFor(request, created.id, "failed");
  assert.match(failed.error, /log in/);
  assert.equal(failed.result, undefined);
});

for (const mode of ["style", "reenact"]) test(`${mode} validates supplied subject inputs and template/prompt pairing before calling Codex`, async (t) => {
  let calls = 0;
  const { request } = await setup(t, async () => { calls++; return result; });
  const source = await (await request("/jobs", submit())).json();
  await waitFor(request, source.id, "completed");
  const reenact = { subjectImage: image, basePrompt: result.promptZh, promptSourceJobId: source.id };
  for (const input of [
    ...(mode === "reenact" ? [undefined] : [null]), {}, { basePrompt: "test" }, { subjectImage: image, basePrompt: " " },
    { ...reenact, subjectImage: "data:image/png;base64,aGVsbG8=" },
    { ...reenact, basePrompt: "x".repeat(20001) },
    { ...reenact, promptSourceJobId: "../../token" },
  ]) {
    assert.equal((await request("/jobs", submit({ mode, reenact: input }))).status, 400);
  }
  const otherImage = "data:image/jpeg;base64,/9j/2Q==";
  const mismatch = await request("/jobs", submit({ image: otherImage, mode, reenact }));
  assert.equal(mismatch.status, 400);
  assert.match((await mismatch.json()).error, /来源不一致/);
  assert.equal(calls, 1);
});

for (const mode of ["style", "reenact"]) test(`${mode} sends two distinct images and edited instructions, restores history, and keeps old output`, async (t) => {
  const inputs = [];
  const { request, dir } = await setup(t, async (args) => {
    inputs.push({ mode: args.mode, template: await readFile(args.imagePath), subject: args.subjectImagePath && await readFile(args.subjectImagePath), prompt: args.basePrompt });
    return result;
  });
  const source = await (await request("/jobs", submit())).json();
  await waitFor(request, source.id, "completed");
  const subjectImage = "data:image/jpeg;base64,/9j/2Q==";
  const reenact = { subjectImage, basePrompt: "Edited [SUBJECT] prompt", promptSourceJobId: source.id };
  const response = await request("/jobs", submit({ mode, reenact }));
  assert.equal(response.status, 202);
  const job = await response.json();
  await waitFor(request, job.id, "completed");
  assert.equal(inputs[1].mode, mode);
  assert.deepEqual(inputs[1].template, decodeImage(image).bytes);
  assert.deepEqual(inputs[1].subject, decodeImage(subjectImage).bytes);
  assert.equal(inputs[1].prompt, reenact.basePrompt);
  const restored = await (await request(`/jobs/${job.id}/reference`)).json();
  assert.equal(restored.image, image);
  assert.deepEqual(restored.reenact, reenact);
  const history = await (await request("/jobs")).json();
  assert.equal(history.length, 2);
  assert.deepEqual(history.find(x => x.id === source.id).result, result);
  assert.equal(history.find(x => x.id === job.id).reenact.subjectImage, undefined, "history metadata must not include full images");
  assert.equal(JSON.parse(await readFile(join(dir, "records", `${job.id}.json`))).reenact.basePrompt, reenact.basePrompt);
  const retry = await (await request("/jobs", submit({ ...restored, mode }))).json();
  await waitFor(request, retry.id, "completed");
  assert.deepEqual(inputs[2], inputs[1]);
  await rm(join(dir, "images", job.subjectAsset));
  const missing = await (await request(`/jobs/${job.id}/reference`)).json();
  assert.equal(missing.image, image, "a missing subject must not hide the template or result");
  assert.match(missing.subjectError, /主体图已不存在/);
  assert.equal(missing.reenact.subjectImage, "");
  const generic = await (await request("/jobs", submit())).json();
  await waitFor(request, generic.id, "completed");
  assert.equal(inputs[3].subject, undefined);
  assert.equal(generic.reenact, undefined);
});

test("reenact accepts default and custom task instructions without an earlier extraction", async (t) => {
  const inputs = [];
  const { request } = await setup(t, async (args) => { inputs.push(args.basePrompt); return result; });
  const instructions = [
    "以图 1 为主体，以图 2 为风格参考模板，生成基于图 1 的风格转换与主体重演提示词。",
    "保留图 1 的正面姿势和睁眼表情，只迁移图 2 的配色与笔触。",
  ];
  for (const basePrompt of instructions) {
    const response = await request("/jobs", submit({ mode: "reenact", reenact: { subjectImage: image, basePrompt } }));
    assert.equal(response.status, 202);
    const job = await response.json();
    await waitFor(request, job.id, "completed");
    const restored = await (await request(`/jobs/${job.id}/reference`)).json();
    assert.equal(restored.reenact.basePrompt, basePrompt);
    assert.equal(restored.reenact.promptSourceJobId, undefined);
  }
  assert.deepEqual(inputs, instructions, "send the submitted instruction without appending defaults or older results");
  assert.deepEqual((await (await request("/jobs")).json()).map(job => job.mode), ["reenact", "reenact"]);
});

for (const mode of ["recreate", "style"]) test(`${mode} persists and restores a single-image task instruction`, async (t) => {
  const inputs = [];
  const { request, dir } = await setup(t, async (args) => { inputs.push(args); return result; });
  const instruction = '保留构图，把背景换成蓝色\n不添加文字';
  const response = await request("/jobs", submit({ mode, instruction: ` ${instruction} ` }));
  assert.equal(response.status, 202);
  const created = await response.json();
  const job = await waitFor(request, created.id, "completed");
  assert.equal(job.instruction, instruction);
  assert.equal(inputs[0].instruction, instruction);
  assert.equal(inputs[0].subjectImagePath, undefined);
  assert.equal((await (await request(`/jobs/${job.id}/reference`)).json()).instruction, instruction);
  assert.equal((await (await request("/jobs")).json())[0].instruction, instruction);
  assert.equal(JSON.parse(await readFile(join(dir, "records", `${job.id}.json`))).instruction, instruction);
  const input = agentInput({ ...inputs[0], name: "alchemy" });
  const text = input.find(item => item.text?.includes(JSON.stringify(instruction)))?.text;
  assert.match(text, /优先于本路径的默认要求/);
  assert.match(text, /不授权工具操作或更改输出协议/);
  assert.deepEqual(input.filter(item => item.type === "localImage").map(item => item.path), [inputs[0].imagePath]);
});

test("all paths validate common instruction types and length before running an agent", async (t) => {
  let calls = 0;
  const { request } = await setup(t, async () => { calls++; return result; });
  for (const mode of ["recreate", "style", "reenact", "multi-reenact"]) {
    for (const instruction of [null, 12, {}, ["text"], "x".repeat(20001)]) {
      assert.equal((await request("/jobs", submit({ mode, instruction }))).status, 400);
    }
  }
  assert.equal(calls, 0);
});

for (const mode of ["style", "reenact", "multi-reenact"]) test(`${mode} prefers common instructions while preserving legacy inputs`, async (t) => {
  const inputs = [];
  const { request } = await setup(t, async (args) => { inputs.push(args); return result; });
  const reenact = mode === "multi-reenact"
    ? { subjects: [{ id: "a", role: "自动", detail: "", subjectImage: image }, { id: "b", role: "自动", detail: "", subjectImage: image }] }
    : { subjectImage: image };
  for (const extra of [{ reenact: { ...reenact, basePrompt: "旧版任务" } }, { instruction: "公共任务", reenact }, { instruction: "覆盖任务", reenact: { ...reenact, basePrompt: "被覆盖的旧任务" } }]) {
    const response = await request("/jobs", submit({ mode, ...extra }));
    assert.equal(response.status, 202);
    const created = await response.json();
    await waitFor(request, created.id, "completed");
    const expected = extra.instruction ?? extra.reenact.basePrompt;
    const restored = await (await request(`/jobs/${created.id}/reference`)).json();
    assert.equal(restored.instruction, expected);
    assert.equal(restored.reenact.basePrompt, expected);
    const input = agentInput({ ...inputs.at(-1), name: "alchemy" });
    assert.ok(input.some(item => item.text?.includes(JSON.stringify(expected))));
    assert.equal(input.filter(item => item.type === "localImage").length, mode === "multi-reenact" ? 3 : 2);
  }
  assert.deepEqual(inputs.map(input => input.instruction), ["旧版任务", "公共任务", "覆盖任务"]);
});

test("generic style keeps legacy paired instructions but explicitly identifies the only attached template", () => {
  const instruction = '保留图 1 的姿势，只迁移图 2 的配色与笔触';
  const input = agentInput({ name: "alchemy", skillPath: "/skill/SKILL.md", mode: "style", imagePath: "/template.png", instruction });
  assert.deepEqual(input.filter(item => item.type === "localImage").map(item => item.path), ["/template.png"]);
  assert.ok(input.some(item => item.text?.includes(JSON.stringify(instruction))));
  assert.match(input[0].text, /本次仅有参考模板的实际输入/);
  assert.match(input[0].text, /主体图没有提供/);
  assert.match(input[0].text, /依赖缺失主体的要求列入 uncertainties/);
  assert.match(input[0].text, /\[SUBJECT\]/);
});

test("Codex receives subject first, template second, and the submitted user task instruction", () => {
  const args = { name: "alchemy", skillPath: "/skill/SKILL.md", imagePath: "/template.png", subjectImagePath: "/subject.png", basePrompt: '保留图 1 的姿势\n只迁移图 2 的"笔触"' };
  const input = agentInput({ ...args, mode: "reenact" });
  assert.deepEqual(input.filter(x => x.type === "localImage").map(x => x.path), ["/subject.png", "/template.png"]);
  assert.ok(input.find(x => x.type === "skill" && x.name === "alchemy"));
  assert.ok(input.find(x => x.type === "text" && x.text.includes(JSON.stringify(args.basePrompt))));
  for (const mode of ["style", "recreate"]) {
    const single = agentInput({ ...args, mode, subjectImagePath: undefined });
    assert.deepEqual(single.filter(x => x.type === "localImage").map(x => x.path), ["/template.png"]);
    assert.ok(!single.some(x => x.text?.includes(args.basePrompt)));
  }
  const transfer = agentInput({ ...args, mode: "style" });
  assert.deepEqual(transfer.filter(x => x.type === "localImage").map(x => x.path), ["/subject.png", "/template.png"]);
  assert.ok(transfer.some(x => x.text?.includes(JSON.stringify(args.basePrompt))));
  assert.match(transfer[0].text, /保留结构，仅迁移风格/);
  assert.match(transfer[0].text, /默认由图 1 提供主体身份、内容、姿态/);
  assert.throws(() => agentInput({ ...args, mode: "style", basePrompt: " " }), /缺少/);
  assert.deepEqual(agentInput({ ...args, mode: "recreate" }).filter(x => x.type === "localImage").map(x => x.path), ["/template.png"]);
  assert.throws(() => agentInput({ ...args, mode: "reenact", subjectImagePath: undefined }), /缺少/);
});

test("multi-reenact keeps ordered roles, immutable generation inputs and latest restoration", async (t) => {
  const otherImage = "data:image/jpeg;base64,/9j/2Q==";
  const thirdImage = "data:image/png;base64," + Buffer.concat([decodeImage(image).bytes, Buffer.from("third")]).toString("base64");
  const subjects = [{ id: "person", subjectImage: image, role: "人物", detail: "保留发型" }, { id: "bag", subjectImage: otherImage, role: "物品", detail: "手持" }];
  const inverseCalls = [], generationCalls = [];
  const { request, dir } = await setup(t, async (args) => {
    inverseCalls.push(args);
    return { ...result, promptZh: "图 1 人物手持图 2 物品", promptEn: "Person in image 1 holding item from image 2" };
  }, async (args) => {
    generationCalls.push(args);
    return { bytes: decodeImage(image).bytes, extension: "png" };
  });
  const response = await request("/jobs", submit({ mode: "multi-reenact", reenact: { subjects, basePrompt: "沿用模板构图" } }));
  assert.equal(response.status, 202);
  const job = await waitFor(request, (await response.json()).id, "completed");
  const args = inverseCalls[0];
  const input = agentInput({ ...args, name: "alchemy" });
  assert.deepEqual(input.filter((item) => item.type === "localImage").map((item) => item.path), [args.imagePath, ...args.subjectImagePaths]);
  assert.deepEqual(await Promise.all(args.subjectImagePaths.map((path) => readFile(path))), subjects.map((subject) => decodeImage(subject.subjectImage).bytes));
  assert.match(input[0].text, /图 1 为参考模板/);
  assert.ok(input.some((item) => item.text?.includes('"role":"人物"')));
  assert.ok(input.some((item) => item.text?.includes('"detail":"手持"')));
  assert.equal(job.reenact.subjects[0].subjectImage, undefined);
  assert.equal((await (await request(`/projects/${job.projectId}`)).json()).modes["multi-reenact"].status, "completed");
  assert.deepEqual((await (await request(`/jobs/${job.id}/reference`)).json()).reenact, { subjects, basePrompt: "沿用模板构图" });

  const replacement = [{ ...subjects[0], subjectImage: thirdImage }, { ...subjects[1], role: "细节" }];
  const generate = (inputs) => request(`/jobs/${job.id}/generations`, { method: "POST", body: JSON.stringify({ language: "zh", subjects: inputs }) });
  assert.equal((await generate([...subjects].reverse())).status, 400, "changed subject numbering requires a new prompt");
  assert.equal((await generate(replacement)).status, 202);
  const first = await waitGeneration(request, job.id, "completed");
  const snapshot = first.generations[0];
  assert.deepEqual(first.reenact, job.reenact);
  assert.deepEqual(snapshot.subjects.map(({ id }) => id), ["person", "bag"]);
  const generationArgs = generationCalls[0];
  const generation = generationInput(generationArgs);
  assert.deepEqual(generation.filter((item) => item.type === "localImage").map((item) => item.path), [generationArgs.imagePath, ...generationArgs.subjectImagePaths]);
  assert.deepEqual(await readFile(generationArgs.subjectImagePaths[0]), decodeImage(thirdImage).bytes);
  assert.match(generation[0].text, /图 1 为参考模板/);
  assert.deepEqual((await (await request(`/jobs/${job.id}/generations/${snapshot.id}/reference`)).json()), { image, subjects: replacement, referenceIndex: 0 });
  assert.deepEqual((await (await request(`/jobs/${job.id}/reference`)).json()).reenact.subjects, replacement);
  assert.equal((await generate(subjects)).status, 202);
  const second = await waitGeneration(request, job.id, "completed");
  assert.deepEqual(second.generations[0], snapshot);
  assert.deepEqual((await (await request(`/jobs/${job.id}/generations/${snapshot.id}/reference`)).json()).subjects, replacement);
  const saved = JSON.parse(await readFile(join(dir, "records", `${job.id}.json`)));
  assert.deepEqual(saved.generations[0].subjects, snapshot.subjects);
  assert.ok(!JSON.stringify(saved).includes("data:image/"));
  await rm(join(dir, "images", snapshot.subjects[0].subjectAsset));
  assert.equal((await request(`/jobs/${job.id}/generations/${snapshot.id}/reference`)).status, 404, "missing snapshot never falls back to a newer upload");
});

test("multi-reenact validates counts, roles, IDs and size before calling agents", async (t) => {
  let calls = 0;
  const { request } = await setup(t, async () => { calls++; return result; });
  const subjects = [{ id: "one", subjectImage: image, role: "自动", detail: "" }, { id: "two", subjectImage: image, role: "服饰", detail: "" }];
  const invalid = [undefined, null, [], subjects.slice(0, 1), [...subjects, ...subjects, ...subjects, subjects[0]],
    [subjects[0], subjects[0]], [subjects[0], { ...subjects[1], id: "../bad" }],
    [subjects[0], { ...subjects[1], role: "unknown" }], [subjects[0], { ...subjects[1], detail: "x".repeat(2001) }],
    [subjects[0], { ...subjects[1], subjectImage: "not-an-image" }],
    [subjects[0], { ...subjects[1], subjectImage: "data:image/png;base64," + Buffer.concat([decodeImage(image).bytes, Buffer.alloc(2 * 1024 * 1024)]).toString("base64") }]];
  for (const inputs of invalid) assert.equal((await request("/jobs", submit({ mode: "multi-reenact", reenact: { subjects: inputs, basePrompt: "融合" } }))).status, 400);
  for (const basePrompt of [undefined, " ", "x".repeat(20001)]) assert.equal((await request("/jobs", submit({ mode: "multi-reenact", reenact: { subjects, basePrompt } }))).status, 400);
  const oversizedTemplate = "data:image/png;base64," + Buffer.concat([decodeImage(image).bytes, Buffer.alloc(4 * 1024 * 1024)]).toString("base64");
  assert.equal((await request("/jobs", submit({ image: oversizedTemplate, mode: "multi-reenact", reenact: { subjects, basePrompt: "融合" } }))).status, 400);
  assert.equal(calls, 0);
  const six = ["自动", "人物", "物品", "服饰", "场景", "细节"].map((role, index) => ({ ...subjects[0], id: String(index), role }));
  const accepted = await request("/jobs", submit({ mode: "multi-reenact", reenact: { subjects: six, basePrompt: "融合" } }));
  assert.equal(accepted.status, 202);
  await waitFor(request, (await accepted.json()).id, "completed");
  assert.equal(calls, 1);
});

test("rejects malformed model output instead of reporting success", () => {
  assert.deepEqual(parseResult(JSON.stringify(result)), result);
  assert.throws(() => parseResult(JSON.stringify({ ...result, promptZh: "" })));
  assert.throws(() =>
    parseResult(JSON.stringify({ ...result, observations: [3] })),
  );
  assert.throws(() => parseResult("not JSON"));
});

test("restart preserves completed output and marks interrupted jobs as failed", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "alchemy-restart-"));
  const id = "00000000-0000-0000-0000-000000000001";
  await writeFile(
    join(dir, `${id}.json`),
    JSON.stringify({ id, status: "running", createdAt: "2026-01-01" }),
  );
  const doneId = "00000000-0000-0000-0000-000000000002";
  await writeFile(
    join(dir, `${doneId}.json`),
    JSON.stringify({
      id: doneId,
      status: "completed",
      createdAt: "2026-01-02",
      result,
      generations: [
        { id: "old", status: "completed", extension: "png" },
        { id: "interrupted", status: "running" },
      ],
    }),
  );
  await writeFile(join(dir, `${doneId}.png`), decodeImage(image).bytes);
  const { server, token } = await createBridge({ dataDir: dir });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const jobs = await (
    await fetch(`http://127.0.0.1:${server.address().port}/jobs`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json();
  assert.deepEqual(jobs.find((x) => x.id === doneId).result, result);
  assert.equal(jobs.find((x) => x.id === doneId).generations[0].status, "completed");
  assert.equal(jobs.find((x) => x.id === doneId).generations[1].status, "failed");
  assert.equal(jobs.find((x) => x.id === id).status, "failed");
  assert.match(jobs.find((x) => x.id === id).error, /重启/);
  const reference = await (await fetch(`http://127.0.0.1:${server.address().port}/jobs/${doneId}/reference`, {
    headers: { Authorization: `Bearer ${token}` },
  })).json();
  assert.equal(reference.image, image);
});

test("task history includes old active reverse/generation tasks beyond the 30 recent completed records", async (t) => {
  let finishReverse, finishGeneration, calls = 0;
  const concrete = { ...result, promptZh: "一只猫", promptEn: "A cat" };
  const waitReverse = async (request, id) => {
    for (let i = 0; i < 100; i++) {
      if ((await (await request(`/jobs/${id}`)).json()).status === "completed") return;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail("reverse did not complete");
  };
  const { request } = await setup(t, () => ++calls === 1 ? new Promise(resolve => { finishReverse = resolve; }) : Promise.resolve(concrete),
    () => new Promise(resolve => { finishGeneration = resolve; }));
  const active = await (await request("/jobs", submit())).json();
  const older = await (await request("/jobs", submit({ mode: "recreate" }))).json();
  await waitReverse(request, older.id);
  await request(`/jobs/${older.id}/generations`, { method: "POST", body: JSON.stringify({ language: "zh" }) });
  assert.equal(typeof finishGeneration, "function");
  for (let i = 0; i < 31; i++) {
    const job = await (await request("/jobs", submit())).json();
    await waitReverse(request, job.id);
  }
  const history = await (await request("/jobs")).json();
  assert.equal(history.length, 32);
  assert.ok(history.some(job => job.id === active.id));
  assert.ok(history.some(job => job.id === older.id && job.generations[0].status === "running"));
  assert.equal((await request("/cli/update", { method: "POST", body: "{}" })).status, 409);
  finishReverse(concrete);
  finishGeneration(decodeImage(image));
  await waitGeneration(request, older.id, "completed");
  await request(`/jobs/${older.id}/generations`, { method: "POST", body: JSON.stringify({ language: "zh" }) });
  assert.equal((await (await request("/jobs")).json())[0].id, older.id, "new generation activity moves the old reverse record to the front");
  finishGeneration(decodeImage(image));
  await waitGeneration(request, older.id, "completed");
});

for (const mode of ["recreate", "style", "reenact", "multi-reenact"]) test(`${mode} chains reverse into generation without another client request and preserves retry snapshots`, async t => {
  const finalResult = { ...result, promptZh: "实际主体", promptEn: "Actual subject", negativePrompt: "no text" };
  const generationStarted = Promise.withResolvers(), calls = [];
  const { request, dir } = await setup(t, async () => finalResult, async args => {
    calls.push(args); generationStarted.resolve(); return decodeImage(image);
  });
  const subjects = ["person", "bag"].map(id => ({ id, role: "自动", detail: "保留", subjectImage: image }));
  const extra = mode === "recreate" ? {} : { instruction: "保留主体", reenact: mode === "multi-reenact" ? { subjects } : { subjectImage: image }, referenceIndex: 1 };
  const response = await request("/jobs", submit({ mode, ...extra, generation: { language: "en", aspectRatio: { width: 3, height: 4 } } }));
  assert.equal(response.status, 202);
  const submitted = await response.json();
  assert.equal(submitted.autoGeneration.status, "pending");
  // Only the initial POST is needed to enter the image model; no UI poll triggers it.
  await Promise.race([generationStarted.promise, new Promise((_, reject) => setTimeout(() => reject(new Error("automatic generation did not start")), 2000).unref())]);
  const completed = await waitGeneration(request, submitted.id, "completed");
  assert.equal(completed.status, "completed");
  assert.equal(completed.autoGeneration.status, "started");
  assert.equal(completed.autoGeneration.generationId, completed.generations[0].id);
  assert.match(calls[0].prompt, /^Actual subject/);
  assert.match(calls[0].prompt, /3:4/);
  assert.equal(calls[0].negativePrompt, "no text");
  assert.equal(calls[0].modelSettings.model, completed.model);
  assert.equal(calls[0].referenceIndex, mode === "recreate" ? 0 : 1);
  assert.equal(!!calls[0].imagePath, mode !== "recreate");
  if (mode === "multi-reenact") assert.deepEqual(calls[0].subjects.map(item => item.id), ["person", "bag"]);
  const first = structuredClone(completed.generations[0]);
  assert.equal((await request(`/jobs/${submitted.id}/generations`, { method: "POST", body: JSON.stringify({ language: "en", aspectRatio: { width: 3, height: 4 } }) })).status, 202);
  const retry = await waitGeneration(request, submitted.id, "completed");
  assert.equal(retry.generations.length, 2);
  assert.deepEqual(retry.generations[0], first);
  assert.equal(calls[1].prompt, calls[0].prompt);
  assert.deepEqual(JSON.parse(await readFile(join(dir, "records", `${submitted.id}.json`))), retry);
});

test("automatic generation validates options and generic style before invoking reverse", async t => {
  let calls = 0;
  const { request } = await setup(t, async () => { calls++; return result; });
  for (const generation of [null, [], true, {}, { language: "other" }, { language: "en", aspectRatio: { width: 0, height: 1 } }, { language: "zh", subjectImage: image }])
    assert.equal((await request("/jobs", submit({ mode: "recreate", generation }))).status, 400);
  assert.equal((await request("/jobs", submit({ generation: { language: "zh" } }))).status, 400);
  assert.equal(calls, 0);
  const plain = await (await request("/jobs", submit())).json();
  const completed = await waitFor(request, plain.id, "completed");
  assert.equal(completed.autoGeneration, undefined);
  assert.equal(completed.generations, undefined);
});

for (const cancelled of [false, true]) test(`automatic generation never starts after reverse ${cancelled ? "cancellation with late success" : "failure"}`, async t => {
  const reverse = Promise.withResolvers();
  let calls = 0;
  const { request } = await setup(t, () => reverse.promise, async () => { calls++; return decodeImage(image); });
  const submitted = await (await request("/jobs", submit({ mode: "recreate", generation: { language: "zh" } }))).json();
  if (cancelled) {
    const stopped = await (await request(`/jobs/${submitted.id}/cancel`, { method: "POST" })).json();
    assert.equal(stopped.autoGeneration.status, "cancelled");
    reverse.resolve({ ...result, promptZh: "complete" });
  } else reverse.reject(new Error("reverse failed"));
  const completed = await waitFor(request, submitted.id, cancelled ? "cancelled" : "failed");
  assert.equal(completed.autoGeneration.status, cancelled ? "cancelled" : "failed");
  assert.equal(completed.generations, undefined);
  assert.equal(calls, 0);
});

test("automatic preparation and image failures preserve the usable reverse result", async t => {
  const { request } = await setup(t, async () => result, async () => { throw new Error("image model failed"); });
  const submitted = await (await request("/jobs", submit({ mode: "recreate", generation: { language: "zh" } }))).json();
  const failed = await waitFor(request, submitted.id, "completed");
  assert.equal(failed.autoGeneration.status, "failed");
  assert.match(failed.autoGeneration.error, /缺少主体/);
  assert.deepEqual(failed.result, result);
  const edits = { promptZh: "实际主体", promptEn: "Actual subject", negativePrompt: "no text" };
  assert.equal((await request(`/jobs/${submitted.id}/prompt`, { method: "POST", body: JSON.stringify(edits) })).status, 200);
  assert.equal((await request(`/jobs/${submitted.id}/generations`, { method: "POST", body: '{"language":"zh"}' })).status, 202);
  const imageFailed = await waitGeneration(request, submitted.id, "failed");
  assert.equal(imageFailed.result.promptZh, edits.promptZh);
  assert.match(imageFailed.generations[0].error, /image model failed/);
});

test("the chain cancel endpoint cancels image generation after reverse completes", async t => {
  const generation = Promise.withResolvers(), entered = Promise.withResolvers();
  const { request } = await setup(t, async () => ({ ...result, promptZh: "实际主体" }), async () => { entered.resolve(); return generation.promise; });
  const submitted = await (await request("/jobs", submit({ mode: "recreate", generation: { language: "zh" } }))).json();
  await entered.promise;
  const stopped = await (await request(`/jobs/${submitted.id}/cancel`, { method: "POST" })).json();
  assert.equal(stopped.status, "completed");
  assert.equal(stopped.generations[0].status, "cancelled");
  generation.resolve(decodeImage(image));
  const completed = await waitGeneration(request, submitted.id, "cancelled");
  assert.equal(completed.generations[0].imageAsset, undefined);
  assert.equal(completed.result.promptZh, "实际主体");
});

for (const change of ["edit", "cancel", "disk failure"]) test(`automatic handoff handles ${change} while the reverse completion is being saved`, async t => {
  const { default: fs } = await import("node:fs");
  const { syncBuiltinESMExports } = await import("node:module");
  const reverse = Promise.withResolvers(), saving = Promise.withResolvers(), release = Promise.withResolvers(), calls = [];
  const finalResult = { ...result, promptZh: "original", negativePrompt: "original exclusion" };
  const { request, dir } = await setup(t, () => reverse.promise, async args => { calls.push(args); return decodeImage(image); });
  const submitted = await (await request("/jobs", submit({ mode: "recreate", generation: { language: "zh" } }))).json();
  const path = join(dir, "records", `${submitted.id}.json`), rename = fs.promises.rename;
  let intercepted = false;
  fs.promises.rename = async (source, target) => {
    if (target === path && !intercepted) {
      const snapshot = JSON.parse(await readFile(source, "utf8"));
      if (snapshot.status === "completed" && snapshot.autoGeneration?.status === "pending") {
        intercepted = true; saving.resolve(); await release.promise;
        if (change === "disk failure") throw new Error("disk failure");
      }
    }
    return rename(source, target);
  };
  syncBuiltinESMExports();
  try {
    reverse.resolve(finalResult); await saving.promise;
    assert.equal(calls.length, 0, "image generation must wait for successful prompt persistence");
    assert.equal((await request("/cli/update", { method: "POST", body: "{}" })).status, 409);
    assert.equal((await request("/models/verify", { method: "POST", body: '{"model":"other"}' })).status, 409);
    let mutation;
    if (change !== "disk failure") {
      mutation = request(`/jobs/${submitted.id}/${change === "edit" ? "prompt" : "cancel"}`, {
        method: "POST", body: JSON.stringify(change === "edit" ? { promptZh: "edited", promptEn: "edited", negativePrompt: "edited exclusion" } : {}),
      });
      let observed = false;
      for (let i = 0; i < 100; i++) {
        const job = await (await request(`/jobs/${submitted.id}`)).json();
        if (change === "edit" ? job.result.promptZh === "edited" : job.autoGeneration.status === "cancelled") { observed = true; break; }
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.equal(observed, true);
    }
    release.resolve();
    if (mutation) assert.equal((await mutation).status, 200);
    const job = await waitFor(request, submitted.id, change === "disk failure" ? "failed" : "completed");
    if (change === "edit") {
      assert.equal(job.result.promptZh, "edited");
      assert.equal(calls[0].prompt, "original");
      assert.equal(calls[0].negativePrompt, "original exclusion");
    } else {
      assert.equal(calls.length, 0);
      assert.equal(job.autoGeneration.status, change === "cancel" ? "cancelled" : "failed");
    }
  } finally {
    release.resolve(); fs.promises.rename = rename; syncBuiltinESMExports();
  }
});
