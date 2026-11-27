import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// One service per data folder: the running service records where it listens, so a manager about to start another
// channel or port on the same folder can find it and refuse. A stale record (crash) is harmless: nothing answers there.
const recordPath = runtimeDir => join(runtimeDir, "service.json");

/** Records this process as the service of the data folder. Written atomically, so a reader sees a whole record or none. */
export function writeServiceRecord(runtimeDir, { port, channel }) {
  const path = recordPath(runtimeDir);
  writeFileSync(`${path}.tmp`, JSON.stringify({ port, channel, pid: process.pid }), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

/** Removes the record when it is still this process's own, never one a newer service wrote. */
export function removeServiceRecord(runtimeDir) {
  try {
    if (JSON.parse(readFileSync(recordPath(runtimeDir), "utf8")).pid === process.pid) rmSync(recordPath(runtimeDir), { force: true });
  } catch {}
}

/** The recorded service of a data folder, or null when there is none or it cannot be read. */
export async function readServiceRecord(runtimeDir) {
  try {
    const { port, channel } = JSON.parse(await readFile(recordPath(runtimeDir), "utf8"));
    return Number.isInteger(port) && port > 0 && port < 65536 && ["release", "dev"].includes(channel) ? { port, channel } : null;
  } catch { return null; }
}
