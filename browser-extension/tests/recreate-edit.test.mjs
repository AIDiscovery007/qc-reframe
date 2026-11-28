import test from 'node:test';
import assert from 'node:assert/strict';
import { EDIT_LIMITS, editPrompt, editRequested, normalizeEditRequest, referenceAspectRatio, sanitizeEditProfile, validEditProfile } from '../lib/recreate-edit.mjs';
import { parseResult } from '../bridge/agent.mjs';
import { validEditRequest } from '../lib/message-validation.ts';
import { createGenerationSession, generationReadiness } from '../lib/generation-session.ts';

const element = (label, currentZh, currentEn) => ({ label, currentZh, currentEn });
const raw = { styleZh: ' 厚涂油画（impasto）， 可见刮刀笔触 ', styleEn: 'Impasto oil painting', elements: [
  element('发色', '人物 齐肩黑发', 'shoulder-length black hair'),
  element('背景', '灰蓝色海边', 'grey-blue seaside'),
  element('文字', '左上角 "SALE"', 'top-left text "SALE"'),
] };
const profile = sanitizeEditProfile(raw);
const reverse = { title: '复刻', observations: ['观察'], promptZh: '提示词', promptEn: 'prompt', negativePrompt: '', uncertainties: [] };

test('user gets bridge-owned editable elements from Agent output, with malformed items dropped', () => {
  // Given Agent output with its own ids, blank or oversized items and extra fields,
  // When the profile is sanitized, Then valid items keep their order, whitespace is normalized and ids are reassigned e1…
  const sanitized = sanitizeEditProfile({ ...raw, elements: [
    { id: 'agent-9', ...raw.elements[0], extra: 'dropped' }, element('', '空名称', 'blank'), element('x'.repeat(EDIT_LIMITS.label + 1), '过长', 'long'),
    element('背景', '   ', 'blank current'), raw.elements[1],
  ] });
  assert.deepEqual(sanitized, { styleZh: '厚涂油画（impasto）， 可见刮刀笔触', styleEn: 'Impasto oil painting', elements: [
    { id: 'e1', label: '发色', currentZh: '人物 齐肩黑发', currentEn: 'shoulder-length black hair' },
    { id: 'e2', label: '背景', currentZh: '灰蓝色海边', currentEn: 'grey-blue seaside' },
  ] });
  assert.equal(validEditProfile(sanitized), true);
  const many = sanitizeEditProfile({ ...raw, elements: Array.from({ length: 20 }, (_, i) => element(`元素${i}`, '现状', 'current')) });
  assert.equal(many.elements.length, EDIT_LIMITS.elements);
  assert.equal(many.elements.at(-1).id, `e${EDIT_LIMITS.elements}`);
  for (const value of [undefined, null, [], {}, { ...raw, styleZh: '' }, { ...raw, styleEn: 'x'.repeat(EDIT_LIMITS.style + 1) }, { ...raw, elements: [element('', '', '')] }])
    assert.equal(sanitizeEditProfile(value), undefined, JSON.stringify(value));
  assert.equal(validEditProfile({ ...profile, elements: [profile.elements[0], profile.elements[0]] }), false, 'duplicate ids');
});

test('user keeps scanned elements only on recreate reverse results', () => {
  // Given the same Agent JSON with editProfile, When parsed for recreate and for other modes, Then only recreate keeps a sanitized profile.
  const text = JSON.stringify({ ...reverse, editProfile: { ...raw, elements: [{ id: 'x', ...raw.elements[0] }] } });
  assert.deepEqual(parseResult(text, 'recreate').editProfile, { ...profile, elements: [profile.elements[0]] });
  for (const mode of ['style', 'reenact', 'multi-reenact', 'session']) assert.equal('editProfile' in parseResult(text, mode), false, mode);
  assert.equal('editProfile' in parseResult(JSON.stringify({ ...reverse, editProfile: { elements: [] } }), 'recreate'), false);
});

test('user edit requests freeze in profile order and reject empty, stale or malformed changes', () => {
  // Given a saved profile, When changes arrive out of order with padding, Then the snapshot follows the profile and trims values.
  assert.deepEqual(normalizeEditRequest(profile, { changes: [{ id: 'e3', value: ' "OPEN" ' }, { id: 'e1', value: '金色短发' }], note: ' 人物微笑 ' }), {
    changes: [{ ...profile.elements[0], value: '金色短发' }, { ...profile.elements[2], value: '"OPEN"' }], note: '人物微笑',
  });
  assert.deepEqual(normalizeEditRequest(profile, { changes: [], note: '加一只猫' }), { changes: [], note: '加一只猫' });
  for (const [currentProfile, edit, message] of [
    [undefined, { changes: [{ id: 'e1', value: '金发' }] }, /重新逆向/],
    [profile, null, /无效的原图编辑参数/],
    [profile, { changes: [], extra: 1 }, /无效的原图编辑参数/],
    [profile, { changes: 'e1' }, /无效的原图编辑参数/],
    [profile, { changes: [], note: 'x'.repeat(EDIT_LIMITS.note + 1) }, /无效的原图编辑参数/],
    [profile, { changes: profile.elements.concat(profile.elements[0]).map(item => ({ id: item.id, value: 'v' })) }, /无效的原图编辑参数/],
    [profile, { changes: [{ id: 'e1', value: '金发', label: '伪造' }] }, /无效的原图编辑参数/],
    [profile, { changes: [{ id: 'e7', value: '金发' }] }, /不一致/],
    [profile, { changes: [{ id: 'e1', value: 'a' }, { id: 'e1', value: 'b' }] }, /不一致/],
    [profile, { changes: [{ id: 'e1', value: '' }] }, /1–500/],
    [profile, { changes: [{ id: 'e1', value: 'x'.repeat(EDIT_LIMITS.value + 1) }] }, /1–500/],
    [profile, { changes: [], note: '  ' }, /至少填写一项/],
  ]) assert.throws(() => normalizeEditRequest(currentProfile, edit), error => error.status === 400 && message.test(error.message), JSON.stringify(edit));
});

