# UIUX 可执行目录（生成文件）

由 `node agent-tool/ui.mjs sync` 从规则目录和实际 CSS 生成；不要手工改数值。目录不代表全部项目规范已自动验证。

## 规则与来源

| ID | 规则 / 意图 | 表面 | 源码 |
| --- | --- | --- | --- |
| UI-CSS-IMPORT | 共享样式装载边界：共享组件样式通过 style.css 聚合，网页端注入 ShadowRoot；组件不直接加载 CSS。 | workspace, popup, content | [browser-extension/entrypoints/popup/style.css](../../../browser-extension/entrypoints/popup/style.css)、[browser-extension/entrypoints/content.ts](../../../browser-extension/entrypoints/content.ts)、[browser-extension/entrypoints/workspace/main.tsx](../../../browser-extension/entrypoints/workspace/main.tsx) |
| UI-TOKEN-DEFINED | 变量有定义或回退：CSS 变量必须有已知定义或合法回退；静态检查不证明运行时继承作用域。 | workspace, popup, content | [browser-extension/entrypoints/popup/style.css](../../../browser-extension/entrypoints/popup/style.css)、[browser-extension/entrypoints/workspace/results.css](../../../browser-extension/entrypoints/workspace/results.css) |
| UI-TOKEN-COLOR | 品牌色复用 token：新声明复用已有品牌色变量；存量裸值先警告，不把所有固定数值视为错误。 | workspace, popup, content | [browser-extension/entrypoints/popup/style.css](../../../browser-extension/entrypoints/popup/style.css) |
| UI-LAYOUT-CANVAS | 工作台画布关系：宽屏双画布等宽，共享标签、画布、图条轨道；窄屏关闭侧 inert。 | workspace | [browser-extension/entrypoints/workspace/CanvasWorkspace.tsx](../../../browser-extension/entrypoints/workspace/CanvasWorkspace.tsx)、[browser-extension/entrypoints/workspace/canvas-workspace.css](../../../browser-extension/entrypoints/workspace/canvas-workspace.css)、[browser-extension/entrypoints/workspace/results.css](../../../browser-extension/entrypoints/workspace/results.css) |
| UI-LAYOUT-QUICK | 轻量画布与图条：保持已确认的轻量画布和图条尺寸，空态与有图状态分开验证。 | popup | [browser-extension/entrypoints/popup/QuickWorkspace.tsx](../../../browser-extension/entrypoints/popup/QuickWorkspace.tsx)、[browser-extension/entrypoints/popup/compact-editor.css](../../../browser-extension/entrypoints/popup/compact-editor.css) |
| UI-IMAGE-PREVIEW | 图片预览入口：预览按钮贴合实际 contain 图片边缘，图片失败后不提供无效入口。 | workspace, popup | [browser-extension/entrypoints/popup/ImagePreview.tsx](../../../browser-extension/entrypoints/popup/ImagePreview.tsx)、[browser-extension/entrypoints/popup/image-preview.css](../../../browser-extension/entrypoints/popup/image-preview.css) |
| UI-IMAGE-VIEWPORT | 图片视口与独立缩放栏：控制行占独立空间，不与图片视口相交；适配完整可见，缩放平移裁剪于视口，工具栏不触发图片手势。 | workspace, popup | [browser-extension/entrypoints/popup/ImageViewer.tsx](../../../browser-extension/entrypoints/popup/ImageViewer.tsx)、[browser-extension/entrypoints/popup/image-viewer.css](../../../browser-extension/entrypoints/popup/image-viewer.css)、[browser-extension/entrypoints/popup/ImagePreview.tsx](../../../browser-extension/entrypoints/popup/ImagePreview.tsx)、[browser-extension/entrypoints/popup/image-preview.css](../../../browser-extension/entrypoints/popup/image-preview.css) |
| UI-EXAMPLE-STATE | 生产组件代表状态：预览数据驱动真实组件的空态、读取、忙碌、失败、禁用、长文本和窄屏；不通过改DOM伪造业务状态。 | workspace, popup | [browser-extension/entrypoints/popup/QuickWorkspace.tsx](../../../browser-extension/entrypoints/popup/QuickWorkspace.tsx)、[browser-extension/entrypoints/workspace/CanvasWorkspace.tsx](../../../browser-extension/entrypoints/workspace/CanvasWorkspace.tsx) |
| UI-EXAMPLE-KEYBOARD | 原生控件与浮层交互：真实键盘验证原生select、帮助展开、图片缩放、dialog焦点约束、Escape关闭和焦点返回。 | workspace, popup | [browser-extension/entrypoints/popup/SelectField.tsx](../../../browser-extension/entrypoints/popup/SelectField.tsx)、[browser-extension/entrypoints/popup/InlineHelp.tsx](../../../browser-extension/entrypoints/popup/InlineHelp.tsx)、[browser-extension/entrypoints/popup/ImagePreview.tsx](../../../browser-extension/entrypoints/popup/ImagePreview.tsx)、[browser-extension/lib/motion-dialog.ts](../../../browser-extension/lib/motion-dialog.ts) |

