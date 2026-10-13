# Reframe 架构重构计划

目标：在保留五条创作路径、既有界面和数据兼容性的前提下，收拢重复业务规则，明确异步操作和持久化归属。以可观察行为、独立测试和审查判断完成；不把构建成功或代码行数下降等同于功能验收。

状态：四轮架构重构、最终门禁维护及独立 Standards/Spec 审查均已完成。用户确认首轮、第二轮后明确授权所有后续轮次；每轮仍由主代理先写并锁定测试，再交给独立 Codex 高推理代理实现，最后独立回归和审查。后续已按用户要求审计并修复当前工作区的 CI 指纹、提交原有改动，另修正全量运行发现的测试等待器竞态。提交 `878463b` 的构建、类型、1,087 项 Node 测试、161 个浏览器场景、静态维护及隔离扩展检查全部通过，详见文末验收结果。推送、合并、发布不在本次交付范围。

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


## 第二轮实现与审查结果

- 独立 Codex 实现提交 `bf379451c7cea9afa525bd2ed5ea78484c17f004`，基准 `7181319`。五个允许文件集中生图配置/尺寸准备和安全图片回收；接口、磁盘格式与原有提交顺序保持。
- 主代理独立运行十文件回归：155 项通过，0 失败、0 跳过；类型检查通过。日志 `.local/reframe-refactor/iteration-2-main-tests.log`。开发代理亦完成规定检查和受保护文件核验。
- Standards 与 Spec 两个独立只读审查均未发现可确认问题。冻结配置和旧尺寸解释、模型下架、跨项目未提交产物保护、启动/输入/删除/idle 错误策略符合 G1–G2。动态与静态结论仅覆盖该轮，不冒充最终全量验收。
- 原用户文件无变化；开发代理未修改锁定测试、工具或测试基线。既有 CI 执行域指纹失败仍保留；最终完整验证在所有前端改动后重新运行。

## 第三轮用户旅程与锁定规格

用户在工作台或快捷端上传、移除和旋转输入，可能在读取/保存期间离开并返回同一项目和版本。界面必须表达真实保存状态，旧操作不能影响新上下文；多图角色、细节和顺序应保持。

### I1 输入受理、失败和恢复

- Given 当前已有有效输入。When 同一事件轮重复上传。Then 只发出一次持久保存；完成前保留原图与选择，显示忙碌并阻止逆向，成功后才显示并选择新主体。
- Given MIME 不符、允许 MIME 的损坏 PNG，或持久保存失败。When 用户上传。Then 保留原图/选择，显示错误，释放编辑锁但继续阻止提交；不能作为无主体请求继续。有效重试或明确移除后恢复。
- Given 主体已选中。When 移除或真实旋转后的保存失败。Then 保留原主体与选择；旋转错误传回预览，弹窗保持打开并显示错误。

### I2 A→B→A 的操作生命周期

- Given 读取或持久保存尚未返回。When 经公开项目/提醒通路离开 A，再返回 A 的同模式同版本。Then 旧成功或失败都不能改变当前图片、选择、焦点、错误和版本。
- Given 返回 A 后已开始新的读取。When 旧读取完成或失败。Then 不发起旧保存，也不能释放新操作的忙碌与提交保护；新读取可正常完成。
- 已发出的成功持久写入仍归原项目，不宣称导航撤销服务器写入。当前唯一 creation-context writer 的串行保存和 CAS 保持。

### I3 多图编排

- Given 两个已有主体及其角色/细节/顺序。When 同时上传两张图且只完成部分解码。Then 不写入空占位；全部完成后一次提交，保留旧主体元数据及顺序，成功选择第一张新增主体。
- When 修改角色或图序的保存失败。Then 错误在当前组件显示，原角色、顺序和选择保持，可继续编辑。

### 测试迁移与范围

`input-persistence-components.test.mjs` 的 20 项旧测试通过 TypeScript AST 提取私有函数、在 VM 中注入 refs，无法验证真实 React effect cleanup，并会把重构后的函数名误当产品合同。本轮在实现前将其行为迁至 `input-operation.browser.js` 的 22 个正式场景，并移除旧文件。既有行为断言保留，增加真实 PNG 解码拒绝及两端 A→B→A；不是因新实现失败而调整预期。

