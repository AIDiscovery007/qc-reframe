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
  { id: 'UI-IMAGE-VIEWPORT', title: '图片视口与独立缩放栏', kind: 'interaction', surfaces: ['workspace', 'popup'], sources: [popup + 'ImageViewer.tsx', popup + 'image-viewer.css', popup + 'ImagePreview.tsx', popup + 'image-preview.css'], intent: '控制行占独立空间，不与图片视口相交；适配完整可见，缩放平移裁剪于视口，工具栏不触发图片手势。' },
  { id: 'UI-EXAMPLE-STATE', title: '生产组件代表状态', kind: 'interaction', surfaces: ['workspace', 'popup'], sources: [popup + 'QuickWorkspace.tsx', workspace + 'CanvasWorkspace.tsx'], intent: '预览数据驱动真实组件的空态、读取、忙碌、失败、禁用、长文本和窄屏；不通过改DOM伪造业务状态。' },
  { id: 'UI-EXAMPLE-KEYBOARD', title: '原生控件与浮层交互', kind: 'interaction', surfaces: ['workspace', 'popup'], sources: [popup + 'SelectField.tsx', popup + 'InlineHelp.tsx', popup + 'ImagePreview.tsx', 'browser-extension/lib/motion-dialog.ts'], intent: '真实键盘验证原生select、帮助展开、图片缩放、dialog焦点约束、Escape关闭和焦点返回。' },
];

