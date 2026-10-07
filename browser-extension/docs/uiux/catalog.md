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

## 组件复用入口

| 组件 | 用法 | 源码 |
| --- | --- | --- |
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
| workspace-wide | workspace 1440×1000 | /workspace.html?state=alignment | UI-LAYOUT-CANVAS, UI-IMAGE-PREVIEW |
| workspace-prompt | workspace 1440×1000 | /workspace.html?state=alignment / prompt | UI-LAYOUT-CANVAS, UI-IMAGE-PREVIEW |
| workspace-narrow | workspace 600×900 | /workspace.html?state=alignment | UI-LAYOUT-CANVAS, UI-IMAGE-PREVIEW |
| popup | popup 400×740 | /popup.html?state=alignment | UI-LAYOUT-QUICK, UI-IMAGE-PREVIEW |
| popup-narrow | popup 320×740 | /popup.html?state=alignment | UI-LAYOUT-QUICK, UI-IMAGE-PREVIEW |
| popup-image-failed | popup 400×740 | /popup.html?state=alignment / image-failed | UI-LAYOUT-QUICK, UI-IMAGE-PREVIEW |
| generation-actions | workspace 1440×1000 | /workspace.html?state=alignment&mode=recreate&generationActionsRegression=1&generationDelay=60000&generationStartDelay=200 | generationActionsRegression |
| auto-style | workspace 1440×1000 | /workspace.html?state=projects&mode=style&autoStyleRegression=1&inputSaveDelay=250 | autoStyleRegression |
| creation-context | workspace 1440×1000 | /workspace.html?state=alignment&mode=recreate&inputSaveDelay=1800&creationContextRegression=mode | creationContextRegression |
| settings-recovery | workspace 1440×1000 | /workspace.html?state=library&settingsRegression=1 | settingsRegression |

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

- 真实扩展安装、权限、跨域、宿主网页及 closed ShadowRoot 内部几何未验证。
- 静态 token 定义检查不证明每个选择器的继承、级联和 computed value 正确。
- 第一阶段没有像素视觉基线；截图用于复核，不能证明全部设计或动效正确。
- 仅覆盖目录列出的场景与规则；预览有通知条及尺寸修正，不能混作实机截图。
