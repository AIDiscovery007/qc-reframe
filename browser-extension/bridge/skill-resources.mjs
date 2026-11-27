import { readFile, writeFile, readdir, realpath, lstat } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";

const LIMIT = 2 * 1024 * 1024;

/**
 * Snapshot of one task's local resources for CLI Agents that cannot read the skill themselves.
 * Writes `task.json` ({ images, references }) with mode 0600 into the private task directory; tools may read only
 * the listed images and reference names. Skill text plus references are capped at 2 MB.
 */
export async function taskResources(input, dir, { probe = false, label }) {
  const images = probe ? [] : input.filter(item => item.type === "localImage").map(item => resolve(item.path));
  const references = {};
  const skillText = [];
  let bytes = 0;
  const count = text => {
    bytes += Buffer.byteLength(text);
    if (bytes > LIMIT) throw new Error(`${label} 技能资料超过大小限制。`);
  };
  if (!probe) for (const skill of input.filter(item => item.type === "skill")) {
    const path = await realpath(skill.path);
    const text = await readFile(path, "utf8");
    count(text);
    skillText.push(text);
    const root = join(dirname(path), "references");
    const collect = async (directory, prefix) => {
      for (const entry of await readdir(directory, { withFileTypes: true }).catch(error => { if (error.code === "ENOENT") return []; throw error; })) {
        const key = `${prefix}/${entry.name}`, file = join(directory, entry.name);
        if (entry.isDirectory()) await collect(file, key);
        else if (entry.isFile() && entry.name.endsWith(".md")) {
          const text = await readFile(file, "utf8");
          count(text);
          references[key] = text;
        }
      }
    };
    const info = await lstat(root).catch(error => { if (error.code !== "ENOENT") throw error; });
    if (info?.isDirectory()) await collect(root, "references");
  }
  const manifest = join(dir, "task.json");
  await writeFile(manifest, JSON.stringify({ images, references }), { mode: 0o600 });
  return { images, references, skillText, manifest };
}

export const referenceToolSpec = {
  name: "alchemy_read_reference",
  description: "Read a reference from the current task's Alchemy skill snapshot. Only the listed reference names are allowed.",
  inputSchema: { type: "object", additionalProperties: false, properties: { path: { type: "string" } }, required: ["path"] },
};

/** Every Agent reads references only by the names in the task snapshot, never by file path. */
export function readReference(references, args) {
  if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some(key => key !== "path") || !Object.hasOwn(references, args.path))
    throw new Error("仅允许读取本次技能的参考文档。");
  return references[args.path];
}

/** Shared task system prompt for CLI Agents that load the skill snapshot through Reframe tools. */
export function taskSystemPrompt({ instructions, skillText, references, schema, readTool = "alchemy_read_reference", schemaRule = true }) {
  return [instructions, ...skillText,
    `仅使用本次提供的图片和技能资料。需要参考文档时调用 ${readTool}，path 使用以下名称：`, Object.keys(references).join("\n"),
    schema && schemaRule ? `只返回符合以下 JSON Schema 的 JSON，不使用 Markdown 代码围栏：${JSON.stringify(schema)}` : ""].join("\n\n");
}
