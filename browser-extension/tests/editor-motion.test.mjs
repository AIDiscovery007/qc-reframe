import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = await readFile(new URL('../entrypoints/workspace/editor-motion.ts', import.meta.url), 'utf8');
const exports = {};
runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports });
function fixture() {
  let rect = { left: 200, top: 700, width: 400, height: 200 };
  const animations = [];
  const motion = exports.createEditorMotion({
    getBoundingClientRect: () => ({ ...rect }),
    animate: (frames, options) => {
      const animation = { frames, options, cancelled: false, cancel() { this.cancelled = true; } };
      animations.push(animation);
      return animation;
    },
  });
  return { motion, animations, place: next => { rect = next; } };
}

test('FLIP reverses from visible interrupted bounds; stale completion cannot release the new layout', () => {
  const { motion, animations, place } = fixture();
  const large = { left: 200, top: 300, width: 800, height: 550 };
  let completions = 0;
  motion.run(() => place(large), false, () => completions++);
  assert.equal(animations[0].options.duration, 320);
  // Model the painted geometry halfway through the first animation.
  place({ left: 200, top: 500, width: 600, height: 375 });
  motion.run(() => place({ left: 200, top: 700, width: 400, height: 200 }), false, () => completions += 10);
  assert.equal(animations[0].cancelled, true);
  assert.equal(animations[1].frames[0].translate, '0px -200px');
  assert.equal(animations[1].frames[0].scale, '1.5 1.875');
  animations[0].onfinish();
  assert.equal(completions, 0);
  animations[1].onfinish();
  assert.equal(completions, 10);
  motion.settle();
  assert.equal(completions, 10);
});

test('keyboard/reduced-motion and lifecycle settling cancel motion and complete exactly once', () => {
  const { motion, animations, place } = fixture();
  let completions = 0;
  motion.run(() => place({ left: 0, top: 0, width: 800, height: 550 }), false);
  motion.run(() => place({ left: 200, top: 700, width: 400, height: 200 }), true, () => completions++);
  assert.equal(animations.length, 1);
  assert.equal(animations[0].cancelled, true);
  assert.equal(completions, 1);
  motion.settle();
  animations[0].onfinish();
  assert.equal(completions, 1);
});
