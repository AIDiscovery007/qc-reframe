const failure = (message, status = 400) => Object.assign(new Error(message), { status, magpieSafe: true });
const safeText = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\p{Cc}\u2028\u2029]/u.test(value);
export const magpieHeaders = Object.freeze({ Authorization: 'Bearer magpie-reframe', 'User-Agent': 'Reframe' });
export const isMagpieModel = value => safeText(value, 256) && /^[^\s/]+\/\S+$/.test(value);

export function magpieBaseUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw failure('请填写有效的本机 Magpie 地址'); }
  if (!safeText(value, 2048) || /[\s?#\\]/.test(value) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      !(['localhost', '[::1]'].includes(url.hostname) || /^127\.\d+\.\d+\.\d+$/.test(url.hostname)) || !['', '/', '/v1', '/v1/'].includes(url.pathname))
    throw failure('本机 Magpie 地址仅支持 localhost 或回环 IP 的根地址及 /v1，不接受凭据或其他路径');
  return `${url.origin}/v1`;
}

export async function inspectMagpie({ baseUrl, signal, fetchImpl = fetch, timeoutMs = 5000 }) {
  const base = magpieBaseUrl(baseUrl);
  const controller = new AbortController(), cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, timeoutMs);
  const read = async path => {
    controller.signal.throwIfAborted();
    const response = await fetchImpl(`${base.slice(0, -3)}${path}`, { method: 'GET', redirect: 'error', signal: controller.signal,
      headers: { ...magpieHeaders, 'X-Magpie-Drawers': '1' } });
    if (!response.ok || Number(response.headers.get('content-length')) > 2 * 1024 * 1024) {
      await response.body?.cancel();
      throw failure(response.ok ? 'Magpie 目录响应超过大小限制' : `Magpie 连接失败（HTTP ${response.status}），请检查本机服务与访问权限`, 502);
    }
    if (!response.body) throw failure('Magpie 返回空目录响应', 502);
    const chunks = []; let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > 2 * 1024 * 1024) throw failure('Magpie 目录响应超过大小限制', 502);
      chunks.push(chunk);
    }
    controller.signal.throwIfAborted();
    return JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
  };
  try {
    if (signal?.aborted) cancel();
    const hello = await read('/api/hello');
    if (hello?.name !== 'magpie' || !safeText(hello.version, 80)) throw failure('地址未返回有效 Magpie 服务信息，请检查地址与版本', 502);
    const directory = await read('/v1/models');
    if (!Array.isArray(directory?.data) || directory.data.length > 10000) throw failure('Magpie 模型目录无效或过大，请检查版本', 502);
    const models = new Map();
    for (const item of directory.data) {
      if (item?.kind !== 'image' || !Array.isArray(item.modalities?.output) || !item.modalities.output.includes('image') || !isMagpieModel(item.id)) continue;
      models.set(item.id, { id: item.id, name: safeText(item.display_name, 200) ? item.display_name : item.id,
        inputImages: Array.isArray(item.modalities?.input) && item.modalities.input.includes('image') });
    }
    return { version: hello.version, models: [...models.values()] };
  } catch (error) {
    if (signal?.aborted) throw Object.assign(new Error('Magpie 连接检查已取消'), { name: 'AbortError', status: 499 });
    if (controller.signal.aborted) throw failure('Magpie 连接检查超时，请确认本机服务已启动', 504);
    if (error.magpieSafe) throw error;
    throw failure('无法读取 Magpie 目录，请检查本机地址、服务与版本', 502);
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
}
