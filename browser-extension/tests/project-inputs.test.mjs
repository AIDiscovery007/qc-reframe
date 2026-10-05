import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createBridge, decodeImage } from "../bridge/server.mjs";
import { createProjectStore, projectIdFor } from "../bridge/projects.mjs";

import { createImageStore } from "../bridge/images.mjs";
import { mkdir } from "node:fs/promises";
const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=";
const otherImage = "data:image/jpeg;base64,/9j/2Q==";
const result = { title: "模板项目", observations: ["观察"], promptZh: "中文提示词", promptEn: "English prompt", negativePrompt: "排除项", uncertainties: [] };
const post = (body) => ({ method: "POST", body: JSON.stringify(body) });

async function setup(t, options = {}, prepare) {
  const dir = await mkdtemp(join(tmpdir(), "alchemy-projects-"));
  const skillPath = join(dir, "SKILL.md");
  await writeFile(join(dir, "model-settings.json"), JSON.stringify({ model: "test-model", accountKey: "test" }));
  await writeFile(skillPath, "---\nname: alchemy\n---\nTest skill");
  if (prepare) await prepare(dir);
  let app;
  async function start() {
    app = await createBridge({ dataDir: dir, skillPath, generationSkillPath: skillPath, agent: async () => result, generator: async () => ({ ...decodeImage(image) }), ...options });
    app.server.listen(0, "127.0.0.1");
    await once(app.server, "listening");
  }
  async function close() {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
  }
  await start();
  t.after(async () => { await close(); await rm(dir, { recursive: true, force: true }); });
  return {
    dir,
    restart: async () => { await close(); await start(); },
    request: (path, options = {}) => fetch(`http://127.0.0.1:${app.server.address().port}${path}`, { ...options, headers: { Authorization: `Bearer ${app.token}`, "Content-Type": "application/json", ...options.headers } }),
  };
}

