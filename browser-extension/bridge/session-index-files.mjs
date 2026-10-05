import { lstatSync, unlinkSync } from "node:fs";
import { join } from "node:path";

// Called only after the index worker has terminated. Never traverse or recursively remove files.
export function clearSessionIndexFiles(directory) {
  try {
    const root = lstatSync(directory);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error();
    const files = [];
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      const path = join(directory, `sessions.sqlite${suffix}`);
      let stat;
      try { stat = lstatSync(path); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error();
      files.push(path);
    }
    for (const path of files) unlinkSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw Object.assign(new Error("无法安全清除本地索引，请检查索引目录权限和文件类型"), { status: 503 });
  }
}