## 组件复用入口

| 组件 | 用法 | 源码 |
| --- | --- | --- |
| ImageGenerationSettings | 设置中的生图渠道、私有凭据及保存反馈。 | [browser-extension/entrypoints/popup/ImageGenerationSettings.tsx](../../../browser-extension/entrypoints/popup/ImageGenerationSettings.tsx) |
| AgentCliSettings | 按管理目标读取CLI状态、安装与更新，不改变逆向Agent，迟到响应按目标隔离。 | [browser-extension/entrypoints/popup/AgentCliSettings.tsx](../../../browser-extension/entrypoints/popup/AgentCliSettings.tsx) |
| AgentSettings | 设置中的原生 Agent 单选卡片，独立模型、失败保留与旧服务回退。 | [browser-extension/entrypoints/popup/AgentSettings.tsx](../../../browser-extension/entrypoints/popup/AgentSettings.tsx) |
| SelectField | 所有下拉框；保留原生键盘、禁用及 Escape 行为。 | [browser-extension/entrypoints/popup/SelectField.tsx](../../../browser-extension/entrypoints/popup/SelectField.tsx) |
| ImagePreview / ImageViewer | 可放大图片；列表缩略图不开放预览，编辑输入才传旋转能力。 | [browser-extension/entrypoints/popup/ImagePreview.tsx](../../../browser-extension/entrypoints/popup/ImagePreview.tsx) |
| QuickWorkspace | popup 与网页浮层的轻量创作，不复制工作台完整编辑能力。 | [browser-extension/entrypoints/popup/QuickWorkspace.tsx](../../../browser-extension/entrypoints/popup/QuickWorkspace.tsx) |
| CanvasWorkspace | 工作台输入画布与共享轨道。新增控件先确认所在轨道。 | [browser-extension/entrypoints/workspace/CanvasWorkspace.tsx](../../../browser-extension/entrypoints/workspace/CanvasWorkspace.tsx) |
| TaskInstruction | 共用任务指令；沿用领域层的提交保护。 | [browser-extension/entrypoints/popup/TaskInstruction.tsx](../../../browser-extension/entrypoints/popup/TaskInstruction.tsx) |
| InlineHelp | 低频文字帮助；错误、费用和禁用原因保持可见。 | [browser-extension/entrypoints/popup/InlineHelp.tsx](../../../browser-extension/entrypoints/popup/InlineHelp.tsx) |
| motion-dialog | 原生 dialog 的蒙板关闭、忙碌保护与焦点恢复。 | [browser-extension/lib/motion-dialog.ts](../../../browser-extension/lib/motion-dialog.ts) |

## 可重现场景