测试复用现有构建、preview、Playwright runner 和证据指纹，不增加测试框架。通过 DOM 用户事件及公开消息运行生产 App/CanvasWorkspace/QuickWorkspace；故障只注入 `createImageBitmap` 与公开扩展消息边界。preview 新增场景注册和已有 UUID 历史 fixture 的复用；不更改生产控件。旋转场景先通过上传保存有效 PNG，避免把合成图库 SVG 当成支持的栅格输入。

预实现测试：首次完整 22 场景中 18 通过；修正测试同步等待、真实按钮名称、多图初始模式和旋转 fixture 后，剩余 4 场景亦全部通过。锁定前再次完整执行 22 场景，22/22 通过，退出 0；报告 `/var/folders/0d/cgp0j7d54qx310xj_4nx5bz00000gn/T/reframe-ui-hMg7zd/report.json`，执行日志 `.local/reframe-refactor/iteration-3-browser-locked.json`。测试修正均发生在生产实现之前，未放宽产品断言。

### 架构验收

1. 两组件共用真实输入操作生命周期 hook：同步 pending、revision/context 与 React cleanup、错误、忙碌及结算；不新增泛用状态机/事件总线/空壳转发。
2. 组件继续拥有选图、焦点、原图/主体大小限制、多图元数据、设置面板和旋转错误传播。Quick 排序的 availability 和成功提交后焦点语义保持。
3. `creation-context` 是唯一持久输入 writer，现有 App 导航、CAS、generation-session 及后端协议不变；不增加依赖或 UI 设计变化。
4. 开发代理只可改两个 Workspace 组件、一个共享输入 hook 及架构说明。不得修改测试/fixture/工具/计划/用户既有文件。主代理在代码提交后独立运行锁定测试、相关回归与双轴审查。

## 第三轮实现与审查结果

- 独立 Codex 实现提交 `ca5fe4a4a0b3c71e429b180c0a3642b27936720b`，基准 `7bbd741`。新增 `use-input-operation.ts`，两端复用同步受理、上下文失效、错误、忙碌和结算；组件保留选图、焦点、尺寸及多图处理。Quick 排序继续由 App 管理 availability，成功回调增加当前操作检查。
- 开发代理 89 项 Node、23 个浏览器场景、类型及差异检查通过。主代理独立运行相同 89 项 Node 和 26 个浏览器场景均通过，报告 `/var/folders/0d/cgp0j7d54qx310xj_4nx5bz00000gn/T/reframe-ui-FsuwTz/report.json`；Standards 与 Spec 独立静态审查均通过，未发现可确认问题。161 个受保护路径摘要均未变化，用户原有改动保持。

## 第四轮用户旅程与锁定规格

用户从快捷端接续草稿、提醒或历史进入项目，并在五种模式中逆向或连续生图。恢复必须遵循原有启动顺序和当前导航归属；按钮说明、可用性和提交输入来自同一创作上下文。

### R1 交接恢复的阶段与版本

- Given 有效 handoff。When 交接读取完成而项目引用仍在读取。Then 先显示交接来源和模式；读取持久项目后才决定草稿是否可恢复。
- Given 输入 revision 一致（旧记录缺省按 0）。When 引用到达。Then 采用持久引用，恢复原草稿并记录 revision。
- Given 持久 revision 已变化。Then 打开最新引用、剥除旧窗口对应输入，标记草稿失效并告知用户；不得用旧草稿覆盖当前项目。
- Given handoff 已过期或读取失败。Then 显示恢复错误，不捏造成功项目。项目引用失败则保留原来源并在 selection.error 中显示错误，仍允许原 settings/tasks 路由；未保存来源与空来源分别保留明确未保存错误与空状态。

### R2 提醒与迟到响应

