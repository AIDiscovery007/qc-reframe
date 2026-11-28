# 开发版隔离与插件内升级

## 授权与范围

用户要求一起完成两件事：

1. **开发版隔离**：同一台电脑可以同时运行一键安装的发行版和源码仓库的开发版，互不干扰。开发版沿用源码仓库目录及其 `.local/`，因此能读到以前生成的项目和图片；发行版使用自己的安装目录。
2. **插件内升级**：一键安装的用户在插件设置里看到新版本，点一次即可升级到最新的 GitHub Release，不必回终端。

发布为 v0.8.0。保留现有数据格式、配对令牌、`qc-alchemy` / `ALCHEMY_*` / `alchemy:*` 命名，以及发行版的端口和扩展 ID。

## 平台证据与限制

- 解压加载的扩展不会被 Chrome 自动更新。扩展调用 `chrome.runtime.reload()` 时会从原文件夹重新读取文件，crx-hotreload 等开发工具依赖的就是这一点。Chrome 和 Codex 内置浏览器的实际表现都须实机验证。
- reload 会关闭所有扩展页面，清空 `storage.session`，并让已打开网页中的 content script 失效。因此升级会关闭工作台，网页需要刷新；工作台由后台在 reload 后重新打开。
- 运行包替换期间，扩展文件夹里的旧分包可能已被删除，此时打开新的扩展页面可能失败。服务确认新版本就绪后应立即 reload。
- WXT 0.21 在 `--mode development` 下输出到 `.output/chrome-mv3-dev`，`resolve-config.mjs` 中 `modeSuffix` 为 `-dev`。生产构建、测试、UI 门禁和运行包仍使用 `.output/chrome-mv3`。
- GitHub API 未认证请求每个 IP 每小时限 60 次；每天检查一次远低于这个上限。
- v0.7.0 没有升级入口：现有用户需要再运行一次安装命令升级到 v0.8.0，之后就能在插件内升级。

## 设计

### 一、开发版隔离

用一个模块 `lib/channel.mjs` 维护两套身份，扩展构建、bridge、服务管理和启动器都从这里读取：

| | 发行版 `release` | 开发版 `dev` |
| --- | --- | --- |
| 扩展构建 | `npm run build` → `.output/chrome-mv3` | `npm run dev` / `npm run dev:build` → `.output/chrome-mv3-dev` |
| 扩展 ID | 现有固定 ID `lmnm…hpgf` | 另一把公开 key 固定的新 ID（私钥不保留） |
| 扩展名称 | QC-Reframe | QC-Reframe Dev |
| 端口 | 43187 | 43197 |
| 启动器 | `com.qc.reframe` | `com.qc.reframe.dev` |
| 服务命令 | `npm run setup / start / stop / status` | `npm run dev:setup / dev:start / dev:stop / dev:status` |
| 数据 | 安装目录 `.local/` | 源码仓库 `.local/` |

- 扩展由构建 mode 决定身份；服务由 `dev:*` 命令传入的 `--dev` 决定，并把 `ALCHEMY_CHANNEL=dev` 传给 bridge 和启动器。运行包里没有开发版构建，因此 `dev:*` 命令在运行包安装中明确拒绝。
- 开发版服务只信任开发版 ID，发行版服务只信任发行版 ID（另加 `ALCHEMY_EXTENSION_ID` 显式批准的 ID）。
- **同一数据目录同时只允许一个服务。** 源码仓库也能运行发行版通道（Windows 源码安装依赖这一点），两个通道共用仓库的 `.local/`。启动时在数据目录登记服务端口和通道；该目录已有存活的服务时拒绝启动，并说明先停哪一个。
- 两个扩展加载在同一个 Chrome 用户里时，网页图片上会出现两个 R 按钮。不调试时可以在扩展页关闭开发版，或者把开发版加载到另一个 Chrome 用户。

### 二、插件内升级

**检查**

- bridge 只请求固定地址 `https://api.github.com/repos/AIDiscovery007/qc-reframe/releases/latest`，限时 10 秒，响应不超过 1 MB，拒绝重定向。只接受 `vX.Y.Z` 格式的标签，并且不是预发布。
- 检查结果和开关保存在 `.local/config/upgrade.json`，服务重启后仍有效。打开工作台时请求自动检查：开关打开且距上次检查满一天才联系 GitHub（2026-11-28 起改为每小时并增加后台提醒，见[主动检查更新与新版本提醒](2026-11-28-upgrade-check-and-reminder.md)）。手动「检查更新」同一分钟内最多请求一次。请求不带任何用户数据，GitHub 能看到的是 IP 和 User-Agent（`QC-Reframe/版本号`）。
- `GET /upgrade` 返回当前版本、最新版本（版本号、标题、Release 页面链接、发布时间）、检查时间、能否升级及原因、上次升级结果。更新说明只给链接，不渲染 Release 正文。

