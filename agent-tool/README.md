# Agent 工具库

供执行者测试、定位和复核 Reframe 的脚本。工具由执行者创建和维护，监工审查适用性与交付证据；新增工具按根 [AGENTS.md](../AGENTS.md) 协作。不在这里复制产品业务规则或另建依赖树。

## 准备与入口

沿用 [扩展安装要求](../browser-extension/README.md)：Node.js >=22.15.0，在 `browser-extension/` 安装依赖。预览直接导入产品 TypeScript 策略，需要 Node 原生类型擦除支持；本轮验证使用 Node 24.19.0。以下命令从仓库根目录执行；脚本与内置资源按自身位置定位，也可使用绝对脚本路径从其他目录运行。

| 工具 | 用途与入口 | 输入 | 输出 |
| --- | --- | --- | --- |
| [ui.mjs](ui.mjs) | UIUX 规范/诊断入口：`node agent-tool/ui.mjs --help` | 源码、规则目录、构建及合成预览 | 上下文、静态问题、生成目录、浏览器测量与截图/trace |
| [preview.mjs](preview.mjs) | 构建后界面与消息契约预览：`node agent-tool/preview.mjs` | 扩展构建产物、公开示例图片；可选下述环境变量 | stdout 本机 URL，HTTP 页面、图片与回归脚本 |
| [gallery-preview.mjs](gallery-preview.mjs) | preview 内部画廊 fixture helper，无独立 CLI | 仓库示例图与合成数据 | 内存缩略图、fixture 路由与消息模拟片段 |
| [benchmark-session-index.mjs](benchmark-session-index.mjs) | 合成数据索引基准：`node agent-tool/benchmark-session-index.mjs 500` | 可选会话数，整数 1–1000，默认 500 | stdout JSON：字符量、数据库大小、写入与 100 次搜索耗时 |
| [benchmark-session-search.mjs](benchmark-session-search.mjs) | 比较逐次启动与复用只读会话连接：`node agent-tool/benchmark-session-search.mjs 5` | 可选每策略请求数，整数 2–20，默认 5；`CODEX_BIN` 默认 `codex` | stdout JSON：CLI 版本、进程数、启动与请求耗时 |

额外位置参数、超出范围或非整数参数均报错并非零退出。

## 界面预览

先运行 `npm --prefix browser-extension run build`，再运行 `npm --prefix browser-extension run preview`。原来的 `cd browser-extension && npm run preview` 入口保留。仅监听 `127.0.0.1`，按 Ctrl+C 停止自己的预览进程。

- `PREVIEW_PORT`：默认 `43188`，整数 0–65535；0 自动分配空闲端口，实际地址见 stdout。占用端口报错，不关闭已有服务。
- `PREVIEW_INPUT_IMAGE` / `PREVIEW_RESULT_IMAGE`：可选本地比对图片，默认使用仓库公开海报素材；自定义相对路径按调用目录解释，也可使用绝对路径。
- 图片顺序行为场景：`ui.mjs verify --scenario image-order-paired`（双图改序/模式隔离/重开/请求）、`image-order-multi`（参考图中间/末尾与主体跨图移动）、`image-order-legacy`（旧历史编号与当前输入隔离）、`image-order-failed`（保存失败回滚）、`image-order-popup`（轻量窗口）；`image-order-keyboard-new/history/failure/late` 为四个独立的 320px popup 场景，使用真实 Enter 触发改序，验证选中与焦点、失败和迟到响应；焦点移出使用工具 focus，外部项目切换使用公开消息与 popup 轮询，成功后观察一次 Tab，不代表完整键盘导航审计。各命令前加 `node agent-tool/`；可在有效构建指纹后加 `--no-build`。合成预览复用生产图片编号校验函数，但不证明真实 bridge 的任务冻结、失效保护或模型附件顺序；这些由隔离后端测试验证。
- 查询参数和界面场景见 [扩展预览文档](../browser-extension/README.md)。回归脚本仍位于 `browser-extension/tests/`；预览只负责加载。

