import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { runImageApi } from '../bridge/image-api.mjs';

const settings = { provider: 'openai', baseUrl: 'https://images.example/v1/', apiKey: 'private-key', model: 'image-model' };
const png = await sharp({ create: { width: 2, height: 3, channels: 3, background: '#f00' } }).png().toBuffer();
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const result = () => json({ data: [{ b64_json: png.toString('base64'), revised_prompt: 'a red cat' }] });
const options = patch => ({ settings, mode: 'recreate', prompt: 'a cat', negativePrompt: 'watermark', ...patch });

test('user: Given stale image paths, When recreating an image, Then only text reaches Images API', async () => {
  let calls = 0;
  const output = await runImageApi(options({ imagePath: '/must-not-read', subjectImagePath: '/also-not-read', aspectRatio: { width: 16, height: 9 }, fetchImpl: async (url, init) => {
    calls++;
    assert.equal(url, 'https://images.example/v1/images/generations');
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, 'Bearer private-key');
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'image-model');
    assert.equal(body.n, 1);
    assert.equal(body.size, '1536x1024');
    assert.match(body.prompt, /a cat/); assert.match(body.prompt, /watermark/);
    assert.equal(body.image, undefined); assert.equal(body.response_format, undefined);
    return result();
  } }));
  assert.equal(calls, 1); assert.deepEqual(output.bytes, png);
  assert.equal(output.extension, 'png'); assert.equal(output.revisedPrompt, 'a red cat');
});

