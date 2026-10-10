import { magpieBaseUrl, isMagpieModel } from './magpie.mjs';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const defaults = {
  magpie: { baseUrl: 'http://127.0.0.1:3425/v1', model: '' },
  openai: { baseUrl: 'https://api.openai.com/v1', model: '', apiKey: '' },
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: '', apiKey: '' },
};
const invalid = (message, status = 400) => Object.assign(new Error(message), { status });
const controls = /[\p{Cc}\u2028\u2029]/u;

function object(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) {
    throw invalid('生图设置包含无效字段。');
  }
}

function text(value, label, limit) {
  if (typeof value !== 'string' || value.length > limit || controls.test(value)) throw invalid(`${label}无效。`);
  return value.trim();
}

function endpoint(value) {
  const input = text(value, 'API 地址', 2048);
  if (!/^https?:\/\//i.test(input) || /[\s?#\\]/.test(input) || input.split('/')[2].includes('@')) throw invalid('API 地址须为 HTTPS 或本机 HTTP，且不能含凭据、查询参数或片段。');
  let url;
  try { url = new URL(input); } catch { throw invalid('API 地址无效。'); }
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw invalid('API 地址须为 HTTPS 或本机 HTTP。');
  return url.href.replace(/\/+$/, '');
}

function config(value) {
  object(value, ['baseUrl', 'model', 'apiKey']);
  const apiKey = text(value.apiKey, 'API Key', 8192);
  if (/\s/.test(apiKey)) throw invalid('API Key 无效。');
  return { baseUrl: endpoint(value.baseUrl), model: text(value.model, '模型名称', 256), apiKey };
}

function magpieConfig(value) {
  object(value, ['baseUrl', 'model']);
  const model = text(value.model, '模型名称', 256);
  if (model && !isMagpieModel(model)) throw invalid('请填写 Magpie 目录中的完整模型 ID（来源/模型）。');
  return { baseUrl: magpieBaseUrl(value.baseUrl), model };
}

function provider(value) {
  if (!['codex', 'openai', 'gemini', 'magpie'].includes(value)) throw invalid('请选择支持的生图渠道。');
  return value;
}

export async function createImageSettingsStore({ dataDir }) {
  const path = join(dataDir, 'image-settings.json');
  let state = { provider: 'codex', configs: structuredClone(defaults) };
  let saved;
  try { saved = await readFile(path, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (saved !== undefined) {
    try {
      const parsed = JSON.parse(saved);
      object(parsed, ['provider', 'configs']);
      object(parsed.configs, ['openai', 'gemini', 'magpie']);
      state = { provider: provider(parsed.provider), configs: { openai: config(parsed.configs.openai), gemini: config(parsed.configs.gemini), magpie: parsed.configs.magpie === undefined ? { ...defaults.magpie } : magpieConfig(parsed.configs.magpie) } };
    } catch { throw invalid('生图设置文件无效，请检查 image-settings.json；原文件已保留。', 500); }
  }

  const view = () => ({ provider: state.provider, configs: Object.fromEntries(Object.entries(state.configs).map(([id, value]) => [id, {
    baseUrl: value.baseUrl, model: value.model, ...(id === 'magpie' ? {} : { hasApiKey: Boolean(value.apiKey) }),
  }])) });
  const ready = () => state.provider === 'codex' || Boolean(state.configs[state.provider].model && (state.provider === 'magpie' || state.configs[state.provider].apiKey));
  let pending = Promise.resolve();
  return {
    view, ready,
    selection() {
      if (state.provider === 'codex') return { provider: 'codex' };
      const selected = state.configs[state.provider];
      if (!ready()) throw invalid(state.provider === 'magpie' ? '请先在设置中选择 Magpie 生图模型。' : '请先在设置中填写生图模型和 API Key。', 409);
      return { provider: state.provider, ...selected };
    },
    async save(body) {
      object(body, ['provider', 'baseUrl', 'model', 'apiKey', 'clearApiKey']);
      const request = { ...body, provider: provider(body.provider) };
      if (request.provider === 'magpie' && (Object.hasOwn(request, 'apiKey') || Object.hasOwn(request, 'clearApiKey'))) throw invalid('Magpie 不使用供应商 API Key，请在 Magpie 管理来源。');
      if (request.provider === 'codex' && Object.keys(request).length !== 1) throw invalid('Codex 生图不使用 API 配置。');
      if (Object.hasOwn(request, 'clearApiKey') && typeof request.clearApiKey !== 'boolean') throw invalid('清除 API Key 的参数无效。');
      const previous = pending;
      const operation = (async () => {
        try { await previous; } catch { /* A failed save must not block later requests. */ }
        const next = structuredClone(state);
        next.provider = request.provider;
        if (request.provider === 'magpie') {
          next.configs.magpie = magpieConfig({ ...state.configs.magpie, ...Object.fromEntries(['baseUrl', 'model'].filter(key => Object.hasOwn(request, key)).map(key => [key, request[key]])) });
        } else if (request.provider !== 'codex') {
          const current = state.configs[request.provider];
          const updated = config({
            baseUrl: Object.hasOwn(request, 'baseUrl') ? request.baseUrl : current.baseUrl,
            model: Object.hasOwn(request, 'model') ? request.model : current.model,
            apiKey: Object.hasOwn(request, 'apiKey') ? request.apiKey : '',
          });
          if (request.clearApiKey && updated.apiKey) throw invalid('不能同时填写和清除 API Key。');
          if (updated.baseUrl !== current.baseUrl && current.apiKey && !updated.apiKey && !request.clearApiKey) throw invalid('更换 API 地址时，请重新填写 API Key 或明确清除原 Key。');
          updated.apiKey = request.clearApiKey ? '' : updated.apiKey || current.apiKey;
          next.configs[request.provider] = updated;
        }
        await mkdir(dataDir, { recursive: true, mode: 0o700 });
        const temporary = `${path}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, JSON.stringify(next), { mode: 0o600, flag: 'wx' });
          await rename(temporary, path);
        } finally { await rm(temporary, { force: true }).catch(() => {}); }
        state = next;
        return view();
      })();
      pending = operation;
      return operation;
    },
  };
}