预览读取构建文件、示例图及显式指定的图片，缩略图在内存生成。浏览器 fixture 会使用当前预览 origin 的 localStorage/sessionStorage；不写真实项目资产、不连接 bridge、不调用 Codex。模拟行为及 HTTP 资源测试不能替代实际扩展与真实模型验收。

## UIUX 规范与诊断

先读 [UIUX 规范](../browser-extension/docs/uiux/README.md)和[生成目录](../browser-extension/docs/uiux/catalog.md)。依赖沿用扩展的 `playwright`、`postcss`、`postcss-value-parser` 与 TypeScript；浏览器检查首次需在 `browser-extension/` 执行 `npx playwright install chromium`。静态检查不需要下载浏览器。

| 命令 | 用途 / 输出 |
| --- | --- |
| `node agent-tool/ui.mjs context --files PATH …` | 按仓库相对路径找规则与候选场景；未知依赖回退全部；`--json` 含组件与变量。 |
| `node agent-tool/ui.mjs check [--changed] [--base REF]` | AST 检查装载、变量、颜色及目录同步；`--changed` 比较 HEAD（或指定 ref）到当前工作区，含未跟踪文件。变量消费者仍全量检查。 |
| `node agent-tool/ui.mjs sync [--check]` | 从 catalog 与实际 CSS 生成索引；`--check` 只比较、不修改。 |
| `node agent-tool/ui.mjs verify [--scenario ID] [--no-build]` | 默认构建并检查全部登记场景；`--no-build` 验证源码/产物指纹后复用构建。 |
| `node agent-tool/ui.mjs inspect --scenario ID [--no-build]` | 同一采样器，额外保留成功场景的祖先测量与 trace。 |

所有命令支持 `--json`，浏览器进度写 stderr。退出码0表示已登记检查通过（允许警告），1表示失败，2表示参数错误。`verify --fault canvas-padding|quick-height|image-offset --no-build` 注入已知错误，**预期退出1**，不改产品文件；默认自动选择该故障的适用场景。

浏览器验证写扩展 `.output/` 构建及指纹，启动自己的 localhost 随机端口与独立浏览器 context；用临时合成图片和 fixture，不访问 bridge、真实项目或模型。固定视口、DPR、语言、时区和减少动态效果设置，等待字体/图片/几何稳定。几何场景固定浏览器 Date，行为回归保持真实时钟以保证 ID 和超时语义；字体使用当前系统字体，不承诺跨系统像素一致。预览服务 fixture 时间仍来自本机。

报告保留在 OS 临时目录 `reframe-ui-*`，包含 JSON 测量、Markdown 摘要、所有场景截图和失败/inspect trace；路径在 stdout。诊断限制16个目标、每个至多5层自身/祖先样式。可用扩展目录中的 `npx playwright show-trace /absolute/path/scene.trace.zip` 查看。报告不会写入版本库；不再需要时可删除这次输出目录。正常退出及 SIGINT/SIGTERM 清理本次进程，系统强制杀死可能留下临时文件或进程。

聚焦验证：`node --test browser-extension/tests/ui-static.test.mjs browser-extension/tests/ui-tool.test.mjs`；真实 Chromium 采样器正反例：`node --test agent-tool/ui/probe.test.mjs`。后者需已安装浏览器，独立于默认产品测试。组件样例、有限视觉比较、隔离真实扩展与分层门禁见下文；各自证据不可替代。

报告另外记录预览 fixture 指纹及文件清单，覆盖 `ui.mjs`、`preview.mjs`、`gallery-preview.mjs`、浏览器回归脚本和画廊 fixture 文件。结束时再次核对；运行中这些输入变化会使结果作废。它独立于产品构建指纹，纯 fixture 修改可以用 `--no-build` 重新验证。

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

[GitHub workflow](../.github/workflows/uiux.yml)在PR及main/master push运行浏览器门禁与测试，初始Linux基线缺失时明确列出待审阅，上传候选；指定workflow_dispatch的require_visual或存在Linux基线manifest后运行full，缺少任一核心场景即失败。仓库分支保护须由维护者将此job设为必需检查；本地文件存在不能证明远端CI执行或分支保护已启用。Mac与Linux基线分目录，不能互相冒用。

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