async function images(t) {
  const dir = await mkdtemp(join(tmpdir(), 'reframe-image-api-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const buffers = await Promise.all(['#f00', '#0f0', '#00f'].map(background => sharp({ create: { width: 2, height: 3, channels: 3, background } }).png().toBuffer()));
  const paths = buffers.map((_, i) => join(dir, `${i}.png`));
  await Promise.all(paths.map((path, i) => writeFile(path, buffers[i])));
  return { paths, buffers };
}

for (const provider of ['openai', 'gemini']) test(`user: Given frozen image order and roles, When generating through ${provider}, Then the request preserves both`, async t => {
  const { paths, buffers } = await images(t);
  await runImageApi(options({ settings: { ...settings, provider }, mode: 'multi-reenact', imagePath: paths[0], subjectImagePaths: paths.slice(1),
    subjects: [{ id: 's1', role: '人物', detail: '红帽' }, { id: 's2', role: '背景', detail: '树木' }], referenceIndex: 1, aspectRatio: { width: 1536, height: 1024 },
    fetchImpl: async (url, init) => {
      let text, sent;
      if (provider === 'openai') {
        assert.equal(url, 'https://images.example/v1/images/edits');
        assert.equal(init.headers['Content-Type'], undefined);
        assert.equal(init.body.get('size'), '1536x1024');
        text = init.body.get('prompt');
        sent = await Promise.all(init.body.getAll('image[]').map(async file => Buffer.from(await file.arrayBuffer())));
      } else {
        assert.equal(url, 'https://images.example/v1/models/image-model:generateContent');
        assert.equal(init.headers['x-goog-api-key'], 'private-key');
        assert.equal(init.headers.Authorization, undefined);
        const body = JSON.parse(init.body);
        assert.equal(body.generationConfig.imageConfig.aspectRatio, '3:2');
        assert.deepEqual(body.generationConfig.responseModalities, ['TEXT', 'IMAGE']);
        text = body.contents[0].parts[0].text;
        sent = body.contents[0].parts.slice(1).map(part => { assert.equal(part.inlineData.mimeType, 'image/png'); return Buffer.from(part.inlineData.data, 'base64'); });
      }
      assert.match(text, /图 2.*参考/); assert.match(text, /红帽/); assert.match(text, /树木/);
      assert.deepEqual(sent, [buffers[1], buffers[0], buffers[2]]);
      return provider === 'openai' ? result() : json({ candidates: [{ content: { parts: [{ text: 'done' }, { inlineData: { data: png.toString('base64'), mimeType: 'image/png' } }] } }] });
    } }));
});

test('user: Given an image URL response, When downloading the result, Then credentials are omitted and redirects disabled', async () => {
  const requests = [];
  const output = await runImageApi(options({ fetchImpl: async (url, init) => {
    requests.push({ url, init });
    return requests.length === 1 ? json({ data: [{ url: 'https://cdn.example/result.png?signature=temporary' }] }) : new Response(png);
  } }));
  assert.deepEqual(output.bytes, png);
  assert.equal(requests[1].url, 'https://cdn.example/result.png?signature=temporary');
  assert.equal(requests[1].init.headers, undefined);
  assert.equal(requests[1].init.redirect, 'error');
});

test('user: Given text-only or blocked Gemini output, When generating an image, Then a useful error excludes vendor text', async () => {
  await assert.rejects(runImageApi(options({ settings: { ...settings, provider: 'gemini' }, fetchImpl: async () => json({ candidates: [{ content: { parts: [{ text: 'private-key private contents' }] }, finishReason: 'SAFETY' }] }) })), /未返回图片.*模型.*安全/);
});

for (const status of [400, 401, 403, 404, 429, 500, 302]) test(`user: Given HTTP ${status}, When generation fails, Then the error excludes vendor content and credentials cannot redirect`, async () => {
  await assert.rejects(runImageApi(options({ fetchImpl: async (_, init) => {
    assert.equal(init.redirect, 'error');
    return new Response('private-key private contents', { status, headers: { Location: 'https://elsewhere.example' } });
  } })), error => { assert.match(error.message, new RegExp(`HTTP ${status}`)); assert.doesNotMatch(error.message, /private/); return true; });
});

for (const baseUrl of ['http://remote.example/v1', 'file:///tmp/image', 'https://user:private-key@remote.example', 'https://example.test/v1?key=private-key', 'https://example.test/#secret'])
  test(`user: Given an invalid ${baseUrl.split(':')[0]} API address, When generating, Then validation rejects it before network access`, async () => {
    let calls = 0;
    await assert.rejects(runImageApi(options({ settings: { ...settings, baseUrl }, fetchImpl: async () => { calls++; return result(); } })), /API 地址/);
    assert.equal(calls, 0);
  });

for (const url of ['http://cdn.example/result', 'https://user:private-key@cdn.example/image', 'data:image/png;base64,AAA', 'file:///tmp/image'])
  test('user: Given an unsafe image URL, When receiving the result, Then no download starts', async () => {
    let calls = 0;
    await assert.rejects(runImageApi(options({ fetchImpl: async () => { calls++; return json({ data: [{ url }] }); } })), /图片地址/);
    assert.equal(calls, 1);
  });

for (const payload of [{ data: [{ b64_json: 'not!base64' }] }, { data: [{ b64_json: Buffer.from('<svg>fake image</svg>').toString('base64') }] }, { data: [{ b64_json: png.subarray(0, 40).toString('base64') }] }])
  test('user: Given an invalid or truncated image payload, When receiving the result, Then generation fails without a completed image', async () => {
    await assert.rejects(runImageApi(options({ fetchImpl: async () => json(payload) })), /图片.*(无效|编码)/);
  });

test('user: Given JPEG or WebP bytes with a false MIME, When receiving the result, Then the decoded image format is returned', async () => {
  for (const format of ['jpeg', 'webp']) {
    const bytes = await sharp(png).toFormat(format).toBuffer();
    const output = await runImageApi(options({ settings: { ...settings, provider: 'gemini' }, fetchImpl: async () => json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: bytes.toString('base64') } }] } }] }) }));
    assert.equal(output.extension, format); assert.deepEqual(output.bytes, bytes);
  }
});

test('user: Given an oversized streamed response, When reading the result, Then reading stops at the limit and cancels the stream', async () => {
  let cancelled = false, reads = 0;
  await assert.rejects(runImageApi(options({ fetchImpl: async () => new Response(new ReadableStream({
    pull(controller) { reads++; controller.enqueue(new Uint8Array(1024 * 1024)); }, cancel() { cancelled = true; },
  })) })), /大小限制/);
  assert.equal(cancelled, true); assert.ok(reads <= 33);
});

test('user: Given a declared oversized image, When downloading the result, Then generation fails before consuming the body', async () => {
  let calls = 0;
  await assert.rejects(runImageApi(options({ fetchImpl: async () => ++calls === 1 ? json({ data: [{ url: 'https://cdn.example/result' }] })
    : new Response(png, { headers: { 'Content-Length': String(21 * 1024 * 1024) } }) })), /大小限制/);
});

