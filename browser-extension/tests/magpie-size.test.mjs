import test from 'node:test';
import assert from 'node:assert/strict';
import * as sizes from '../lib/image-size.mjs';
const model = 'yylx/gpt-image-2.5-flare';
const normalize = (value, selected = model) => sizes.normalizeMagpieSize(selected, value);
const legal = ({ width: w, height: h }) => w % 16 === 0 && h % 16 === 0 && Math.max(w, h) <= 3840 && Math.max(w, h) <= 3 * Math.min(w, h) && w * h >= 655360 && w * h <= 8294400;

test('user keeps legal GPT dimensions and sees experimental presets accurately', () => {
  // Given a supported model and legal size, When selected, Then normalization is idempotent and all presets meet its contract.
  for (const selected of ['yylx/gpt-image-2', 'codex/gpt-image-2', 'x/gpt-image-2-2026-04-21', model, 'x/gpt-image-2.5-sunburst-2026-09-08']) {
    for (const value of [{ width: 3840, height: 2160 }, { width: 1024, height: 1024 }, { width: 2048, height: 2048 }]) {
      const result = normalize(value, selected);
      assert.deepEqual(result.submittedImageSize, value);
      assert.deepEqual(normalize(result.submittedImageSize, selected), result);
      assert.equal(result.experimental, value.width * value.height > 3686400);
    }
    const presets = sizes.magpieSizePresets(selected);
    assert.ok(presets.length >= 10 && presets.length <= 20);
    for (const preset of presets) assert.ok(legal(preset.value), preset.label);
  }
});

test('user custom GPT dimensions choose the deterministic nearest legal ratio and area', () => {
  // Given illegal step/edge/area/ratio inputs, When submitted, Then all constraints hold and the documented product distance is minimized.
  for (const [value, expected] of [
    [{ width: 1500, height: 1000 }, { width: 1504, height: 1008 }],
    [{ width: 3840, height: 3840 }, { width: 2880, height: 2880 }],
    [{ width: 512, height: 512 }, { width: 816, height: 816 }],
    [{ width: 10000, height: 100 }, { width: 1728, height: 576 }],
    [{ width: 1601, height: 900 }, { width: 1600, height: 896 }],
  ]) {
    const frozen = structuredClone(value);
    const result = normalize(value);
    assert.deepEqual(result.submittedImageSize, expected);
    assert.deepEqual(value, frozen);
    assert.ok(legal(expected));
    assert.deepEqual(normalize(expected).submittedImageSize, expected);
  }
  for (const value of [{ width: Number.MAX_VALUE, height: Number.MAX_VALUE }, { width: Number.MIN_VALUE, height: 1 }, { width: 0.1, height: 0.1 }, { width: 1024.5, height: 1536.5 }]) assert.ok(legal(normalize(value).submittedImageSize));
});

test('user selects Gemini composition without a false pixel resolution guarantee', () => {
  // Given a recognized Gemini model, When a ratio or custom dimensions are chosen, Then only the gateway ten-ratio contract is used.
  const gemini = 'yylx/gemini-3.1-flash-image-preview';
  assert.equal(sizes.magpieSizeProfile(gemini), 'gemini');
  const presets = sizes.magpieSizePresets(gemini);
  assert.equal(presets.length, 10);
  for (const preset of presets) {
    const result = normalize(preset.value, gemini);
    assert.equal(result.aspectRatio, preset.label);
    assert.deepEqual(result.submittedImageSize, preset.value);
    assert.equal(result.experimental, false);
  }
  assert.equal(normalize({ width: 10000, height: 100 }, gemini).aspectRatio, '21:9');
  assert.equal(normalize({ width: 1, height: 9999 }, gemini).aspectRatio, '9:16');
});

test('user unknown models and unusable input fall back to explicit gateway default', () => {
  // Given unknown aliases or empty/non-finite/non-positive input, When normalized, Then no invented size is sent or serialized as NaN.
  for (const selected of ['fixture/image', 'codex/gpt-image-2.5', 'x/my-gpt-image-2', 'x/gpt-image-2.5-flare-custom', undefined]) {
    assert.equal(sizes.magpieSizeProfile(selected), 'unknown');
    assert.equal(sizes.normalizeMagpieSize(selected, { width: 1024, height: 1024 }).submittedImageSize, null);
    assert.deepEqual(sizes.magpieSizePresets(selected), []);
  }
  for (const value of [undefined, null, {}, { width: NaN, height: 1024 }, { width: Infinity, height: 1 }, { width: 0, height: 1 }, { width: -3, height: 10 }, { width: null, height: 1 }]) {
    assert.equal(normalize(value).submittedImageSize, null);
    assert.equal(sizes.requestedImageSize(value), undefined);
    assert.ok(!JSON.stringify(normalize(value)).includes('NaN'));
  }
  const value = { width: 10000.5, height: 4001 };
  assert.deepEqual(sizes.requestedImageSize(value), value);
  assert.equal(sizes.validImageSizeRequest(value), true);
  for (const value of [[], 'auto', { width: '10', height: 10 }, { width: 1, height: 1, extra: true }]) assert.equal(sizes.validImageSizeRequest(value), false);
});
