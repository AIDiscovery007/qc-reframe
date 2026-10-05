import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, symlink, link, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { clearSessionIndexFiles } from "../bridge/session-index-files.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "reframe-index-clear-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "index"); await mkdir(directory);
  return { root, directory };
}
test("clear removes only the fixed SQLite files, preserving source sessions and snapshots", async t => {
  const { directory } = await fixture(t);
  for (const name of ["sessions.sqlite", "sessions.sqlite-journal", "sessions.sqlite-wal", "sessions.sqlite-shm", "rollout.jsonl", "snapshot.json", "sessions.sqlite.backup"]) await writeFile(join(directory, name), name);
  clearSessionIndexFiles(directory);
  assert.deepEqual((await readdir(directory)).sort(), ["rollout.jsonl", "sessions.sqlite.backup", "snapshot.json"]);
  clearSessionIndexFiles(directory);
  clearSessionIndexFiles(join(directory, "missing"));
});
for (const kind of ["directory symlink", "file symlink", "hardlink", "directory sidecar"]) {
  test(`clear refuses ${kind} without removing any file`, async t => {
    const { root, directory } = await fixture(t);
    const source = join(root, "source.jsonl"); await writeFile(source, "source stays intact");
    await writeFile(join(directory, "sessions.sqlite"), "corrupt database");
    const sidecar = join(directory, "sessions.sqlite-wal");
    let target = directory;
    if (kind === "directory symlink") { target = join(root, "alias"); await symlink(directory, target); }
    if (kind === "file symlink") await symlink(source, sidecar);
    if (kind === "hardlink") await link(source, sidecar);
    if (kind === "directory sidecar") await mkdir(sidecar);
    assert.throws(() => clearSessionIndexFiles(target), { status: 503 });
    assert.equal(await readFile(source, "utf8"), "source stays intact");
    assert.equal(await readFile(join(directory, "sessions.sqlite"), "utf8"), "corrupt database");
  });
}
