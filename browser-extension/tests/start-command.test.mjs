import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { splitInstallDir, startCommand } from "../lib/start-command.ts";
import { allowsOperation, operationFor } from "../lib/operation-policy.ts";

test("user sees a start command that runs npm start in their installation, even with spaces or quotes", { skip: process.platform === "win32" }, async t => {
  // Given an installation folder whose name needs shell quoting.
  const parent = await mkdtemp(join(tmpdir(), "reframe start "));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const dir = join(parent, "it's QC-Reframe");
  await mkdir(dir);
  await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { start: "node -e \"console.log(process.cwd())\"" } }));
  // When the user pastes the command into a shell.
  const command = startCommand(dir);
  const output = execFileSync("/bin/sh", ["-c", command.replace("npm start", "npm start --silent")], { encoding: "utf8" });
  // Then npm start runs inside exactly that folder.
  assert.match(command, /&& npm start$/);
  assert.equal(output.trim().split("\n").at(-1), (await import("node:fs")).realpathSync(dir));
});

test("user is shown no command when the reported folder is missing, relative or could inject lines", () => {
  for (const dir of [undefined, null, 1, "", "relative/path", "C:\\Reframe", "/tmp/a\nrm -rf ~", "/tmp/\u0007", "/" + "a".repeat(1100)])
    assert.equal(startCommand(dir), null, JSON.stringify(dir));
});

test("user's web pages never receive the installation folder from health responses", () => {
  // Given a health response carrying the installation path.
  const { health, installDir } = splitInstallDir({ service: "qc-alchemy", ready: true, installDir: "/Users/someone/QC-Reframe" });
  // Then the background keeps the path and every UI receives health without it.
  assert.equal(installDir, "/Users/someone/QC-Reframe");
  assert.deepEqual(health, { service: "qc-alchemy", ready: true });
  assert.deepEqual(splitInstallDir({ ready: true, installDir: "relative" }), { health: { ready: true }, installDir: undefined });
  assert.deepEqual(splitInstallDir({ ready: true }), { health: { ready: true } });
  // And only extension pages, not content scripts, may ask for the start command.
  const operation = operationFor("alchemy:start-command");
  assert.equal(allowsOperation(operation, "extension"), true);
  assert.equal(allowsOperation(operation, "content"), false);
  assert.equal(allowsOperation(operation, "extension", "port"), false);
});
