# Reframe UIUX 规范与验收

新增界面先找到已有组件、布局轨道和变量，再扩展产品能力。这里维护设计意图、复用入口与更新流程；[可执行目录](catalog.md)列出来源、规则、场景和从 CSS 提取的变量。工具使用见[工具库](../../../agent-tool/README.md)。

## 权威来源与复用

| 层次 | 权威来源 | 开发约束 |
| --- | --- | --- |
| 品牌与共享样式 | [popup/style.css](../../entrypoints/popup/style.css)及其聚合样式 | 复用语义变量；生成目录只是索引，不另存一套 token 数值。 |
| 工作台布局 | [canvas-workspace.css](../../entrypoints/workspace/canvas-workspace.css)、[results.css](../../entrypoints/workspace/results.css) | 新控件先确定所属轨道；用共同布局关系对齐，避免独立 margin/padding 补偿。 |
| 轻量创作 | [QuickWorkspace](../../entrypoints/popup/QuickWorkspace.tsx)、[compact-editor.css](../../entrypoints/popup/compact-editor.css) | popup 与网页浮层复用轻量组件；不要复制完整工作台。固定画布180px、图条36px，区别于工作台。 |
| 图片查看 | [ImagePreview](../../entrypoints/popup/ImagePreview.tsx)、[image-preview.css](../../entrypoints/popup/image-preview.css) | 可放大画布复用组件；34px入口距实际 contain 图片右下边缘4px，失败时隐藏。列表缩略图不自动加入口。 |
| 控件与交互 | [组件目录](catalog.md#组件复用入口) | 下拉、任务指令、帮助、dialog 优先复用。错误、禁用原因与任务后果保持可见。 |
| 样式隔离 | [content.ts](../../entrypoints/content.ts)、[workspace/main.tsx](../../entrypoints/workspace/main.tsx) | 共享组件不直接 import CSS；经聚合入口加载。网页浮层保留 ShadowRoot 隔离。 |

宽屏工作台的输入/结果两列共享标签、画布、图条基线并等宽；窄屏切换两侧时关闭侧 inert，活动侧完整可用。几何检查使用1 CSS px容差处理子像素取整，不能用容差掩盖真实偏移。操作区可达性、键盘焦点、动效与内容层级仍需按实际操作复核。

## 开发前后怎么用

以下命令从仓库根目录执行，完整参数见 `node agent-tool/ui.mjs --help`。绝对脚本路径也可从其他目录执行；`context --files` 的路径按仓库根目录解释。

```sh
node agent-tool/ui.mjs context --files browser-extension/entrypoints/workspace/CanvasWorkspace.tsx
node agent-tool/ui.mjs check --changed
node agent-tool/ui.mjs verify --scenario workspace-wide
node agent-tool/ui.mjs inspect --scenario workspace-wide --no-build
```

`context` 返回规则来源、组件和候选场景；未知或未建立完整映射的文件回退全部场景，不能据此证明没有其他影响。命中静态规则的来源（聚合样式、入口、变量定义文件等）也回退全部场景，即使同时命中几何规则；静态规则来源不是完整的消费者依赖图。只有明确几何映射的独立组件保持定向选择。`check` 检查 CSS 装载、变量定义和品牌色复用。存量裸品牌色先警告，新增行提升为错误；带有效 fallback 的变量允许通过。静态存在性不代表 CSS 继承作用域正确。

`verify` 默认先构建当前源码，再运行隔离预览和 Chromium。`--no-build` 只接受与源码及产物指纹匹配的已有构建；并发修改导致指纹变化时结果作废。无 `--scenario` 运行全部已登记场景，包含4组既有行为回归。`inspect` 保留成功场景的祖先样式与 trace，失败的 verify 自动保留诊断。

先读报告里的失败 ruleId、目标和期望/实际，再查看截图、祖先 rect、computed styles、scroll/clipping 与源码候选。候选文件不是确定根因。浏览器异常、场景未就绪和构建失配均失败退出；显式非适用项标记 skipped，不冒充该项已验证。

## 人类调整设计时同步更新

1. 记录设计意图、适用表面与合法变体，明确哪条旧规则需要变化。
2. 修改实际 CSS/token、复用组件或布局来源，检查共用组件的所有消费者。
3. 更新 [catalog.mjs](../../../agent-tool/ui/catalog.mjs) 的规则/组件/场景映射。几何语义确实变化时，更新 [probe.mjs](../../../agent-tool/ui/probe.mjs) 的独立期望和对应正反例；不要从当前 computed style 自动反推期望。
4. 运行 `node agent-tool/ui.mjs sync`，复核生成目录差异；再运行 `sync --check`、静态检查及受影响场景。共享 token 或不确定影响范围时运行全部场景。
5. 查看截图和测量证据，说明行为、视觉和实机验证的边界，按项目流程交监工复核。更新期望必须解释设计依据，不能仅为消除失败。

`sync` 只生成目录并检查登记来源/规则链接；不会修改组件、验收期望或截图基线，也不能自动理解设计意图。新增公共组件应同时登记复用入口和代表性场景；新状态没有适用检查时，明确记录覆盖缺口。

## 首期覆盖与后续范围

首期覆盖6个规则 ID：样式装载、变量定义、品牌色复用、工作台画布关系、轻量画布尺寸、图片预览入口。场景包括宽/窄工作台、长提示词、宽/窄 popup、图片失败及已有生成操作/自动风格/创作上下文/设置恢复回归。真实产品场景使用合成竖图；横图和方图的 contain 算法正反例由独立 probe fixture 验证。

当前没有像素视觉基线。截图用于人类和 agent 复核，不代表设计质量、全部状态、所有操作区可达性或动效已自动验收。真实扩展安装、宿主样式、权限、closed ShadowRoot 内部几何不在本工具覆盖内；不为诊断更改生产 ShadowRoot 模式。预览注入通知条及尺寸修正，不能混作实机证据。

后续按实际缺陷增加状态/关系断言，再扩展受控环境中的有限视觉基线、组件示例页和 CI。具体视觉基线更新需要复核差异，首期没有自动接受新截图的命令。
