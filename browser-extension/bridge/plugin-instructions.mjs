// The plugin's own AGENTS.md / CLAUDE.md: one standing instruction that Reframe adds to every
// reverse task, whichever Agent runs it. Without a saved override the shipped text applies, so
// users who never customized it receive later built-in updates.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const PLUGIN_INSTRUCTIONS_LIMIT = 16000;
export const BUILTIN_INSTRUCTIONS_PATH = fileURLToPath(new URL("./plugin-instructions.md", import.meta.url));
const FILE = "plugin-instructions.md";
const invalid = (message, status = 400) => Object.assign(new Error(message), { status });
// Tab and line feed are text; every other control character is rejected.
const controls = /[\u0000-\u0008\u000b-\u001f\u007f\u2028\u2029]/u;

function normalize(value) {
  if (typeof value !== "string") throw invalid("插件指令须为文本。");
  const text = value.replace(/\r\n?/g, "\n").trim();
  if (text.length > PLUGIN_INSTRUCTIONS_LIMIT) throw invalid(`插件指令最多 ${PLUGIN_INSTRUCTIONS_LIMIT} 个字符。`);
  if (controls.test(text)) throw invalid("插件指令包含不支持的控制字符。");
  return text;
}

export async function createPluginInstructionsStore({ dataDir, builtinPath = BUILTIN_INSTRUCTIONS_PATH }) {
  const path = join(dataDir, FILE);
  const builtin = normalize(await readFile(builtinPath, "utf8"));
  let custom;
  try { custom = normalize(await readFile(path, "utf8")); }
  catch (error) {
    if (error.code !== "ENOENT") throw invalid(`插件指令文件无效，请检查 ${FILE}；原文件已保留。`, 500);
  }

  const text = () => custom ?? builtin;
  const revision = () => createHash("sha256").update(JSON.stringify([custom !== undefined, text()])).digest("hex");
  const view = () => ({ text: text(), builtin, custom: custom !== undefined, revision: revision(), maxLength: PLUGIN_INSTRUCTIONS_LIMIT });
  return {
    view,
    // Frozen into a task at admission; an empty string means the user chose no instruction.
    snapshot: text,
    // HTTP mutations already hold the service mutation lock, so the revision check and the write cannot interleave.
    async save(body) {
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !["text", "revision"].includes(key)))
        throw invalid("插件指令请求包含无效字段。");
      if (typeof body.revision !== "string") throw invalid("插件指令版本无效。");
      const next = normalize(body.text);
      if (body.revision !== revision()) throw invalid("插件指令已在其他窗口更新，请重新载入后再保存。", 409);
      if (next === builtin) await rm(path, { force: true });
      else {
        await mkdir(dataDir, { recursive: true, mode: 0o700 });
        const temporary = `${path}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, next, { mode: 0o600, flag: "wx" });
          await rename(temporary, path);
        } finally { await rm(temporary, { force: true }).catch(() => {}); }
      }
      custom = next === builtin ? undefined : next;
      return view();
    },
  };
}
