# Agent 工具库

供执行者测试、定位和复核 Reframe 的脚本。工具由执行者创建和维护，监工审查适用性与交付证据；新增工具按根 [AGENTS.md](../AGENTS.md) 协作。不在这里复制产品业务规则或另建依赖树。

## 准备与入口

沿用 [扩展安装要求](../browser-extension/README.md)：Node.js >=22.15.0，在 `browser-extension/` 安装依赖。预览直接导入产品 TypeScript 策略，需要 Node 原生类型擦除支持；本轮验证使用 Node 24.19.0。以下命令从仓库根目录执行；脚本与内置资源按自身位置定位，也可使用绝对脚本路径从其他目录运行。

| 工具 | 用途与入口 | 输入 | 输出 |
| --- | --- | --- | --- |
| [ci.mjs](ci.mjs) | CI 差异分流与文档检查：`node agent-tool/ci.mjs classify` / `docs` | GitHub 事件环境变量及本地 Git 提交 | JSON 分类/检查结果；可选 GitHub 输出与摘要 |
| [ui.mjs](ui.mjs) | UIUX 规范/诊断入口：`node agent-tool/ui.mjs --help` | 源码、规则目录、构建及合成预览 | 上下文、静态问题、生成目录、浏览器测量与截图/trace |
| [preview.mjs](preview.mjs) | 构建后界面与消息契约预览：`node agent-tool/preview.mjs` | 扩展构建产物、公开示例图片；可选下述环境变量 | stdout 本机 URL，HTTP 页面、图片与回归脚本 |
| [gallery-preview.mjs](gallery-preview.mjs) | preview 内部画廊 fixture helper，无独立 CLI | 仓库示例图与合成数据 | 内存缩略图、fixture 路由与消息模拟片段 |
| [benchmark-session-index.mjs](benchmark-session-index.mjs) | 合成数据索引基准：`node agent-tool/benchmark-session-index.mjs 500` | 可选会话数，整数 1–1000，默认 500 | stdout JSON：字符量、数据库大小、写入与 100 次搜索耗时 |
| [benchmark-session-search.mjs](benchmark-session-search.mjs) | 比较逐次启动与复用只读会话连接：`node agent-tool/benchmark-session-search.mjs 5` | 可选每策略请求数，整数 2–20，默认 5；`CODEX_BIN` 默认 `codex` | stdout JSON：CLI 版本、进程数、启动与请求耗时 |

额外位置参数、超出范围或非整数参数均报错并非零退出。

## CI 差异与文档检查

`ci.mjs` 仅依赖 Node 内置模块与 Git，不需要安装扩展依赖。从仓库根目录运行，读取 `GITHUB_EVENT_NAME`、`GITHUB_EVENT_PATH`（事件 JSON）及 push 的 `GITHUB_SHA`。`classify` 输出 `docs` 或 `full`、理由、提交与路径；设置 `GITHUB_OUTPUT` / `GITHUB_STEP_SUMMARY` 时追加分类输出和摘要。`docs` 重新验证分类、执行 `git diff --check` 和仓库链接检查，失败非零退出。

- 轻量白名单：根 `README.md`、`GLOSSARY.md`、`AGENTS.md`、`Contribution.md`；插件根 `README.md`、`AGENTS.md`；`browser-extension/docs/` 下的 `FEATURES.md`、`architecture.md`、`INSTALL_WITH_CODEX.md`；`.agents/roles/`、`agent-logs/`、`browser-extension/docs/releases/` 的直属 `.md` 普通非执行文件。其他路径进入统一代码验证入口，包括工具说明、UIUX规范/基线、画廊、源码、依赖与CI自身。
- PR比较 merge-base→head 的累计差异；push比较 before→sha。改名检查两端，删除仍参与分类；空差异、未知事件、基准不可读、非普通文件或Git错误均回退代码验证，手动触发始终完整。这里的 `full` 只是“非 docs”分类；最终范围由下述 `test-run` 决定，视觉层级仍由既有基线/手动参数决定。
- 文档检查读取提交中的文件，不读取未跟踪工作区文件作为有效目标。检查变更文档内的相对文件/目录链接及图片路径，也扫描其他白名单文档中因删除/改名新失效的入链；未修改文档原有断链不追溯阻断。支持仓库常用行内链接和引用定义、角括号及URL编码路径；忽略代码示例、协议URL、绝对机器路径及纯锚点，不联网、不验证标题锚点或完整CommonMark/HTML语法。
- 轻量路径只执行checkout、Node准备、分类和文档检查，不恢复npm缓存、不安装依赖/Chromium、不构建、不启动UI门禁、不上传UI产物。代码路径保留缓存、构建、类型、静态、产品/工具与浏览器验证；已准备报告目录时上传证据。
- 副作用：脚本启动只读Git子进程，只向stdout及显式GitHub输出文件写入；不访问账户、真实项目数据、模型或网络，不启动服务器/浏览器。`node --test agent-tool/ci.test.mjs` 在OS临时目录创建、提交、改名和删除合成Git文件，结束自动清理；无需产品构建。

