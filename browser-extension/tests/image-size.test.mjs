import test from 'node:test';
import assert from 'node:assert/strict';
import { validImageSize, MAX_IMAGE_DIMENSION, MAX_IMAGE_PIXELS } from '../lib/image-size.mjs';

test('user selects gateway default or integer dimensions within the shared pixel budget', () => {
  // Given an omitted or explicit size, When validating, Then only bounded width/height pairs are accepted.
  assert.equal(MAX_IMAGE_DIMENSION, 10000); assert.equal(MAX_IMAGE_PIXELS, 40000000);
  for (const value of [undefined, { width: 1, height: 1 }, { width: 10000, height: 4000 }, { width: 5000, height: 8000 }]) assert.equal(validImageSize(value), true);
  for (const value of [null, [], 'auto', {}, { width: 1 }, { width: 0, height: 1 }, { width: -1, height: 1 }, { width: 1.1, height: 1 }, { width: Infinity, height: 1 }, { width: 10001, height: 1 }, { width: 10000, height: 4001 }, { width: 1, height: 1, extra: true }]) assert.equal(validImageSize(value), false);
});