| ID | 表面 / 视口 | 状态 | 检查 |
| --- | --- | --- | --- |
| batch-toolbar-360 | workspace 360×1034 | /workspace.html?state=library&count=24 | batchToolbar |
| batch-toolbar-650 | workspace 650×1034 | /workspace.html?state=library&count=24 | batchToolbar |
| batch-toolbar-651 | workspace 651×1034 | /workspace.html?state=library&count=24 | batchToolbar |
| batch-toolbar-877 | workspace 877×1034 | /workspace.html?state=library&count=24 | batchToolbar |
| batch-toolbar-1440 | workspace 1440×1034 | /workspace.html?state=library&count=24 | batchToolbar |
| batch-recreate-mixed | workspace 1440×1000 | /workspace.html?state=library&count=4&batchRecreateRegression=mixed | batchRecreateRegression |
| batch-recreate-retry | workspace 1440×1000 | /workspace.html?state=library&count=4&batchRecreateRegression=retry | batchRecreateRegression |
| batch-recreate-late | workspace 1440×1000 | /workspace.html?state=library&count=4&batchRecreateRegression=late&batchPreviewDelay=1500 | batchRecreateRegression |
| batch-recreate-narrow | workspace 360×740 | /workspace.html?state=library&count=4&batchRecreateRegression=narrow | batchRecreateRegression |
| batch-recreate-keyboard | workspace 360×740 | /workspace.html?state=library&count=4&batchRecreateRegression=keyboard | batchRecreateRegression |
| batch-recreate-history | workspace 1440×1000 | /workspace.html?state=library&count=4&batchRecreateRegression=history | batchRecreateRegression |
| batch-recreate-hidden | workspace 1440×1000 | /workspace.html?state=library&count=4&batchRecreateRegression=hidden | batchRecreateRegression |
| batch-recreate-all-accepted | workspace 1440×1000 | /workspace.html?state=library&count=4&batchRecreateRegression=all-accepted | batchRecreateRegression |
| batch-recreate-preflight-hidden | workspace 1440×1000 | /workspace.html?state=library&count=4&batchRecreateRegression=preflight-hidden&batchPreviewDelay=1500 | batchRecreateRegression |
| batch-recreate-retry-hidden | workspace 1440×1000 | /workspace.html?state=library&count=4&batchRecreateRegression=retry-hidden | batchRecreateRegression |
| workspace-wide | workspace 1440×1000 | /workspace.html?state=alignment | UI-LAYOUT-CANVAS, UI-IMAGE-PREVIEW |
| workspace-prompt | workspace 1440×1000 | /workspace.html?state=alignment / prompt | UI-LAYOUT-CANVAS, UI-IMAGE-PREVIEW |
| workspace-narrow | workspace 600×900 | /workspace.html?state=alignment | UI-LAYOUT-CANVAS, UI-IMAGE-PREVIEW |
| popup | popup 400×740 | /popup.html?state=alignment | UI-LAYOUT-QUICK, UI-IMAGE-PREVIEW |
| popup-narrow | popup 320×740 | /popup.html?state=alignment | UI-LAYOUT-QUICK, UI-IMAGE-PREVIEW |
| popup-image-failed | popup 400×740 | /popup.html?state=alignment / image-failed | UI-LAYOUT-QUICK, UI-IMAGE-PREVIEW |
| generation-actions | workspace 1440×1000 | /workspace.html?state=alignment&mode=recreate&generationActionsRegression=1&generationDelay=60000&generationStartDelay=200 | generationActionsRegression |
| end-to-end-keyboard-workspace-cancel | workspace 1440×1000 | /workspace.html?state=alignment&mode=recreate&endToEndKeyboard=1&startDelay=4000&reverseDelay=60000 | endToEndKeyboard |
| end-to-end-keyboard-workspace-legacy | workspace 1440×1000 | /workspace.html?state=alignment&mode=recreate&endToEndKeyboard=1&startDelay=4000&reverseDelay=60000&start=legacy | endToEndKeyboard |
| end-to-end-keyboard-workspace-failure | workspace 1440×1000 | /workspace.html?state=alignment&mode=recreate&endToEndKeyboard=1&startDelay=4000&reverseDelay=60000&start=failed | endToEndKeyboard |
| end-to-end-keyboard-workspace-tab | workspace 1440×1000 | /workspace.html?state=alignment&mode=recreate&endToEndKeyboard=1&startDelay=4000&reverseDelay=60000 | endToEndKeyboard |
| end-to-end-keyboard-workspace-tab-failure | workspace 1440×1000 | /workspace.html?state=alignment&mode=recreate&endToEndKeyboard=1&startDelay=4000&reverseDelay=60000&start=failed | endToEndKeyboard |
| end-to-end-keyboard-workspace-project | workspace 1440×1000 | /workspace.html?state=alignment&mode=recreate&endToEndKeyboard=1&startDelay=4000&reverseDelay=60000 | endToEndKeyboard |
| end-to-end-keyboard-workspace-project-failure | workspace 1440×1000 | /workspace.html?state=alignment&mode=recreate&endToEndKeyboard=1&startDelay=4000&reverseDelay=60000&start=failed | endToEndKeyboard |
| end-to-end-keyboard-popup-cancel | popup 320×740 | /popup.html?state=alignment&mode=recreate&endToEndKeyboard=1&startDelay=4000&reverseDelay=60000 | endToEndKeyboard |
| end-to-end-keyboard-popup-legacy | popup 320×740 | /popup.html?state=alignment&mode=recreate&endToEndKeyboard=1&startDelay=4000&reverseDelay=60000&start=legacy | endToEndKeyboard |
| end-to-end-keyboard-popup-failure | popup 320×740 | /popup.html?state=alignment&mode=recreate&endToEndKeyboard=1&startDelay=4000&reverseDelay=60000&start=failed | endToEndKeyboard |
| end-to-end-keyboard-popup-tab | popup 320×740 | /popup.html?state=alignment&mode=recreate&endToEndKeyboard=1&startDelay=4000&reverseDelay=60000 | endToEndKeyboard |
| end-to-end-keyboard-popup-tab-failure | popup 320×740 | /popup.html?state=alignment&mode=recreate&endToEndKeyboard=1&startDelay=4000&reverseDelay=60000&start=failed | endToEndKeyboard |
| end-to-end-keyboard-popup-project | popup 320×740 | /popup.html?state=alignment&mode=recreate&endToEndKeyboard=1&startDelay=4000&reverseDelay=60000 | endToEndKeyboard |
| end-to-end-keyboard-popup-project-failure | popup 320×740 | /popup.html?state=alignment&mode=recreate&endToEndKeyboard=1&startDelay=4000&reverseDelay=60000&start=failed | endToEndKeyboard |
| end-to-end-popup-start-failed | popup 320×740 | /popup.html?state=alignment&mode=recreate&endToEndRegression=popup-start-failed&generationDelay=1000 | endToEndRegression |
| end-to-end-workspace | workspace 1440×1000 | /workspace.html?state=alignment&mode=recreate&endToEndRegression=workspace&generationDelay=1000&startDelay=200&reverseDelay=1500 | endToEndRegression |
| end-to-end-popup | popup 320×740 | /popup.html?state=alignment&mode=recreate&endToEndRegression=popup&generationDelay=1000&startDelay=200&reverseDelay=1500 | endToEndRegression |
| end-to-end-cancel | workspace 1440×1000 | /workspace.html?state=alignment&mode=recreate&endToEndRegression=cancel&generationDelay=1000&startDelay=200&reverseDelay=1500 | endToEndRegression |
| end-to-end-phase-cancel | workspace 1440×1000 | /workspace.html?state=alignment&mode=recreate&endToEndRegression=phase-cancel&generationDelay=1000&startDelay=200&reverseDelay=300&generationStartDelay=2000 | endToEndRegression |
| end-to-end-context | workspace 1440×1000 | /workspace.html?state=alignment&mode=recreate&endToEndRegression=context&generationDelay=1000&startDelay=200&reverseDelay=1500 | endToEndRegression |
| end-to-end-reverse-failed | workspace 1440×1000 | /workspace.html?state=alignment&mode=recreate&endToEndRegression=reverse-failed&generationDelay=1000&startDelay=200&reverseDelay=1500&reverse=failed | endToEndRegression |
| end-to-end-generation-failed | workspace 1440×1000 | /workspace.html?state=alignment&mode=recreate&endToEndRegression=generation-failed&generationDelay=1000&startDelay=200&reverseDelay=1500&fx=failed | endToEndRegression |
| image-order-paired | workspace 1440×1000 | /workspace.html?state=projects&mode=style&imageOrderRegression=paired&inputSaveDelay=100 | imageOrderRegression |
| image-order-multi | workspace 1440×1000 | /workspace.html?state=multi&mode=multi-reenact&imageOrderRegression=multi&inputSaveDelay=100 | imageOrderRegression |
| image-order-legacy | workspace 1440×1000 | /workspace.html?state=projects&mode=style&imageOrderRegression=legacy&inputSaveDelay=100 | imageOrderRegression |
| image-order-failed | workspace 1440×1000 | /workspace.html?state=projects&mode=style&imageOrderRegression=failed&inputSaveDelay=100&inputSaveFailures=1 | imageOrderRegression |
| image-order-popup | popup 400×740 | /popup.html?state=projects&mode=style&imageOrderRegression=popup&inputSaveDelay=100 | imageOrderRegression |
| image-instruction-default-paired | workspace 1440×1000 | /workspace.html?state=projects&mode=style&imageOrderRegression=paired&instructionFixture=default&inputSaveDelay=100 | imageOrderRegression |
| image-instruction-legacy-paired | workspace 1440×1000 | /workspace.html?state=projects&mode=reenact&imageOrderRegression=instruction-legacy&instructionFixture=legacy&inputSaveDelay=100 | imageOrderRegression |
| image-instruction-default-multi | workspace 1440×1000 | /workspace.html?state=multi&mode=multi-reenact&imageOrderRegression=multi&instructionFixture=default&inputSaveDelay=100 | imageOrderRegression |
| image-order-keyboard-new | popup 320×740 | /popup.html?state=projects&mode=style&inputSaveDelay=4000&imageOrderFixture=new | imageOrderKeyboard |
| image-order-keyboard-history | popup 320×740 | /popup.html?state=projects&mode=style&inputSaveDelay=4000 | imageOrderKeyboard |
| image-order-keyboard-failure | popup 320×740 | /popup.html?state=projects&mode=style&inputSaveDelay=4000&inputSaveFailures=1 | imageOrderKeyboard |
| image-order-keyboard-late | popup 320×740 | /popup.html?state=projects&mode=style&inputSaveDelay=4000 | imageOrderKeyboard |
| auto-style | workspace 1440×1000 | /workspace.html?state=projects&mode=style&autoStyleRegression=1&inputSaveDelay=250 | autoStyleRegression |
| creation-context | workspace 1440×1000 | /workspace.html?state=alignment&mode=recreate&inputSaveDelay=1800&creationContextRegression=mode | creationContextRegression |
| automatic-connection-workspace | workspace 1440×1000 | /workspace.html?state=empty&connectionRegression=1 | connectionRegression |
| automatic-connection-workspace-narrow | workspace 320×740 | /workspace.html?state=empty&connectionRegression=1 | connectionRegression |
| automatic-connection-popup | popup 320×740 | /popup.html?state=empty&connectionRegression=1 | connectionRegression |
| settings-recovery-narrow | workspace 320×740 | /workspace.html?state=library&settingsRegression=1 | settingsRegression |
| settings-recovery | workspace 1440×1000 | /workspace.html?state=library&settingsRegression=1 | settingsRegression |
| image-settings-wide | workspace 1440×1000 | /workspace.html?state=library&imageSettingsRegression=wide | imageSettingsRegression |
| image-settings-narrow | workspace 360×740 | /workspace.html?state=library&imageSettingsRegression=narrow | imageSettingsRegression |
| image-settings-legacy | workspace 1440×1000 | /workspace.html?state=library&imageSettingsRegression=legacy | imageSettingsRegression |
| example-workspace-empty | workspace 1440×1000 | /workspace.html?state=empty | UI-EXAMPLE-STATE |
| example-popup-empty | popup 400×740 | /popup.html?state=empty | UI-EXAMPLE-STATE |
| example-input-loading | workspace 1440×1000 | /workspace.html?state=alignment&reference=pending&referenceDelay=60000 | UI-EXAMPLE-STATE |
| example-reverse-busy | popup 400×740 | /popup.html?state=running | UI-EXAMPLE-STATE |
| example-reverse-failed | popup 400×740 | /popup.html?state=failed | UI-EXAMPLE-STATE |
| example-no-model | popup 400×740 | /popup.html?state=models-new | UI-EXAMPLE-STATE |
| example-long-instruction | workspace 1440×1000 | /workspace.html?state=alignment | UI-EXAMPLE-STATE, UI-LAYOUT-CANVAS |
| example-narrow-input | workspace 600×900 | /workspace.html?state=alignment | UI-EXAMPLE-STATE, UI-LAYOUT-CANVAS |
| example-narrow-result | workspace 600×900 | /workspace.html?state=alignment | UI-EXAMPLE-STATE, UI-LAYOUT-CANVAS |
| example-image-viewer | workspace 1440×1000 | /workspace.html?state=alignment | UI-EXAMPLE-KEYBOARD, UI-IMAGE-VIEWPORT |
| example-image-viewer-portrait | workspace 975×1034 | /workspace.html?state=alignment | UI-EXAMPLE-KEYBOARD, UI-IMAGE-VIEWPORT |
| example-image-viewer-narrow | popup 320×740 | /popup.html?state=alignment | UI-EXAMPLE-KEYBOARD, UI-IMAGE-VIEWPORT |
| example-image-viewer-short | popup 320×360 | /popup.html?state=alignment | UI-EXAMPLE-KEYBOARD, UI-IMAGE-VIEWPORT |
| example-image-viewer-result-short | workspace 640×360 | /workspace.html?state=alignment | UI-EXAMPLE-KEYBOARD, UI-IMAGE-VIEWPORT |
| example-image-viewer-result-popup | popup 400×740 | /popup.html?state=alignment | UI-EXAMPLE-KEYBOARD, UI-IMAGE-VIEWPORT |
| example-native-controls | workspace 1440×1000 | /workspace.html?state=alignment | UI-EXAMPLE-KEYBOARD |
| agent-settings-layout-wide | workspace 1440×1000 | /workspace.html?state=library&settingsUi=wide&cli=wide | UI-EXAMPLE-STATE |
| agent-settings-layout-narrow | workspace 320×740 | /workspace.html?state=library&settingsUi=narrow&cli=narrow | UI-EXAMPLE-STATE |
| agent-settings-layout-loading | workspace 320×740 | /workspace.html?state=library&settingsUi=loading&cli=loading | UI-EXAMPLE-STATE |
| agent-settings-layout-missing | workspace 320×740 | /workspace.html?state=library&settingsUi=missing&cli=missing | UI-EXAMPLE-STATE |
| agent-settings-layout-failed | workspace 320×740 | /workspace.html?state=library&settingsUi=failed&cli=failed | UI-EXAMPLE-STATE |
| agent-settings-layout-custom | workspace 320×740 | /workspace.html?state=library&settingsUi=custom&cli=custom | UI-EXAMPLE-STATE |
| agent-settings-layout-updating | workspace 320×740 | /workspace.html?state=library&settingsUi=updating&cli=updating | UI-EXAMPLE-STATE |
| agent-settings-layout-installing | workspace 320×740 | /workspace.html?state=library&settingsUi=installing&cli=installing | UI-EXAMPLE-STATE |
| agent-settings-wide | workspace 1440×1000 | /workspace.html?state=library&agentSettingsRegression=wide | agentSettingsRegression |
| agent-settings-narrow | workspace 320×740 | /workspace.html?state=library&agentSettingsRegression=narrow | agentSettingsRegression |
| agent-settings-legacy | workspace 1440×1000 | /workspace.html?state=library&agentSettingsRegression=legacy | agentSettingsRegression |

