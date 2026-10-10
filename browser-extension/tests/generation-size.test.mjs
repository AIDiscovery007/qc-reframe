import test from 'node:test';
import assert from 'node:assert/strict';
import { inheritedGenerationSize, parseImageDimensions, generationSizeDescription } from '../lib/generation-size.ts';
import { validImageSize } from '../lib/image-size.mjs';

test('user switches channels without converting old ratios into pixels or pixels into ratios', () => {
  // Given legacy ratios and pixel history, When the active channel changes, Then only dimensions of the same kind are inherited.
  const old = { aspectRatio: { width: 3, height: 2 } };
  const current = { provider: 'magpie', imageSize: { width: 1536, height: 1024 } };
  assert.equal(inheritedGenerationSize(true, old), undefined);
  assert.deepEqual(inheritedGenerationSize(false, old), old.aspectRatio);
  assert.equal(inheritedGenerationSize(false, current), undefined);
  assert.deepEqual(inheritedGenerationSize(true, current), current.imageSize);
  assert.equal(inheritedGenerationSize(true, { provider: 'magpie', aspectRatio: old.aspectRatio }), undefined);
  const snapshot = inheritedGenerationSize(true, current);
  current.imageSize.width = 2048;
  assert.deepEqual(snapshot, { width: 1536, height: 1024 });
});

test('user custom pixels accept canonical integers within the pixel budget', () => {
  // Given custom dimension text, When parsed, Then fractions, scientific notation, blanks and excess pixels cannot be submitted.
  assert.deepEqual(parseImageDimensions('1536', '1024'), { width: 1536, height: 1024 });
  for (const [width, height] of [['', '1024'], ['1e3', '1024'], ['01', '1024'], ['1.0', '1024'], ['1.5', '1024'], ['10001', '1'], ['10000', '4001'], [' 1024', '1024']]) {
    assert.equal(validImageSize(parseImageDimensions(width, height)), false, `${width} × ${height}`);
  }
  assert.equal(validImageSize(parseImageDimensions('10000', '4000')), true);
});

test('user sees requested pixels separately from actual returned dimensions', () => {
  // Given a gateway returns a different size, When history is inspected, Then the requested and actual sizes are both explicit.
  assert.equal(generationSizeDescription({ provider: 'magpie', imageSize: { width: 1536, height: 1024 }, outputSize: { width: 1024, height: 1024 } }), '请求尺寸：1536 × 1024 px · 实际图片：1024 × 1024 px');
  assert.equal(generationSizeDescription({ provider: 'magpie' }), '请求尺寸：Magpie 网关默认');
  assert.equal(generationSizeDescription({ aspectRatio: { width: 3, height: 2 } }), '请求比例：3:2');
});