- Given task 提醒。When 任务和项目引用读取成功。Then 一起采用正确任务、模式、版本及项目；请求的 generation 存在时打开图片，否则定位提示词。
- Given 交接/任务的首段或项目读取未完成。When A→B→A 导航、打开 unread 列表或界面卸载。Then 旧成功和失败均不能更新当前选择、错误、草稿或面板；失效的首段不继续发起项目读取；卸载后不再启动新读取。
- 启动顺序保持：项目视图、初始 query 入口/快捷已保存草稿、轮询建立、最后消费 hash。保留六种延迟初始化、Quick ownContext 与新全局选择、重复提醒请求和模式/可见性 revision 的原测试。

### R3 五模式动作合同

- Given 当前 resolveCreation 上下文。Then style 可仅参考图逆向但连续生图需主体；recreate 和 session 不发送 reenact payload；reenact 需主体；multi-reenact 至少两张有效主体；session 需已选会话。主体及多图 payload 保留用户当前任务指令、角色和顺序。
- 输入/图序/多图内容改变或只有通用风格提示词时需重新逆向。损坏主体不能回退到旧历史；有效替换或明确清空沿用 resolveCreation 的恢复语义。
- 无选择、参考错误/读取中、主体错误/读取中、模式缺失输入、空指令按既有优先级给出提示；忙碌和未保存提示词编辑禁止提交。生图不可用仅阻止连续动作，逆向仍可用。
- 尺寸选择保留 App 原算法及真实尺寸 helper；Magpie 非法或部分像素意图仍走现有自动修正/回退，普通比例非法仍阻止连续动作。不要复制尺寸规则到新模块。

### 公共边界与测试范围

`lib/creation-entry.ts` 的 `createEntryReader({ request, query, revision })` 只管理两个入口的读取链、revision/dispose 失效、引用新旧及错误归类；提供 `read({ handoff } | { task }, accept)` 和 `dispose()`。每次 read 捕获外部 revision，每次 await 后及同步交付前复核，App 的每次导航仍先递增 revision。交付事件使用 `kind`：`handoff-source`、`handoff`（handoff、selection、freshness=fresh/stale/unavailable）、`reminder`（job、selection）、`error`（message）。回调同步交付；不传入成组 React setters，不把轮询/初始化/URL 路由挪入 reader。

`lib/reverse-action.ts` 的 `deriveReverseAction({ mode, context, hasSelection, referenceError, subjectUnavailable, blocked, generationBlocked, promptEditing, sizeValid })` 是纯函数，context 是 resolveCreation 的结果。返回 instructionStale、genericPrompt、needsPrompt、subjectError、genericHint、reverseHint、reverseDisabled、chainDisabled 及可选 reenact payload。App 保留尺寸选择、实际 start、状态和界面装配。

主代理在实现前新增 `creation-entry.test.mjs`，在公开 I/O 依赖边界控制阶段、成功/失败及导航失效；`quick-workspace.test.mjs` 仅向既有 App effect harness 注入新 reader，全部原断言保留。`workspace-prompt-action.test.mjs` 的八项私有派生表达式改测纯公开函数，保留尺寸选择与实际 App reverse 小适配器的提取，以验证禁用时不调用 start 和正确提交 payload；14 项测试保留原四模式全部行为并补 session 与错误优先级。迁移后的 14 项断言已在实现前通过临时适配器执行原 App 派生表达式（自动 AST 读取），无手写替代算法；日志 `.local/reframe-refactor/iteration-4-drafts/baseline-action.log`。新 reader/纯模块尚不存在时正式测试预期失败，交付实现后须全部通过。

既有浏览器 `creation-context`、`end-to-end-context`、恢复/连续动作及第三轮输入场景继续验证真实构建装配；最终执行完整浏览器门禁。纯模块测试不声称覆盖真实模型或用户安装环境。

### 架构验收与实施范围