export const components = [
  { name: 'ImageGenerationSettings', source: popup + 'ImageGenerationSettings.tsx', use: '设置中的生图渠道、私有凭据及保存反馈。' },
  { name: 'AgentCliSettings', source: popup + 'AgentCliSettings.tsx', use: '按管理目标读取CLI状态、安装与更新，不改变逆向Agent，迟到响应按目标隔离。' },
  { name: 'AgentSettings', source: popup + 'AgentSettings.tsx', use: '设置中的原生 Agent 单选卡片，独立模型、失败保留与旧服务回退。' },
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
  ...[360, 650, 651, 877, 1440].map(width => ({
    id: `batch-toolbar-${width}`, surface: 'workspace', path: '/workspace.html?state=library&count=24',
    viewport: { width, height: 1034 }, regression: 'batchToolbar', batchToolbar: true, rules: [],
  })),
  ...['mixed', 'retry', 'late', 'narrow', 'keyboard', 'history', 'hidden', 'all-accepted', 'preflight-hidden', 'retry-hidden'].map(flow => ({
    id: `batch-recreate-${flow}`, surface: 'workspace',
    path: `/workspace.html?state=library&count=4&batchRecreateRegression=${flow}${['late', 'preflight-hidden'].includes(flow) ? '&batchPreviewDelay=1500' : ''}`,
    viewport: ['narrow', 'keyboard'].includes(flow) ? { width: 360, height: 740 } : wide,
    regression: 'batchRecreateRegression', batchKeyboard: ['keyboard', 'all-accepted'].includes(flow), batchAllAccepted: flow === 'all-accepted', rules: [],
  })),
  { id: 'workspace-wide', surface: 'workspace', path: '/workspace.html?state=alignment', viewport: wide, rules: ['UI-LAYOUT-CANVAS', 'UI-IMAGE-PREVIEW'] },
  { id: 'workspace-prompt', surface: 'workspace', path: '/workspace.html?state=alignment', viewport: wide, prepare: 'prompt', rules: ['UI-LAYOUT-CANVAS', 'UI-IMAGE-PREVIEW'] },
  { id: 'workspace-narrow', surface: 'workspace', path: '/workspace.html?state=alignment', viewport: { width: 600, height: 900 }, rules: ['UI-LAYOUT-CANVAS', 'UI-IMAGE-PREVIEW'] },
  { id: 'popup', surface: 'popup', path: '/popup.html?state=alignment', viewport: { width: 400, height: 740 }, rules: ['UI-LAYOUT-QUICK', 'UI-IMAGE-PREVIEW'] },
  { id: 'popup-narrow', surface: 'popup', path: '/popup.html?state=alignment', viewport: { width: 320, height: 740 }, rules: ['UI-LAYOUT-QUICK', 'UI-IMAGE-PREVIEW'] },
  { id: 'popup-image-failed', surface: 'popup', path: '/popup.html?state=alignment', viewport: { width: 400, height: 740 }, prepare: 'image-failed', rules: ['UI-LAYOUT-QUICK', 'UI-IMAGE-PREVIEW'] },
  ...[['workspace', 'magpie'], ['popup', 'magpie'], ['workspace', 'ready'], ['popup', 'ready'], ['workspace', 'blocked'], ['workspace', 'legacy'], ['workspace', 'legacy-empty']].map(([surface, state]) => ({
    id: `generation-readiness-${surface}-${state}`, surface,
    path: `/${surface}.html?state=alignment&mode=recreate&generationReadinessRegression=${state}&generationDelay=60000`,
    viewport: surface === 'popup' ? { width: 360, height: 740 } : wide, regression: 'generationReadinessRegression', rules: [],
  })),
  { id: 'generation-actions', surface: 'workspace', path: '/workspace.html?state=alignment&mode=recreate&generationActionsRegression=1&generationDelay=60000&generationStartDelay=200', viewport: wide, regression: 'generationActionsRegression', rules: [] },
  ...['workspace', 'popup'].flatMap(surface => ['cancel', 'legacy', 'failure', 'tab', 'tab-failure', 'project', 'project-failure'].map(flowKeyboardCase => ({
    id: `end-to-end-keyboard-${surface}-${flowKeyboardCase}`, surface,
    path: `/${surface}.html?state=alignment&mode=recreate&endToEndKeyboard=1&startDelay=4000&reverseDelay=60000${flowKeyboardCase === 'legacy' ? '&start=legacy' : flowKeyboardCase.includes('failure') ? '&start=failed' : ''}`,
    viewport: surface === 'popup' ? { width: 320, height: 740 } : wide, regression: 'endToEndKeyboard', flowKeyboardCase, rules: [],
  }))),
  { id: 'end-to-end-popup-start-failed', surface: 'popup', path: '/popup.html?state=alignment&mode=recreate&endToEndRegression=popup-start-failed&generationDelay=1000', viewport: { width: 320, height: 740 }, regression: 'endToEndRegression', rules: [] },
  ...['workspace', 'popup', 'cancel', 'phase-cancel', 'context', 'reverse-failed', 'generation-failed'].map(flow => ({
    id: `end-to-end-${flow}`, surface: flow === 'popup' ? 'popup' : 'workspace',
    path: `/${flow === 'popup' ? 'popup' : 'workspace'}.html?state=alignment&mode=recreate&endToEndRegression=${flow}&generationDelay=1000&startDelay=200${flow === 'phase-cancel' ? '&reverseDelay=300&generationStartDelay=2000' : '&reverseDelay=1500'}${flow === 'reverse-failed' ? '&reverse=failed' : ''}${flow === 'generation-failed' ? '&fx=failed' : ''}`,
    viewport: flow === 'popup' ? { width: 320, height: 740 } : wide, regression: 'endToEndRegression', rules: [],
  })),
  ...[
    ['image-order-paired', 'projects', 'style', 'paired'],
    ['image-order-multi', 'multi', 'multi-reenact', 'multi'],
    ['image-order-legacy', 'projects', 'style', 'legacy'],
    ['image-order-failed', 'projects', 'style', 'failed'],
    ['image-order-popup', 'projects', 'style', 'popup'],
  ].map(([id, state, mode, regression]) => ({ id, surface: regression === 'popup' ? 'popup' : 'workspace', path: `/${regression === 'popup' ? 'popup' : 'workspace'}.html?state=${state}&mode=${mode}&imageOrderRegression=${regression}&inputSaveDelay=100${regression === 'failed' ? '&inputSaveFailures=1' : ''}`, viewport: regression === 'popup' ? { width: 400, height: 740 } : wide, regression: 'imageOrderRegression', rules: [] })),
  ...[
    ['default-paired', 'projects', 'style', 'paired', 'default'],
    ['legacy-paired', 'projects', 'reenact', 'instruction-legacy', 'legacy'],
    ['default-multi', 'multi', 'multi-reenact', 'multi', 'default'],
  ].map(([id, state, mode, regression, instruction]) => ({ id: `image-instruction-${id}`, surface: 'workspace', path: `/workspace.html?state=${state}&mode=${mode}&imageOrderRegression=${regression}&instructionFixture=${instruction}&inputSaveDelay=100`, viewport: wide, regression: 'imageOrderRegression', rules: [] })),
  ...['new', 'history', 'failure', 'late'].map(keyboardCase => ({ id: `image-order-keyboard-${keyboardCase}`, surface: 'popup', path: `/popup.html?state=projects&mode=style&inputSaveDelay=4000${keyboardCase === 'new' ? '&imageOrderFixture=new' : ''}${keyboardCase === 'failure' ? '&inputSaveFailures=1' : ''}`, viewport: { width: 320, height: 740 }, regression: 'imageOrderKeyboard', keyboardCase, rules: [] })),
  { id: 'auto-style', surface: 'workspace', path: '/workspace.html?state=projects&mode=style&autoStyleRegression=1&inputSaveDelay=250', viewport: wide, regression: 'autoStyleRegression', rules: [] },
  { id: 'creation-context', surface: 'workspace', path: '/workspace.html?state=alignment&mode=recreate&inputSaveDelay=1800&creationContextRegression=mode', viewport: wide, regression: 'creationContextRegression', rules: [] },
  { id: 'settings-recovery-narrow', surface: 'workspace', path: '/workspace.html?state=library&settingsRegression=1', viewport: { width: 320, height: 740 }, regression: 'settingsRegression', rules: [] },
  { id: 'settings-recovery', surface: 'workspace', path: '/workspace.html?state=library&settingsRegression=1', viewport: wide, regression: 'settingsRegression', rules: [] },
];