test('user edit prompts name each change against its current state and never reuse the copy prompt', () => {
  // Given a frozen snapshot, When assembled in either language, Then each line pairs current state and requested change, then the style anchor.
  const edit = normalizeEditRequest(profile, { changes: [{ id: 'e2', value: '夕阳下的麦田' }], note: '人物微笑' });
  const zh = editPrompt(profile, edit, 'zh');
  assert.match(zh, /^以图 1 为原图进行局部编辑：只改动下列修改项及其必然连带的局部/);
  assert.match(zh, /\n1\. 背景：图中为「灰蓝色海边」，改为「夕阳下的麦田」。\n其他要求：人物微笑\n/);
  assert.match(zh, /沿用图 1 的画风与渲染方式（厚涂油画（impasto）， 可见刮刀笔触）/);
  assert.doesNotMatch(zh, /提示词/);
  const en = editPrompt(profile, edit, 'en');
  assert.match(en, /^Edit image 1 locally: change only the items below/);
  assert.match(en, /1\. Currently "grey-blue seaside"; change to: "夕阳下的麦田"\.\nOther requirements: 人物微笑/);
  assert.match(en, /same style as image 1 \(Impasto oil painting\)/);
  assert.doesNotMatch(editPrompt(profile, normalizeEditRequest(profile, { changes: [{ id: 'e1', value: '金发' }] }), 'zh'), /其他要求/);
  const punctuated = { ...profile, styleZh: '平涂几何色块，带孔版印刷颗粒。', styleEn: 'Flat geometric blocks with risograph grain.' };
  assert.match(editPrompt(punctuated, edit, 'zh'), /（平涂几何色块，带孔版印刷颗粒）/);
  assert.match(editPrompt(punctuated, edit, 'en'), /\(Flat geometric blocks with risograph grain\)/);
});

