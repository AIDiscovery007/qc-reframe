import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { runInNewContext } from "node:vm";
import { createImageInspection } from "../bridge/inspection.mjs";

async function fixture(t, bytes) {
  const dir = await mkdtemp(join(tmpdir(), "alchemy-inspection-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "source.png");
  await writeFile(path, bytes);
  return { dir, path, tool: createImageInspection([path]) };
}
const decode = result => Buffer.from(result.contentItems.find(c => c.type === "inputImage").imageUrl.split(",")[1], "base64");
const info = result => JSON.parse(result.contentItems[0].text);

test("the published exec helper displays flattened and structured results without leaking image bytes into text", async t => {
  const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer();
  const { tool } = await fixture(t, bytes);
  const result = await tool.call({ image: 1 });
  const metadata = result.contentItems[0].text;
  const url = result.contentItems[1].imageUrl;
  const source = tool.spec.description.split("function showInspection")[1].split("\nshowInspection(await")[0];
  const show = runInNewContext(`(function showInspection${source})`);
  const block = { type: "image", mimeType: "image/png", data: url.split(",")[1] };
  for (const [input, expectedImage] of [
    [`${metadata}\n${url}\n`, url],
    [result, url],
    [[{ type: "input_text", text: metadata }, { type: "input_image", image_url: url }], url],
    [{ content: [{ type: "text", text: metadata }, block] }, block],
  ]) {
    const texts = [], images = [];
    show(input, value => texts.push(value), value => images.push(value));
    assert.deepEqual(texts, [metadata]);
    assert.deepEqual(images, [expectedImage]);
  }
  const texts = [], images = [];
  show({ success: false, contentItems: [{ type: "inputText", text: "invalid bbox" }] }, value => texts.push(value), value => images.push(value));
  assert.deepEqual(texts, ["invalid bbox"]);
  assert.deepEqual(images, []);
  for (const input of [{ unknown: url }, `${metadata}\n${url}\ntruncated`])
    assert.throws(() => show(input, () => assert.fail("must not dump payload"), () => assert.fail("must not display invalid payload")), /payload|shape/);
});

test("inspection returns actual cropped nearest-neighbour pixels, alpha and honest colour metadata without writing files", async t => {
  const pixels = Buffer.from([255,0,0,255, 0,255,0,255, 0,0,255,128, 255,255,255,255]);
  const bytes = await sharp(pixels, { raw: { width: 2, height: 2, channels: 4 } }).png().toBuffer();
  const { tool, dir } = await fixture(t, bytes);
  const before = await readdir(dir);
  const full = await tool.call({ image: 1 });
  assert.equal(full.success, true);
  assert.deepEqual(info(full).oriented, { width: 2, height: 2 });
  assert.equal(info(full).source.hasIccProfile, false);
  assert.match(info(full).output.colourHandling, /unverified/);
  const result = await tool.call({ image: 1, bbox: { x: 0, y: 1, width: 1, height: 1 }, scale: 4 });
  const { data, info: raw } = await sharp(decode(result)).raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual([raw.width, raw.height, raw.channels], [4, 4, 4]);
  for (let i = 0; i < data.length; i += 4) assert.deepEqual([...data.subarray(i, i + 4)], [0, 0, 255, 128]);
  assert.ok((await sharp(decode(result)).metadata()).icc);
  assert.deepEqual(await readdir(dir), before);
});

test("bbox coordinates address original EXIF-oriented pixels and output limits report actual scaling", async t => {
  const pixels = Buffer.from([255,0,0, 0,255,0, 0,0,255, 255,255,255, 0,0,0, 255,255,0]);
  const bytes = await sharp(pixels, { raw: { width: 3, height: 2, channels: 3 } }).withMetadata({ orientation: 6 }).png().toBuffer();
  const { tool, dir } = await fixture(t, bytes);
  const result = await tool.call({ image: 1, bbox: { x: 0, y: 0, width: 1, height: 1 }, scale: 2 });
  assert.deepEqual(info(result).oriented, { width: 2, height: 3 });
  assert.equal(info(result).source.exifOrientation, 6);
  assert.equal(info(result).source.hasIccProfile, true);
  const data = await sharp(decode(result)).raw().toBuffer();
  assert.deepEqual([...data.subarray(0, 3)], [255, 255, 255]);
  const path = join(dir, "large.png");
  await sharp({ create: { width: 2200, height: 2100, channels: 3, background: "red" } }).png().toFile(path);
  const large = await createImageInspection([path]).call({ image: 1, scale: 4 });
  const output = info(large).output;
  assert.ok(output.width <= 2048 && output.height <= 2048 && output.width * output.height <= 4_000_000);
  assert.ok(output.scaleX < 1);
  const metadata = await sharp(decode(large)).metadata();
  assert.deepEqual([metadata.width, metadata.height], [output.width, output.height]);
  await assert.rejects(createImageInspection([path]).call({ image: 1, bbox: { x: 0, y: 0, width: 2200, height: 2100 }, sample: true }), /100 万/);
});

test("inspection rejects arbitrary paths, non-input ids, invalid crops and unreadable inputs", async t => {
  const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer();
  const { tool, path } = await fixture(t, bytes);
  for (const args of [null, [], { image: 1, path }, { image: 1, url: "https://example.com" }, { image: 0 }, { image: 2 }, { image: "1" }, { image: 1, scale: 5 }, { image: 1, scale: NaN }, { image: 1, scale: "2" }, { image: 1, bbox: null }, { image: 1, bbox: { x: 1, y: 0, width: 2, height: 1 } }, { image: 1, bbox: { x: .5, y: 0, width: 1, height: 1 } }])
    await assert.rejects(tool.call(args));
  await writeFile(path, "not an image");
  await assert.rejects(tool.call({ image: 1 }), /无法读取/);
  await rm(path);
  await assert.rejects(tool.call({ image: 1 }), /无法读取/);
  await writeFile(path, '<svg width="2" height="2"></svg>');
  await assert.rejects(tool.call({ image: 1 }), /栅格/);
});

test("colour samples use original ROI pixels, exclude transparency and disclose partial alpha", async t => {
  const pixels = Buffer.from([10,20,30,255, 30,40,50,128, 250,250,250,0]);
  const bytes = await sharp(pixels, { raw: { width: 3, height: 1, channels: 4 } }).png().toBuffer();
  const { tool } = await fixture(t, bytes);
  const result = await tool.call({ image: 1, bbox: { x: 0, y: 0, width: 3, height: 1 }, scale: 4, sample: true });
  assert.deepEqual(info(result).sample.statistics, [
    { median: 20, min: 10, max: 30 }, { median: 30, min: 20, max: 40 }, { median: 40, min: 30, max: 50 },
  ]);
  assert.equal(info(result).sample.pixels, 2);
  assert.equal(info(result).sample.excludedTransparentPixels, 1);
  assert.equal(info(result).sample.partialAlphaPixels, 1);
  const empty = await tool.call({ image: 1, bbox: { x: 2, y: 0, width: 1, height: 1 }, sample: true });
  assert.deepEqual(info(empty).sample.statistics, [null, null, null]);
  await assert.rejects(tool.call({ image: 1, sample: true }), /需要 bbox/);
  await assert.rejects(tool.call({ image: 1, sample: "true" }), /布尔/);
});

for (const stage of ["metadata", "toBuffer"]) test(`cancellation during ${stage} prevents subsequent inspection stages`, async t => {
  const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer();
  const { tool } = await fixture(t, bytes);
  const controller = new AbortController();
  const reason = new Error("cancel inspection");
  const original = sharp.prototype[stage];
  let calls = 0;
  t.mock.method(sharp.prototype, stage, async function (...args) {
    calls++;
    const result = await original.apply(this, args);
    controller.abort(reason);
    return result;
  });
  if (stage === "metadata") t.mock.method(sharp.prototype, "toBuffer", () => assert.fail("decode started after cancellation"));
  await assert.rejects(tool.call({ image: 1, bbox: { x: 0, y: 0, width: 2, height: 2 }, sample: true }, { signal: controller.signal }), error => error === reason);
  assert.equal(calls, 1, "sampling must not start after cancelled PNG rendering");
  await assert.rejects(tool.call({ image: 1 }, { signal: controller.signal }), error => error === reason);
  assert.equal(calls, 1, "pre-cancelled calls do no image work");
});

test("user's inspection result shrinks to fit an Agent image byte limit or fails explicitly", async t => {
  // Given a noisy region whose full-size PNG exceeds the Agent's per-image byte limit.
  const noise = Buffer.alloc(600 * 600 * 3);
  for (let i = 0, x = 1; i < noise.length; i++) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; noise[i] = x >>> 24; }
  const bytes = await sharp(noise, { raw: { width: 600, height: 600, channels: 3 } }).png().toBuffer();
  const { path } = await fixture(t, bytes);
  // When the inspection runs with that limit.
  const limited = await createImageInspection([path], { maxBytes: 200_000 }).call({ image: 1 });
  // Then the PNG fits, the reported scale matches the actual output and the kernel stays nearest-neighbour.
  const output = info(limited).output;
  assert.ok(decode(limited).length <= 200_000);
  assert.ok(output.scaleX < 1 && output.width < 600);
  const metadata = await sharp(decode(limited)).metadata();
  assert.deepEqual([metadata.width, metadata.height], [output.width, output.height]);
  assert.match(JSON.stringify(info(limited)), /nearest/);
  // When no size could fit, Then the task is told to pick a smaller region instead of receiving an oversized image.
  await assert.rejects(createImageInspection([path], { maxBytes: 10 }).call({ image: 1 }), /图片大小限制/);
});
