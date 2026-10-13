# Reframe 架构重构计划

目标：在保留五条创作路径、既有界面和数据兼容性的前提下，收拢重复业务规则，明确异步操作和持久化归属。以可观察行为、独立测试和审查判断完成；不把构建成功或代码行数下降等同于功能验收。

状态：用户于 2026-10-13 确认重构计划和第一轮 B1–B3 规格及测试。第一轮已实现并完成独立审查，未发现新增回归；完整门禁仍有下文记录的既有 CI 指纹失败。用户随后确认第二轮 G1–G2，并明确授权所有后续轮次、不再逐轮询问。第二轮规格与测试已锁定，进入实现；后续继续由主代理先写并锁定测试，再独立交付、验证和审查。用户已选择独立 Codex 开发代理，高推理强度。主代理维护规格、测试与验收，开发代理仅修改实现并提交。推送、合并、发布不在当前交付范围。

## 现有边界与重构依据

- 保留 UI → 扩展 background → 本机 bridge 三环境，以及 `creation-context`、`generation-session`、`task-runtime`、`task-records`、`generation-output` 的已有责任。
- `bridge/server.mjs` 同时承担 HTTP 适配、批次受理、配置快照、任务交接及回收条件。第一步提取具有完整业务意义的受理入口，不机械拆出多层转发。
- `CanvasWorkspace.tsx` 与 `QuickWorkspace.tsx` 重复管理输入操作的 pending、revision、上下文判断、错误及收尾。
- `App.tsx` 的初始化 Effect 混合首次恢复、选择轮询、提醒及工作台接续；部分测试依赖抽取其私有闭包。逐轮将规则移至真实可测试接口，布局、焦点和导航展示仍归组件。

行为依据为 [插件指引](../../AGENTS.md)、[架构说明](../architecture.md)和[工程规则](../../../AGENTS.md)。既有文档与实现如有冲突，记录并确认预期后再修改；不把可疑现状自动当成正确合同。

## 迭代顺序

| 迭代 | 用户可完成的闭环 | 架构交付 | 主要验收 |
| --- | --- | --- | --- |
| 1 | 预检批量完整复刻、提交、同键恢复并看到结果 | 批次受理拥有资格、指纹、快照和持久提交；路由保留鉴权、解析和装配 | 并发同键、异体冲突、响应丢失、部分受理、失败重试、重启不重放 |
| 2 | 独立或连续逆向与生图、取消、恢复保存并查看历史 | 收敛生图配置/尺寸快照准备与安全回收入口；沿用 runtime/records/output 的提交点 | 五模式、渠道与图序快照、取消占用、保存失败不重跑模型、恢复前不回收 |
| 3 | 在工作台或快捷端替换、移除、旋转输入后继续创作 | 两端共用输入操作生命周期；持久输入仍归 creation-context writer | 同步防重入、读取/保存失败、A→B→A 迟到响应、焦点与多图顺序 |
| 4 | 从快捷端接续工作台、切换版本并再次逆向 | 明确恢复/响应采纳接口和纯逆向资格规则，减少 App 闭包耦合 | 草稿隔离、远端 revision、提醒与接续交错、历史资源缺失、五路径资格 |

每轮先由主代理写出并运行对应测试，再锁定交给开发代理实现。用户于 2026-10-13 明确授权所有轮次，覆盖技能的逐轮确认要求，不再重复询问。每轮包含相关接线、文档、验证及独立提交；后一轮不用于补齐前一轮缺失的功能。新证据可调整后续范围，但须保留已确认行为。

## 第一轮 用户旅程与规格

用户在项目库选中若干项目，预检后批量完整复刻。网络慢时可能重复点击或以同一请求编号重试；如果受理响应丢失，应能恢复原批次，避免重复模型调用。

### B1 并发同键同体

- Given 首个请求的批次文件提交尚未完成，对应模型尚未启动。
- When 第二个相同 requestId、项目及选项的请求在首个请求返回前到达。
- Then 两次返回同一 batch ID 和项目列表；响应中已公开的 job ID 以及完成后的 job ID 与持久受理时预分配的身份一致；只有一个持久批次；每个受理项目仅逆向一次、自动生图一次。

确认前的规格校正：排队项目对应的 job record 尚未创建时，现有接口省略 jobId。测试保留这一协议，核对已公开标识和最终标识，不要求受理响应提前公开 jobId。此校正不涉及生产修改。

### B2 并发同键异体

