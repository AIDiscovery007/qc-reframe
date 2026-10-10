import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { createImageInspection } from "./inspection.mjs";

export default async function register(pi) {
  if (SettingsManager.create(process.cwd(), process.env.PI_CODING_AGENT_DIR).getBlockImages()) {
    process.stderr.write("Pi 已启用 blockImages，请先在 Pi 设置中允许图片输入后重试。\n");
    process.exit(1);
  }
  const { images, references } = JSON.parse(await readFile(process.env.REFRAME_PI_MANIFEST, "utf8"));
  const inspection = createImageInspection(images);
  pi.registerTool({ name: inspection.spec.name, label: "检查输入图片", description: inspection.spec.description.split("\nWhen called via functions.exec")[0],
    parameters: inspection.spec.inputSchema,
    async execute(_id, args, signal) {
      const result = await inspection.call(args, { signal });
      return { content: result.contentItems.map(item => item.type === "inputText" ? { type: "text", text: item.text }
        : { type: "image", mimeType: "image/png", data: item.imageUrl.split(",")[1] }), details: {} };
    } });
  pi.registerTool({ name: "alchemy_read_reference", label: "读取技能参考", description: "Read a reference from the current task's Alchemy skill snapshot. Only the listed reference names are allowed.",
    parameters: { type: "object", additionalProperties: false, properties: { path: { type: "string" } }, required: ["path"] },
    async execute(_id, args, signal) {
      signal?.throwIfAborted();
      if (!args || Object.keys(args).some(key => key !== "path") || !Object.hasOwn(references, args.path)) throw new Error("仅允许读取本次技能的参考文档。");
      return { content: [{ type: "text", text: references[args.path] }], details: {} };
    } });  process.stdout.write(JSON.stringify({ type: "reframe_tools_ready" }) + "\n");
}
