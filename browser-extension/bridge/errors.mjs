// Only explicit protocol rejections imply CLI incompatibility. Invalid input,
// account/provider failures and transport errors keep their original meaning.
export function codexRpcError(error, method) {
  const result = error instanceof Error ? error : Object.assign(new Error(error?.message || "Codex 请求失败"), { code: error?.code, status: error?.status });
  const message = result.message;
  const protocolMismatch = result.code === -32601 || ([-32600, -32602].includes(result.code) && /(?:unknown|unrecognized|unsupported) (?:method|field)\b|method (?:not found|not supported)/i.test(message))
    || ([-32600, -32602].includes(result.code) && /unknown variant [`'"](?:localImage|skill|function|namespace|read-only|never|full|asc|thread\/[^`'"]+|turn\/start)[`'"]/i.test(message))
    || /(?:requires?|require).*experimentalApi|experimentalApi.*(?:required|enabled)/i.test(message);
  if (!protocolMismatch) return result;
  return Object.assign(new Error(`当前 Codex CLI 不支持 Reframe 所需接口${method ? `（${method}）` : ""}，请在设置中心检查 CLI 更新后重新检测。`),
    { code: result.code, status: result.status || 503, recovery: "cli" });
}
