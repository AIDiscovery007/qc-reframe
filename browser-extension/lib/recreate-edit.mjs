// 完整复刻「原图编辑」的共同规则：逆向输出的可编辑元素、用户修改项的校验与生图提示词拼装。
// Bridge 用它做权威校验和拼装，界面只用它预览和判断能否提交。

export const EDIT_LIMITS = { elements: 12, label: 24, current: 600, style: 1200, value: 500, note: 1000 };

const text = (value, max) => typeof value === 'string' && !!value.trim() && value.length <= max;
const clean = value => value.replace(/\s+/g, ' ').trim();

/** Keep only well-formed elements from Agent output; ids are reassigned so the bridge, not the Agent, owns them. */
export function sanitizeEditProfile(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.elements)) return undefined;
  if (!text(value.styleZh, EDIT_LIMITS.style) || !text(value.styleEn, EDIT_LIMITS.style)) return undefined;
  const elements = value.elements
    .filter(item => item && typeof item === 'object' && text(item.label, EDIT_LIMITS.label) && text(item.currentZh, EDIT_LIMITS.current) && text(item.currentEn, EDIT_LIMITS.current))
    .slice(0, EDIT_LIMITS.elements)
    .map((item, index) => ({ id: `e${index + 1}`, label: clean(item.label), currentZh: clean(item.currentZh), currentEn: clean(item.currentEn) }));
  return elements.length ? { styleZh: clean(value.styleZh), styleEn: clean(value.styleEn), elements } : undefined;
}

export function validEditProfile(profile) {
  return !!profile && typeof profile === 'object' && text(profile.styleZh, EDIT_LIMITS.style) && text(profile.styleEn, EDIT_LIMITS.style)
    && Array.isArray(profile.elements) && profile.elements.length >= 1 && profile.elements.length <= EDIT_LIMITS.elements
    && profile.elements.every(item => item && /^e\d{1,2}$/.test(item.id) && text(item.label, EDIT_LIMITS.label) && text(item.currentZh, EDIT_LIMITS.current) && text(item.currentEn, EDIT_LIMITS.current))
    && new Set(profile.elements.map(item => item.id)).size === profile.elements.length;
}

/** True when the draft would change something; empty fields mean「保持不变」. */
export function editRequested(edit) {
  return !!edit && (edit.changes?.some(item => typeof item.value === 'string' && item.value.trim()) || (typeof edit.note === 'string' && !!edit.note.trim()));
}

/** Validate a submitted request against the saved profile. Returns the frozen snapshot in profile order, or throws. */
export function normalizeEditRequest(profile, edit) {
  const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
  if (!validEditProfile(profile)) fail('此版本没有可编辑元素，请重新逆向后再使用原图编辑');
  if (!edit || typeof edit !== 'object' || Array.isArray(edit) || Object.keys(edit).some(key => !['changes', 'note'].includes(key))) fail('无效的原图编辑参数');
  const { changes = [], note = '' } = edit;
  if (!Array.isArray(changes) || changes.length > profile.elements.length || typeof note !== 'string' || note.length > EDIT_LIMITS.note) fail('无效的原图编辑参数');
  const values = new Map();
  for (const change of changes) {
    if (!change || typeof change !== 'object' || Array.isArray(change) || Object.keys(change).some(key => !['id', 'value'].includes(key))) fail('无效的原图编辑参数');
    if (!profile.elements.some(item => item.id === change.id) || values.has(change.id)) fail('修改项与当前提示词版本不一致，请刷新后重试');
    if (!text(change.value, EDIT_LIMITS.value)) fail(`每项修改须填写 1–${EDIT_LIMITS.value} 个字符`);
    values.set(change.id, change.value.trim());
  }
  if (!values.size && !note.trim()) fail('请至少填写一项修改');
  return {
    changes: profile.elements.filter(item => values.has(item.id)).map(item => ({ ...item, value: values.get(item.id) })),
    note: note.trim(),
  };
}

/**
 * The image-edit prompt sent with the original as image 1. It never reuses the full reverse prompt, which would ask for an unchanged copy.
 * Untouched elements are restated by their observed state so the model has concrete anchors to keep; the changes win where they overlap.
 * The output ratio is left to the bridge's ratio line, so a user-chosen ratio is never contradicted here.
 */
export function editPrompt(profile, edit, language) {
  const zh = language === 'zh';
  // The anchor sits inside parentheses, so its own closing punctuation would read「…。）」.
  const style = (zh ? profile.styleZh : profile.styleEn).replace(/[\s。．.；;，,]+$/, '');
  const changed = new Set(edit.changes.map(item => item.id));
  const lines = edit.changes.map((item, index) => zh
    ? `${index + 1}. ${item.label}：图中为「${item.currentZh}」，改为「${item.value}」。`
    : `${index + 1}. Currently "${item.currentEn}"; change to: "${item.value}".`);
  if (edit.note) lines.push(zh ? `其他要求：${edit.note}` : `Other requirements: ${edit.note}`);
  const kept = profile.elements.filter(item => !changed.has(item.id)).map(item => zh ? `- ${item.label}：${item.currentZh}` : `- ${item.currentEn}`);
  const keep = kept.length ? [`${zh
    ? '保持不变（与图 1 一致；与上方修改冲突时以修改为准）：'
    : 'Keep unchanged (identical to image 1; where an item conflicts with the changes above, follow the changes):'}\n${kept.join('\n')}`] : [];
  return (zh ? [
    '以图 1 为原图进行局部编辑：只改动下列修改项及其必然连带的局部（如新衣物的褶皱与投影），其余区域保持图 1 原样。',
    `修改：\n${lines.join('\n')}`,
    ...keep,
    '修改未涉及的方面也与图 1 一致：主体身份与辨识特征（如人物的脸型五官、肤质与妆容）、姿态与各部位的朝向和偏转角度、构图机位与裁切、配色与光影、材质与清晰度。',
    `新增或改动的内容沿用图 1 的画风与渲染方式（${style}），在透视、光照和笔触上与周围画面自然衔接，不留拼贴或修补痕迹。`,
  ] : [
    'Edit image 1 locally: change only the items below and the local effects they necessarily bring (such as the folds and shadows of new clothing); keep every other area exactly as in image 1.',
    `Changes:\n${lines.join('\n')}`,
    ...keep,
    "Aspects the changes do not touch also stay identical to image 1: the subject's identity and distinguishing features (such as a person's face shape and features, skin texture and makeup), the pose and the facing direction and turn angle of each part, camera position and crop, palette and lighting, materials and sharpness.",
    `Render new or changed content in the same style as image 1 (${style}), matching its perspective, lighting and brushwork so it blends in without collage or patch artifacts.`,
  ]).join('\n\n');
}

/** A compact width:height close to the reference, within the generation ratio bounds. */
export function referenceAspectRatio(width, height) {
  if (![width, height].every(value => Number.isFinite(value) && value > 0)) return undefined;
  const ratio = Math.min(20, Math.max(1 / 20, width / height));
  let best = { width: 1, height: 1 }, error = Infinity;
  for (let h = 1; h <= 32; h++) {
    const w = Math.max(1, Math.round(ratio * h));
    const next = Math.abs(Math.log(w / h / ratio));
    if (next < error - 1e-9 && w / h >= 1 / 20 && w / h <= 20) { best = { width: w, height: h }; error = next; }
  }
  return best;
}
