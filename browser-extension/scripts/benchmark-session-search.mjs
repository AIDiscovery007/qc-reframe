// Read-only benchmark. Prints timings/counts only; never prints titles or transcripts.
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";
import { withCodex } from "../bridge/codex-rpc.mjs";
import { createSessionReader } from "../bridge/session-rpc.mjs";

const count = Number(process.argv[2] || 5);
if (!Number.isInteger(count) || count < 2 || count > 20) throw new Error("Use 2–20 requests");
const binary = process.env.CODEX_BIN || "codex";
const { stdout } = await promisify(execFile)(binary, ["--version"]);
const params = { limit: 30, sortKey: "updated_at", modelProviders: [],
  sourceKinds: ["cli", "vscode", "appServer", "exec", "unknown"], archived: false };
const rounded = value => Math.round(value * 10) / 10;
const old = [];
for (let i = 0; i < count; i++) {
  const start = performance.now();
  let initialized;
  await withCodex({ cwd: process.cwd(), timeoutMs: 30_000, maxResponseBytes: 24 * 1024 * 1024 }, async request => {
    initialized = performance.now();
    await request("thread/list", params);
  });
  old.push({ startupMs: rounded(initialized - start), totalMs: rounded(performance.now() - start) });
}
let startupMs, spawns = 0;
const reader = createSessionReader({ cwd: process.cwd(), spawnProcess: (...args) => {
  spawns++;
  const start = performance.now(), proc = spawn(...args);
  let buffer = "";
  const initialized = chunk => {
    buffer += chunk.toString("utf8");
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      let message; try { message = JSON.parse(line); } catch { continue; }
      if (message.id === 0 && !message.method) {
        startupMs = rounded(performance.now() - start);
        proc.stdout.off("data", initialized); buffer = ""; return;
      }
    }
  };
  proc.stdout.on("data", initialized);
  return proc;
} });
const reused = [];
try {
  for (let i = 0; i < count; i++) {
    const start = performance.now();
    await reader.request("thread/list", params);
    reused.push(rounded(performance.now() - start));
  }
} finally { reader.close(); }
console.log(JSON.stringify({ cliVersion: stdout.trim(), requestsPerStrategy: count,
  old: { processes: count, requests: old, totalMs: rounded(old.reduce((sum, item) => sum + item.totalMs, 0)) },
  reused: { processes: spawns, startupMs, requestTotalMs: reused, totalMs: rounded(reused.reduce((sum, value) => sum + value, 0)) },
  scope: "thread/list metadata only; sequential; old then reused; local warm-cache timings, not a controlled performance guarantee",
}, null, 2));