**受理（`POST /upgrade { version }`）**

满足下列全部条件才受理，否则返回 409 和可执行的说明：

- 安装目录是运行包（有 `runtime-package.json`）。源码仓库会提示用 git 更新。
- 系统是 macOS 或 Linux，服务由 `npm start` 或启动器托管（不是终端前台运行）。
- 请求的版本等于服务端重新确认的最新版本，并且高于当前版本，不接受降级或任意版本。
- 没有逆向、生图、排队批次、模型验证、CLI 安装更新或会话读取在进行，也没有另一次升级正在进行。

**执行**

- 受理后，bridge 用固定参数启动一个独立进程，运行**本机已安装的** `scripts/install.sh`。传入 `QC_REFRAME_DIR` 为安装目录、`QC_REFRAME_VERSION` 为目标版本，并沿用服务的 `ALCHEMY_DATA_DIR`、`ALCHEMY_PORT` 与 `ALCHEMY_EXTENSION_ID`。输出写入 `.local/logs/upgrade.log`。
- 安装器先下载并校验；校验失败时不改动任何文件，旧服务继续运行。随后它经 `/shutdown` 停止服务，期间如果有新任务开始，服务会拒绝停止，升级中止，文件不变。
- **安装器新增回滚。** 替换前，把运行包拥有的条目和 `node_modules` 移到 `.qc-reframe-previous/`；`setup` 或 `start` 失败时移回旧文件并启动旧服务。全部成功后才删除备份。手动运行一键安装命令时同样适用。
- 安装器把结果写入 `.local/runtime/upgrade-result.json`（`{version, from, outcome, stage, at}`，outcome 为 upgraded、rolled_back 或 failed，stage 为 download、verify、stop、replace、setup 或 start），新服务或恢复后的旧服务通过 `GET /upgrade` 报告这个结果。
- 升级进行期间，服务拒绝除 `/shutdown` 外的所有写请求。安装目录存在 `.qc-reframe-install-pending` 或 `.qc-reframe-previous` 时，浏览器启动器不唤醒服务，避免启动半替换的文件。

**收尾**

- 发起升级的扩展每 1.5 秒读取 `GET /upgrade`，服务离线时继续等待：版本变成目标版本即成功；出现本次尝试的回滚或失败记录、或服务不再报告升级中，即结束。成功后后台在 `storage.local` 记下时间，然后调用 `chrome.runtime.reload()`；重新启动的后台在两分钟内看到这个记录时打开「设置中心 › 本机连接」，卡片显示升级时间并提示刷新已打开的网页。记录读取后即删除。
- 回滚时显示「升级到 X 失败（阶段），已恢复 Y 并重新启动本机服务」；下载、校验或停止阶段失败时说明本机服务未改动；替换后失败且未能恢复时提示重新运行安装命令。10 分钟内仍无结果时，提示运行 `npm run status` 并查看 `.local/logs/upgrade.log`。
- 另一个浏览器（例如 Codex 内置浏览器）里的扩展发现服务版本高于自身版本时，在「本机连接」显示「扩展需要重新加载以完成升级」和按钮。如果重新加载后版本仍然不一致，说明扩展不是从安装目录加载的，提示用户从 `.output/chrome-mv3` 加载。

**界面**

- 入口放在设置中心「本机连接」，在「重启本机服务」下方，显示当前版本、最新版本、「查看更新说明」「检查更新」「升级到 X」和「每天自动检查更新」开关。
- 有新版本时，侧栏底部的连接状态旁显示「新版本」；服务比扩展新时显示「需重新加载」。两者都打开「本机连接」，并优先于 Agent CLI 的「可更新」提示（侧栏只放一个）。
- 升级前弹出确认框，说明会暂时停止服务、工作台会关闭后自动重新打开、未保存的编辑会丢失。

### 三、Release 签名

Release 工作流用存放在 GitHub Secret 中的 Ed25519 私钥签名 `SHA256SUMS`，生成 `SHA256SUMS.sig`。安装器里内置公钥，用 Node 的 `crypto.verify` 校验。插件内升级必须校验签名；终端安装在有签名时校验。没有签名时，插件内升级只能靠同一 Release 的 SHA-256 校验，防得住传输损坏，防不住 Release 资源被篡改。

