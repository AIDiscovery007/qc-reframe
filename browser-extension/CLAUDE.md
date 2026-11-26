# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概览

QC-Reframe：Chrome MV3 扩展（WXT + React 19 + TypeScript）+ 本机 Node bridge（`127.0.0.1:43187`）+ 随仓库分发的 `alchemy` 逆向技能。流程为「网页选图 → 本机 Agent（Codex 或 Pi）逆向提示词 → 所选渠道生图（Codex 内置 / OpenAI 兼容 / Gemini / Magpie 本机网关）」。五条创作路径：`style`、`recreate`、`reenact`、`multi-reenact`、`session`。版本以 `package.json` 为准。

## 先读规则

本文只是速查，详细约束以下列文档为准；发现与代码或用户需求矛盾时明确指出，不静默改变产品行为。

| 文档 | 何时读 |
| --- | --- |
| `../AGENTS.md` → `../docs/standards/{code,frontend,backend,review}.md` | 改代码前读 code.md；按工作类型补读前端/后端规则；审查读 review.md |
| `AGENTS.md`（本目录） | 产品决策与兼容约束：五模式职责、图片顺序、项目/快照、生图渠道、UI 与动效约定 |
| `docs/architecture.md` | 模块所有权、提交时序、改动对应的测试 interface |
| `../Contribution.md` | BDD 验收、完整回归、Git 与发布流程 |
| `../agent-tool/README.md` | `preview`、`ui.mjs` 等工具与完整回归的命令、前置条件与副作用 |
| `docs/uiux/README.md` | 改 UI 前定位设计来源、组件与场景 |
| `../GLOSSARY.md` | 领域术语 |

## 常用命令

在 `browser-extension/` 执行（Node ≥ 22.15）：

```bash
npm install                       # postinstall 执行 wxt prepare
npm run dev                       # WXT 开发模式
npm run build                     # 产物 .output/chrome-mv3（prebuild 先生成图标）
npm run compile                   # tsc --noEmit
npm test                          # node --test tests/*.test.mjs；须先 build，扩展测试读取当前构建
node --test tests/task-runtime.test.mjs           # 单个测试文件
node --test --test-name-pattern "stop remaining" tests/batches.test.mjs   # 按名称过滤
npm run preview                   # 合成数据预览 http://127.0.0.1:43188，不连 bridge、不调用模型
npm run zip                       # 发布 ZIP，仅含浏览器端
```

UI 门禁与回归（从仓库根执行；浏览器检查首次需在本目录 `npx playwright install chromium`）：

```bash
node agent-tool/ui.mjs check --changed                 # 静态 UI 规则
node agent-tool/ui.mjs verify --scenarios ID … [--no-build]   # 定向场景
node agent-tool/ui.mjs gate --tier browser             # 全部登记场景 + 隔离真实扩展
# 完整回归步骤见 ../agent-tool/README.md#完整回归（与 CI 相同）
```

`tests/*.browser.js` 不由 `npm test` 运行，而是 `ui.mjs` 场景经 preview 加载的浏览器回归脚本。`prepare/verify/gate/extension/evidence` 共用 `.output/ui-validation.lock`；验证期间不要另行 `npm run build` 或修改受检源码。

本机服务：`npm run setup | start | stop | status | doctor | pair`；`setup` 为 macOS 上已安装的 Chrome、Codex 注册原生按需启动器（2026-11-26 已在 macOS 真机验证：Chrome 与 Codex 内置浏览器打开 Reframe 时各自都能唤醒已停止的服务），也可 `npm run launcher:install -- chrome|codex` 单独注册。`npm run package:runtime` 在构建后生成 Release 运行包，`scripts/install.sh` 是对应的一键安装器。扩展 ID 由 manifest key 固定。只管理自己启动的服务，不杀不明进程、不绕过端口冲突。

## 架构要点

三个执行环境，业务规则集中在拥有它的 module，UI 只保留导航、布局与效果，HTTP 入口只保留鉴权、解析与装配。

**扩展端**
- 入口：`entrypoints/content.ts`（网页选图，closed Shadow DOM 浮层，不含 React 面板）、`page-panel.ts`（面板按需 bundle，首次打开时由后台 `scripting` 注入顶层 frame）、`background.ts`（消息路由与编排；连接/草稿/校验在 `lib/service-connection.ts`、`lib/session-drafts.ts`、`lib/message-validation.ts`，令牌只留在后台）、`popup/`（共用 React 组件与轻量界面 `QuickWorkspace`）、`workspace/`（独立工作台）。
- 请求链：UI → `lib/client.ts` → background → bridge（Bearer + Host/Origin 校验）。`lib/operation-policy.ts` 是请求来源、transport 与超时的共同目录。
- `lib/creation-context.ts`：草稿/当前输入/历史快照的优先级，以及唯一的持久输入 writer（`inputRevision` CAS）。响应的上下文核对与 commit 必须在同一段同步代码中完成，中间不得 `await`。
- `lib/generation-session.ts` + `lib/use-generation.ts`：工作台与快捷端共用的生图资格、提交和取消，改一处覆盖两端。
- `entrypoints/popup/App.tsx` 只是组合根（状态、布局、接线）。启动/轮询/交接/提醒在 `lib/surface-sync.ts`，服务健康在 `service-health.ts`，渠道设置在 `generation-settings.ts`，项目输入与可见性在 `project-inputs.ts`、`project-visibility.ts`，逆向提交与取消在 `reverse-action.ts`，交接草稿在 `workspace-handoff.ts`；新规则放进这些 module 并直接导入测试，不从 App 源码提取闭包。