1. App 仍拥有初始化、轮询、导航路由、UI state、generation-session、持久 writer 与 CAS。只抽出真实异步入口读取规则和纯资格/payload 决策；不新增通用流程框架、setter bag、重复状态或转发空壳。
2. 允许开发代理修改 App.tsx、上述两个新 lib 模块和架构说明。不得修改测试、工具、fixture、计划及用户既有文件；协议、存储、五模式语义、UI 设计及依赖不变。
3. 用户已统一授权所有轮次，本轮不重复询问；主代理先提交规格与测试，再交给独立 Codex 高推理实现并完成回归及 Standards/Spec 审查。

第四轮锁定前验证：原算法适配器的 14 项动作断言通过；正式三文件运行因两个新公共模块尚不存在而失败（`ERR_MODULE_NOT_FOUND`），符合测试先行预期，日志 `.local/reframe-refactor/iteration-4-red.log`。`git diff --check` 通过。

第四轮测试适配补正：首次交付后 86 项通过、7 项旧 quick-workspace 测试在断言前报 `ReferenceError`。原因是主代理迁移时只注入了 reader factory，漏掉了独立函数提取器所需 reader 实例及 handoff-only fixture 的 query 依赖。开发代理按约定停止且未修改测试。主代理补齐真实 reader 注入，并让未配置 query 的意外调用显式失败；所有既有断言、输入、等待和错误预期保持不变。这是已声明私有 harness 迁移的依赖补全，不是对实现结果放宽合同；两个公共模块的锁定测试已经通过。补正后重新锁定摘要再继续实现。

第四轮实现提交 `3539da2cd537bb410c44eedcddb2bcda3e22750d`，只包含四个允许文件。开发代理类型、差异检查及 93 项 Node、18 个浏览器场景通过；主代理独立重跑六文件 93 项测试通过，166 个受保护路径未变。双轴审查与最终全量验证结果另记。

## 最终验证维护：浏览器执行域审阅

本轮前 CI 指纹断言已失败，前端重构又使旧审阅摘要必然失效。主代理安排独立只读边界审计后确认：preview 只加载显式登记的 image-order 纯模块和前端 fixture；runner 拦截外部 origin；真实扩展检查通过不转发代理隔离 loopback，并不把生产 bridge 当场景 page coverage。用户原有 CI 修改只收紧文档分流，没有新增执行入口。

审计发现现有指纹漏掉真实 prebuild 入口 `scripts/icons.mjs` 和编译配置 `tsconfig.json`。普通 build 不运行 manage 服务入口，但新增脚本/helper 的执行变化也必须使原审阅失效。因此在最终验证前增加一个独立维护闭环：

- Given 已审阅浏览器构建/预览执行域。When icons、manage、新增脚本 helper 或 tsconfig 内容改变。Then 域指纹改变，既有 bridge 兜底依赖排除失效；实际映射/未知执行仍遵循原保守策略。
- 主代理先在 test-impact.test.mjs 增加独立负例；开发代理仅修改 test-policy.mjs 的域文件集合（整个 scripts 目录及 tsconfig）和经过审计的固定摘要。不得改变可靠源、core tests、保守回退或既有断言来接受未知执行。
- 审阅摘要绑定完整实现后的已提交干净树。当前工作区域内额外存在用户原有的 CI 修改，必须继续使精确审阅失效，不将未经提交的用户内容混入实现提交；完整工作区测试如仍因此失败须明确报告。另在独立干净 checkout 验证提交的门禁，不暂改、暂存或还原用户文件。

边界证据：`agent-tool/ui/build.mjs:67`、`browser-extension/package.json:18`、`agent-tool/ui/runner.mjs:29`/`:244`、`agent-tool/preview.mjs:345`、`agent-tool/ui/extension.mjs:39`/`:154`/`:175`、`agent-tool/test-impact.mjs:97`。更新摘要依据已审阅的执行边界，不自动学习当前值。工作区与干净树证据分开记录。


## 最终审查与验收结果

### 架构与独立审查

四轮实现分别为 `94fb5a0`、`bf37945`、`ca5fe4a`、`3539da2`：收拢批次受理、生图准备及图片回收、两端输入操作生命周期、创作入口读取及逆向资格。协议、磁盘格式、五种创作模式、两槽位调度和现有界面保持兼容，没有新增依赖。App 继续拥有导航与界面装配，持久输入继续由 creation-context writer 管理。

