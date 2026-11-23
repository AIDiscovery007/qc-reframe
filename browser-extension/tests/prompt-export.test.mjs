import test from 'node:test';
import assert from 'node:assert/strict';
import { promptMarkdown } from '../lib/prompt-export.ts';

const result = { title: '雨夜', observations: ['冷色霓虹'], promptZh: '中文', promptEn: 'English', negativePrompt: '', uncertainties: [] };
const job = overrides => ({ id: 'job', mode: 'reenact', sourceUrl: 'https://example.test/a.jpg', result, reenact: { subjectImage: 'x' }, ...overrides });

test('user exports attachments in the frozen task order, reference first for new tasks', () => {
  // Given new tasks that stored referenceIndex 0.
  // When the prompt sheet is exported.
  // Then the reference is image 1, followed by subjects in their saved order.
  assert.match(promptMarkdown(job({ referenceIndex: 0 })), /按顺序附图 1（参考图）、图 2（主体图）/);
  assert.match(promptMarkdown(job({ mode: 'multi-reenact', referenceIndex: 0, reenact: { subjects: [{}, {}] } })), /图 1（参考图）、图 2（主体 1）、图 3（主体 2）/);
});

test('user exports legacy tasks with subjects first and the reference last', () => {
  // Given a historical record without referenceIndex.
  // When it is exported.
  // Then the old interpretation is kept instead of being recomputed.
  assert.match(promptMarkdown(job({ mode: 'multi-reenact', reenact: { subjects: [{}, {}] } })), /图 1（主体 1）、图 2（主体 2）、图 3（参考图）/);
});

test('user exports recreate prompts without attachments and cannot export an unfinished task', () => {
  // Given a recreate task, and a task without a result.
  const sheet = promptMarkdown(job({ mode: 'recreate', reenact: undefined }));
  // Then recreate says no attachments are needed, empty sections are named, and an unfinished task exports nothing.
  assert.match(sheet, /模式：完整复刻\n\n使用方法：仅使用下方提示词生图，无需附图。/);
  assert.match(sheet, /## 排除项\n无\n/);
  assert.match(sheet, /## 不确定性\n无额外说明\n/);
  assert.equal(promptMarkdown(job({ result: undefined })), undefined);
});