**bridge（`bridge/*.mjs`）**
- `server.mjs`：鉴权、Host/Origin、mutation lock 与装配；路由在 `routes/{service,projects,jobs}.mjs`（`(request, app) → handled`），请求体/图片解码在 `http.mjs`，批次泵在 `batch-scheduler.mjs`。无 Origin 的本机客户端（如未来 CLI）凭 `.local/config/token` 的 Bearer 访问同一接口。
- `task-runtime.mjs`（占用/取消，最终保存后才释放）+ `task-records.mjs`（冻结快照、串行原子写入；任务 feed 只发布已提交快照；重启时把中断任务标记失败）。
- `batch-admission.mjs` / `generation-preparation.mjs`：受理时冻结素材、图序、Agent/模型、渠道配置与尺寸；之后的设置变化不影响已受理任务。
- `images.mjs`：按 SHA256 内容寻址的不可变图片；`image-collection.mjs` 在门禁满足（无未提交记录、无占用、迁移完成）时才回收。
- `agents.mjs` 是逆向 Agent 注册表：`builtinAgents()` 登记 adapter `{ id, label, models, cli?, run, compatibility? }`，`frozen(snapshot)` 按任务快照解析（缺字段为 Codex，未登记明确失败）。`agent.mjs` 与 Agent 无关，只调用 adapter 的 `run`；Codex adapter 在 `codex-agent.mjs`（`codex-rpc.mjs` app-server JSON-RPC，默认 `ephemeral` 线程），Pi 在 `pi-agent.mjs`；`inspection.mjs` 提供逆向专用的只读图像取证工具。
- `storage.mjs` 管理 `.local/`（`config/ records/ images/ logs/ runtime/`）及旧布局迁移。

## 跨模块不变量

- **兼容命名**：内部 `alchemy:*` 消息、`qc-alchemy` 服务标识、`ALCHEMY_*` 环境变量和 `alchemy` 技能名保留，禁止全仓机械改名。
- **快照与旧数据**：在途和历史任务按提交时快照执行，不重算、不改写；旧记录缺少字段时保持旧解释（如图序为「主体在前、参考最后」、缺 Agent 视为 Codex）。存储改动须覆盖旧记录恢复与服务重启。
- **图片顺序**：新输入以 `referenceIndex=0` 将参考图设为图 1；逆向提示词、附图数组、取证编号与生图附图顺序必须一致。改序、改主体或改任务指令后须重新逆向。
- **不静默回退**：模型、Agent、生图渠道不可用时明确失败，不自动重试、不回退到其他配置或全局默认模型。
- **迟到响应**：前端按项目/模式/版本上下文与 revision 丢弃旧响应；失败保留原输入。
- **密钥边界**：配对令牌不进入 UI、页面 DOM 或交接数据；生图 API Key 只在私有配置（`0600`）与执行期内存中，不写入任务或批次记录。
- **CSS 装载**：共用组件不得直接 import CSS，统一经 `entrypoints/popup/style.css` 的 `@import` 汇总（网页浮层以 `?inline` 注入 ShadowRoot）；`img-fx`/`three` 只由工作台入口加载，不进 content 包。
- **UI 复用**：下拉框用 `SelectField.tsx`，带蒙板弹窗用 `lib/motion-dialog.ts`，图片预览用 `ImagePreview`/`ImageViewer`，色值用 `style.css` 已有变量；按用户要求不显示额外的焦点 outline；动效统一遵循 `lib/motion-preference.ts`。

## 验证与交付

- 新增或改动的产品行为先写 BDD 场景（标题以 `user` 开头，Given/When/Then，含失败分支），再写能复现问题的失败测试，最后实现；期望来自需求，不从当前实现反推。
- 预览只证明合成界面，不能证明扩展权限、跨域取图或真实模型可用。真实逆向/生图会消耗额度，仅在任务明确要求时执行。
- 构建后已打开的网页仍运行旧脚本：重新加载扩展再刷新网页；不要把「已构建」报告成「已安装」。
- `.local/`、`design-extract-output/`、`.output/` 等保持忽略；不运行 `git clean -fdx`，不用用户真实项目做删除测试，不把真实数据放进 fixture。
- Git：新分支用 `agent/简短主题`；提交信息用 `feat:`/`fix:`/`docs:`/`test:` 前缀，按路径暂存，提交前执行 `git diff --check`；只推送目标分支与指定标签，不强推。发布流程见 `../Contribution.md#发布新版本先提交再发布`。
