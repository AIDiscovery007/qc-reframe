# 用 Codex 安装 QC-Reframe 0.4.2

这是供用户及其 Codex 执行的本地安装流程。版本为 `0.4.2`，发行标签为 `v0.4.2`。请完成能够执行的步骤，再集中列出需要用户操作的剩余步骤。

本版支持自定义图片顺序，新输入默认参考图为图 1，系统默认指令随实际图片顺序和数量更新，自定义指令保留原样；变化与验证范围见 [v0.4.2 版本说明](releases/v0.4.2.md)。

[← 首页](../../README.md) · [功能导览](FEATURES.md) · [使用手册](../README.md)

## 让 Codex 帮你安装

在 **Codex 桌面 App 的本地聊天**里复制发送：

```text
请帮我安装并启动 QC-Reframe 0.4.2：
https://github.com/AIDiscovery007/qc-reframe

请获取仓库的 v0.4.2 标签，先阅读 browser-extension/docs/INSTALL_WITH_CODEX.md，
先确认插件实际使用的本机 Codex CLI 路径、安装来源和版本，检查更新并按原安装方式处理，再完成环境检查、初始化、构建、本机服务启动和配对准备，
优先在我的 Codex 内置浏览器里使用。能自动完成的步骤请直接完成。
需要我登录或在浏览器界面确认加载扩展时，再给我准确的文件路径和最短操作步骤。
不要覆盖已有安装、项目记录或 Codex 全局配置。
完成后打开 Pinterest，让我能点击图片上的 Reframe 图标，再选择“立即逆向”开始使用。
请分别说明服务、扩展加载、配对是否已实际验证，尚未完成的步骤不要标为完成。
```

首次加载扩展、登录与权限确认可能需要手动完成。也可自行按下列步骤安装；首次必须获取完整仓库，Chrome ZIP 不包含本机服务与技能。

## 1. 获取完整发行版

仓库：https://github.com/AIDiscovery007/qc-reframe

优先复用用户已有的同一安装目录；没有时，在用户可写且准备长期保留的位置执行：

```bash
git clone --branch v0.4.2 --single-branch https://github.com/AIDiscovery007/qc-reframe.git
cd qc-reframe/browser-extension
```

也可下载 GitHub Release 的 Source code ZIP 并解压，然后进入其中的 `browser-extension`。不要仅下载浏览器 Chrome ZIP，它没有本机服务和 skill。不要删除或覆盖同名目录；已有安装先检查本地改动和数据。

## 2. 检查前置条件

需要 Node.js 22.15+ 和 Codex CLI。先检查 `node --version`、`npm --version`，确认插件实际使用的 CLI 绝对路径，再对该路径检查版本和登录状态。已有安装优先核对 `.local/config/runtime.json` 的 `CODEX_BIN` 及当前环境变量，不能只检查 PATH 上另一份 `codex`。缺少时从官方来源安装：