async function settled(request, id) {
  for (let i = 0; i < 100; i++) {
    const job = await (await request(`/jobs/${id}`)).json();
    if (job.status !== "running" && !job.generations?.some((item) => item.status === "running") && !(await (await request("/health")).json()).active) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Job did not settle");
}


const variant = name => `data:image/png;base64,${Buffer.concat([decodeImage(image).bytes, Buffer.from(name)]).toString("base64")}`;

test("edited inputs keep project identity, historical snapshots and restart state", async t => {
  const { request, restart } = await setup(t);
  const project = await (await request("/projects", post({ image }))).json();
  const first = await (await request("/jobs", post({ projectId: project.id, image, mode: "recreate", inputRevision: 0 }))).json();
  await settled(request, first.id);
  const path = `/projects/${project.id}`, rotated = variant("rotated");
  const changed = await request(`${path}/input`, post({ expectedRevision: 1, image: rotated, mode: "recreate", instruction: "rotate" }));
  assert.equal(changed.status, 200);
  const selection = await changed.json();
  assert.equal(selection.projectId, project.id);
  assert.equal(selection.id, `${project.id}:2`);
  assert.equal(selection.inputRevision, 2);
  assert.equal(selection.image, rotated);
  assert.deepEqual(Object.values(selection.inputVersions), Array(4).fill("new"));
  assert.equal((await request("/jobs", post({ projectId: project.id, image: rotated, mode: "recreate", inputRevision: 0 }))).status, 409);
  assert.equal((await request("/jobs", post({ projectId: project.id, image, mode: "recreate", inputRevision: 2 }))).status, 400);
  const second = await (await request("/jobs", post({ projectId: project.id, image: rotated, mode: "recreate", inputRevision: 2 }))).json();
  await settled(request, second.id);
  const historical = await (await request("/jobs", post({ projectId: project.id, image, mode: "recreate", referenceJobId: first.id, inputRevision: 3 }))).json();
  await settled(request, historical.id);
  assert.equal((await (await request(`${path}/reference`)).json()).inputVersions.recreate, second.id);
  assert.equal((await (await request(`/jobs/${first.id}/reference`)).json()).image, image);
  assert.equal((await (await request(`/jobs/${second.id}/reference`)).json()).image, rotated);
  assert.equal((await (await request("/projects", post({ image }))).json()).id, project.id);
  assert.equal((await (await request(`${path}/reference`)).json()).image, rotated);
  await restart();
  assert.equal((await (await request("/projects")).json()).length, 1);
  assert.equal((await (await request(path)).json()).jobCount, 3);
  assert.equal((await (await request(`${path}/reference`)).json()).image, rotated);
  assert.equal((await (await request(`/jobs/${historical.id}`)).json()).projectId, project.id);
});

test("draft roles survive restart, and collection respects current inputs and shared images", async t => {
  const { request, restart, dir } = await setup(t);
  const rotated = variant("rotated"), subject = variant("subject");
  const project = await (await request("/projects", post({ image }))).json();
  const shared = await (await request("/projects", post({ image: rotated }))).json();
  const path = `/projects/${project.id}`;
  const subjects = [{ id: "person", role: "人物", detail: "保留", subjectImage: subject }];
  const updated = await request(`${path}/input`, post({ expectedRevision: 0, image: rotated, mode: "multi-reenact", instruction: "", subjects }));
  assert.equal(updated.status, 200);
  assert.deepEqual((await updated.json()).inputs["multi-reenact"].subjects, subjects);
  assert.equal((await (await request("/projects")).json()).length, 2);
  assert.equal((await readdir(join(dir, "images"))).length, 2, "unreferenced original is collected");
  await restart();
  assert.deepEqual((await (await request(`${path}/reference`)).json()).inputs["multi-reenact"].subjects, subjects);
  await request("/projects/delete", post({ ids: [shared.id] }));
  assert.equal((await (await request(`${path}/reference`)).json()).image, rotated);
  await request(`${path}/input`, post({ expectedRevision: 1, mode: "multi-reenact", instruction: "", subjects: [] }));
  assert.equal((await readdir(join(dir, "images"))).length, 1);
  const paired = await (await request(`${path}/input`, post({ expectedRevision: 2, mode: "reenact", instruction: "retain", subjectImage: subject }))).json();
  assert.equal(paired.inputs.reenact.subjectImage, subject);
  await restart();
  assert.equal((await (await request(`${path}/reference`)).json()).inputs.reenact.subjectImage, subject);
});

test("input updates validate complete requests and reject concurrent stale writes", async t => {
  const { request } = await setup(t);
  const project = await (await request("/projects", post({ image }))).json();
  const path = `/projects/${project.id}/input`;
  for (const extra of [{ expectedRevision: -1 }, { expectedRevision: "0" }, { mode: "invalid" }, { instruction: null }, { image: "invalid" }, { subjectImage: "invalid", mode: "reenact" }, { subjects: [null], mode: "multi-reenact" }])
    assert.equal((await request(path, post({ expectedRevision: 0, mode: "recreate", instruction: "", ...extra }))).status, 400);
  const responses = await Promise.all(["one", "two"].map(instruction => request(path, post({ expectedRevision: 0, mode: "recreate", instruction }))));
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  assert.equal((await (await request(`/projects/${project.id}/reference`)).json()).inputRevision, 1);
});

test("failed project input persistence does not alter the in-memory selection", async t => {
  const dir = await mkdtemp(join(tmpdir(), "qc-input-failure-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const images = await createImageStore(dir);
  const store = await createProjectStore({ dataDir: dir, jobs: new Map(), images });
  const project = await store.register(decodeImage(image));
  const file = join(dir, `project-${project.id}.json`);
  await rm(file);
  await mkdir(file);
  await assert.rejects(store.saveInput(project.id, { image: decodeImage(otherImage), mode: "recreate", input: { instruction: "new" } }));
  assert.equal((await store.reference(project.id)).image, image);
  assert.equal(store.summary(project.id).inputRevision, 0);
});

test("late task completion cannot restore replaced inputs or their selected version", async t => {
  let finish;
  const { request, restart } = await setup(t, { agent: () => new Promise(resolve => { finish = resolve; }) });
  const job = await (await request("/jobs", post({ image, mode: "recreate" }))).json();
  const path = `/projects/${job.projectId}`;
  const rotated = variant("while-running");
  assert.equal((await request(`${path}/input`, post({ expectedRevision: 1, image: rotated, mode: "recreate", instruction: "" }))).status, 200);
  finish(result);
  await settled(request, job.id);
  await restart();
  const selection = await (await request(`${path}/reference`)).json();
  assert.equal(selection.image, rotated);
  assert.equal(selection.inputVersions.recreate, "new");
  assert.equal((await (await request(`/jobs/${job.id}/reference`)).json()).image, image);
});

test("paired subject edits preserve prompt selection while changed instructions invalidate it", async t => {
  const { request } = await setup(t);
  const job = await (await request("/jobs", post({ image, mode: "reenact", instruction: "same", reenact: { subjectImage: otherImage } }))).json();
  await settled(request, job.id);
  const path = `/projects/${job.projectId}/input`;
  const saved = await (await request(path, post({ expectedRevision: 1, mode: "reenact", instruction: "same", subjectImage: variant("new subject") }))).json();
  assert.equal(saved.inputVersions.reenact, job.id);
  const edited = await (await request(path, post({ expectedRevision: 2, mode: "reenact", instruction: "different", subjectImage: otherImage }))).json();
  assert.equal(edited.inputVersions.reenact, "new");
  const foreign = await (await request("/jobs", post({ image: variant("foreign"), mode: "recreate" }))).json();
  await settled(request, foreign.id);
  assert.equal((await request("/jobs", post({ projectId: job.projectId, referenceJobId: foreign.id, inputRevision: 3, image: variant("foreign"), mode: "recreate" }))).status, 400);
});

test("new task submission commits its current instruction and subjects without reverting saved edits", async t => {
  const { request, restart } = await setup(t);
  const project = await (await request("/projects", post({ image }))).json();
  const path = `/projects/${project.id}`;
  await request(`${path}/input`, post({ expectedRevision: 0, mode: "reenact", instruction: "old", subjectImage: otherImage }));
  const job = await (await request("/jobs", post({ projectId: project.id, inputRevision: 1, image, mode: "reenact", instruction: "new", reenact: { subjectImage: variant("new") } }))).json();
  await settled(request, job.id);
  await restart();
  const selected = await (await request(`${path}/reference`)).json();
  assert.equal(selected.inputRevision, 2);
  assert.equal(selected.inputVersions.reenact, job.id);
  assert.deepEqual(selected.inputs.reenact, { instruction: "new", subjectImage: variant("new") });
  assert.equal((await request(`${path}/input`, post({ expectedRevision: 1, mode: "reenact", instruction: "stale", subjectImage: otherImage }))).status, 409);
  assert.equal((await (await request(`${path}/reference`)).json()).inputs.reenact.instruction, "new");
});

test("failure selecting a new task leaves a persisted failed task and no running controller", async t => {
  const { default: fs } = await import("node:fs");
  const { syncBuiltinESMExports } = await import("node:module");
  const { request, dir, restart } = await setup(t);
  const project = await (await request("/projects", post({ image }))).json();
  const rename = fs.promises.rename;
  let writes = 0;
  fs.promises.rename = async (source, target) => {
    if (target === join(dir, "records", `project-${project.id}.json`) && ++writes === 2)
      throw Object.assign(new Error("simulated input selection failure"), { code: "EIO" });
    return rename(source, target);
  };
  syncBuiltinESMExports();
  try {
    assert.equal((await request("/jobs", post({ projectId: project.id, image, mode: "recreate" }))).status, 500);
  } finally {
    fs.promises.rename = rename;
    syncBuiltinESMExports();
  }
  const jobs = await (await request("/jobs")).json();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, "failed");
  assert.equal((await (await request("/health")).json()).active, 0);
  assert.equal(JSON.parse(await readFile(join(dir, "records", `${jobs[0].id}.json`))).status, "failed");
  await restart();
  assert.equal((await (await request(`/jobs/${jobs[0].id}`)).json()).status, "failed");
});

test("missing draft subjects do not block project opening or independent input repair", async t => {
  const { request, dir } = await setup(t);
  const project = await (await request("/projects", post({ image }))).json();
  const path = `/projects/${project.id}`;
  await request(`${path}/input`, post({ expectedRevision: 0, mode: "reenact", instruction: "", subjectImage: otherImage }));
  const subjects = [{ id: "one", role: "人物", detail: "", subjectImage: variant("kept") }];
  await request(`${path}/input`, post({ expectedRevision: 1, mode: "multi-reenact", instruction: "", subjects }));
  const record = JSON.parse(await readFile(join(dir, "records", `project-${project.id}.json`)));
  await rm(join(dir, "images", record.inputs.reenact.subjectAsset));
  const opened = await request(`${path}/reference`);
  assert.equal(opened.status, 200);
  const selection = await opened.json();
  assert.equal(selection.image, image);
  assert.equal(selection.inputs.reenact.subjectImage, "");
  assert.match(selection.inputs.reenact.subjectError, /主体图/);
  assert.deepEqual(selection.inputs["multi-reenact"].subjects, subjects);
  const independent = await request(`${path}/input`, post({ expectedRevision: 2, image: variant("new reference"), mode: "recreate", instruction: "" }));
  assert.equal(independent.status, 200);
  assert.equal((await independent.json()).image, variant("new reference"));
  const repaired = await request(`${path}/input`, post({ expectedRevision: 3, mode: "reenact", instruction: "", subjectImage: otherImage }));
  assert.equal(repaired.status, 200);
  assert.equal((await repaired.json()).inputs.reenact.subjectImage, otherImage);
});

test("all input modes enforce the same four-megabyte reference limit", async t => {
  const { request } = await setup(t);
  const project = await (await request("/projects", post({ image }))).json();
  const oversized = `data:image/png;base64,${Buffer.concat([decodeImage(image).bytes, Buffer.alloc(4 * 1024 * 1024)]).toString("base64")}`;
  for (const mode of ["style", "recreate", "reenact", "multi-reenact"])
    assert.equal((await request(`/projects/${project.id}/input`, post({ expectedRevision: 0, image: oversized, mode, instruction: "" }))).status, 400);
  assert.equal((await (await request(`/projects/${project.id}/reference`)).json()).inputRevision, 0);
});

test("missing project metadata recovers its stable identity and latest surviving job image", async t => {
  const { request, dir, restart } = await setup(t);
  const first = await (await request("/jobs", post({ image, mode: "recreate" }))).json();
  await settled(request, first.id);
  const path = `/projects/${first.projectId}`;
  const rotated = variant("latest");
  await request(`${path}/input`, post({ expectedRevision: 1, image: rotated, mode: "recreate", instruction: "" }));
  const second = await (await request("/jobs", post({ projectId: first.projectId, image: rotated, mode: "recreate", inputRevision: 2 }))).json();
  await settled(request, second.id);
  const file = join(dir, "records", `project-${first.projectId}.json`);
  await rm(file);
  await restart();
  assert.equal((await (await request("/projects")).json()).length, 1);
  assert.equal((await (await request(path)).json()).jobCount, 2);
  assert.equal((await (await request(`${path}/reference`)).json()).image, rotated);
  assert.equal((await (await request(`/jobs/${second.id}`)).json()).projectId, first.projectId);
  await rm(file);
  for (const asset of [first.imageAsset, second.imageAsset]) await rm(join(dir, "images", asset));
  await restart();
  const projects = await (await request("/projects")).json();
  assert.equal(projects.length, 1);
  assert.equal(projects[0].id, first.projectId);
  assert.equal(projects[0].jobCount, 2);
});

test("editing a historical version with the same reference creates a new mode input without borrowing the latest prompt", async t => {
  const { request, dir, restart } = await setup(t);
  const create = async mode => {
    const job = await (await request("/jobs", post({ image, mode, instruction: "same", ...(mode === "reenact" ? { reenact: { subjectImage: otherImage } } : {}) }))).json();
    await settled(request, job.id);
    return job;
  };
  const first = await create("reenact"), latest = await create("reenact"), unrelated = await create("recreate");
  const path = `/projects/${first.projectId}`;
  const current = await (await request(`${path}/input`, post({ expectedRevision: 3, referenceJobId: latest.id, mode: "reenact", instruction: "same", subjectImage: variant("current edit") }))).json();
  assert.equal(current.inputVersions.reenact, latest.id);
  const historical = await (await request(`${path}/input`, post({ expectedRevision: 4, referenceJobId: first.id, mode: "reenact", instruction: "same", subjectImage: variant("historical edit") }))).json();
  assert.equal(historical.inputVersions.reenact, "new");
  assert.equal(historical.inputVersions.recreate, unrelated.id);
  assert.equal(historical.image, image);
  assert.equal((await request(`${path}/input`, post({ expectedRevision: 5, referenceJobId: "missing", mode: "reenact", instruction: "same" }))).status, 400);
  const recordPath = join(dir, "records", `project-${first.projectId}.json`);
  const record = JSON.parse(await readFile(recordPath));
  delete record.inputVersions;
  await writeFile(recordPath, JSON.stringify(record));
  await restart();
  const legacy = await (await request(`${path}/input`, post({ expectedRevision: 5, referenceJobId: first.id, mode: "reenact", instruction: "same", subjectImage: otherImage }))).json();
  assert.equal(legacy.inputVersions.reenact, "new");
});

for (const legacy of [false, true]) test(`historical submissions preserve current same-image inputs and selection (legacy=${legacy})`, async t => {
  const { request, dir, restart } = await setup(t);
  const create = async instruction => {
    const job = await (await request("/jobs", post({ image, mode: "reenact", instruction, reenact: { subjectImage: otherImage } }))).json();
    await settled(request, job.id);
    return job;
  };
  const first = await create("first"), latest = await create("latest");
  const path = `/projects/${first.projectId}`;
  await request(`${path}/input`, post({ expectedRevision: 2, mode: "reenact", instruction: "latest", subjectImage: variant("draft subject") }));
  if (legacy) {
    const recordPath = join(dir, "records", `project-${first.projectId}.json`);
    const record = JSON.parse(await readFile(recordPath));
    delete record.inputVersions;
    await writeFile(recordPath, JSON.stringify(record));
    await restart();
  }
  const created = await request("/jobs", post({ projectId: first.projectId, referenceJobId: first.id, inputRevision: 3, image, mode: "reenact", instruction: "historical revision", reenact: { subjectImage: image } }));
  assert.equal(created.status, 202);
  const job = await created.json();
  await settled(request, job.id);
  await restart();
  const selection = await (await request(`${path}/reference`)).json();
  assert.equal(selection.inputRevision, 3, "historical submission preserves the current input revision");
  assert.equal(selection.inputVersions.reenact, latest.id);
  assert.deepEqual(selection.inputs.reenact, { instruction: "latest", subjectImage: variant("draft subject") });
  assert.equal((await (await request(`/jobs/${job.id}/reference`)).json()).instruction, "historical revision");
  assert.equal((await (await request(path)).json()).jobCount, 3);
});

test("the first legacy paired-subject edit fixes its current version and survives reopening", async t => {
  const { request, dir, restart } = await setup(t);
  const job = await (await request("/jobs", post({ image, mode: "reenact", instruction: "same", reenact: { subjectImage: otherImage } }))).json();
  await settled(request, job.id);
  const file = join(dir, "records", `project-${job.projectId}.json`);
  const record = JSON.parse(await readFile(file));
  delete record.inputs;
  delete record.inputVersions;
  await writeFile(file, JSON.stringify(record));
  await restart();
  const edited = await (await request(`/projects/${job.projectId}/input`, post({ expectedRevision: 1, mode: "reenact", instruction: "same", subjectImage: variant("first edit") }))).json();
  assert.equal(edited.inputVersions.reenact, job.id);
  assert.equal(edited.inputs.reenact.subjectImage, variant("first edit"));
  await restart();
  const reopened = await (await request(`/projects/${job.projectId}/reference`)).json();
  assert.equal(reopened.inputVersions.reenact, job.id);
  assert.equal(reopened.inputs.reenact.subjectImage, variant("first edit"));
});

for (const emptyInput of [true, false]) test(`changing a legacy reference preserves other modes' current composition (saved empty=${emptyInput})`, async t => {
  const dir = await mkdtemp(join(tmpdir(), "qc-input-recovery-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const images = await createImageStore(dir);
  const imageAsset = await images.put(decodeImage(image));
  const initial = await images.put(decodeImage(otherImage));
  const latestSubject = await images.put(decodeImage(variant("latest generation subject")));
  const projectId = "a".repeat(64);
  const referenceJob = { id: "00000000-0000-0000-0000-000000000001", projectId, mode: "reenact", createdAt: "2026-01-01", imageAsset, subjectAsset: initial, instruction: "selected older prompt", generations: [{ subjectAsset: latestSubject }] };
  const newestJob = { ...referenceJob, id: "00000000-0000-0000-0000-000000000002", createdAt: "2026-01-02", instruction: "newer prompt", generations: [] };
  const oldSubjects = [{ id: "one", role: "人物", detail: "", subjectAsset: initial }, { id: "two", role: "物品", detail: "", subjectAsset: initial }];
  const latestSubjects = oldSubjects.map(subject => ({ ...subject, subjectAsset: latestSubject }));
  const multi = { id: "00000000-0000-0000-0000-000000000003", projectId, mode: "multi-reenact", createdAt: "2026-01-03", imageAsset, reenact: { basePrompt: "preserve roles", subjects: oldSubjects }, generations: [{ subjects: latestSubjects }] };
  const style = { ...referenceJob, id: "00000000-0000-0000-0000-000000000004", mode: "style", createdAt: "2026-01-04" };
  await writeFile(join(dir, `project-${projectId}.json`), JSON.stringify({ id: projectId, createdAt: "2026-01-01", updatedAt: "2026-01-04", extension: "png", imageAsset,
    inputVersions: { reenact: referenceJob.id, ...(!emptyInput ? { style: "new" } : {}) }, ...(emptyInput ? { inputs: { style: { instruction: "" } } } : {}) }));
  const store = await createProjectStore({ dataDir: dir, images, jobs: new Map([referenceJob, newestJob, multi, style].map(job => [job.id, job])) });
  await store.saveInput(projectId, { image: decodeImage(variant("rotated")), mode: "recreate", input: { instruction: "rotate" } });
  const selection = await store.reference(projectId);
  assert.equal(selection.inputs.reenact.instruction, "selected older prompt");
  assert.equal(selection.inputs.reenact.subjectImage, variant("latest generation subject"));
  assert.equal(selection.inputs["multi-reenact"].instruction, "preserve roles");
  assert.deepEqual(selection.inputs["multi-reenact"].subjects.map(subject => subject.subjectImage), Array(2).fill(variant("latest generation subject")));
  assert.deepEqual(selection.inputs.style, emptyInput ? { instruction: "" } : undefined);
  assert.deepEqual(Object.values(selection.inputVersions), Array(4).fill("new"));
});

test("post-commit collection failure does not turn a saved input into a failed request", async t => {
  const { default: fs } = await import("node:fs");
  const { syncBuiltinESMExports } = await import("node:module");
  const { request, dir } = await setup(t);
  const project = await (await request("/projects", post({ image }))).json();
  const remove = fs.promises.rm;
  const obsolete = join(dir, "images", project.imageAsset);
  fs.promises.rm = async (file, options) => {
    if (file === obsolete) throw Object.assign(new Error("simulated collection failure"), { code: "EIO" });
    return remove(file, options);
  };
  syncBuiltinESMExports();
  try {
    const response = await request(`/projects/${project.id}/input`, post({ expectedRevision: 0, image: variant("replacement"), mode: "recreate", instruction: "" }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).inputRevision, 1);
  } finally {
    fs.promises.rm = remove;
    syncBuiltinESMExports();
  }
  assert.equal((await (await request(`/projects/${project.id}/reference`)).json()).image, variant("replacement"));
  assert.equal((await readdir(join(dir, "images"))).length, 2);
  const job = await (await request("/jobs", post({ projectId: project.id, inputRevision: 1, image: variant("replacement"), mode: "recreate" }))).json();
  await settled(request, job.id);
  await request("/projects", post({ image: variant("replacement") }));
  assert.equal((await readdir(join(dir, "images"))).length, 1, "pending collection retries when the next task settles");
});
