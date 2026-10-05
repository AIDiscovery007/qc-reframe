import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCodexExecutable, runCliCommand } from "./cli.mjs";

const labels = { models: "模型连接", reverse: "图片逆向", generation: "图片生成", sessions: "会话读取" };
const unknownFeatures = () => Object.fromEntries(Object.keys(labels).map(key => [key, { status: "unknown" }]));
const methods = {
  initialize: ["clientInfo"],
  "account/read": ["refreshToken"], "config/read": ["cwd", "includeLayers"], "model/list": ["limit", "cursor", "includeHidden"],
  "thread/start": ["cwd", "sandbox", "approvalPolicy", "developerInstructions", "model", "modelProvider", "config", "ephemeral"],
  "turn/start": ["threadId", "input", "model", "effort"],
  "thread/list": ["limit", "cursor", "sortKey", "modelProviders", "sourceKinds", "archived"],
  "thread/read": ["threadId", "includeTurns"],
  "thread/turns/list": ["threadId", "limit", "cursor", "sortDirection", "itemsView"],
  "modelProvider/capabilities/read": [],
};

// Read only public JSON Schema. Unrecognized layouts remain unknown, never incompatible.
export function inspectProtocol(schema) {
  const resolve = (node, seen = new Set()) => {
    if (!node || typeof node !== "object") return undefined;
    if (!node.$ref) return node;
    if (!node.$ref.startsWith("#/") || seen.has(node.$ref)) return undefined;
    seen.add(node.$ref);
    return resolve(node.$ref.slice(2).split("/").reduce((value, key) => value?.[key.replaceAll("~1", "/").replaceAll("~0", "~")], schema), seen);
  };
  const alternatives = node => {
    node = resolve(node);
    return node?.oneOf || node?.anyOf || (node ? [node] : []);
  };
  const enumIncludes = (node, value, depth = 0) => {
    node = resolve(node);
    if (!node || depth > 16) return null;
    if (node.const === value || node.enum?.includes(value)) return true;
    const variants = node.oneOf || node.anyOf;
    if (variants) {
      const values = variants.map(item => enumIncludes(item, value, depth + 1));
      return values.includes(true) ? true : values.every(item => item === false) ? false : null;
    }
    return node.enum || "const" in node || ["null", "object", "number", "integer", "boolean"].includes(node.type) ? false : null;
  };
  const requests = alternatives(schema).map(node => resolve(node));
  if (!requests.length || requests.some(node => !node?.properties?.method)) return unknownFeatures();
  const request = method => requests.find(node => enumIncludes(node.properties.method, method) === true);
  const field = (method, name) => resolve(request(method)?.properties.params)?.properties?.[name];
  const hasMethod = method => {
    const node = request(method);
    if (!node) return requests.every(node => Array.isArray(resolve(node.properties.method)?.enum) || resolve(node.properties.method)?.const) ? false : null;
    const params = resolve(node.properties.params);
    if (!methods[method].length) return true;
    return params?.properties ? methods[method].every(key => key in params.properties) : null;
  };
  const hasField = (method, name) => resolve(request(method)?.properties.params)?.properties ? !!field(method, name) : null;
  const inputType = type => {
    const input = resolve(field("turn/start", "input"));
    const variants = alternatives(input?.items).map(node => resolve(node));
    if (!variants.length || variants.some(item => !item?.properties?.type)) return null;
    const values = variants.map(item => enumIncludes(item.properties.type, type));
    return values.includes(true) ? true : values.every(value => value === false) ? false : null;
  };
  const experimental = () => {
    if (!hasField("initialize", "capabilities")) return hasField("initialize", "capabilities");
    const variants = alternatives(field("initialize", "capabilities")).map(node => resolve(node)).filter(node => node?.type !== "null");
    return variants.length && variants.every(node => node?.properties) ? variants.some(node => "experimentalApi" in node.properties) : null;
  };
  const models = ["initialize", "account/read", "config/read", "model/list"].map(hasMethod);
  const inference = [...models, hasMethod("thread/start"), hasMethod("turn/start"), inputType("text"),
    enumIncludes(field("thread/start", "sandbox"), "read-only"), enumIncludes(field("thread/start", "approvalPolicy"), "never")];
  const checks = {
    models,
    reverse: [...inference, experimental(), hasField("thread/start", "dynamicTools"), hasField("turn/start", "outputSchema"), inputType("localImage"), inputType("skill")],
    generation: [...inference, hasMethod("modelProvider/capabilities/read"), inputType("localImage"), inputType("skill")],
    // Older servers return complete embedded turns; pagination is checked only when requested.
    sessions: [hasMethod("initialize"), ...["thread/list", "thread/read"].map(hasMethod)],
  };
  return Object.fromEntries(Object.entries(checks).map(([key, values]) => [key, values.includes(false)
    ? { status: "unsupported", message: `当前 Codex CLI 不支持 Reframe 所需的${labels[key]}接口，请在设置中心检查 CLI 更新后重新检测。` }
    : { status: values.every(value => value === true) ? "supported" : "unknown" }]));
}

async function executableIdentity() {
  const located = await resolveCodexExecutable();
  if (!located) return null;
  const info = await stat(located.resolved);
  const packageRoot = located.resolved.match(/^(.*[\\/]node_modules[\\/]@openai[\\/]codex)[\\/]/)?.[1];
  const version = packageRoot ? await readFile(join(packageRoot, "package.json"), "utf8").then(text => JSON.parse(text).version).catch(() => null) : null;
  return { ...located, key: JSON.stringify([located.executable, located.resolved, info.ino, info.size, info.mtimeMs, info.ctimeMs, version]) };
}

async function readProtocol(executable) {
  const directory = await mkdtemp(join(tmpdir(), "reframe-protocol-"));
  try {
    await runCliCommand(executable, ["app-server", "generate-json-schema", "--experimental", "--out", directory], { timeout: 8_000 });
    const path = join(directory, "ClientRequest.json");
    if ((await stat(path)).size > 16 * 1024 * 1024) throw new Error("Protocol schema too large");
    return JSON.parse(await readFile(path, "utf8"));
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export function createCompatibilityChecker({ identify = executableIdentity, probe = readProtocol, now = Date.now } = {}) {
  let report = { checkedAt: null, features: unknownFeatures() }, identity, checking, attemptedAt = 0;
  return {
    snapshot() { return structuredClone(report); },
    async getCompatibility({ force = false } = {}) {
      if (checking) {
        if (!force) return checking;
        await checking;
        return this.getCompatibility({ force: true });
      }
      checking = (async () => {
        const located = await identify().catch(() => null);
        if (!force && identity === located?.key && report.checkedAt && (!report.error || now() - attemptedAt < 30_000)) return structuredClone(report);
        identity = located?.key;
        attemptedAt = now();
        report = { checkedAt: new Date(attemptedAt).toISOString(), features: unknownFeatures() };
        if (!located) report.error = "未找到可运行的 Codex CLI，请在设置中心检查安装路径后重新检测。";
        else {
          try { report.features = inspectProtocol(await probe(located.executable)); }
          catch { report.error = "暂时无法检查 CLI 接口能力；可继续尝试使用，或在设置中心检查更新后重新检测。"; }
        }
        return structuredClone(report);
      })().finally(() => { checking = undefined; });
      return checking;
    },
  };
}

export function assertFeatureSupported(report, feature) {
  const state = report?.features?.[feature];
  if (state?.status === "unsupported") throw Object.assign(new Error(state.message), { status: 409, code: "CLI_INCOMPATIBLE", recovery: "cli" });
}
