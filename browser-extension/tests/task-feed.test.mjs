import test from "node:test";
import assert from "node:assert/strict";
import { createTaskFeed } from "../bridge/task-feed.mjs";

test("automatic flow feed waits for the image stage and exposes preparation failures", () => {
  const feed = createTaskFeed(), job = { id: "job", projectId: "project", mode: "recreate", status: "running", createdAt: "2026-10-08", autoGeneration: { status: "pending", language: "en" } };
  const jobs = new Map([[job.id, job]]), projects = { isHidden: () => false };
  const snapshot = () => feed.snapshot(jobs, projects);
  feed.update(job);
  const initial = snapshot();
  assert.equal(initial.tasks[0].status, "running");
  assert.equal(initial.tasks[0].autoGeneration, true);
  job.status = "completed";
  feed.update(job);
  assert.deepEqual(snapshot(), initial, "a saved prompt is not a completed image workflow");
  job.autoGeneration.status = "failed";
  feed.update(job);
  assert.equal(snapshot().tasks[0].status, "failed");
  assert.notEqual(snapshot().revision, initial.revision);
  job.autoGeneration = { status: "started", language: "en", generationId: "generation" };
  job.generations = [{ id: "generation", status: "running", createdAt: "2026-10-08" }];
  feed.update(job);
  assert.equal(snapshot().tasks.length, 1);
  assert.equal(snapshot().tasks[0].generationId, "generation");
  assert.equal(snapshot().tasks[0].autoGeneration, undefined);
  assert.equal(snapshot().tasks[0].status, "running");
  job.generations[0].status = "completed";
  feed.update(job);
  assert.equal(snapshot().tasks[0].status, "completed");
  feed.close();
});

test("cancelled pending flows never appear completed even when their prompt was saved", () => {
  const feed = createTaskFeed(), job = { id: "job", projectId: "project", status: "completed", autoGeneration: { status: "cancelled" } };
  feed.update(job);
  const tasks = feed.snapshot(new Map([[job.id, job]]), { isHidden: () => false }).tasks;
  assert.equal(tasks[0].status, "cancelled");
  assert.equal(tasks[0].autoGeneration, true);
  feed.close();
});