## 验收场景

**开发版隔离**

- **user runs the release and dev services side by side**
  Given 发行版服务在 43187 运行
  When 在源码仓库运行 `npm run dev:start`
  Then 开发版服务在 43197 启动，使用仓库的 `.local/`，发行版继续运行

- **user opens each extension and reaches its own service**
  Given 两个扩展和两个服务都在运行
  When 分别打开 QC-Reframe 与 QC-Reframe Dev 的工作台
  Then 各自连接自己的服务，看到各自的项目

- **user cannot point two services at one data folder**
  Given 源码仓库的发行版通道服务在运行
  When 在同一仓库运行 `npm run dev:start`
  Then 启动被拒绝，提示先运行 `npm stop`，现有服务和数据不变

- **user wakes the dev service from the dev extension**
  Given 已运行 `dev:setup`，开发版服务已停止
  When 打开 QC-Reframe Dev
  Then `com.qc.reframe.dev` 启动器启动开发版服务，发行版的启动器注册不变

- **user cannot use dev commands in a release install**
  Given 一键安装的目录
  When 运行 `dev:start`
  Then 明确拒绝，不改动任何文件

**插件内升级**

- **user sees a newer release in settings**
  Given 运行包安装 0.8.0，GitHub 最新版本为 0.8.1
  When 打开「本机连接」
  Then 显示 0.8.1、「查看更新说明」链接和「升级」按钮，侧栏显示「新版本」

- **user upgrades with one click**
  Given 有新版本，且没有任务在运行
  When 点「升级」并确认
  Then 服务被替换为新版本，`.local/` 保留，扩展重新加载，工作台自动重新打开并提示刷新网页

- **user cannot upgrade while a task runs**
  Given 有逆向任务在运行
  When 点「升级」
  Then 按钮不可用并说明原因；即使请求已发出，服务也返回 409，什么都不改动

- **user keeps the old version when the download fails**
  Given 下载或校验失败
  When 升级执行
  Then 文件和服务都保持旧版本，界面显示失败原因，可以重试

- **user gets the old version back when the new one cannot start**
  Given 新版本替换后 `setup` 或 `start` 失败
  When 升级执行
  Then 旧文件被移回，旧服务重新启动，界面显示「升级失败，已恢复 0.8.0」和失败阶段

- **user on a source checkout is told to use git**
  Given 源码仓库安装
  When 打开「本机连接」
  Then 显示最新版本，但不提供升级按钮，说明用 git 更新

- **user finishes the upgrade in a second browser**
  Given Chrome 已完成升级，Codex 内置浏览器里仍是旧扩展
  When 在 Codex 打开 QC-Reframe
  Then 显示「扩展需要重新加载」和按钮，点击后版本一致

- **user is offline or GitHub is unreachable**
  Given 检查请求超时或失败
  When 打开「本机连接」
  Then 显示「无法检查更新」和重试按钮，其他功能不受影响

- **user turns off automatic checks**
  Given 关闭自动检查
  When 打开插件
  Then 不发出检查请求，只有点「检查更新」时才发出

## 用户决定（2026-11-27）

1. **自动检查**：每天最多自动检查一次，并提供关闭开关。
2. **Release 签名**：本版加上。维护者在 GitHub 仓库添加签名私钥 Secret 并自行备份；私钥不进仓库，也不经过对话。

## 验证计划

- **开发版隔离**：`lib/channel.mjs` 的身份表、开发版 key 与 ID 配对、通道和端口选择、数据目录占用、`dev:*` 在运行包中拒绝、启动器名称和允许来源，均用临时目录与 `ALCHEMY_APP_SUPPORT_DIR` 测试。
- **升级检查**：模拟 GitHub 响应，覆盖超时、超大响应、重定向、非法标签、预发布、降级、缓存和频率限制。
- **升级受理**：覆盖源码安装、平台、前台服务、忙碌、版本不符、重复提交，只校验固定的安装器参数，不真正启动进程。
- **安装器**：用本机假 Release（`QC_REFRAME_BASE_URL`）覆盖升级、下载或校验失败不改动文件、`setup` 失败回滚、`start` 失败回滚、中断后重跑和签名校验。
- **扩展端**：用合成 preview 场景覆盖有新版本、忙碌、失败、源码安装、版本不一致和离线状态；reload 与重新打开工作台的接线用后台单元测试覆盖。真实 reload 须在 Chrome 和 Codex 中实机验证，自动工具不能操作扩展管理页。
- 最后运行完整回归。不调用真实模型，不使用用户的真实项目。