- Given 首个请求的批次提交尚未完成。
- When 同一 requestId 的并发请求改变语言选项。
- Then 原请求正常完成，冲突请求返回 409；原语言、项目和任务身份不变，不产生第二批次或额外模型调用。

### B3 持久提交后的响应丢失

- Given 批次文件已完成原子替换，但 HTTP 202 尚未发出。
- When 客户端断开，再以同键同体请求恢复。
- Then 已受理批次无需客户端在线即可完成逆向与生图；恢复返回原 batch/job IDs；任务不被客户端断开取消，不重放模型。

### 必须保留的既有场景

沿用 `batches.test.mjs`：预检无模型调用；部分受理；两条完整流程的容量限制；排队输入与模型快照；同键异体拒绝；停止剩余与单项取消；受理保存失败零执行并可重试；重启标记中断且同键不重放；删除 journal 与图片引用保护。

沿用 `bridge.test.mjs`、`image-api-bridge.test.mjs`、`task-runtime.test.mjs`、`task-records.test.mjs`：自动交接须等待逆向成功保存；取消/失败不启动下一阶段；在途快照不被新设置改写；终态保存和占用不提前释放。

### 验收条件与测试范围

1. 新增 `tests/batch-admission.test.mjs` 通过真实本机 HTTP 接口、临时磁盘和受控执行器覆盖 B1–B3。仅在文件系统提交边界暂停 I/O，并真实断开客户端连接；不复刻生产算法或改私有业务状态。
2. 受理业务有明确所有者；生产 HTTP handler 不再维护完整受理算法。预检与提交复用规则，持久 store 继续管理原子写入；不得增加只有转发职责的空壳层。
3. 原 endpoint、HTTP 状态、请求/响应和磁盘格式保持兼容；鉴权、mutation lock、部分受理和密钥隔离保留。普通非幂等请求不新增自动重放。
4. 开发代理不得写或修改测试、测试 fixture、UI 基线或验证工具。主代理在交接前记录锁定文件及摘要，审查时复核；不能通过放宽断言消除失败。
5. 通过相关产品测试、类型检查及构建，再完成适用完整回归和独立审查。当前缺少本次可信选测索引，最终按现有工具回退完整验证；命令及证据约束见 [工具索引](../../../agent-tool/README.md)。
6. 第一轮不改变 UI 设计、五模式语义、两槽位调度和自动交接时序，不访问或迁移真实用户项目；真实模型、付费服务和用户已安装扩展不由隔离 HTTP 测试证明。

## 第一轮实现与审查结果

- 规格锁定提交 `5cc7f4d40c5bb526ce1e4f54a5f345271c0717b9`；独立 Codex 实现提交 `94fb5a022b8db3d603cc748f376ebeb6e04904b0`。新增 `bridge/batch-admission.mjs` 统一预检、资格、幂等指纹、快照及持久受理，`server.mjs` 保留 HTTP、锁、调度和公开响应适配；同步架构说明。未改变协议、磁盘结构、两槽位调度或密钥生命周期。
- Standards 审查：上述三文件在代码和后端规范下未发现可确认问题。受理模块拥有完整业务决策，store 继续拥有原子提交；路由适配与调度保留真实职责，没有空壳转发层。静态结论不替代动态测试。
- Spec 审查：B1–B3、既有部分受理和恢复合同符合；同键恢复先于当前依赖检查，持久提交开始后不因请求断开撤销受理。锁定测试摘要未变，开发代理没有修改测试、fixture、工具或既有用户文件。
- 开发代理运行 108 项相关测试、类型检查和差异检查通过。主代理独立运行 `node agent-tool/test-run.mjs run --full --base 5cc7f4d --output .local/reframe-refactor/iteration-1-full`：构建、类型检查通过；100 个 Node 文件共 1,085 项，1,084 通过、1 失败、0 跳过，与基线完全相同。唯一失败仍是 `test-impact.test.mjs:188` 的既有 CI 指纹差异，不能表述为完整门禁通过。
- 主代理在同一 coverage 环境重新核对浏览器基线报告与摘要，`ui.mjs evidence` 返回 `passed`、`reusable: true`；第一轮只改后端，139 个场景与隔离扩展证据仍有效。报告 `.local/reframe-refactor/iteration-1-full/browser-evidence.json`；保留前述跳过项及真实环境限制，不代表再次执行了浏览器场景。
- 结论：第一轮范围内未发现需修改问题，可进入第二轮规格确认；全项目最终验收尚未完成。CI 审阅指纹差异仍显式保留，未通过刷新摘要或改断言消除失败。

