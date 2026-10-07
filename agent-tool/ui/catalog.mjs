// Rule ownership and coverage, not a second source of design values.
const popup = 'browser-extension/entrypoints/popup/';
const workspace = 'browser-extension/entrypoints/workspace/';
export const rules = [
  { id: 'UI-CSS-IMPORT', title: '共享样式装载边界', kind: 'static', surfaces: ['workspace', 'popup', 'content'], sources: [popup + 'style.css', 'browser-extension/entrypoints/content.ts', workspace + 'main.tsx'], intent: '共享组件样式通过 style.css 聚合，网页端注入 ShadowRoot；组件不直接加载 CSS。' },
  { id: 'UI-TOKEN-DEFINED', title: '变量有定义或回退', kind: 'static', surfaces: ['workspace', 'popup', 'content'], sources: [popup + 'style.css', workspace + 'results.css'], intent: 'CSS 变量必须有已知定义或合法回退；静态检查不证明运行时继承作用域。' },
  { id: 'UI-TOKEN-COLOR', title: '品牌色复用 token', kind: 'static', surfaces: ['workspace', 'popup', 'content'], sources: [popup + 'style.css'], intent: '新声明复用已有品牌色变量；存量裸值先警告，不把所有固定数值视为错误。' },
  { id: 'UI-LAYOUT-CANVAS', title: '工作台画布关系', kind: 'geometry', surfaces: ['workspace'], sources: [workspace + 'CanvasWorkspace.tsx', workspace + 'canvas-workspace.css', workspace + 'results.css'], intent: '宽屏双画布等宽，共享标签、画布、图条轨道；窄屏关闭侧 inert。' },
  { id: 'UI-LAYOUT-QUICK', title: '轻量画布与图条', kind: 'geometry', surfaces: ['popup'], sources: [popup + 'QuickWorkspace.tsx', popup + 'compact-editor.css'], intent: '保持已确认的轻量画布和图条尺寸，空态与有图状态分开验证。' },
  { id: 'UI-IMAGE-PREVIEW', title: '图片预览入口', kind: 'geometry', surfaces: ['workspace', 'popup'], sources: [popup + 'ImagePreview.tsx', popup + 'image-preview.css'], intent: '预览按钮贴合实际 contain 图片边缘，图片失败后不提供无效入口。' },
];

export const components = [
  { name: 'SelectField', source: popup + 'SelectField.tsx', use: '所有下拉框；保留原生键盘、禁用及 Escape 行为。' },
  { name: 'ImagePreview / ImageViewer', source: popup + 'ImagePreview.tsx', use: '可放大图片；列表缩略图不开放预览，编辑输入才传旋转能力。' },
  { name: 'QuickWorkspace', source: popup + 'QuickWorkspace.tsx', use: 'popup 与网页浮层的轻量创作，不复制工作台完整编辑能力。' },
  { name: 'CanvasWorkspace', source: workspace + 'CanvasWorkspace.tsx', use: '工作台输入画布与共享轨道。新增控件先确认所在轨道。' },
  { name: 'TaskInstruction', source: popup + 'TaskInstruction.tsx', use: '共用任务指令；沿用领域层的提交保护。' },
  { name: 'InlineHelp', source: popup + 'InlineHelp.tsx', use: '低频文字帮助；错误、费用和禁用原因保持可见。' },
  { name: 'motion-dialog', source: 'browser-extension/lib/motion-dialog.ts', use: '原生 dialog 的蒙板关闭、忙碌保护与焦点恢复。' },
];

const wide = { width: 1440, height: 1000 };
export const scenarios = [
  { id: 'workspace-wide', surface: 'workspace', path: '/workspace.html?state=alignment', viewport: wide, rules: ['UI-LAYOUT-CANVAS', 'UI-IMAGE-PREVIEW'] },
  { id: 'workspace-prompt', surface: 'workspace', path: '/workspace.html?state=alignment', viewport: wide, prepare: 'prompt', rules: ['UI-LAYOUT-CANVAS', 'UI-IMAGE-PREVIEW'] },
  { id: 'workspace-narrow', surface: 'workspace', path: '/workspace.html?state=alignment', viewport: { width: 600, height: 900 }, rules: ['UI-LAYOUT-CANVAS', 'UI-IMAGE-PREVIEW'] },
  { id: 'popup', surface: 'popup', path: '/popup.html?state=alignment', viewport: { width: 400, height: 740 }, rules: ['UI-LAYOUT-QUICK', 'UI-IMAGE-PREVIEW'] },
  { id: 'popup-narrow', surface: 'popup', path: '/popup.html?state=alignment', viewport: { width: 320, height: 740 }, rules: ['UI-LAYOUT-QUICK', 'UI-IMAGE-PREVIEW'] },
  { id: 'popup-image-failed', surface: 'popup', path: '/popup.html?state=alignment', viewport: { width: 400, height: 740 }, prepare: 'image-failed', rules: ['UI-LAYOUT-QUICK', 'UI-IMAGE-PREVIEW'] },
  { id: 'generation-actions', surface: 'workspace', path: '/workspace.html?state=alignment&mode=recreate&generationActionsRegression=1&generationDelay=60000&generationStartDelay=200', viewport: wide, regression: 'generationActionsRegression', rules: [] },
  { id: 'auto-style', surface: 'workspace', path: '/workspace.html?state=projects&mode=style&autoStyleRegression=1&inputSaveDelay=250', viewport: wide, regression: 'autoStyleRegression', rules: [] },
  { id: 'creation-context', surface: 'workspace', path: '/workspace.html?state=alignment&mode=recreate&inputSaveDelay=1800&creationContextRegression=mode', viewport: wide, regression: 'creationContextRegression', rules: [] },
  { id: 'settings-recovery', surface: 'workspace', path: '/workspace.html?state=library&settingsRegression=1', viewport: wide, regression: 'settingsRegression', rules: [] },
];

export const uncovered = [
  '真实扩展安装、权限、跨域、宿主网页及 closed ShadowRoot 内部几何未验证。',
  '静态 token 定义检查不证明每个选择器的继承、级联和 computed value 正确。',
  '第一阶段没有像素视觉基线；截图用于复核，不能证明全部设计或动效正确。',
  '仅覆盖目录列出的场景与规则；预览有通知条及尺寸修正，不能混作实机截图。',
];