test('user: Given a generation request, When cancelling before or during fetch, Then no cancelled request starts and AbortError is preserved', async () => {
  let calls = 0;
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(runImageApi(options({ signal: cancelled.signal, fetchImpl: async () => { calls++; return result(); } })), { name: 'AbortError' });
  assert.equal(calls, 0);
  const pending = new AbortController();
  await assert.rejects(runImageApi(options({ signal: pending.signal, fetchImpl: async (_, { signal }) => {
    pending.abort(); signal.throwIfAborted();
  } })), { name: 'AbortError' });
});

test('user: Given a stalled or broken connection, When generation fails, Then timeout and network errors omit credentials', async () => {
  await assert.rejects(runImageApi(options({ timeoutMs: 5, fetchImpl: async (_, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('private-key URL')), { once: true })) })), /超时/);
  await assert.rejects(runImageApi(options({ fetchImpl: async () => { throw new Error('private-key https://user:pass@vendor'); } })), error => { assert.match(error.message, /连接失败/); assert.doesNotMatch(error.message, /private|vendor|pass/); return true; });
});

test('user: Given a session reference and possible stale subjects, When generating, Then only the reference is accepted before network access', async t => {
  const { paths, buffers } = await images(t);
  await runImageApi(options({ mode: 'session', imagePath: paths[0], fetchImpl: async (_, { body }) => {
    assert.match(body.get('prompt'), /图 1 仅为风格参考/);
    assert.equal(body.getAll('image[]').length, 1);
    assert.deepEqual(Buffer.from(await body.get('image[]').arrayBuffer()), buffers[0]);
    return result();
  } }));
  await assert.rejects(runImageApi(options({ mode: 'session', imagePath: paths[0], subjectImagePath: paths[1], fetchImpl: async () => { throw new Error('must not call'); } })), /不接受主体图/);
});

test('user: Given a submitted multi-image request, When settings or roles change during image reads, Then the request keeps its original snapshot', async t => {
  const { paths } = await images(t), mutable = { ...settings }, subjects = [{ id: 'a', role: '人物', detail: '红帽' }, { id: 'b', role: '背景', detail: '树木' }];
  const request = runImageApi(options({ settings: mutable, mode: 'multi-reenact', imagePath: paths[0], subjectImagePaths: paths.slice(1), subjects, fetchImpl: async (_, init) => {
    assert.equal(init.headers.Authorization, 'Bearer private-key'); assert.equal(init.body.get('model'), 'image-model');
    assert.match(init.body.get('prompt'), /红帽/); assert.doesNotMatch(init.body.get('prompt'), /late/);
    return result();
  } }));
  mutable.apiKey = 'late-key'; mutable.model = 'late-model'; subjects[0].detail = 'late-detail';
  await request;
});