## 文件级选测与集中回归

统一入口从仓库根运行：

| 命令 | 用途与输出 |
| --- | --- |
| `node agent-tool/test-run.mjs plan --index /absolute/test-index.json` | 只读来源/影响分析；输出 selected、deferred、fallback，不构建、不启动测试。 |
| `node agent-tool/test-run.mjs run --index /absolute/test-index.json --base REF --output /absolute/new-directory` | 构建一次、类型检查、核心＋关联旧测试＋新增/修改测试；索引缺失或不可靠则完整。输出 report.json、逐测试日志、各阶段与场景耗时。 |
| `node agent-tool/test-run.mjs run --full --base REF --output /absolute/new-directory` | 完整产品/工具测试及完整 browser gate；`--visual` 额外要求已审阅平台视觉基线。完整成功且来源干净稳定才输出 test-index.json。 |
| `node agent-tool/test-schedule.mjs plan [PR编号或0]` | 只读 GitHub main/open PR/job 状态，输出待跑和推迟原因；0代表main。 |
| `node agent-tool/test-schedule.mjs verify-full PR编号` | 重读当前 head/base/test-merge，核验准确版本完整成功；旧SHA、失败、取消、未完成不通过。 |

`test-run`（含plan）前置条件是扩展 npm 依赖和 Playwright Chromium 已安装，plan只读取二进制/字体指纹，不启动浏览器。`--no-build` 仅复用同模式有效指纹；`--base` 缺失默认 HEAD，CI 不确定基准使用空树保守检查。输出目录须独享；本地未提交源码可以完整验证，但不发布可复用提交索引。

