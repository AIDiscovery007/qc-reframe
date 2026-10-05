import { createHash, randomUUID } from "node:crypto";
import { mkdir, lstat, readFile, writeFile, rename, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { recordFilePattern } from "./storage.mjs";

const assetPattern = /^[a-f0-9]{64}\.(png|jpeg|webp)$/;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function slots(record, file) {
  const project = file.startsWith("project-");
  const id = file.slice(project ? 8 : 0, -5);
  if (record?.id !== id || typeof record.createdAt !== "string" ||
    (record.generations !== undefined && !Array.isArray(record.generations))) throw new Error("图片记录无效");
  const entries = [[record, "imageAsset", file.slice(0, -5)]];
  for (const input of Object.values(record.inputs || {})) {
    if (!input || typeof input !== "object") throw new Error("项目输入记录无效");
    entries.push([input, "subjectAsset"]);
    if (input.subjects !== undefined) {
      if (!Array.isArray(input.subjects) || input.subjects.some((subject) => !subject || typeof subject.subjectAsset !== "string")) throw new Error("项目主体记录无效");
      for (const subject of input.subjects) entries.push([subject, "subjectAsset"]);
    }
  }
  if (!project) {
    entries.push([record, "subjectAsset", `${id}-subject`]);
    const subjects = [record.reenact?.subjects, ...(record.generations || []).map((generation) => generation.subjects)];
    for (const list of subjects) {
      if (list === undefined) continue;
      if (!Array.isArray(list) || list.length < 2 || list.some((subject) => !subject || typeof subject.subjectAsset !== "string"))
        throw new Error("多图主体记录无效");
      for (const subject of list) entries.push([subject, "subjectAsset"]);
    }
    for (const generation of record.generations || []) {
      if (!/^[\w-]+$/.test(generation?.id || "")) throw new Error("生图记录无效");
      entries.push([generation, "imageAsset", `${generation.id}-generated`],
        [generation, "subjectAsset", `${generation.id}-subject`]);
    }
  }
  return entries;
}

// Call migration/collection only before serving requests or while all image tasks are idle.
export async function createImageStore(dataDir, recordsDir = dataDir) {
  const directory = join(dataDir, "images");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory()) throw new Error("图片目录无效");
  const pending = new Map();
  const path = (asset) => {
    if (typeof asset !== "string" || !assetPattern.test(asset)) throw new Error("图片引用无效");
    return join(directory, asset);
  };
  const generationPath = ({ id, imageAsset, extension }) => {
    if (imageAsset !== undefined) return path(imageAsset);
    if (typeof id !== "string" || !/^[\da-f-]{36}$/.test(id) || !["png", "jpeg", "webp"].includes(extension)) throw new Error("生成图片引用无效");
    return join(dataDir, `${id}-generated.${extension}`);
  };
  async function read(asset) {
    const file = path(asset);
    if (!(await lstat(file)).isFile()) throw new Error("图片文件无效");
    const bytes = await readFile(file);
    if (hash(bytes) !== asset.slice(0, 64)) throw new Error("图片校验失败");
    return bytes;
  }
  async function put({ bytes, extension }) {
    const asset = `${hash(bytes)}.${extension}`;
    const file = path(asset);
    if (pending.has(asset)) return pending.get(asset);
    const operation = (async () => {
      try { await read(asset); return asset; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      const temporary = join(directory, `.${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
        await rename(temporary, file);
      } finally { await rm(temporary, { force: true }); }
      return asset;
    })();
    pending.set(asset, operation);
    try { return await operation; } finally { pending.delete(asset); }
  }
  async function legacy(prefix) {
    if (!/^[\w-]+$/.test(prefix)) throw new Error("旧图片路径无效");
    for (const extension of ["png", "jpeg", "webp"]) {
      const file = join(dataDir, `${prefix}.${extension}`);
      try {
        if (!(await lstat(file)).isFile()) throw new Error("旧图片文件无效");
        return { bytes: await readFile(file), extension, file };
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
  async function records() {
    const entries = [];
    for (const file of await readdir(recordsDir)) {
      if (!recordFilePattern.test(file)) continue;
      if (!(await lstat(join(recordsDir, file))).isFile()) throw new Error("图片记录文件无效");
      const record = JSON.parse(await readFile(join(recordsDir, file), "utf8"));
      entries.push({ file, record, entries: slots(record, file) });
    }
    return entries;
  }
  return {
    put, read, path, generationPath, legacy,
    async migrate() {
      // A damaged record may still own images. Leave all legacy files intact in that case.
      let all;
      try { all = await records(); } catch { return; }
      const obsolete = new Set();
      for (const { file, record, entries } of all) {
        let changed = false;
        for (const [owner, key, prefix] of entries) {
          const old = prefix ? await legacy(prefix) : undefined;
          if (owner[key] !== undefined) {
            path(owner[key]);
            if (old && (await read(owner[key])).equals(old.bytes)) obsolete.add(old.file);
          } else if (old) {
            owner[key] = await put(old);
            await read(owner[key]);
            changed = true;
            obsolete.add(old.file);
          }
        }
        if (changed) {
          const temporary = join(recordsDir, `${file}.${randomUUID()}.tmp`);
          await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
          await rename(temporary, join(recordsDir, file));
        }
      }
      // All referencing records are committed before removing any old image.
      for (const file of obsolete) await rm(file, { force: true });
    },
    async collect() {
      const used = new Set();
      try {
        for (const { entries } of await records()) {
          for (const [owner, key, prefix] of entries) {
            if (owner[key] !== undefined) { path(owner[key]); used.add(owner[key]); }
            // Failed/partial migrations keep both forms recoverable.
            else if (prefix && await legacy(prefix)) return;
          }
        }
      } catch { return; }
      for (const file of await readdir(directory)) {
        if (assetPattern.test(file) && !used.has(file) && (await lstat(path(file))).isFile())
          await rm(path(file));
      }
    },
  };
}