## 第二轮用户旅程与规格（已确认）

用户独立生图、连续逆向后生图或提交批次时，执行使用受理时的渠道和尺寸。执行期间配置可能变化、模型可能下架；图片已经生成后也可能遇到本地任务记录保存失败。用户应保有成功提示词和可恢复图片，并能继续编辑其他项目而不丢失产物。

### G1 逆向期间模型下架

- Given 使用目录中可用的 Magpie 模型受理连续逆向及自动生图，逆向尚未完成。
- When 原模型从目录撤除，用户又将当前渠道改为 OpenAI，然后逆向成功。
- Then 成功提示词及完成状态持久保留；自动生图标记失败并说明原 Magpie 模型不可用；交接复查受理时的 Magpie 地址，不使用当前渠道替代，不调用任何生图模型，也不产生 generation record。

对应 `tests/image-api-bridge.test.mjs` 的 `user keeps the completed prompt when the accepted Magpie model disappears during reverse`。确认前修正了测试的地址假设：既有设置合同将 Magpie 根地址规范化为 `/v1`（`image-settings.test.mjs` 已覆盖）；断言使用确定的规范化地址，不要求原始输入字符串不变。未改生产代码或既有断言。

### G2 未提交产物与跨项目回收

- Given 生图产物已写入图片目录，但同一任务的完成记录及失败记录均因磁盘故障无法提交，任务执行已结束。
- When 用户替换另一个项目的参考图，随后修复磁盘并对原 generation 执行本地保存，再保存另一个项目的输入。
- Then 第一轮输入保存成功但回收暂缓，待保存图片与旧图片均保留；本地保存使用原 generation ID，清除待保存状态，不重新逆向或生图；恢复提交后回收可以删除无引用旧图，原生成图片仍可通过 HTTP 读取。

对应 `tests/image-api-bridge.test.mjs` 的 `user saving another project preserves an uncommitted paid image and later saves it without calling the model again`。故障注入仅拦截该任务 JSON 文件的原子替换；图片与 HTTP 均走真实临时 I/O，不操纵业务私有状态。

### 既有合同与架构验收

1. 生图准备模块拥有渠道选择、Codex context 读取、渠道尺寸校验、Magpie 尺寸快照和依赖可用性检查的真实算法。独立、连续、批次复用此规则；已受理快照只复查依赖，不重新选择当前渠道或重算旧尺寸。任务资格、提示词构造、图片图序和调度沿用现有责任，不包装为多个回调转发。
2. 图片回收协调模块统一 pending 状态、运行中及未提交记录门禁、批次与待保存输出引用、原图到缩略图的回收顺序和失败重试。调用方继续拥有 mutation lock，禁止重复获取同一锁；启动恢复先于回收。
3. 保留不同入口的错误合同：启动回收失败中止启动；输入已经提交后的回收失败不改成输入失败；项目删除链失败继续阻止后续写入。不得为了接口统一而吞掉这些错误。
4. 沿用 `image-api-bridge.test.mjs` 中在途渠道/凭据/尺寸、非法尺寸先拒绝、旧尺寸不重算、逆向失败/取消不交接、最终保存失败恢复和批次保护；沿用 `agent-bridge.test.mjs` 三入口 context 断连、`project-inputs.test.mjs` 回收失败重试、`magpie-size.test.mjs` 尺寸规则、`images.test.mjs` 损坏引用保护、runtime/records 终态与占用测试。
5. 实现范围限于 `bridge/server.mjs`、`bridge/batch-admission.mjs`、两个职责明确的新模块及架构说明。保留 runtime/records/output、原始图片存储、尺寸算法、endpoint、持久格式和五模式语义。新增 BDD 测试仍由主代理维护，开发代理不得修改测试或工具。
6. 第二轮不修改 UI 或测试策略，不访问真实模型、付费服务、用户项目及已安装扩展。锁定前先运行对应回归；实现后由主代理独立验证并进行 Standards/Spec 审查。

### 确认前验证