第四轮 Standards 与 Spec 审查均未发现可确认问题：入口读取在每阶段检查 revision/dispose，保留分阶段交接及原初始化顺序；五模式资格、错误优先级和 payload 复用 resolveCreation，尺寸选择和实际提交仍归 App。前三轮结论见对应章节。

执行域维护提交 `be65f33` 仅修改 test-policy.mjs；两项独立审查均通过。整个 scripts 子树及 tsconfig 纳入指纹，可靠源、核心测试和保守回退不变。固定摘要 `43d8e4558b562a2254a11d0848eaf42deef8aa3285f1e14ac38c1709a28a0fc9` 与干净提交树一致；当前工作区摘要差异仅来自用户原有的 agent-tool/ci.mjs，未把该修改提交或忽略。

首次最终全量发现派生 UI 场景目录漏同步 22 条 input-operation 场景，引发 catalog 检查、quick gate 及取消 gate 测试的三个连带失败。独立诊断确认唯一根因是 UI-CATALOG-SYNC，浏览器及取消机制本身未回归。主代理通过官方 sync 命令仅生成 catalog.md 的 22 条新增记录，提交 `748882d`；所有测试断言及用户维护文件保持原样。重新执行完整 Node 后，三个连带失败全部消失。

### 完整验证证据

| 环境 | 构建与类型 | Node | 浏览器与扩展 | 结论 |
| --- | --- | --- | --- | --- |
| 干净提交 `748882d50152c1316e715cb60d4b59733c98f5f3` 的独立 worktree | 通过 | 100 文件，1,085 通过、0 失败、0 跳过 | 161 场景及隔离扩展通过；静态与维护检查通过 | 完整门禁通过，成功生成测试索引 |
| 保留用户原有改动的当前工作区 | 通过 | 100 文件，1,086 通过、1 失败、0 跳过 | 161 场景及隔离扩展通过；目录同步后的独立 quick gate 通过 | 唯一失败为原有 CI 修改造成的精确指纹不匹配；不声称此工作区完整门禁通过 |

验证命令与记录：

- 干净提交：`node agent-tool/test-run.mjs run --full --base e306d7b --output <主工作区>/.local/reframe-refactor/final-clean`。完整报告保存在主工作区 `.local/reframe-refactor/final-clean/report.json`；浏览器门禁报告 `/var/folders/0d/cgp0j7d54qx310xj_4nx5bz00000gn/T/reframe-ui-gate-XhJv6t/gate.json`。临时 worktree 无跟踪文件变化，验收后归档。
- 当前工作区：同一完整命令输出到 `.local/reframe-refactor/final-workspace-catalog-fixed`。唯一失败为 test-impact.test.mjs 的已审阅执行域摘要断言；其余全部通过，包括新增负例和原失败的三个工具测试。
- 当前工作区浏览器：`REFRAME_TEST_COVERAGE=1 node agent-tool/ui.mjs gate --tier browser --no-build --base e306d7b --reason post-refactor-full --json`。记录 `.local/reframe-refactor/final-workspace-browser.json`，preview 161/161、extension 均通过；该次整体结果因当时目录未同步而失败。同步后运行 `node agent-tool/ui.mjs gate --tier quick --base e306d7b --reason post-refactor-catalog-sync --json` 独立通过，记录 `.local/reframe-refactor/final-workspace-quick.json`。
- 干净提交和工作区测试分别有 1,085 与 1,087 项，差异来自用户原有测试修改，未混为同一测试集。实施结束后的 165 项保护记录全部一致；最终验收文档更新不修改锁定测试或用户文件。

### 验证范围与交付

161 个浏览器场景均已执行，无场景跳过；报告保留三项细节跳过：两个只读结果预览没有输入旋转控件，以及 macOS headless 下原生 select 系统弹层的键盘行为无法验证。真实模型、付费生图服务和用户日常安装的扩展环境未调用；没有替代像素级视觉基线审查。隔离验证未发现新增功能回归，不将其表述为任意环境下绝对无缺陷。

