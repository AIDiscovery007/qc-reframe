import test from 'node:test';
import assert from 'node:assert/strict';
import * as generationSize from '../lib/generation-size.ts';
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

test('user legacy integer dimensions retain strict parsing and adapter bounds', () => {
  // Given legacy integer dimension text, When strictly parsed, Then fractions, scientific notation, blanks and excess pixels stay invalid for the legacy parser and bounded adapter.
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


test('user keeps positive finite pixel intent and incomplete dimensions mean automatic', () => {
  // Given custom pixel text, When edited, Then positive finite values survive unchanged and unusable pairs become automatic.
  assert.deepEqual(generationSize.parsePixelDimensions('10000.5', '1e3'), { width: 10000.5, height: 1000 });
  for (const [width, height] of [['', '1024'], ['-1', '1024'], ['0', '1024'], ['Infinity', '1024'], ['1e309', '1024'], ['word', '1024']]) {
    assert.equal(generationSize.parsePixelDimensions(width, height), undefined);
  }
});

test('user sees requested, normalized and output dimensions without reinterpreting old history', () => {
  // Given a saved normalization snapshot, When history is opened after models change, Then the recorded submission stays distinct from intent and output.
  assert.equal(generationSizeDescription({ provider: 'magpie', imageSize: { width: 10000, height: 10000 }, submittedImageSize: { width: 2048, height: 2048 }, sizeRule: 'gpt-test', outputSize: { width: 1024, height: 1024 } }), '请求尺寸：10000 × 10000 px · 提交尺寸：2048 × 2048 px · 实际图片：1024 × 1024 px');
  assert.equal(generationSizeDescription({ provider: 'magpie', imageSize: { width: 20, height: 30 }, submittedImageSize: null, sizeRule: 'unknown-auto' }), '请求尺寸：20 × 30 px · 提交尺寸：自动（网关默认）');
  assert.equal(generationSizeDescription({ provider: 'magpie', model: 'gpt-image-2', imageSize: { width: 10000, height: 10000 } }), '请求尺寸：10000 × 10000 px');
});