## CSS 变量清单

这是声明清单，包含状态/媒体查询覆盖；同名变量有不同作用域，不代表每个数值都可全局复用。CSS 是数值唯一来源。

| 变量 | 值 | 选择器 | 来源行 |
| --- | --- | --- | --- |
| --input-image-height | clamp(120px,30cqi,180px) | .workspace-inputs,.composition-layout | [browser-extension/entrypoints/popup/image-input.css](../../../browser-extension/entrypoints/popup/image-input.css):2 |
| --paper | #faf9f6 | :root, :host | [browser-extension/entrypoints/popup/style.css](../../../browser-extension/entrypoints/popup/style.css):14 |
| --surface | #fffefa | :root, :host | [browser-extension/entrypoints/popup/style.css](../../../browser-extension/entrypoints/popup/style.css):15 |
| --surface-muted | #f0ede6 | :root, :host | [browser-extension/entrypoints/popup/style.css](../../../browser-extension/entrypoints/popup/style.css):16 |
| --ink | #26241f | :root, :host | [browser-extension/entrypoints/popup/style.css](../../../browser-extension/entrypoints/popup/style.css):17 |
| --muted | #746f65 | :root, :host | [browser-extension/entrypoints/popup/style.css](../../../browser-extension/entrypoints/popup/style.css):18 |
| --line | #e5e1d8 | :root, :host | [browser-extension/entrypoints/popup/style.css](../../../browser-extension/entrypoints/popup/style.css):19 |
| --yellow | #ffd440 | :root, :host | [browser-extension/entrypoints/popup/style.css](../../../browser-extension/entrypoints/popup/style.css):20 |
| --pink | #fe7da8 | :root, :host | [browser-extension/entrypoints/popup/style.css](../../../browser-extension/entrypoints/popup/style.css):21 |
| --cyan | #27ccf3 | :root, :host | [browser-extension/entrypoints/popup/style.css](../../../browser-extension/entrypoints/popup/style.css):22 |
| --shadow-floating | 0 16px 48px rgb(40 34 24 / .12), 0 2px 8px rgb(40 34 24 / .04) | :root, :host | [browser-extension/entrypoints/popup/style.css](../../../browser-extension/entrypoints/popup/style.css):23 |
| --ease-out | cubic-bezier(.23, 1, .32, 1) | :root, :host | [browser-extension/entrypoints/popup/style.css](../../../browser-extension/entrypoints/popup/style.css):24 |
| --font | "Space Grotesk", "Trebuchet MS", -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif | :root, :host | [browser-extension/entrypoints/popup/style.css](../../../browser-extension/entrypoints/popup/style.css):25 |
| --select-inset | 12px | .select-control | [browser-extension/entrypoints/popup/style.css](../../../browser-extension/entrypoints/popup/style.css):143 |
| --prompt-editor-height | max(240px,min(56dvh,calc(100dvh - 420px),600px)) | .workspace-app | [browser-extension/entrypoints/workspace/canvas-workspace.css](../../../browser-extension/entrypoints/workspace/canvas-workspace.css):110 |
| --result-drawer-width | 50cqw | .workspace-app | [browser-extension/entrypoints/workspace/results.css](../../../browser-extension/entrypoints/workspace/results.css):15 |
| --canvas-label-height | 26px | .workspace-app | [browser-extension/entrypoints/workspace/results.css](../../../browser-extension/entrypoints/workspace/results.css):15 |
| --canvas-strip-height | 56px | .workspace-app | [browser-extension/entrypoints/workspace/results.css](../../../browser-extension/entrypoints/workspace/results.css):15 |
| --canvas-controls-height | min(270px,38dvh) | .workspace-app | [browser-extension/entrypoints/workspace/results.css](../../../browser-extension/entrypoints/workspace/results.css):15 |
| --canvas-gap | 8px | .workspace-app | [browser-extension/entrypoints/workspace/results.css](../../../browser-extension/entrypoints/workspace/results.css):15 |
| --canvas-half-gap | 12px | .workspace-app | [browser-extension/entrypoints/workspace/results.css](../../../browser-extension/entrypoints/workspace/results.css):15 |
| --drawer-duration | 380ms | .workspace-app | [browser-extension/entrypoints/workspace/results.css](../../../browser-extension/entrypoints/workspace/results.css):15 |
| --drawer-ease | cubic-bezier(.32,.72,0,1) | .workspace-app | [browser-extension/entrypoints/workspace/results.css](../../../browser-extension/entrypoints/workspace/results.css):15 |
| --canvas-rows | var(--canvas-label-height) minmax(0,1fr) var(--canvas-strip-height) var(--canvas-controls-height) | .workspace-body | [browser-extension/entrypoints/workspace/results.css](../../../browser-extension/entrypoints/workspace/results.css):16 |
| --canvas-controls-height | calc(var(--prompt-editor-height) + 38px) | .workspace-body:has(.workspace-editor:not([inert]) .canvas-workspace[data-prompt-open="true"]) | [browser-extension/entrypoints/workspace/results.css](../../../browser-extension/entrypoints/workspace/results.css):18 |
| --drawer-duration | 0ms | .workspace-app[data-motion="reduce"],.workspace-app[data-motion-input="keyboard"] | [browser-extension/entrypoints/workspace/results.css](../../../browser-extension/entrypoints/workspace/results.css):52 |
| --canvas-half-gap | 9px | .workspace-app | [browser-extension/entrypoints/workspace/results.css](../../../browser-extension/entrypoints/workspace/results.css):55 |
| --result-drawer-width | 100cqw | .workspace-app | [browser-extension/entrypoints/workspace/results.css](../../../browser-extension/entrypoints/workspace/results.css):59 |
| --canvas-label-height | 24px | .workspace-app | [browser-extension/entrypoints/workspace/results.css](../../../browser-extension/entrypoints/workspace/results.css):59 |
| --canvas-strip-height | 52px | .workspace-app | [browser-extension/entrypoints/workspace/results.css](../../../browser-extension/entrypoints/workspace/results.css):59 |
| --canvas-controls-height | 190px | .workspace-app | [browser-extension/entrypoints/workspace/results.css](../../../browser-extension/entrypoints/workspace/results.css):59 |
| --canvas-half-gap | 0px | .workspace-app | [browser-extension/entrypoints/workspace/results.css](../../../browser-extension/entrypoints/workspace/results.css):59 |
| --canvas-strip-height | 46px | .workspace-app | [browser-extension/entrypoints/workspace/results.css](../../../browser-extension/entrypoints/workspace/results.css):69 |
| --canvas-controls-height | 150px | .workspace-app | [browser-extension/entrypoints/workspace/results.css](../../../browser-extension/entrypoints/workspace/results.css):69 |
| --canvas-gap | 6px | .workspace-app | [browser-extension/entrypoints/workspace/results.css](../../../browser-extension/entrypoints/workspace/results.css):69 |
| --task-accent | #8b731b | .task-orchestration | [browser-extension/entrypoints/workspace/task-orchestration.css](../../../browser-extension/entrypoints/workspace/task-orchestration.css):1 |
| --task-accent | #5b7140 | .task-orchestration[data-state=success] | [browser-extension/entrypoints/workspace/task-orchestration.css](../../../browser-extension/entrypoints/workspace/task-orchestration.css):4 |
| --workspace-footer-height | 96px | .workspace-app | [browser-extension/entrypoints/workspace/workspace.css](../../../browser-extension/entrypoints/workspace/workspace.css):3 |
| --sidebar-inset | 12px | .workspace-app | [browser-extension/entrypoints/workspace/workspace.css](../../../browser-extension/entrypoints/workspace/workspace.css):3 |
| --sidebar-width | 204px | .workspace-app | [browser-extension/entrypoints/workspace/workspace.css](../../../browser-extension/entrypoints/workspace/workspace.css):3 |
| --sidebar-inset | 9px | .workspace-app | [browser-extension/entrypoints/workspace/workspace.css](../../../browser-extension/entrypoints/workspace/workspace.css):89 |
| --sidebar-width | 170px | .workspace-app | [browser-extension/entrypoints/workspace/workspace.css](../../../browser-extension/entrypoints/workspace/workspace.css):89 |
| --sidebar-width | 64px | .workspace-app[data-sidebar-collapsed="true"] | [browser-extension/entrypoints/workspace/workspace.css](../../../browser-extension/entrypoints/workspace/workspace.css):99 |
| --sidebar-inset | 7px | .workspace-app[data-sidebar-collapsed="true"] | [browser-extension/entrypoints/workspace/workspace.css](../../../browser-extension/entrypoints/workspace/workspace.css):99 |
| --sidebar-width | 54px | .workspace-app[data-sidebar-collapsed="true"] | [browser-extension/entrypoints/workspace/workspace.css](../../../browser-extension/entrypoints/workspace/workspace.css):114 |
| --sidebar-inset | 4px | .workspace-app[data-sidebar-collapsed="true"] | [browser-extension/entrypoints/workspace/workspace.css](../../../browser-extension/entrypoints/workspace/workspace.css):114 |

## 覆盖边界

- 预览示例不验证真实扩展；extension独立命令负责声明的宿主页面与closed ShadowRoot外部行为，closed ShadowRoot内部几何仍未覆盖。
- 静态 token 定义检查不证明每个选择器的继承、级联和 computed value 正确。
- visual工具提供像素对比；真实基线仍须人工审阅后接受，截图或差异阈值不能证明全部设计与动效正确。
- 仅覆盖目录列出的场景与规则；预览有通知条及尺寸修正，不能混作实机截图。
- 阶段2代表状态由生产组件及预览数据运行，覆盖图片查看、原生select、帮助、dialog键盘与焦点；不是每个组件与每种状态的笛卡尔积。
- 未覆盖原生系统下拉的像素外观、触屏/屏幕阅读器、旋转应用中禁止关闭、嵌套dialog与真实模型；headless原生picker键盘不支持时单独标记skipped。