用户已有文件、删除及未跟踪规范文档保持原样。本次实现、测试和架构说明均按范围提交；未推送、发布或改动用户已安装服务。之后的最终记录提交仅修改本计划，不改变已验收代码及执行域。

## 后续：当前工作区 CI 与整体提交

用户随后明确要求修复剩余 CI 指纹失败、当前工作区完整检查通过，并把当前 worktree 的已有改动一并提交。此次授权扩大了提交范围，前一节“保留未提交”的结论仅描述此前交付状态。

验收合同：

- Given 当前 CI 删除角色文档和日志的轻量白名单，独立审计确认没有新增执行入口或放宽回退。When 将这份 CI 连同当前工程规则纳入提交，并登记审阅过的执行域。Then 固定指纹对应将提交的完整树，当前工作区及提交后的完整门禁通过。
- Given 已审阅的 CI 和浏览器执行域。When CI、构建脚本、fixture 或其他受保护来源再次变化。Then 旧指纹失效；未知执行继续保守回退，实际观测依赖始终保留。
- Given 角色文档、日志或工程规范发生变化。Then CI 走完整验证；白名单发布文档继续按原规则检查删除、改名和断链。

主代理在实施前复现 test-impact 的唯一摘要失败，并补充上述 CI 指纹失效及三种非白名单路径的测试输入；没有删除断言或更改预期。审计之后由独立 Codex 高推理代理仅更新固定审阅摘要；不得改为运行时自动接受、移除 CI 指纹成员、弱化来源核验或修改测试。主代理独立验证并审查，然后按用户授权提交已有工程规则、测试和维护记录，不推送或发布。

实施与补充证据：

- `8786038` 锁定指纹失效测试及本节合同，独立 Codex 高推理代理在 `9b5fba3` 仅更新固定审阅摘要。`deb6815` 纳入用户已有工程规则、CI 白名单收窄、测试和维护记录；该提交的 Git 树、工作区及固定摘要三者一致。29 项针对性测试通过，独立 Standards/Spec 审查无发现。
- `deb6815` 的首次完整运行（`.local/ci-domain-final/full/report.json`）中，原 CI 指纹失败已消除；1,087 项 Node 测试中仅会话串联场景失败。等待器先读到生图仍在运行的任务快照，再读到 `/health.active === 0`，错误地返回旧快照。自动生图在逆向任务释放占用前受理，且生图保存完成后才释放占用，因此先确认空闲、再取任务快照符合生产合同。主代理只调整测试等待器读取顺序，保留全部完成断言、轮询次数及间隔；17 项会话测试通过（`.local/ci-domain-final/session-bridge.log`）。没有把 `running` 当成成功，也没有增加重试或超时。
- 等待器修复提交为 `878463b`，独立审查确认占用交接没有空闲间隙，读取顺序符合隔离场景的行为合同；如果生产端提前释放占用，原完成断言仍会失败。

最终验收：

- 在干净提交 `878463b6fe5cdf1c0ecafd51ffbebb6a71e40786` 上执行 `node agent-tool/test-run.mjs run --full --base ec08c7f --output .local/ci-domain-final/full-settled`，从构建开始执行，没有复用上轮通过项。完整报告 `.local/ci-domain-final/full-settled/report.json` 状态为 `passed`，退出码为 0，并成功发布测试影响索引。
- 构建、类型、100 个文件中的 1,087 项 Node 测试全部通过，Node 失败、取消、跳过均为 0；静态维护、161 个浏览器场景及隔离扩展门禁全部通过。
- 没有新增浏览器跳过；仅保留此前三项细节：两个只读图片预览不适用输入旋转控件，macOS headless 的原生 select 系统弹层键盘行为未验证。真实付费模型、用户日常安装环境和像素级基线范围仍同前述说明。
- 用户已有改动均已纳入 Git；本次最后提交仅更新本计划中的验收记录，不改变已通过的代码、测试或执行域。未推送、合并或发布。
