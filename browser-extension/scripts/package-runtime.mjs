// Builds the release runtime package: the built extension, local service, skill and installer,
// without sources or dev tools. `setup` recognises it by runtime-package.json and skips the build.
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EXTENSION_PUBLIC_KEY } from "../lib/extension-identity.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const runtimeArchive = "qc-reframe-runtime.tar.gz";
// Everything `npm start`, setup and the launcher read at run time; the package test checks imports resolve.
export const runtimeEntries = ["package.json", "package-lock.json", "bridge", "scripts/manage.mjs", "scripts/native-host.mjs",
  "scripts/install.sh", ".agents/skills/alchemy", ".output/chrome-mv3", "docs/INSTALL_WITH_CODEX.md"];

export async function packageRuntime(outputDir = join(root, ".output")) {
  const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const manifest = JSON.parse(await readFile(join(root, ".output/chrome-mv3/manifest.json"), "utf8"));
  if (manifest.version !== version) throw new Error(`扩展构建版本 ${manifest.version} 与 package.json ${version} 不同，请先运行 npm run build。`);
  if (manifest.key !== EXTENSION_PUBLIC_KEY) throw new Error("扩展构建缺少固定 key，请先运行 npm run build。");
  const stage = await mkdtemp(join(tmpdir(), "qc-reframe-runtime-"));
  try {
    const top = join(stage, "qc-reframe");
    for (const entry of runtimeEntries) await cp(join(root, entry), join(top, entry), { recursive: true });
    await mkdir(join(top, "lib"));
    for (const name of (await readdir(join(root, "lib"))).filter(name => name.endsWith(".mjs")))
      await cp(join(root, "lib", name), join(top, "lib", name));
    await writeFile(join(top, "runtime-package.json"), JSON.stringify({ version }, null, 2) + "\n");
    await mkdir(outputDir, { recursive: true });
    const archive = join(resolve(outputDir), runtimeArchive);
    // COPYFILE_DISABLE keeps macOS metadata files out of the archive.
    const tar = spawnSync("tar", ["-czf", archive, "-C", stage, "qc-reframe"], { env: { ...process.env, COPYFILE_DISABLE: "1" }, stdio: "inherit" });
    if (tar.status !== 0) throw new Error("运行包打包失败。");
    return archive;
  } finally { await rm(stage, { recursive: true, force: true }); }
}

if (resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  try { console.log(await packageRuntime(process.argv[2])); }
  catch (error) { console.error(`QC-Reframe：${error.message}`); process.exitCode = 1; }
}