- 每个 Node 测试文件在单独进程/覆盖目录实际执行；浏览器按既有 scenario ID 独立采集，再用 hidden sourcemap 映射实际执行范围。loaded bundle 的源码集合另记为保守依赖，不冒称执行。原始 Node 覆盖在本地 evidence/node/node-N，CI artifact 省略其冗大的原始JSON，保留日志、逐项映射与报告。
- CSS/assets、worker/background、匿名VM、readFile、重设环境/脱离的子进程无法单凭覆盖证明无影响。除5个已审阅直接导入的 Node 测试外，其他及未来新增测试默认关联全部初始可靠源码；缺map/未知浏览器执行也补保守依赖。经审阅的预览执行域不启动生产bridge，只有运行工具、全部前端/fixture、依赖等源码指纹严格匹配test-policy中已审阅摘要时，才排除task-runtime/task-records的未知page依赖；实际执行/映射到的关系始终保留。任一域内变化自动失效并恢复保守全量，维护者重新审阅导入与执行边界后才可更新摘要，不自动学习接受。第一阶段减少bridge变更的不相关浏览器场景，Node范围仍保守。
- 预览进程经父子 IPC 为实际发出的 `/preview.js` 与已登记的 regression 脚本登记 URL、body SHA256 和仓库来源摘要。采集器核对 coverage.source 与当前来源后才标记 harness，并保留 operation-policy、image-order 等序列化产品依赖；产品bundle也须与磁盘实际内容一致才可使用source map；相同 URL 换内容、来源漂移、脚本文本缺失、无登记或匿名嵌套 eval 仍为 unknown。报告 attribution 保存 scriptId、内容摘要、分类及理由，不按 sourceURL 名称或 Playwright 前缀忽略脚本，也不宣称 anonymous 已清零。
- 初始可靠源码仅 `generation-session.ts`、`operation-policy.ts`、`bridge/task-runtime.mjs`、`bridge/task-records.mjs`。首次完整索引只采集，两次完整采集的关联测试集合完全相等且非空才标记shadow通过；集合缩小或扩大均回退full。高频CI实际消费该标记；未知混合、改名/删除/新增源码、依赖/工具/构建变化、7天过期、跨环境、非祖先/来源不符一律full。新改测试必跑；全部工具测试、声明核心与隔离MV3检查必跑，selected不是完整回归证据。
- 索引完整性要求 Node 0 skip/todo、全部文件和场景执行、静态/类型/gate通过、前后来源一致。沿用现有gate的3项精确能力声明（两项只读图旋转不适用、原生picker能力缺口），逐项保留场景/规则/原因且场景固定核心；任何新增skip或整场景缺失都拒绝索引。full与selected共用浏览器场景、必需断言、三项例外及扩展16项检查/隔离/来源校验；selected按准确应跑集合验证，缺场景、失败断言或未声明skip均失败。报告保留skippedChecks的原始actual与原因；skipped计整场景跳过，不能掩盖断言跳过。完整指已登记可运行覆盖，不代表原生picker、真实模型或人工视觉验收通过。
- `REFRAME_TEST_COVERAGE=1` 仅测试构建生成隐藏map，参与构建/证据指纹；普通构建与coverage构建不能混用，coverage模式禁止zip。测试不修改生产业务，不访问真实模型/账户/项目；启动本机合成预览、隔离浏览器及临时测试子进程，写构建和独享临时证据。SIGINT/SIGTERM终止当前进程并使结果失败；强杀可能留下临时目录，不能据残留文件认定成功。
- `test-full.yml` 每小时第17分钟检查main和所有开放PR，固定SHA与merge双亲，只读worker执行。同一控制规则/准确SHA只认最新执行：先归并同run的最高attempt，再按attempt实际开始时间比较不同run；最新成功或在跑则推迟，失败/取消重试，旧成功不能覆盖新状态。attempt未结束时所有目标均不得提前验收；结束后各目标按自身job状态与结论判定，其他目标失败不否定成功目标。调度、验收、baseline与文档比较共用此判定；时间或记录有歧义则明确失败。手动dispatch可提前完整执行；纯说明变化仅在无该目标准确执行记录时走轻量，已有失败/取消须重试，在跑须等待，不能被docs分支覆盖。完整分页枚举run元数据，再对活跃或最近7天更新/开始的run读取指定attempt及jobs，避免按创建日期遗漏旧run近期重跑；时序来自[GitHub attempt API](https://docs.github.com/en/rest/actions/workflow-runs#get-a-workflow-run-attempt)，不假定API返回顺序。API/分页失败明确失败，不是空计划成功。调度存在GitHub排队延迟，未宣称精确整点SLA。
- fork保留普通原生pull_request CI及GitHub审批，但其可修改的工作流/工具所生成的成功job和artifact不构成可信完整验收。主线调度不执行fork代码，明确defer为`fork-independent-trusted-verification-required`；`verify-full`对fork一律失败，必须由维护者另行独立可信验收。同仓PR仍核对受信任调度的准确被测SHA，不能用schedule控制提交替代。该CLI不设置远端分支保护，也不代替独立review。
- 调度/证据CLI需要 `gh` 登录及 `GITHUB_REPOSITORY=owner/repo DEFAULT_BRANCH=main`，使用GitHub只读API；baseline子命令仅从每个SHA最新执行仍成功的可信main记录下载artifact到指定临时文件；同SHA后续失败/取消/在跑会淘汰旧index，网络失败则full。artifact名称绑定成功run_attempt，重复项取当前attempt最新ID，旧失败attempt不串入。选测环境指纹核对实际Chromium/headless二进制、驱动、字体及配置文件内容和LANG/TZ等变量；字体以有序来源目录与相对文件名、内容摘要标识，跟随符号链接，不依赖安装根路径或mtime，真实内容变化仍失效回退full。本机evidence门禁继续使用原严格本机回执。它不发消息、不提交/推送/合并/发布。`verify-full` 必须使用当前可信默认分支的干净控制checkout（工具所在目录，而非调用者的PR工作目录），例如 `GITHUB_REPOSITORY=owner/repo DEFAULT_BRANCH=main node /absolute/trusted-main/agent-tool/test-schedule.mjs verify-full 12`；工具核验该checkout仍对应远端main，拒绝PR版本或脏控制器。`verify-full` 是检查时点的证据，真正合并前仍须确认head/base未推进。

针对性验证：`node --test agent-tool/test-impact.test.mjs agent-tool/test-run.test.mjs agent-tool/test-schedule.test.mjs`，使用合成临时Git、真实Node覆盖及API边界fixture，不访问真实GitHub或启动产品浏览器。远端工作流须实际运行后才算CI通过。

## 界面预览

逆向 Agent 设置：`node agent-tool/ui.mjs verify --scenarios agent-settings-wide agent-settings-narrow agent-settings-legacy`。覆盖 Codex/Pi 卡片、独立模型目录、保存失败、重开与旧服务兼容，使用合成消息，不调用真实 CLI 或模型。

生图 API 设置：`node agent-tool/ui.mjs verify --scenarios image-settings-wide image-settings-narrow image-settings-legacy`。复用生产设置组件，覆盖两种 API、保存失败、重开、密钥不回显、清除和窄屏；仅合成消息，不访问真实凭据、供应商或项目。桥接与协议反例：`node --test browser-extension/tests/image-api-bridge.test.mjs browser-extension/tests/image-api.test.mjs browser-extension/tests/image-settings.test.mjs`，使用临时配置、合成图片与 stub，不调用真实模型。

先运行 `npm --prefix browser-extension run build`，再运行 `npm --prefix browser-extension run preview`。原来的 `cd browser-extension && npm run preview` 入口保留。仅监听 `127.0.0.1`，按 Ctrl+C 停止自己的预览进程。

- `PREVIEW_PORT`：默认 `43188`，整数 0–65535；0 自动分配空闲端口，实际地址见 stdout。占用端口报错，不关闭已有服务。
- `PREVIEW_INPUT_IMAGE` / `PREVIEW_RESULT_IMAGE`：可选本地比对图片，默认使用仓库公开海报素材；自定义相对路径按调用目录解释，也可使用绝对路径。
- 图片预览遮挡检查：`node agent-tool/ui.mjs verify --scenario example-image-viewer-portrait`（975×1034），另有 `example-image-viewer`（宽屏）、`example-image-viewer-narrow`（320×740）、`example-image-viewer-short`（320×360）、`example-image-viewer-result-short`（先640×740打开再缩小至640×360，恢复原尺寸检查焦点返回，只读结果）、`example-image-viewer-result-popup`（400×740 只读结果）。使用生产组件与合成数据，检查独立控制行、适配/缩放/平移/旋转及键盘返回；报告 `evidence.imageViewer` 含过程截图。运行后关闭临时页面，不应用旋转、不写真实项目；需要已有有效产物时使用 `--no-build`。`node --test agent-tool/ui/image-viewer.test.mjs` 验证旧浮层遮挡和裁剪失效负例，不触发构建；closed ShadowRoot 的共享 CSS fixture 只证明合成布局，不能代替真实内容面板验收。
- 图片顺序行为场景：`ui.mjs verify --scenario image-order-paired`（双图改序/模式隔离/重开/请求）、`image-order-multi`（参考图中间/末尾与主体跨图移动）、`image-order-legacy`（旧历史编号与当前输入隔离）、`image-order-failed`（保存失败回滚）、`image-order-popup`（轻量窗口）；`image-order-keyboard-new/history/failure/late` 为四个独立的 320px popup 场景，使用真实 Enter 触发改序，验证选中与焦点、失败和迟到响应；焦点移出使用工具 focus，外部项目切换使用公开消息与 popup 轮询，成功后观察一次 Tab，不代表完整键盘导航审计。各命令前加 `node agent-tool/`；可在有效构建指纹后加 `--no-build`。合成预览复用生产图片编号校验函数，但不证明真实 bridge 的任务冻结、失效保护或模型附件顺序；这些由隔离后端测试验证。
- 默认任务指令图号：`ui.mjs verify --scenario image-instruction-default-paired` 验证改序、模式隔离、重开与提交；`image-instruction-legacy-paired` 验证精确旧默认迁移；`image-instruction-default-multi` 验证参考模板居中及主体增删编号。双图场景同时验证自定义文本原样保存和提交，三个场景均检查历史任务未改写；仅使用合成预览，不证明真实后端持久化或模型遵从。
- 连续生图：`node agent-tool/ui.mjs verify --scenario end-to-end-workspace`；另有 `end-to-end-popup`（320px）、`end-to-end-cancel`、`end-to-end-phase-cancel`、`end-to-end-context`、`end-to-end-reverse-failed`、`end-to-end-generation-failed`、`end-to-end-popup-start-failed`（自动启动失败后重试比例）。验证一次提交、独立逆向、同提示词重复生图、语言比例、阶段取消、跨上下文及失败恢复；预览新增 `endToEndRegression`、`reverse=failed`、`reverseDelay` 等仅用于合成场景，不调用真实模型或写入真实项目。API持久化及服务重启另由后端隔离测试覆盖。真实键盘场景为 `end-to-end-keyboard-{workspace|popup}-{cancel|failure|tab|tab-failure|project|project-failure|legacy}`，使用 Playwright Enter/Tab 验证提交、取消、失败及迟到响应焦点，复用统一 runner；项目切换用公开消息或工作台导航 hash 触发，不代表点击提交期间被禁用的项目按钮，仍仅操作合成预览。
- 批量完整复刻：`node agent-tool/ui.mjs verify --scenario batch-recreate-mixed`；另有 `batch-recreate-retry`、`batch-recreate-late`、`batch-recreate-narrow`、`batch-recreate-keyboard`、`batch-recreate-history`、`batch-recreate-hidden`、`batch-recreate-all-accepted`、`batch-recreate-preflight-hidden`、`batch-recreate-retry-hidden`。验证全受理后的键盘焦点与 Tab 续行、预检在途/完成后外部隐藏及全隐藏零提交、包含开关恢复、隐藏后未知请求保持同键同体、批次之后手动生图仍可见、隐藏项目不被取消回包重新显示、预检失败、提交时部分拒绝、仅清受理选择、语言比例、同键重试、迟到预检、批次停止剩余与单项取消；键盘场景使用真实 Enter/Space/Tab/Escape 检查对话框焦点约束和返回；跨窗口隐藏通过公开消息模拟，并触发既有可见性轮询读取健康状态，不直接修改 React 状态。预览提供固定的 running/queued/rejected 响应及取消结果，不实现生产调度；不证明并发、持久化、服务重启、关闭工作台继续执行或真实模型成功，这些分别由后端隔离测试或实机验证覆盖。`batchPreviewDelay`/`batchStartDelay` 和 `batchRecreateRegression` 仅控制合成消息。
- 批量操作栏响应式：`node agent-tool/ui.mjs verify --scenarios batch-toolbar-360 batch-toolbar-650 batch-toolbar-651 batch-toolbar-877 batch-toolbar-1440`。沿现有合成项目覆盖卡片/列表、隐藏范围、0/1/10/24项及取消选择；记录操作栏、按钮和内容区几何，检查文字完整、无底色、无横溢出及键盘焦点，保留各宽度截图。不调用模型或改真实项目。
- 查询参数和界面场景见 [扩展预览文档](../browser-extension/README.md)。回归脚本仍位于 `browser-extension/tests/`；预览只负责加载。

预览读取构建文件、示例图及显式指定的图片，缩略图在内存生成。浏览器 fixture 会使用当前预览 origin 的 localStorage/sessionStorage；不写真实项目资产、不连接 bridge、不调用 Codex。模拟行为及 HTTP 资源测试不能替代实际扩展与真实模型验收。

自动连接补充验收：`node agent-tool/ui.mjs verify --scenarios automatic-connection-workspace automatic-connection-workspace-narrow automatic-connection-popup`。合成未配对状态、首次健康请求失败及下一轮成功，验证自动恢复、无手填配对、首次不强制打开设置、离线本地设置可用与恢复后导航保留；不启动真实本机服务或调用模型。

模型设置补充验收：`node agent-tool/ui.mjs verify --scenarios agent-settings-layout-wide agent-settings-layout-narrow agent-settings-layout-loading agent-settings-layout-missing agent-settings-layout-failed agent-settings-layout-custom agent-settings-layout-updating agent-settings-layout-installing`。沿用统一构建、隔离预览与Chromium，使用合成消息；分别输出模型/管理区截图，320px长路径另存详情图，并检查真实Space/Enter/Tab焦点。既有`agent-settings-*`负责业务往返，`image-settings-*`与`settings-recovery{,-narrow}`覆盖共享导航。`verify --fault settings-overflow`与`--fault settings-focus`应非零退出，分别证明横溢出与不可见卡片焦点会被检测。默认构建会写入构建产物，临时报告/profile及进程由工具管理；不访问真实账户、CLI、模型、用户数据或接受视觉基线。有效构建可加`--no-build`复用。

## UIUX 规范与诊断

先读 [UIUX 规范](../browser-extension/docs/uiux/README.md)和[生成目录](../browser-extension/docs/uiux/catalog.md)。依赖沿用扩展的 `playwright`、`postcss`、`postcss-value-parser` 与 TypeScript；浏览器检查首次需在 `browser-extension/` 执行 `npx playwright install chromium`。静态检查不需要下载浏览器。

| 命令 | 用途 / 输出 |
| --- | --- |
| `node agent-tool/ui.mjs prepare [--no-build]` | 唯一 UI 构建/指纹准备入口；默认构建，`--no-build` 只核对已有产物。单独构建不能建立 UI 证据。 |
| `node agent-tool/ui.mjs evidence --report FILE --sha256 DIGEST [--reason TEXT]` | 只读核验执行者交付时的摘要、完整覆盖、附件、当前来源及同机环境；输出可复用范围与未覆盖项，不接受视觉基线。 |
| `node agent-tool/ui.mjs context --files PATH …` | 按仓库相对路径找规则与候选场景；未知依赖回退全部；`--json` 含组件与变量。 |
| `node agent-tool/ui.mjs check [--changed] [--base REF]` | AST 检查装载、变量、颜色及目录同步；`--changed` 比较 HEAD（或指定 ref）到当前工作区，含未跟踪文件。变量消费者仍全量检查。 |
| `node agent-tool/ui.mjs sync [--check]` | 从 catalog 与实际 CSS 生成索引；`--check` 只比较、不修改。 |
| `node agent-tool/ui.mjs verify [--scenario ID \| --scenarios ID …] [--no-build] [--reason TEXT]` | 默认构建并检查全部登记场景；显式列表提供定向反馈，报告标注覆盖；CI选测由 `test-run` 统一决定；`--no-build` 验证源码/产物指纹后复用构建。 |
| `node agent-tool/ui.mjs inspect --scenario ID [--no-build]` | 同一采样器，额外保留成功场景的祖先测量与 trace。 |

所有命令支持 `--json`，浏览器进度写 stderr。退出码0表示已登记检查通过（允许警告），1表示失败，2表示参数错误。`verify --fault canvas-padding|quick-height|image-offset --no-build` 注入已知错误，**预期退出1**，不改产品文件；默认自动选择该故障的适用场景。

浏览器验证写扩展 `.output/` 构建及指纹，启动自己的 localhost 随机端口与独立浏览器 context；用临时合成图片和 fixture，不访问 bridge、真实项目或模型。固定视口、DPR、语言、时区和减少动态效果设置，等待字体/图片/几何稳定。几何场景固定浏览器 Date，行为回归保持真实时钟以保证 ID 和超时语义；字体使用当前系统字体，不承诺跨系统像素一致。预览服务 fixture 时间仍来自本机。

报告保留在 OS 临时目录 `reframe-ui-*`，包含 JSON 测量、Markdown 摘要、所有场景截图和失败/inspect trace；路径在 stdout。诊断限制16个目标、每个至多5层自身/祖先样式。可用扩展目录中的 `npx playwright show-trace /absolute/path/scene.trace.zip` 查看。报告不会写入版本库；不再需要时可删除这次输出目录。正常退出及 SIGINT/SIGTERM 清理本次进程，系统强制杀死可能留下临时文件或进程。

聚焦验证：`node --test browser-extension/tests/ui-static.test.mjs browser-extension/tests/ui-tool.test.mjs`；真实 Chromium 采样器正反例：`node --test agent-tool/ui/probe.test.mjs`。后者需已安装浏览器，独立于默认产品测试。组件样例、有限视觉比较、隔离真实扩展与分层门禁见下文；各自证据不可替代。

完整 UI 工具测试：`node --test --test-concurrency=1 agent-tool/ui/*.test.mjs`。其中门禁取消持久化测试在独立子进程中只保留三个核心视觉场景，以验证信号、失败报告和资源清理；它不替代 `gate --tier browser` 的全场景验收。

报告另外记录预览 fixture 指纹及文件清单，覆盖 `ui.mjs`、`preview.mjs`、`gallery-preview.mjs`、浏览器回归脚本和画廊 fixture 文件。结束时再次核对；运行中这些输入变化会使结果作废。它独立于产品构建指纹，纯 fixture 修改可以用 `--no-build` 重新验证。

## 开发反馈、最终证据与耗时

```sh
node agent-tool/ui.mjs prepare
# 按 plan 建议显式选择；独立复核关键键盘、失败恢复与共享消费者后再定稿
node agent-tool/ui.mjs verify --scenarios example-image-viewer-portrait end-to-end-keyboard-popup-failure --no-build --reason development-risk-review
node agent-tool/ui.mjs gate --tier browser --no-build --reason final-validation --json
# DIGEST 使用上一步执行者交付中的 evidenceSha256，不能从待审文件重新算一个代替
node agent-tool/ui.mjs evidence --report /absolute/gate.json --sha256 DIGEST --reason supervisor-review --json
```

`prepare`、`verify`、`gate`、`extension`、`evidence` 共用 `.output/ui-validation.lock`。同一调用链可嵌套，其他进程/调用立即失败（等待0毫秒）；不会自动清锁或结束持有者。正常、异常及可处理信号退出释放锁；SIGKILL/崩溃可能残留，先核实持有 PID/操作和工作状态，再人工移除确认无持有者的锁。工具锁无法拦截直接 `npm run build` 或编辑器写入；验证窗口内团队暂停所有构建及受检源码/fixture/检查器修改，首尾指纹变化使报告失效。

`evidence` 仅支持macOS/Linux本机24小时内的完整 browser/full 报告。核验产品源码/产物、fixture、检查器、Node/OS/架构、Playwright驱动/Chromium及headless-shell可执行文件、字体目录元数据及相关环境变量，重算报告和截图/trace/候选附件摘要，再核对原始报告与门禁内容一致。静态/目录/到期例外检查在复用时重新执行，避免跨日期或仅文档变化绕过门禁。缺失、篡改、环境变化、未声明跳过、部分覆盖或取消一律失败；旧报告无新回执时不可复用。摘要须来自可信执行者当轮交付，它只能约束内容未变，不能证明可信执行者以外的任意文件执行过测试。字体目录元数据不能发现保持大小和时间戳的刻意替换；有字体/系统状态疑点时重跑。它不替代独立风险复核，不代表产品/工具测试或视觉批准，真实模型、用户profile与跨机器复用均不在范围内。

报告包含 `reason`、`startedAt/finishedAt`、`timing.durationMs`、阶段耗时与场景 `durationMs`；gate区分静态、预览、隔离扩展、视觉候选，preview区分构建/核验、启动与清理。`waitMs: 0` 仅表示锁不等待，不是团队没有等待。人工开发、评审和协调等待在任务日志按开始/结束或实际估计记录，并标注估计；重跑写明原因，不把缺失工时算0。比较须同机器、同构建模式、同场景及合理负载；历史数字只作历史参考。

正常产品场景归最终gate统一执行。工具自测保留检查器代表正例及错误状态、隐藏/禁用动作、几何故障、取消、清理和来源漂移反例；不再逐一重复全部正常样例。只改产品时按风险选择工具测试，工具改动运行相关自测；最终产品回归和共享界面覆盖不因此减少。交付最少列明变更、定向复核、最终报告及可信摘要、未覆盖项、实际耗时/重跑原因；不为小样式改动扩建无需求的工具或复制日志全文。

## 状态样例、视觉、扩展与门禁

| 命令 | 用途 / 输出 |
| --- | --- |
| `ui.mjs examples [--origin http://127.0.0.1:PORT]` | 临时HTML导航，链接生产预览；预览需单独启动，自动验证仍运行verify。 |
| `ui.mjs baseline --report /absolute/report.json [--scenario ID]` | 生成3个核心场景或指定场景的候选、比较HTML与manifest，不接受截图。 |
| `ui.mjs visual --report /absolute/report.json [--baseline-dir DIR]` | 固定策略像素比较；缺基线或环境不兼容退出1。 |
| `ui.mjs accept --candidate DIR --scenario ID --reason TEXT --reviewer NAME [--baseline-dir DIR]` | 人类明确审阅后一次接受一个核心场景，保留来源与审阅记录；reviewer字符串不是授权。 |
| `ui.mjs extension` | 消费已有verify构建指纹，启动临时profile中的真实MV3；网络仅本次合成fixture，失败/信号清理自己资源。 |
| `ui.mjs gate --tier quick\|browser\|full [--base REF] [--no-build] [--baseline-dir DIR]` | quick=静态增量+目录+例外；browser再加全场景预览+真实扩展；full再要求已审阅像素基线。 |
| `ui.mjs change --files PATH … --reason TEXT [--output FILE]` | 生成proposed设计变更记录：来源hash、受影响规则/场景、复核清单。输出文件必须不存在。 |
| `ui.mjs change --record FILE` | 校验记录与当前来源/映射一致，不证明记录中的证据真实执行或已审阅。 |

上表命令均加前缀 `node agent-tool/`；完整参数以 `--help` 为准。路径参数除`--files`按仓库根解析外，报告/候选/基线/output按当前目录解析，推荐绝对路径。npm别名在扩展目录：`ui:check`、`ui:verify`、`ui:full`。`gate browser/full`保守运行全部登记场景，避免不完整依赖图漏测；context仍可帮助手工定位。

新命令沿用exit0成功、exit1失败/未覆盖、exit2参数错误。候选生成成功表示材料可审阅，不代表视觉验收通过；`gate browser`也不包含视觉批准。OS临时目录统一保存报告，CI设置TMPDIR后归档，扩展profile正常清理但证据保留。

[GitHub workflow](../.github/workflows/uiux.yml)在PR及main/master push保留同一个 `UIUX infrastructure / uiux` 检查，先按文档白名单分流。纯说明文档只做轻量检查；其他改动进入上方统一分级入口的选测/保守回退，手动及fork运行完整回归。完整流水线在初始Linux基线缺失时明确列出待审阅并上传候选；指定workflow_dispatch的require_visual或存在Linux基线manifest后运行视觉full层级，缺少任一核心场景即失败。仓库分支保护须由维护者将此job设为必需检查；本地文件存在不能证明远端CI执行或分支保护已启用。Mac与Linux基线分目录，不能互相冒用。

详细设计变更、到期例外与首次基线流程见[维护指南](../browser-extension/docs/uiux/maintenance.md)。

## 基准的副作用与限制

索引基准直接复用产品索引实现，在 OS 临时目录创建独立 `reframe-index-benchmark-*` 数据库，只写合成文本；正常结束或可捕获异常时关闭并删除该目录。强制终止可能留下该临时目录。它不读取真实 Codex 会话，不接受现有数据库路径。耗时受机器、数据规模与缓存影响。

搜索基准会执行指定 CLI 的 `--version` 并启动 `app-server`，只发送初始化与 `thread/list`，每次最多列出 30 条未归档会话元数据，不读取正文、不创建任务、不调用模型。真实运行会使用调用目录及当前 CLI 配置/登录，CLI 自身可能写运行日志或状态；输出不包含标题、正文或会话 ID。仅在任务授权覆盖本地会话元数据读取时运行；自动回归使用隔离 stub，不访问真实会话。CLI 版本查询和 RPC 有 30 秒超时，完成时释放自己创建的进程。两策略顺序运行，结果是本地暖缓存样本，不是受控性能保证。

## 验证与维护

从根目录运行：

```sh
npm --prefix browser-extension run build
npm --prefix browser-extension run compile
npm --prefix browser-extension test
```

聚焦验证：`node --test browser-extension/tests/agent-tool.test.mjs browser-extension/tests/preview-contract.test.mjs`。覆盖两个调用目录、预览静态资源与生产消息契约、参数拒绝、临时索引清理以及隔离 CLI 的协议/进程回收。

新增或迁移工具须同步本索引、调用入口与必要行为验证，记录依赖、输入输出、副作用和适用边界。安装/服务管理 `browser-extension/scripts/manage.mjs` 与构建图标 `browser-extension/scripts/icons.mjs` 属于产品运行/构建链，保留原位。

coverage报告复核须显式沿用模式：`REFRAME_TEST_COVERAGE=1 node agent-tool/ui.mjs evidence --report /absolute/gate.json --sha256 TRUSTED_DIGEST`。普通命令按normal模式检查，不会自动信任报告切换模式；模式不符应失败。
