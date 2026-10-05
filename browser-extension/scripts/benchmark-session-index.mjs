import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createSessionSearchIndex } from "../bridge/session-search-index.mjs";

// Synthetic fixtures only. Usage: node scripts/benchmark-session-index.mjs [sessions=500]
const count = Number(process.argv[2] ?? 500);
if (process.argv.length > 3 || !Number.isInteger(count) || count < 1 || count > 1000)
  throw new Error("Usage: node scripts/benchmark-session-index.mjs [session count: 1–1000]");

const phrases = [
  "林夏走过海边看到晨光，拿起相机拍摄远处的帆船。",
  "小说第二章描写主人公寻找失踪同伴，穿越森林抵达城市。",
  "剪辑视频使用暖色调，封面保留清晰标题与自然光影。",
  "创作漫画需要一致的人物服装，背景是未来城市和山间小屋。",
  "设计参考图的风格包含水彩纹理和细腻线条，画面安静。",
];
const queries = ["的", "海", "林", "图", "猫", "海边", "林夏", "封面", "小说", "风格", "城市", "视频", "漫画", "相机", "背景", "小说 封面", "林夏 海边", "不存在", "水彩纹理", "主人公寻找失踪同伴"];
const milliseconds = value => Number(value.toFixed(2));
function timings(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    totalMs: milliseconds(samples.reduce((sum, value) => sum + value, 0)),
    p50Ms: milliseconds(sorted[Math.ceil(sorted.length * 0.5) - 1]),
    p95Ms: milliseconds(sorted[Math.ceil(sorted.length * 0.95) - 1]),
    maxMs: milliseconds(sorted.at(-1)),
  };
}

const directory = mkdtempSync(join(tmpdir(), "reframe-index-benchmark-"));
let index;
try {
  index = createSessionSearchIndex({ directory });
  const writes = [], searches = [];
  let indexedCharacters = 0;
  for (let n = 0; n < count; n++) {
    const messages = Array.from({ length: 25 }, (_, j) =>
      Array.from({ length: 6 }, (_, k) => phrases[(n + j + k) % phrases.length]).join("") + "场景编号" + n + "-" + j);
    const title = n % 3 === 0 ? "海边视频封面 " + n : "小说插图创作 " + n;
    indexedCharacters += title.length + messages.reduce((sum, message) => sum + message.length, 0);
    const began = performance.now();
    index.put({ id: "session-" + n, title, updatedAt: n, archived: false }, messages);
    writes.push(performance.now() - began);
  }
  for (let n = 0; n < 100; n++) {
    const began = performance.now();
    index.search({ query: queries[n % queries.length] });
    searches.push(performance.now() - began);
  }
  console.log(JSON.stringify({
    sessions: count,
    indexedCharacters,
    averageCharactersPerSession: Math.round(indexedCharacters / count),
    dbMiB: Number((statSync(join(directory, "sessions.sqlite")).size / 1048576).toFixed(2)),
    indexWrites: timings(writes),
    searchCount: searches.length,
    searches: timings(searches),
  }));
} finally {
  try { index?.close(); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}
