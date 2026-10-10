import { magpieBaseUrl, magpieHeaders } from './magpie.mjs';
import { readFile, stat } from 'node:fs/promises';
import sharp from 'sharp';
import { orderedImages } from './image-order.mjs';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 30 * 1024 * 1024;
const RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
const failure = message => Object.assign(new Error(message), { imageApiSafe: true });

function endpoint(baseUrl) {
  let url;
  try { url = new URL(baseUrl); } catch { throw failure('生图 API 地址无效'); }
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && (['localhost', '[::1]'].includes(url.hostname) || /^127\.\d+\.\d+\.\d+$/.test(url.hostname)))))
    throw failure('生图 API 地址须使用 HTTPS（本机服务可使用 HTTP），且不能包含凭据、查询参数或片段');
  return url.href.replace(/\/+$/, '');
}

async function imageResult(bytes) {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw failure('生图图片为空或超过 20 MB');
  try {
    const image = sharp(bytes, { limitInputPixels: 40_000_000, failOn: 'warning' });
    const { format, pages, width, height } = await image.metadata();
    if (!['png', 'jpeg', 'webp'].includes(format) || (pages || 1) > 1) throw new Error();
    await image.stats();
    return { bytes, extension: format, outputSize: { width, height } };
  } catch { throw failure('生图图片无效，仅支持可解码的 PNG、JPEG 或 WebP 静态图片'); }
}

async function responseBytes(response, limit) {
  if (!response.ok) {
    await response.body?.cancel();
    const help = response.status === 401 || response.status === 403 ? '请检查 API Key 和模型权限'
      : response.status === 429 ? '额度不足或请求过于频繁，请稍后重试'
      : response.status === 400 || response.status === 404 ? '请检查地址、模型及其生图/附图能力' : '请稍后重试';
    throw failure(`生图 API 请求失败（HTTP ${response.status}），${help}`);
  }
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel(); throw failure('生图 API 响应超过大小限制');
  }
  const chunks = []; let length = 0;
  if (!response.body) throw failure('生图 API 返回空响应');
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > limit) throw failure('生图 API 响应超过大小限制');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}

function decodeImage(data) {
  if (typeof data !== 'string' || data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data))
    throw failure('生图 API 返回的图片编码无效或超过 20 MB');
  return Buffer.from(data, 'base64');
}