export const exampleScenarios = [
  ...['wide', 'narrow', 'legacy'].map(variant => ({ id: `image-settings-${variant}`, surface: 'workspace', path: `/workspace.html?state=library&imageSettingsRegression=${variant}`, viewport: variant === 'narrow' ? { width: 360, height: 740 } : wide, regression: 'imageSettingsRegression', example: 'image-settings', title: '生图渠道设置', states: ['saved', 'failure', 'narrow'], components: ['ImageGenerationSettings'], steps: '打开设置保存直连API与Magpie，检查连接失败、旧目录迟到、保存恢复、重开与密钥不回显。', rules: [] })),
  { id: 'example-workspace-empty', title: '工作台新项目空态', surface: 'workspace', path: '/workspace.html?state=empty', viewport: wide, example: 'empty', states: ['empty'], components: ['CanvasWorkspace'], steps: '关闭首次连接设置，查看尚未选择参考图的工作台。' },
  { id: 'example-popup-empty', title: '轻量上传空态', surface: 'popup', path: '/popup.html?state=empty', viewport: { width: 400, height: 740 }, example: 'empty', states: ['empty'], components: ['QuickWorkspace'], steps: '查看上传入口；没有项目时不显示任务提交区。' },
  { id: 'example-input-loading', title: '参考图读取中', surface: 'workspace', path: '/workspace.html?state=alignment&reference=pending&referenceDelay=60000', viewport: wide, example: 'loading', states: ['loading', 'disabled'], components: ['CanvasWorkspace'], steps: '读取延迟60秒，检查原画布等待反馈与提交保护。' },
  { id: 'example-reverse-busy', title: '逆向忙碌与取消入口', surface: 'popup', path: '/popup.html?state=running', viewport: { width: 400, height: 740 }, example: 'busy', states: ['busy', 'disabled'], components: ['QuickWorkspace'], steps: '查看阶段状态、取消入口和输入禁用；不调用真实模型。' },
  { id: 'example-reverse-failed', title: '逆向失败与恢复入口', surface: 'popup', path: '/popup.html?state=failed', viewport: { width: 400, height: 740 }, example: 'failed', states: ['failed'], components: ['QuickWorkspace'], steps: '查看可读错误与检查模型/登录的恢复入口。' },
  { id: 'example-no-model', title: '模型未验证的禁用保护', surface: 'popup', path: '/popup.html?state=models-new', viewport: { width: 400, height: 740 }, example: 'disabled', states: ['disabled'], components: ['QuickWorkspace'], steps: '参考图存在但没有已验证模型，提交与指令输入应禁用。' },
  { id: 'example-long-instruction', title: '长指令与展开提示词', surface: 'workspace', path: '/workspace.html?state=alignment', viewport: wide, example: 'long', states: ['long-text'], components: ['CanvasWorkspace', 'TaskInstruction'], steps: '切到完整复刻，输入长指令并打开提示词；自动验收保留草稿并检查几何。' },
  { id: 'example-narrow-input', title: '窄屏输入区', surface: 'workspace', path: '/workspace.html?state=alignment', viewport: { width: 600, height: 900 }, example: 'narrow-input', states: ['narrow'], components: ['CanvasWorkspace'], steps: '窗口宽度600px，点击输入画布；结果侧应inert。' },
  { id: 'example-narrow-result', title: '窄屏结果区', surface: 'workspace', path: '/workspace.html?state=alignment', viewport: { width: 600, height: 900 }, example: 'narrow-result', states: ['narrow'], components: ['CanvasWorkspace'], steps: '窗口宽度600px，点击生成结果；输入侧应inert。' },
  { id: 'example-image-viewer', title: '图片查看与键盘返回', surface: 'workspace', path: '/workspace.html?state=alignment', viewport: wide, example: 'image', states: ['keyboard', 'dialog', 'focus'], components: ['ImagePreview / ImageViewer', 'motion-dialog'], steps: '聚焦图片放大入口按Enter，缩放/适应窗口；Tab留在dialog内，Escape返回触发器。' },
  ...[
    ['portrait', '竖图预览与独立控制行', 'workspace', { width: 975, height: 1034 }, 'input'],
    ['narrow', '320px 图片预览与旋转', 'popup', { width: 320, height: 740 }, 'input'],
    ['short', '320px 矮窗口图片预览', 'popup', { width: 320, height: 360 }, 'input'],
    ['result-short', '矮窗口只读结果预览', 'workspace', { width: 640, height: 360 }, 'result'],
    ['result-popup', '轻量窗口只读结果预览', 'popup', { width: 400, height: 740 }, 'result'],
  ].map(([suffix, title, surface, viewport, imageTarget]) => ({ id: `example-image-viewer-${suffix}`, title, surface, path: `/${surface}.html?state=alignment`, viewport, imageTarget, ...(suffix === 'result-short' ? { imageOpenViewport: { width: 640, height: 740 } } : {}), example: 'image', states: ['keyboard', 'dialog', 'focus', 'geometry', 'zoom', ...(imageTarget === 'input' ? ['rotation'] : ['read-only'])], components: ['ImagePreview / ImageViewer', 'motion-dialog'], steps: `${suffix === 'result-short' ? '先在640×740打开，缩小到640×360验证弹窗，恢复原尺寸再检查焦点返回；' : ''}打开图片预览，检查适配/放大/拖拽与控制栏不交叠；输入图旋转后重新适配，Escape返回入口。` })),
  { id: 'example-native-controls', title: '原生下拉、帮助与设置弹窗', surface: 'workspace', path: '/workspace.html?state=alignment', viewport: wide, example: 'controls', states: ['keyboard', 'dialog', 'focus'], components: ['SelectField', 'InlineHelp', 'motion-dialog'], steps: '打开设置→界面与动效；键盘改变原生下拉、Escape收起选项、Enter/Space展开帮助，最后Escape关闭设置。' },
  ...['wide', 'narrow', '360', '956', 'loading', 'missing', 'failed', 'custom', 'updating', 'installing'].map(state => ({
    id: `agent-settings-layout-${state}`, title: `模型表单与本机管理 · ${state}`,
    surface: 'workspace', path: `/workspace.html?state=library&settingsUi=${state}&cli=${state}`,
    viewport: state === 'wide' ? wide : { width: state === '956' ? 956 : state === '360' ? 360 : 320, height: state === '956' ? 1034 : 740 }, example: 'agent-settings-layout', settingsUi: state,
    states: [state, 'geometry', ...(['wide', 'narrow'].includes(state) ? ['keyboard', 'focus'] : [])],
    components: ['AgentSettings', 'AgentCliSettings', 'SelectField'], steps: '检查生产模型表单与CLI管理区的实际尺寸、可读反馈与长路径，分别留存截图；宽窄常态使用真实Space/Enter/Tab，验证卡片、模型验证成功和旧恢复入口焦点。仅合成消息。',
  })),
  ...['wide', 'narrow', 'legacy'].map(variant => ({
    id: `agent-settings-${variant}`, title: `逆向 Agent 设置 · ${variant === 'narrow' ? '窄屏' : variant === 'legacy' ? '旧服务' : '宽屏'}`,
    surface: 'workspace', path: `/workspace.html?state=library&agentSettingsRegression=${variant}`,
    viewport: variant === 'narrow' ? { width: 320, height: 740 } : wide, example: 'agent-settings', regression: 'agentSettingsRegression',
    states: variant === 'legacy' ? ['compatibility'] : ['failed', 'disabled', 'focus', ...(variant === 'narrow' ? ['narrow'] : [])],
    components: ['AgentSettings', 'AgentCliSettings', 'SelectField'], steps: '自动打开插件模型：验证切换失败保留、独立模型、Pi安装失败重试/更新、模型与CLI互斥、管理目标恢复与迟到响应、重开恢复；旧服务回退原模型设置。仅使用合成消息。',
  })),
].map(scenario => ({ ...scenario, rules: [scenario.example === 'image' || scenario.example === 'controls' ? 'UI-EXAMPLE-KEYBOARD' : 'UI-EXAMPLE-STATE', ...(scenario.example === 'image' ? ['UI-IMAGE-VIEWPORT'] : []), ...(['long', 'narrow-input', 'narrow-result'].includes(scenario.example) ? ['UI-LAYOUT-CANVAS'] : [])] }));
scenarios.push(...exampleScenarios);
for (const component of components) component.examples = exampleScenarios.filter(scenario => scenario.components.includes(component.name)).map(scenario => scenario.id);

export const uncovered = [
  '预览示例不验证真实扩展；extension独立命令负责声明的宿主页面与closed ShadowRoot外部行为，closed ShadowRoot内部几何仍未覆盖。',
  '静态 token 定义检查不证明每个选择器的继承、级联和 computed value 正确。',
  'visual工具提供像素对比；真实基线仍须人工审阅后接受，截图或差异阈值不能证明全部设计与动效正确。',
  '仅覆盖目录列出的场景与规则；预览有通知条及尺寸修正，不能混作实机截图。',
  '阶段2代表状态由生产组件及预览数据运行，覆盖图片查看、原生select、帮助、dialog键盘与焦点；不是每个组件与每种状态的笛卡尔积。',
  '未覆盖原生系统下拉的像素外观、触屏/屏幕阅读器、旋转应用中禁止关闭、嵌套dialog与真实模型；headless原生picker键盘不支持时单独标记skipped。',
];
