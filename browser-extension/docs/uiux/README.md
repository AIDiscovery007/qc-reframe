# Reframe UIUX 规范与验收

新增界面先找到已有组件、布局轨道和变量，再扩展产品能力。这里维护设计意图、复用入口与更新流程；[可执行目录](catalog.md)列出来源、规则、场景和从 CSS 提取的变量。工具使用见[工具库](../../../agent-tool/README.md)。

## 权威来源与复用

| 层次 | 权威来源 | 开发约束 |
| --- | --- | --- |
| 品牌与共享样式 | [popup/style.css](../../entrypoints/popup/style.css)及其聚合样式 | 复用语义变量；生成目录只是索引，不另存一套 token 数值。 |
| 工作台布局 | [canvas-workspace.css](../../entrypoints/workspace/canvas-workspace.css)、[results.css](../../entrypoints/workspace/results.css) | 新控件先确定所属轨道；用共同布局关系对齐，避免独立 margin/padding 补偿。 |
| 轻量创作 | [QuickWorkspace](../../entrypoints/popup/QuickWorkspace.tsx)、[compact-editor.css](../../entrypoints/popup/compact-editor.css) | popup 与网页浮层复用轻量组件；不要复制完整工作台。固定画布180px、图条36px，区别于工作台。 |
| 图片查看 | [ImagePreview](../../entrypoints/popup/ImagePreview.tsx)、[image-preview.css](../../entrypoints/popup/image-preview.css)、[ImageViewer](../../entrypoints/popup/ImageViewer.tsx)及其[样式](../../entrypoints/popup/image-viewer.css) | 可放大画布复用组件；34px入口距实际 contain 图片右下边缘4px，失败时隐藏。列表缩略图不自动加入口。 |
| 控件与交互 | [组件目录](catalog.md#组件复用入口) | 下拉、任务指令、帮助、dialog 优先复用。错误、禁用原因与任务后果保持可见。 |
| 样式隔离 | [content.ts](../../entrypoints/content.ts)、[workspace/main.tsx](../../entrypoints/workspace/main.tsx) | 共享组件不直接 import CSS；经聚合入口加载。网页浮层保留 ShadowRoot 隔离。 |

宽屏工作台的输入/结果两列共享标签、画布、图条基线并等宽；窄屏切换两侧时关闭侧 inert，活动侧完整可用。几何检查使用1 CSS px容差处理子像素取整，不能用容差掩盖真实偏移。操作区可达性、键盘焦点、动效与内容层级仍需按实际操作复核。

## 创作操作

工作台共用操作栏同时提供「仅逆向 / 更新提示词」「逆向并生图」和独立「生成图片 / 再生成图片」。连续操作以亮黄主按钮表达，独立逆向复用次级底色；轻量界面在任务指令下复用两项逆向操作，窄屏允许换行，保留当前结果的独立生图按钮。通用风格无主体时显示补充主体的条件；不通过隐藏独立流程强制连续生图。

逆向阶段和交接阶段保留取消入口与可读状态，开始生图后由原结果区接管进度和取消；连续流程不自动展开提示词。发起按钮在提交和逆向阶段保持同一节点并变为取消入口，保留键盘焦点；用户已转焦或切换上下文时不主动夺回焦点。输入或提示词草稿未保存、比例无效时不能绕过原有保护。工作台比例沿用当前操作栏，首次无提示词时自动；快捷端沿用最近一次比例；自动生图启动前失败且尚无生图记录时，独立重试沿用该流程提交的比例。使用同一提示词重复生图不生成新提示词版本。

浏览器场景使用合成消息和图片验证两种界面的操作、取消、失败、版本与参数，不能证明真实模型或用户已安装扩展已通过。

## 图片预览

缩放控制位于图片区下方的独立紧凑行，占据实际布局空间；不以浮层覆盖图片。图片区是唯一的适配尺寸、缩放锚点和拖拽裁剪边界，适应窗口后完整显示图片，放大后只在该区域绘制。控制行上的滚轮或拖拽不改变图片；输入图另保留旋转操作，结果图只读。沿用原生 dialog、键盘缩放/平移、Escape、焦点返回和 Shadow DOM 内 portal。

`UI-IMAGE-VIEWPORT` 检查两区不相交、适配图片包含关系、放大裁剪与手势边界。`example-image-viewer` 及其 portrait/narrow/short/result-short/result-popup 变体覆盖宽屏、975×1034、320×740、320×360、640×360 与 400×740（640×360 工作台结果场景先打开弹窗再缩小，背景结果画布在该矮窗口不足以直接打开；恢复原尺寸后才验证 Escape 焦点返回）；输入图还验证旋转后重新适配。报告另存 fit、zoom-pan、rotation-fit 截图，旋转未应用到真实项目。关闭保护与真实 closed ShadowRoot 内部仍须独立验收，不能用合成样例推定通过。

## 图片排序

输入图条是图号的可视顺序：新输入参考图默认图 1；选中任意已上传图片，使用图条下方「图片前移 / 图片后移」调整。工作台允许主体互排和跨参考图移动，快捷面板支持双图，多图进入工作台。只有一张图时不展示排序控件；角色互换仍是独立操作。

默认任务指令与图条共用图片顺序映射，按角色动态注入图号；排序、增删及恢复输入时仅更新完整匹配系统默认的文本（含旧固定图号默认）。手动编辑或清空保留原样；历史任务和输出不回写，规范化默认显示本身不使旧提示词失效。

复用原图条、工具栏及原生按钮，不新增动效或改变画布/图条高度。首尾按钮禁用，选中状态跟随图片身份；保存中禁止重复操作，失败保持原序并可重试。保存成功显示新图号，改序回到当前输入并重新生成提示词；旧版本保留旧图号。图片顺序行为场景覆盖模式隔离、重开与保存失败；320px popup 的独立键盘场景使用真实 Enter 触发并验证当前输入和历史改序的选中/焦点、失败不夺焦与外部项目切换后的迟到响应（等待响应时用工具定位焦点，外部切换通过公开项目消息与 popup 轮询；成功后额外观察一次 Tab，不代表完整 Tab 顺序审计，未覆盖系统下拉键盘选值、触屏或屏幕阅读器）；后端请求/快照由隔离测试验证，预览不证明真实模型遵从。

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

## 六阶段交付范围

| 阶段 | 已实现机制 | 验收入口与边界 |
| --- | --- | --- |
| 1 规范与定位 | token来源、组件索引、静态检查、布局测量与祖先诊断 | `context` / `check` / `verify` / `inspect`；只覆盖登记的关系 |
| 2 组件状态样例 | 生产组件的空态、加载、忙碌、失败、禁用、长文本、窄屏、键盘dialog/帮助样例 | `examples`生成导航；`verify`运行目录中的example场景；系统原生picker键盘未覆盖 |
| 3 有限视觉比较 | 3个核心场景、环境/字体指纹、before/after/diff、候选和单场景接受 | `baseline`提出候选，`visual`比较；初始截图须人类审阅，不自动成为基线 |
| 4 隔离真实扩展 | 未修改MV3构建、临时profile、service worker、扩展页面、宿主隔离与外部键盘行为 | `extension`；closed ShadowRoot内部几何和真实模型仍未覆盖 |
| 5 开发与CI门禁 | quick/browser/full分层、失败非零、所有登记场景保守执行、报告归档 | `gate`、npm别名、GitHub workflow；远端实际结果必须另行核实 |
| 6 持续维护机制 | 设计变更影响记录、来源指纹检查、精确例外到期检查、代表性同值token迁移 | `change`、exceptions.json；后续真实设计变更仍由人和agent持续维护 |

组件样例使用预览消息与合成资源，几何场景复用生产构建；没有复制一套展示组件。`examples`生成的HTML链接需要另行启动preview，自动准备和验收由`verify`负责。示例覆盖声明及局限也显示在导航页中。

真实扩展验收运行于临时Chromium profile，保留生产closed ShadowRoot；观察宿主页面、扩展宿主元素及可见外部行为。代理只服务本次合成宿主和图片，其他网络请求全部拒绝，不转发到本地bridge或模型。报告区分真实MV3行为与preview fixture，不能互换证据。

视觉比较限于workspace-wide、workspace-narrow和popup。系统、浏览器、字体测量、DPR、语言、时区、视口、fixture须匹配；缺失或不兼容返回uncovered且CLI退出1。默认RGBA通道容差8、允许差异像素0，无大面积遮罩。具体流程见[视觉基线](visual-baselines/README.md)。

维护、门禁与首次基线接入见[维护流程](maintenance.md)。基础设施已能执行检查，并不等于所有产品状态或所有后续设计变更已经验收。