- Node.js：[官方下载](https://nodejs.org/en/download)。
- Codex CLI：[官方安装与登录说明](https://developers.openai.com/codex/cli)。常用安装方式为 `npm install -g @openai/codex`。已有 CLI 时按原安装方式升级到最新版本，避免重复安装多份。
- 登录需要用户本人完成时，给出实际 CLI 路径的登录命令；不索取密码或复制账户凭据。

**必须单独检查插件实际使用的 Codex CLI。** 桌面 App 更新不代表这份 CLI 已更新。已有 CLI 按原渠道升级：独立安装版使用其稳定入口的自更新能力，npm/Homebrew 使用对应管理器；App 内置或自定义安装按原来源处理，不另装一份来掩盖路径问题。可先在设置中心查看实际路径与安装来源，再按 [官方更新说明](https://learn.chatgpt.com/docs/codex/cli)处理。

例如，macOS/Linux 将下面的示例路径替换为已检测的绝对路径并正确引用后执行；不要把示例原样当作真实路径。Windows PowerShell 使用 `& '实际路径' --version` 等形式。路径含引号时使用工具生成的安全引用命令。

```bash
'/absolute/path/to/codex' --version
'/absolute/path/to/codex' login status
# 需要登录时：
'/absolute/path/to/codex' login
```

升级后仍对同一个实际路径复查版本；路径变化时更新 `CODEX_BIN` 并重启本机服务。再刷新插件模型列表、由用户点击「验证并使用」并重试原任务。版本是否最新与功能是否兼容分别判断；检查更新失败不能标为最新，也不能据此认定不兼容。模型文本验证不证明生图工具、账号权限或额度可用。

脚本会在 PATH 及 macOS 常见的 Codex/ChatGPT App 资源目录查找 CLI。无法找到时，通过 `CODEX_BIN` 指定真实可执行文件的绝对路径；不修改用户全局 PATH 或 Codex 配置。Windows 上请让 Codex 定位可直接启动的 `codex.exe`，不要将 npm 的 `.cmd` 包装文件设为 `CODEX_BIN`。首发自动化在 macOS 验证，其他系统需单独确认。

## 3. 初始化并启动

```bash
npm run setup
npm start
npm run status
```

`setup` 会检查 CLI 登录、完整的 Alchemy skill、imagegen 文件，运行 `npm ci` 和生产构建，并将 CLI/skill 路径保存在 `.local/config/runtime.json`。仓库已包含 Alchemy 的运行指令及必需参考文档，不需要从作者电脑复制文件，也不必安装到全局 skills 目录。

**初始化恢复：** CLI 缺失、未登录或缺少 app-server 时，`setup` 会提示后续处理并继续构建，使新用户可以先启动服务、加载扩展和配对，再在设置中心检查。Node.js 与 Alchemy skill 的必需检查仍会阻止无效初始化；`npm run doctor` 仍严格检查 CLI。完成构建和配对不代表 CLI 或模型已可用，仍需按提示完成安装、登录与验证。

`start` 在后台运行 bridge，关闭启动终端后仍可使用；它会先验证带配对令牌的 `/health`。重复启动同一版本会复用服务。若端口被其他服务、旧版本或另一份安装占用，会停止启动流程并说明原因，不强行结束别人的进程。不要通过修改端口来绕过冲突，浏览器端默认连接 `43187`。

`status` 应显示 `service: "qc-alchemy"`、`version: "0.4.2"`、`ready: true`。这只证明 bridge 与 Alchemy skill 就绪；`doctor` 另检查 CLI 登录。它们不会实际调用模型，因此不代表模型或生图已就绪。设置中心会另外展示 CLI 功能接口检查：只读获取本机 CLI 的接口描述，不调用模型；检查结果未知时不拦截任务，明确不支持时只限制相关功能，不关闭整个工作台。

imagegen 默认读取 `$CODEX_HOME/skills/.system/imagegen/SKILL.md`，未设置 `CODEX_HOME` 时读取 `~/.codex/skills/.system/imagegen/SKILL.md`。如果找不到，让 Codex 查找用户实际安装的 imagegen skill 并设置路径；不要创建一个同名空文件充当已安装。缺失 imagegen 不妨碍提示词逆向，但生图不可用。找到 skill 也不代表账户一定支持内置 `image_gen`。

特殊路径可在首次初始化时指定，脚本会保存这些路径供后续启动使用：

```bash
CODEX_BIN=/absolute/path/to/codex \
ALCHEMY_SKILL_PATH=/absolute/path/to/alchemy/SKILL.md \
IMAGEGEN_SKILL_PATH=/absolute/path/to/imagegen/SKILL.md \
npm run setup
```

若曾指定 `CODEX_BIN`，确认它指向更新后的 CLI，必要时用新路径重新运行 `npm run setup`。使用默认位置时不需要这些参数。保留 skill 的伴随 `references/` 文件。环境变量优先于保存的路径。

## 4. 加载到浏览器

### Codex 内置浏览器

请在当前客户端实际检查浏览器的扩展管理入口。支持加载已解压扩展时，选择初始化输出的 **绝对路径 `.output/chrome-mv3`**；支持导入 ZIP 时，使用 Release 的 Chrome ZIP。不同版本可能有不同入口或组织限制，不假定所有客户端都有相同按钮。

若工具无法操作扩展管理界面，把准确目录路径或 ZIP 路径交给用户，由用户完成这一次加载。不要改写浏览器 profile 数据库、绕过安装确认或声称扩展已安装。没有第三方扩展入口时，说明当前客户端限制并提供 Chrome 路径。

本项目已在开发者的 Codex 内置浏览器验证过扩展流程；[官方 Browser 说明](https://learn.chatgpt.com/docs/browser)并未给出通用的第三方扩展自动安装接口，因此不能承诺一条脚本在所有客户端内静默安装。

### Chrome

1. 打开 `chrome://extensions`。
2. 开启开发者模式，选择“加载已解压的扩展程序”。
3. 选择 `.output/chrome-mv3`，确认列表显示 QC-Reframe **0.4.2**。

请用户自行确认浏览器展示的权限。安装到 Chrome 与安装到 Codex 内置浏览器是两份独立安装。

## 5. 配对并打开

```bash
npm run pair
```

将本机生成的配对码粘贴到 **QC-Reframe 插件自己的设置界面**，完成连接。能通过获准的 UI 工具填写时直接操作，否则给用户最短步骤。不要把配对码发到 GitHub、网页表单、Issue 或分享日志；后台日志不会主动输出配对码。

在 Codex 内置浏览器打开 https://www.pinterest.com/ 。有浏览器工具或 `open_in_codex` 时直接打开；只有 CLI 时让用户在桌面 App 中打开。已打开的网页需要刷新才能注入扩展。

验收分开报告：

- 服务状态：认证的健康检查成功、版本与 skill 就绪。
- 扩展状态：实际加载 0.4.2，悬停图片后出现 R 标志，点击可展开“立即逆向 / 加入 Reframe / 打开工作台”。
- 配对状态：点击悬浮入口，面板显示连接成功，并能显示选中的参考图。

配对后在「插件模型」选择候选项，点击「验证并使用」才保存。该操作发送一次简短请求，会消耗少量模型额度；用户仅要求安装时，保留为手动步骤并说明尚未验证。

选择图片会打开或创建本机项目；首次安装验收到此即可。没有用户额外要求，不自动进行提示词逆向或生图，不消耗模型额度。未实际验证的项明确保留为待完成。

## 日常启动、升级和排错

从 v0.4.1 或更早版本升级到 v0.4.2，必须更新完整仓库并重启本机服务，再重新加载扩展、刷新工作台与网页。图片顺序的保存、逆向和生图需要新服务；只替换 Chrome ZIP 不够。已有项目、历史结果、配对与配置保留，无需手工迁移或重新配对，不修改 Codex 全局配置，也不自动归并已有重复项目。

1. 保存重要编辑，等待任务完成或主动取消后，在原 `browser-extension` 目录执行 `npm stop`。由 `npm run bridge` 前台启动的服务请在原终端停止。
2. 保留本地改动与 `.local/` 数据，将完整仓库更新到 `v0.4.2`，在 `browser-extension` 执行 `npm run setup`，再执行 `npm start`；核对 `npm run status` 为 `0.4.2`、`ready: true`。
3. 重新加载原扩展，再刷新工作台和已打开网页，确认扩展管理页显示 `0.4.2`。使用 ZIP 时，将本版 ZIP 解压到原扩展加载目录；不要删除原扩展或清空浏览器数据。轻量端未提交草稿属于浏览器会话数据，不承诺跨浏览器重启保留。

按上述步骤停止旧服务并启动新版；已支持插件内重启的托管服务，也可在更新和构建完成后通过「设置中心 → 本机连接」重启已连接的托管服务。任务、模型验证或 Codex 操作执行中不可重启。按钮不下载更新、不重载扩展；服务离线时仍需终端运行 `npm start`。详见 [v0.4.2 升级说明](releases/v0.4.2.md#升级方式与数据)。

本版相较 v0.3.x 无新增权限；从 v0.2.0 或更早版本升级时，需按浏览器要求确认自 v0.3.0 起新增的 `notifications`、`offscreen`、`alarms` 权限，分别用于桌面提醒、可选提示音和后台恢复检查。默认桌面通知静默，声音需在设置中心主动开启。系统通知关闭时仍可查看界面未读标记。

首次安装仍需完整仓库，不能仅靠 Chrome ZIP 完成。会话正文索引在「选择对话会话 → 标题和正文」中按需建立；索引是本地可重建数据，清除后可重新建立，不删除 Codex 源会话或已提交任务的创作快照。

- 配对后在「连接设置 → 插件模型」选择模型并点击「验证并使用」。这会发送一次简短请求，消耗少量模型额度；用户仅要求安装时，保留为手动步骤，不自动验证。不要通过修改 Codex 全局模型来修复插件兼容性。
- `model is not supported when using Codex with a ChatGPT account`：刷新插件模型列表，选择其他模型并验证。CLI 登录成功或目录中出现模型名称，都不等于实际调用成功。切换账号、登录状态或提供方后重新验证。
- CLI 接口不兼容：在现有「Codex 与更新」检查受影响功能、实际 CLI 路径和更新来源。有新版本时按原渠道升级，复查完成后重新验证模型，并由用户重试失败操作。不要反复提交同一个已知不兼容的任务，也不要把网络、额度或生图权限失败一概归因于版本旧。
- 在同一 `browser-extension` 目录运行 `npm start`；电脑重启后需要再次运行，不会配置开机自启。
- `npm stop` 停止脚本启动的后台服务，保留配对码和全部项目；任务运行中会拒绝停止。先在插件完成或取消任务。
- `npm run bridge` 前台启动，适合排错，用 Ctrl+C 停止。由原终端启动的服务也从原终端停止。
- 后台日志：`.local/logs/bridge.log`。配置：`.local/config/runtime.json`。这些文件及所有图片/Prompt 都已被 Git 忽略。
- `doctor` 失败：按输出处理 CLI、登录或 skill；可在明确替换路径后重新运行 `npm run setup`，不会清空项目。
- 端口冲突：确认服务所属目录；旧版本先停止再启动。不要杀死不明进程或删除 token 来尝试修复。
- 第一次启动被打断且留下 `.local/runtime/start.lock`：先确认没有启动命令还在执行，再移除该空目录，保留其他 `.local` 文件。
- 升级：完成任务 → 停止服务 → 获取目标版本 → `npm run setup` → `npm start` → 重新加载浏览器扩展 → 刷新工作台和原网页。
- 三层更新分别核对：Codex CLI 按实际路径及原渠道处理；Reframe 服务通过更新完整源码、构建并重启生效；浏览器扩展需重新加载，已打开网页还需刷新。本机服务重启按钮不会下载 CLI 或 Reframe 更新，也不会替代扩展重载。
- 网页仍显示旧 logo 或提示扩展失效：重新加载扩展后还需刷新网页。
- 提示词能生成但图片不能生成：检查 imagegen skill、Codex 账户/模型的内置生图支持及额度，不切换成未经用户配置的模型 API。

普通运行数据统一归入 `.local/config/`、`records/`、`images/`、`logs/` 和 `runtime/`。旧发布版的配置和记录可能直接位于 `.local/` 根部；更新后的服务会在启动时自动归位，配对信息及共享图片路径保留。备份时先停止服务，再复制整个数据目录；无需逐个整理文件。旧版根部 `start.lock` 若仍存在，也需先确认原启动命令已结束。