export async function runImageApi({ settings, mode, imagePath, subjectImagePath, subjectImagePaths, subjects, referenceIndex, prompt, negativePrompt, aspectRatio, signal, onProgress, fetchImpl = fetch, timeoutMs = 300_000 }) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const timer = setTimeout(cancel, timeoutMs);
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    if (signal?.aborted) cancel();
    controller.signal.throwIfAborted();
    const { provider, baseUrl, apiKey, model } = { ...settings };
    const magpie = provider === 'magpie', imagesApi = provider !== 'gemini';
    if (!['openai', 'gemini', 'magpie'].includes(provider) || (!magpie && (typeof apiKey !== 'string' || !apiKey.trim())) || typeof model !== 'string' || !model.trim())
      throw failure('请先在设置中完整配置生图 API');
    const base = magpie ? magpieBaseUrl(baseUrl) : endpoint(baseUrl);
    if (magpie && mode !== 'recreate') throw failure('Magpie 当前仅支持完整复刻的纯文生图，附图能力尚未开放');
    if (magpie && aspectRatio !== undefined) throw failure('Magpie 当前使用网关默认尺寸，不支持指定比例');
    if (typeof prompt !== 'string' || !prompt.trim() || /\[SUBJECT\]/i.test(prompt)) throw failure('请先补充主体并重新逆向，再生成图片');
    if (aspectRatio && (!Number.isInteger(aspectRatio.width) || !Number.isInteger(aspectRatio.height) || aspectRatio.width < 1 || aspectRatio.height < 1 || aspectRatio.width > 10000 || aspectRatio.height > 10000))
      throw failure('生图宽高比例无效');
    if (mode === 'session' && (!imagePath || subjectImagePath || subjectImagePaths || subjects))
      throw failure('会话创作需要一张风格参考图，不接受主体图');
    if (mode !== 'recreate' && subjectImagePaths && (!imagePath || subjectImagePaths.length < 2 || subjectImagePaths.length > 6 || subjectImagePaths.length !== subjects?.length))
      throw failure('多图任务缺少主体图快照');
    const order = mode === 'recreate' ? { paths: [] } : orderedImages(imagePath, subjectImagePaths || (subjectImagePath ? [subjectImagePath] : []), referenceIndex);
    let text = `${prompt}${negativePrompt ? `\n\n排除项 / Negative prompt:\n${negativePrompt}` : ''}`;
    if (order.paths.length) {
      text += mode === 'session' ? '\n图 1 仅为风格参考，创作内容以提示词为准。'
        : !order.subjectNumbers.length ? '\n图 1 为参考图，各图保留项与迁移项以提示词为准。'
        : `\n图 ${order.referenceIndex + 1} 为参考模板；${order.subjectNumbers.map(number => `图 ${number}`).join('、')} 为主体。各图保留项与迁移项以提示词为准。`;
      if (subjects) text += `\n当前图片分工：${JSON.stringify(subjects.map(({ id, role, detail }, index) => ({ image: order.subjectNumbers[index], id, role, detail })))}`;
    }
    const ratio = aspectRatio ? aspectRatio.width / aspectRatio.height : 1;
    const size = ratio > 1 ? '1536x1024' : ratio < 1 ? '1024x1536' : '1024x1024';
    const imageRatio = RATIOS.reduce((best, current) => {
      const value = entry => { const [w, h] = entry.split(':').map(Number); return Math.abs(Math.log(w / h / ratio)); };
      return value(current) < value(best) ? current : best;
    });
    const images = [];
    for (const path of order.paths) {
      controller.signal.throwIfAborted();
      if ((await stat(path)).size > MAX_IMAGE_BYTES) throw failure('输入图片超过 20 MB');
      images.push(await imageResult(await readFile(path, { signal: controller.signal })));
    }
    controller.signal.throwIfAborted();
    let url, body, headers;
    if (imagesApi) {
      url = `${base}/images/${images.length ? 'edits' : 'generations'}`;
      headers = magpie ? { ...magpieHeaders } : { Authorization: `Bearer ${apiKey}` };
      if (images.length) {
        body = new FormData();
        body.set('model', model); body.set('prompt', text); body.set('n', '1'); body.set('size', size);
        images.forEach(({ bytes, extension }, index) => body.append('image[]', new Blob([bytes], { type: `image/${extension}` }), `image-${index + 1}.${extension}`));
      } else {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify({ model, prompt: text, n: 1, ...(magpie ? {} : { size }) });
      }
    } else {
      url = `${base}/models/${encodeURIComponent(model.replace(/^models\//, ''))}:generateContent`;
      headers = { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' };
      body = JSON.stringify({ contents: [{ role: 'user', parts: [{ text }, ...images.map(({ bytes, extension }) => ({ inlineData: { mimeType: `image/${extension}`, data: bytes.toString('base64') } }))] }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'], ...(aspectRatio ? { imageConfig: { aspectRatio: imageRatio } } : {}) } });
    }
    onProgress?.({ stage: '正在请求生图 API…' });
    controller.signal.throwIfAborted();
    const response = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: controller.signal, headers, body });
    let data;
    try { data = JSON.parse((await responseBytes(response, MAX_RESPONSE_BYTES)).toString('utf8')); }
    catch (error) { if (error.imageApiSafe) throw error; throw failure('生图 API 返回的响应不是有效 JSON'); }
    controller.signal.throwIfAborted();
    const item = imagesApi ? data?.data?.[0] : data?.candidates?.[0]?.content?.parts?.find(part => part.inlineData && !part.thought)?.inlineData;
    if (!item) throw failure('生图 API 未返回图片，请检查模型是否支持生图或调整触发安全限制的提示词');
    let bytes;
    if (imagesApi && !item.b64_json && item.url) {
      let download;
      try { download = new URL(item.url); } catch { throw failure('生图 API 返回的图片地址无效'); }
      if (download.protocol !== 'https:' || download.username || download.password) throw failure('生图 API 图片地址须使用无凭据 HTTPS');
      onProgress?.({ stage: '正在下载生成图片…' });
      controller.signal.throwIfAborted();
      bytes = await responseBytes(await fetchImpl(download.href, { redirect: 'error', signal: controller.signal }), MAX_IMAGE_BYTES);
    } else bytes = decodeImage(imagesApi ? item.b64_json : item.data);
    const output = await imageResult(bytes);
    controller.signal.throwIfAborted();
    return { ...output, ...(magpie && typeof data.model === 'string' ? { gatewayReportedModel: data.model.replace(/[\p{Cc}\u2028\u2029]/gu, '').slice(0, 256) } : {}),
      revisedPrompt: typeof item?.revised_prompt === 'string' ? (apiKey ? item.revised_prompt.replaceAll(apiKey, '[已隐藏]') : item.revised_prompt).slice(0, 100_000) : undefined };
  } catch (error) {
    if (signal?.aborted) throw Object.assign(new Error('生图已取消'), { name: 'AbortError' });
    if (controller.signal.aborted) throw failure('生图 API 请求超时，请稍后重试');
    if (error.imageApiSafe || error.magpieSafe) throw error;
    throw failure('生图 API 连接失败，请检查地址和网络后重试');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
}
