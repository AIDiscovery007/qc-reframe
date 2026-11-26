import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { splitStartLocation, startCommand } from "../lib/start-command.ts";
import { allowsOperation, operationFor } from "../lib/operation-policy.ts";

// An installation folder whose name needs shell quoting, with a start script that reports where and on what data it runs.
async function installation(t) {
  const parent = await mkdtemp(join(tmpdir(), "reframe start "));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const dir = join(parent, "it's QC-Reframe");
  await mkdir(dir);
  await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: {
    start: "node -e \"console.log(JSON.stringify([process.cwd(), process.env.ALCHEMY_DATA_DIR ?? null]))\"",
  } }));
  // The user pastes the command into a fresh shell without ALCHEMY_DATA_DIR; --silent keeps npm's banner out of the output.
  const { ALCHEMY_DATA_DIR, ...fresh } = process.env;
  const run = command => JSON.parse(execFileSync("/bin/sh", ["-c", command.replace("npm start", "npm start --silent")],
    { encoding: "utf8", env: fresh }).trim().split("\n").at(-1));
  return { parent, dir, run };
}

test("user sees a start command that runs npm start in their installation, even with spaces or quotes", { skip: process.platform === "win32" }, async t => {
  // Given an installation that uses its own .local data folder.
  const { dir, run } = await installation(t);
  // When the user pastes the command into a shell.
  const command = startCommand({ installDir: dir });
  // Then npm start runs inside exactly that folder, with no data-folder override.
  assert.match(command, /^cd '.*' && npm start$/);
  assert.deepEqual(run(command), [realpathSync(dir), null]);
});

test("user whose service keeps its data elsewhere gets a start command that reopens that same data", { skip: process.platform === "win32" }, async t => {
  // Given a service started with ALCHEMY_DATA_DIR pointing outside the installation, in a folder that needs quoting.
  const { parent, dir, run } = await installation(t);
  const dataDir = join(parent, "Reframe data's home");
  // When the user pastes the offline command into a fresh terminal without that variable.
  const command = startCommand({ installDir: dir, dataDir });
  // Then npm start runs in the installation on the same data folder, not an empty default one.
  assert.deepEqual(run(command), [realpathSync(dir), dataDir]);
});

test("user is shown no command when the reported folders are missing, relative or could inject lines", () => {
  const unsafe = [undefined, null, 1, "", "relative/path", "C:\\Reframe", "/tmp/a\nrm -rf ~", "/tmp/\u0007", "/" + "a".repeat(1100)];
  for (const value of [undefined, null, "/tmp/QC-Reframe", ["/tmp/QC-Reframe"]]) assert.equal(startCommand(value), null, JSON.stringify(value));
  for (const installDir of unsafe) assert.equal(startCommand({ installDir }), null, JSON.stringify(installDir));
  // An unsafe data folder gives no command rather than one that silently opens the default, empty data folder.
  for (const dataDir of unsafe.filter(value => value !== undefined))
    assert.equal(startCommand({ installDir: "/tmp/QC-Reframe", dataDir }), null, JSON.stringify(dataDir));
});

test("user's web pages never receive the installation or data folder from health responses", () => {
  // Given health responses carrying the installation path, with and without a separate data folder.
  const plain = splitStartLocation({ service: "qc-alchemy", ready: true, installDir: "/Users/someone/QC-Reframe" });
  const custom = splitStartLocation({ ready: true, installDir: "/Users/someone/QC-Reframe", dataDir: "/Volumes/Data/Reframe" });
  // Then the background keeps the folders and every UI receives health without them.
  assert.deepEqual(plain, { health: { service: "qc-alchemy", ready: true }, location: { installDir: "/Users/someone/QC-Reframe" } });
  assert.deepEqual(custom, { health: { ready: true }, location: { installDir: "/Users/someone/QC-Reframe", dataDir: "/Volumes/Data/Reframe" } });
  // And unusable folders are still removed from health but never stored.
  assert.deepEqual(splitStartLocation({ ready: true, installDir: "relative" }), { health: { ready: true }, location: undefined });
  assert.deepEqual(splitStartLocation({ ready: true, installDir: "/Users/someone/QC-Reframe", dataDir: "relative" }), { health: { ready: true }, location: undefined });
  assert.deepEqual(splitStartLocation({ ready: true }), { health: { ready: true } });
  // And only extension pages, not content scripts, may ask for the start command.
  const operation = operationFor("alchemy:start-command");
  assert.equal(allowsOperation(operation, "extension"), true);
  assert.equal(allowsOperation(operation, "content"), false);
  assert.equal(allowsOperation(operation, "extension", "port"), false);
});
