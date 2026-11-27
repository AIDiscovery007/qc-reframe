// Stdio MCP server that `claude -p --mcp-config` launches for one reverse task. It exposes only the task's
// read-only image inspection and skill references from the private manifest; paths never come from tool arguments.
import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createImageInspection } from "./inspection.mjs";

// Claude accepts at most 2000 px per edge when a request carries many images and about 5 MB of base64 per image.
export const CLAUDE_IMAGE_LIMITS = { maxEdge: 2000, maxPixels: 4_000_000, maxBytes: 3_750_000 };

export function createReframeTools({ images, references }) {
  const inspection = createImageInspection(images, CLAUDE_IMAGE_LIMITS);
  const tools = [
    { name: inspection.spec.name, description: inspection.spec.description.split("\nWhen called via functions.exec")[0], inputSchema: inspection.spec.inputSchema },
    { name: "alchemy_read_reference", description: "Read a reference from the current task's Alchemy skill snapshot. Only the listed reference names are allowed.",
      inputSchema: { type: "object", additionalProperties: false, properties: { path: { type: "string" } }, required: ["path"] } },
  ];
  async function call(name, args, { signal } = {}) {
    signal?.throwIfAborted();
    if (name === inspection.spec.name) {
      const result = await inspection.call(args, { signal });
      return result.contentItems.map(item => item.type === "inputText" ? { type: "text", text: item.text }
        : { type: "image", mimeType: "image/png", data: item.imageUrl.split(",")[1] });
    }
    if (name === "alchemy_read_reference") {
      if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some(key => key !== "path") || !Object.hasOwn(references, args.path))
        throw new Error("仅允许读取本次技能的参考文档。");
      return [{ type: "text", text: references[args.path] }];
    }
    throw new Error("未知工具。");
  }
  return { tools, call };
}

/** Serves newline-delimited JSON-RPC 2.0 until input ends. */
export function serve({ tools, call }, input = process.stdin, output = process.stdout) {
  const running = new Map();
  const send = message => output.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  const lines = createInterface({ input, crlfDelay: Infinity });
  lines.on("line", async line => {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch { return send({ id: null, error: { code: -32700, message: "Parse error" } }); }
    const { id, method, params } = message;
    if (method === "notifications/cancelled") { running.get(params?.requestId)?.abort(); return; }
    if (id === undefined || id === null) return;
    if (method === "initialize") return send({ id, result: { protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
      capabilities: { tools: {} }, serverInfo: { name: "reframe", version: "1.0.0" } } });
    if (method === "ping") return send({ id, result: {} });
    if (method === "tools/list") return send({ id, result: { tools } });
    if (method !== "tools/call") return send({ id, error: { code: -32601, message: "Method not found" } });
    const controller = new AbortController();
    running.set(id, controller);
    try { send({ id, result: { content: await call(params?.name, params?.arguments ?? {}, { signal: controller.signal }) } }); }
    catch (error) { if (!controller.signal.aborted) send({ id, result: { content: [{ type: "text", text: error.message || "工具执行失败。" }], isError: true } }); }
    finally { running.delete(id); }
  });
  return lines;
}

const main = (() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (main) {
  try {
    const manifest = JSON.parse(await readFile(process.argv[2], "utf8"));
    serve(createReframeTools(manifest));
  } catch {
    process.stderr.write("无法读取 Reframe 任务资料。\n");
    process.exit(1);
  }
}