test('user: Given a completed API response, When cancelling before image download, Then no follow-up download starts', async () => {
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(runImageApi(options({ signal: controller.signal, fetchImpl: async () => {
    calls++; controller.abort();
    return json({ data: [{ url: 'https://cdn.example/result' }] });
  } })), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('user: Given a configured HTTP endpoint in 127.0.0.0/8, When generating, Then the loopback endpoint is accepted', async () => {
  await runImageApi(options({ settings: { ...settings, baseUrl: 'http://127.0.0.2:8080/v1' }, fetchImpl: async url => {
    assert.equal(url, 'http://127.0.0.2:8080/v1/images/generations'); return result();
  } }));
});

test('user: Given a vendor revised_prompt containing the API key, When receiving the result, Then the key is removed before persistence', async () => {
  const output = await runImageApi(options({ fetchImpl: async () => json({ data: [{ b64_json: png.toString('base64'), revised_prompt: 'Authorization private-key repeated private-key' }] }) }));
  assert.doesNotMatch(output.revisedPrompt, /private-key/);
  assert.match(output.revisedPrompt, /Authorization/);
});

test('user generates via Magpie without a supplier key or implicit size conversion', async () => {
  // Given a text task, When sent, Then n=1, app identity, default size and reported model survive decoding.
  const output = await runImageApi(options({ settings: { provider: 'magpie', baseUrl: 'http://localhost:3425', model: 'source/image-model' }, fetchImpl: async (url, init) => {
    assert.equal(url, 'http://localhost:3425/v1/images/generations');
    assert.equal(init.headers.Authorization, 'Bearer magpie-reframe');
    assert.deepEqual(JSON.parse(init.body), { model: 'source/image-model', prompt: 'a cat\n\n排除项 / Negative prompt:\nwatermark', n: 1 });
    return json({ model: 'source/reported', data: [{ b64_json: png.toString('base64'), revised_prompt: 'revised' }] });
  } }));
  assert.equal(output.gatewayReportedModel, 'source/reported');
  assert.deepEqual(output.outputSize, { width: 2, height: 3 }); assert.deepEqual(output.bytes, png);
});

test('user rejects Magpie ratios and non-Magpie dimensions before file or network access', async () => {
  // Given incompatible size options, When submitted, Then no filesystem input or network call is attempted.
  for (const patch of [{ settings: { provider: 'magpie', baseUrl: 'http://localhost:3425', model: 'source/image' }, aspectRatio: { width: 1, height: 1 } }, { imageSize: { width: 640, height: 480 } }]) {
    await assert.rejects(runImageApi(options({ ...patch, fetchImpl: async () => { assert.fail('invalid size reached gateway'); } })), /Magpie|尺寸/);
  }
});

for (const imageSize of [undefined, { width: 1200, height: 800 }]) test(`user sends ordered Magpie references with ${imageSize ? 'explicit pixels' : 'gateway default size'}`, async t => {
  // Given ordered references and roles, When Magpie edits, Then all image[] parts remain ordered and size is exact or omitted.
  const { paths, buffers } = await images(t);
  await runImageApi(options({ settings: { provider: 'magpie', baseUrl: 'http://localhost:3425', model: 'source/image' }, mode: 'multi-reenact', imagePath: paths[0],
    subjectImagePaths: paths.slice(1), subjects: [{ id: 'a', role: '人物', detail: '红帽' }, { id: 'b', role: '场景', detail: '树木' }], referenceIndex: 1, imageSize,
    fetchImpl: async (url, init) => {
      assert.equal(url, 'http://localhost:3425/v1/images/edits'); assert.equal(init.body.get('n'), '1');
      assert.equal(init.body.get('size'), imageSize ? '1200x800' : null);
      assert.match(init.body.get('prompt'), /图 2 为参考/); assert.match(init.body.get('prompt'), /红帽/);
      assert.deepEqual(await Promise.all(init.body.getAll('image[]').map(async file => Buffer.from(await file.arrayBuffer()))), [buffers[1], buffers[0], buffers[2]]);
      return result();
    } }));
});

test('user sends explicit Magpie pixel dimensions unchanged in a text request', async () => {
  // Given nonstandard pixel dimensions, When generating from text, Then the JSON size is WxH without ratio conversion.
  await runImageApi(options({ settings: { provider: 'magpie', baseUrl: 'http://localhost:3425', model: 'source/image' }, imageSize: { width: 1337, height: 911 }, fetchImpl: async (url, init) => {
    assert.equal(url, 'http://localhost:3425/v1/images/generations'); assert.equal(JSON.parse(init.body).size, '1337x911'); return result();
  } }));
});

for (const imageSize of [null, { width: 0, height: 10 }, { width: 1.5, height: 1 }, { width: 10001, height: 1 }, { width: 10000, height: 4001 }, { width: 1, height: 1, extra: 1 }]) test('user cannot send invalid Magpie dimensions to the gateway', async () => {
  // Given invalid pixels, When submitting, Then validation rejects before any billable request.
  let calls = 0;
  await assert.rejects(runImageApi(options({ settings: { provider: 'magpie', baseUrl: 'http://localhost:3425', model: 'source/image' }, imageSize,
    fetchImpl: async () => { calls++; return result(); } })), /尺寸/);
  assert.equal(calls, 0);
});

for (const response of [() => new Response('not found', { status: 404 }), () => new Response('unsupported', { status: 405 }), () => json({ data: [{ b64_json: Buffer.from('not image').toString('base64') }] })]) test('user sees a Magpie edit failure without silent text fallback or retry', async t => {
  // Given an unsupported edit endpoint or non-image result, When editing, Then exactly one request fails without implicit retry.
  const { paths } = await images(t); let calls = 0;
  await assert.rejects(runImageApi(options({ settings: { provider: 'magpie', baseUrl: 'http://localhost:3425', model: 'source/image' }, mode: 'session', imagePath: paths[0], fetchImpl: async url => {
    calls++; assert.equal(url, 'http://localhost:3425/v1/images/edits'); return response();
  } })));
  assert.equal(calls, 1);
});