test('user edit prompts keep every unchanged element by its observed state and let changes win on conflict', () => {
  // Given a profile of three elements and a change to only the background plus a free-form note,
  // When assembled in either language, Then the untouched elements are listed by their current state in profile order as things to keep,
  // the changes and note take precedence over that list, untouched aspects such as identity and per-part orientation stay with image 1,
  // and the output ratio is left to the bridge's own ratio line so a user-chosen ratio is never contradicted.
  const edit = normalizeEditRequest(profile, { changes: [{ id: 'e2', value: '夕阳下的麦田' }], note: '人物微笑' });
  const zh = editPrompt(profile, edit, 'zh');
  assert.match(zh, /\n\n保持不变（与图 1 一致；与上方修改冲突时以修改为准）：\n- 发色：人物 齐肩黑发\n- 文字：左上角 "SALE"\n\n/);
  assert.doesNotMatch(zh, /- 背景/);
  assert.match(zh, /修改未涉及的方面也与图 1 一致：主体身份与辨识特征（[^）]*脸型五官[^）]*）、姿态与各部位的朝向和偏转角度、/);
  assert.doesNotMatch(zh, /画幅|宽高比/);
  const en = editPrompt(profile, edit, 'en');
  assert.match(en, /\n\nKeep unchanged \(identical to image 1; where an item conflicts with the changes above, follow the changes\):\n- shoulder-length black hair\n- top-left text "SALE"\n\n/);
  assert.match(en, /Aspects the changes do not touch also stay identical to image 1: the subject's identity and distinguishing features \([^)]*face shape[^)]*\), the pose and the facing direction and turn angle of each part, /);
  assert.doesNotMatch(en, /aspect ratio/i);
  // Given every element is changed, Then there is nothing left to list, but untouched aspects are still kept.
  const all = editPrompt(profile, normalizeEditRequest(profile, { changes: profile.elements.map(item => ({ id: item.id, value: '新' })) }), 'zh');
  assert.doesNotMatch(all, /保持不变/);
  assert.match(all, /修改未涉及的方面也与图 1 一致/);
  const allEn = editPrompt(profile, normalizeEditRequest(profile, { changes: profile.elements.map(item => ({ id: item.id, value: 'new' })) }), 'en');
  assert.doesNotMatch(allEn, /Keep unchanged/);
});

test('user automatic recreate size follows a compact reference ratio within generation bounds', () => {
  // Given reference dimensions, When reduced, Then common ratios are exact and extremes are clamped to 1:20…20:1.
  for (const [width, height, expected] of [[1024, 768, [4, 3]], [1920, 1080, [16, 9]], [1080, 1920, [9, 16]], [1, 1, [1, 1]], [1000, 1, [20, 1]], [1, 1000, [1, 20]]])
    assert.deepEqual(referenceAspectRatio(width, height), { width: expected[0], height: expected[1] }, `${width}x${height}`);
  const odd = referenceAspectRatio(1234, 567);
  assert.ok(odd.height <= 32 && Math.abs(Math.log(odd.width / odd.height / (1234 / 567))) < 0.02);
  for (const [width, height] of [[0, 10], [10, -1], [NaN, 10], [10, Infinity]]) assert.equal(referenceAspectRatio(width, height), undefined);
});

test('user drafts are judged for submission the same way the bridge reads them', () => {
  // Given UI drafts, When checked, Then whitespace-only fields mean「保持不变」and a note alone counts as a change.
  assert.equal(editRequested({ changes: [{ id: 'e1', value: '  ' }] }), false);
  assert.equal(editRequested({ changes: [], note: ' 加一只猫 ' }), true);
  assert.equal(editRequested({ changes: [{ id: 'e2', value: '麦田' }] }), true);
  assert.equal(editRequested(undefined), false);
});

test('user messages carrying an edit are shape-checked before reaching the bridge', () => {
  // Given background message payloads, When validated, Then only {changes:[{id,value}], note?} within limits passes.
  assert.equal(validEditRequest({ changes: [{ id: 'e1', value: '金发' }] }), true);
  assert.equal(validEditRequest({ changes: [], note: '加一只猫' }), true);
  for (const edit of [undefined, null, [], 'e1', { changes: {} }, { changes: [], prompt: 'x' }, { changes: [{ id: 'x1', value: 'v' }] }, { changes: [{ id: 'e1', value: 1 }] },
    { changes: [{ id: 'e1', value: 'v', label: 'x' }] }, { changes: [{ id: 'e1', value: 'x'.repeat(EDIT_LIMITS.value + 1) }] },
    { changes: Array.from({ length: EDIT_LIMITS.elements + 1 }, (_, i) => ({ id: `e${i + 1}`, value: 'v' })) }, { changes: [], note: 1 }, { changes: [], note: 'x'.repeat(EDIT_LIMITS.note + 1) }])
    assert.equal(validEditRequest(edit), false, JSON.stringify(edit));
});

const job = (patch = {}) => ({ id: 'version-a', mode: 'recreate', result: { promptZh: '提示词', promptEn: 'prompt', editProfile: profile }, generations: [], ...patch });
const input = (patch = {}) => ({ job: job(), lang: 'zh', disabled: false, ...patch });
function session() {
  const requests = [];
  const value = createGenerationSession('version-a', message => { requests.push(message); return new Promise(() => {}); });
  return { session: value, requests, callbacks: { onUpdate() {}, onRequestState() {} } };
}

test('user submits a trimmed edit only on an editable recreate version', async () => {
  // Given an editable recreate version, When an edit with blank fields is submitted, Then the message carries only filled, trimmed changes.
  const f = session();
  assert.equal(generationReadiness(input()).editable, true);
  f.session.act(input({ edit: { changes: [{ id: 'e1', value: ' 金发 ' }, { id: 'e2', value: '  ' }], note: '  ' } }), false, f.callbacks);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.requests[0].edit, { changes: [{ id: 'e1', value: '金发' }] });
  assert.equal(f.requests[0].type, 'alchemy:generate');
});

test('user cannot send an edit that is empty, targets an old version or another mode', async () => {
  // Given versions without a profile, another mode or an empty draft, When an edit is submitted, Then no request is sent; text generation is unaffected.
  for (const patch of [
    { edit: { changes: [{ id: 'e1', value: '  ' }] } },
    { job: job({ result: { promptZh: '旧提示词', promptEn: 'old' } }), edit: { changes: [{ id: 'e1', value: '金发' }] } },
    { job: job({ mode: 'style', reenact: {} }), subjectImage: 'subject', edit: { changes: [{ id: 'e1', value: '金发' }] } },
  ]) {
    const f = session();
    assert.equal(await f.session.act(input(patch), false, f.callbacks), false, JSON.stringify(patch));
    assert.equal(f.requests.length, 0);
  }
  const legacy = input({ job: job({ result: { promptZh: '旧提示词', promptEn: 'old' } }) });
  assert.equal(generationReadiness(legacy).editable, false);
  const f = session();
  f.session.act(legacy, false, f.callbacks);
  assert.equal(f.requests.length, 1);
  assert.equal('edit' in f.requests[0], false);
});