- `node --test --test-reporter=spec browser-extension/tests/image-api-bridge.test.mjs browser-extension/tests/project-inputs.test.mjs browser-extension/tests/agent-bridge.test.mjs browser-extension/tests/magpie-size.test.mjs browser-extension/tests/batches.test.mjs browser-extension/tests/batch-admission.test.mjs browser-extension/tests/task-runtime.test.mjs browser-extension/tests/task-records.test.mjs browser-extension/tests/images.test.mjs`：106 项通过，0 失败、0 跳过；日志 `.local/reframe-refactor/iteration-2-baseline.log`。
- 锁定测试文件 SHA-256：`image-api-bridge.test.mjs` → `ee8f8721bde24b4fe48bfd052b1b85381e385a97ce84a7cd5dd47ebe4b1a3f71`。本轮仅新增 G1、G2，既有测试断言保持不变。第一轮 `batch-admission.test.mjs` 摘要仍与锁定值一致。
- `git diff --check` 通过。此阶段未修改第二轮生产代码，也未启动第二轮开发代理。

## 实现交接与最终交付

开发代理使用本机 Codex CLI 的 headless 会话，`model_reasoning_effort="high"`，在指定仓库工作。交接包含本轮锁定规格、测试摘要、允许修改路径、现有未提交改动清单及验证命令。遇到产品歧义停止报告；完成后仅按路径提交本轮实现，回报 commit、验证及未决问题。

当前工作区已有用户对工程规范、CI、UIUX 文档和 inspection-rpc 测试的未提交变更。它们作为输入保留，不混入本轮提交，不重置工作区。实现范围扩大时先补读相应工程规则。

每轮由主代理执行锁定测试并按 code-review 技能分别审查规范与规格；失败只反馈实现。最终交付架构说明、每轮提交、完整测试/浏览器证据、发现问题的处理结果及未覆盖边界。“无已知未处理回归”以本轮验证为限，不承诺所有环境绝对无缺陷。

## 当前验证记录

- 重构前六组核心测试通过：bridge、task-runtime、task-records、generation-session、project-inputs、batches；未修改生产代码。
- 第一轮基线：`node --test --test-reporter=spec browser-extension/tests/batch-admission.test.mjs browser-extension/tests/batches.test.mjs`，18 项通过（新增 B1–B3 共 3 项），0 失败。
- 锁定测试 SHA-256：`batch-admission.test.mjs` → `1aaf9595270b475c5ee7211cf3b6071334630ff8adfeb59fcb1a523a68584daf`。用户已确认；锁定时无生产修改。
- 重构前完整 Node 基线（当前脏工作区，HEAD `e306d7ba13084def4aaaaab269d38d1b339f6d6e`）：构建及类型检查通过，100 个测试文件共 1,085 项测试，1,084 通过、1 失败、0 跳过。命令：`node agent-tool/test-run.mjs run --full --base e306d7b --output .local/reframe-refactor/baseline-full`。该统一运行因 Node 失败而未进入 browser gate，不能视为完整通过；报告在 `.local/reframe-refactor/baseline-full/report.json`。
- 唯一 Node 失败为 `agent-tool/test-impact.test.mjs:188` 的已审阅浏览器执行域指纹断言。只在内存快照中将 `agent-tool/ci.mjs` 换回 HEAD 内容，指纹即从当前 `35ba178937e531e4d3028b945e1ae3be541ffab3c79d21210da23325bcabdf66` 恢复为记录值 `c804740776e971df4c1f5c02473a1cbb15211c57d0ce5fdde756e123776aa91f`，证实由本轮开始前已有的 CI 修改引起。未修改文件、断言或审阅值。后续验收必须按实际执行域重新审查并处理此差异，不能静默刷新指纹。
- 独立补跑浏览器基线：`REFRAME_TEST_COVERAGE=1 node agent-tool/ui.mjs gate --tier browser --no-build --base e306d7b --reason pre-refactor-baseline --json`，退出 0；静态维护检查、139/139 登记预览场景和隔离真实扩展检查通过。报告副本 `.local/reframe-refactor/baseline-full/browser-gate.json`（其 `reportPath` 指向同机原始报告），证据摘要 `0623b880c23567e3e60f985450df2f208a9842889b53ae2bc6727d77e11c85b0`。这是重构前基线，不是改后验收；不含已审阅像素基线比较、真实模型和用户已安装环境。
- 使用相同 `REFRAME_TEST_COVERAGE=1` 环境执行 `ui.mjs evidence --report <原始报告> --sha256 <证据摘要>` 复核通过，可复用范围仅为当前来源及同机浏览器证据。三项细项跳过已保留：两个只读结果预览没有输入旋转控件（不适用），一个 macOS headless 原生 select 键盘序列未获验证；139 个场景本身均运行完成。未启用 coverage 环境时的证据核对会因构建模式不同拒绝复用，不能跨模式冒用报告。
