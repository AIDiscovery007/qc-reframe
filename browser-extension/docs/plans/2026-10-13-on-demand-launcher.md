# 打开 Reframe 时启动本机服务

## 授权与范围

用户选择「打开插件时按需启动，首次安装注册本机启动器」，主要使用 macOS 上的 Codex 内置浏览器，并已授权后续 BDD 轮次，无须逐轮确认。沿用独立 Codex 高推理实现、主代理编写规格和测试及审查的分工。

一个端到端迭代完成：安装注册 → 界面连接检查 → 固定本机请求 → 复用服务管理器启动 → 原有 HTTP 握手。不是登录时启动；后台提醒和普通业务写入不得触发启动。保留数据格式、配对令牌、端口和现有鉴权。

## 平台证据与限制

- Chrome Native Messaging 官方合同：https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging 。扩展需 `nativeMessaging` 权限，本机 manifest 使用明确的 `allowed_origins`，stdio 为本机字节序 uint32 长度及 UTF-8 JSON。
- 当前 Codex 应用内的 Chromium 包含 `runtime.connectNative` / `runtime.sendNativeMessage`、host 加载和启动实现，以及 `/Library/OpenAI/Codex/NativeMessagingHosts` 路径。静态实现证据不等于实机调用成功。
- 用户级默认目录为 `~/Library/Application Support/OpenAI/Codex/NativeMessagingHosts`：Codex Framework 的 PathProvider 取 key 201 后拼接 `OpenAI/Codex/NativeMessagingHosts`；[Chromium 的 macOS 路径枚举](https://github.com/chromium/chromium/blob/main/base/base_paths_mac.h) 将 201 定义为 `DIR_APP_DATA`，其[实现](https://github.com/chromium/chromium/blob/main/base/base_paths_mac.mm)取用户 Application Support 目录。此为应用静态代码与上游定义交叉核对的结论，实际调用仍须单独验证。
- 浏览器工具禁止访问 `chrome://extensions`；不绕过该限制。用户级安装路径必须有应用实现证据后再使用，未知时不猜测或改写浏览器内部配置。
- 自动化验收使用临时安装目录、假 CLI 和隔离浏览器；不调用真实模型、不读取浏览器凭据或修改真实项目。实际 Codex 扩展调用能力单独记录。

## 固定接口

- 本机 host 名称 `com.qc.reframe`，唯一请求 `{ "action": "ensure-start" }`。响应仅 `{ "ok": true }` 或 `{ "ok": false, "error": "可执行的恢复说明" }`，不返回 token。
- `npm run launcher:install -- codex` / `npm run launcher:uninstall -- codex` 分别注册和撤销。管理器入口为 `native-install` / `native-uninstall`，浏览器参数为 `codex`；`ALCHEMY_NATIVE_HOST_DIR` 可显式指定 manifest 目录，测试始终使用临时目录。
- 注册入口固定安装根目录、Node 绝对路径、数据目录和端口；浏览器请求不得提供命令、路径或环境变量。只批准本安装构建目录对应的扩展及已配置的明确扩展 ID。
- 首轮支持 macOS Codex；其他平台和浏览器明确报告尚未支持，继续可使用已有手动启动命令。不得无提示安装到其他浏览器。

## BDD 场景与验收

| 场景 | Given / When / Then |
| --- | --- |
| N1 自动连接 | Given 服务离线，When 用户打开工作台、轻量面板或主动连接，Then 发出一次固定本机启动请求，成功后执行原 HTTP 握手和健康读取；令牌只存在私有存储。已有服务在线时不调用启动器。 |
| N2 并发和重试 | Given 多个界面同时打开，When 它们发现服务离线，Then 共用一次进行中的启动；不同本机 host 进程也只启动一个服务实例。一次启动失败后，下次打开可以重试。 |
| N3 明确失败 | Given 启动器未注册、不支持、断连、无效回包或挂起，When 界面连接，Then 在 30 秒总期限内失败并提示安装或检查启动器；关闭 native port 和计时器，保留已有偏好和令牌。HTTP 鉴权或服务器错误不触发启动。 |
| N4 最小副作用 | Given 界面未打开，When worker 启动或提醒轮询，Then 不唤起服务。网络写入失败不重放；无效来源和请求不调用 host。 |
| N5 安装和撤销 | Given 带空格的安装路径和批准的扩展 ID，When 注册后再次注册，Then manifest 和可执行启动器有效、明确授权且幂等；外来同名注册拒绝覆盖。撤销只删除属于本安装的启动器和注册，不删除数据或停止服务。 |
| N6 受控进程 | Given 浏览器没有 shell PATH 且环境中的数据目录/端口被改变，When 调用已安装启动器，Then 使用安装时固定的 Node 和位置，不扫描或登录 CLI，不输出凭据。 |
| N7 输入边界 | Given 非法来源、未知字段、畸形 JSON、超限帧或不完整 EOF，When host 读取请求，Then 不启动服务，有限时间内返回错误或关闭；分片的合法帧可以启动。 |
| N8 启动保护 | Given 端口被其他进程占用或启动锁未释放，When 请求自动启动，Then 有界失败，不终止或替换现有服务；复用服务时保持原 instanceId 和 token。 |
| N9 回归隔离 | Given 已注册真实本机 host，When 运行隔离扩展回归且 HTTP 连接失败，Then 浏览器权限边界禁止 Native Messaging，不可能唤起真实服务。测试加载临时扩展副本，仅删除 manifest 的必需/可选 `nativeMessaging` 权限；生产 JS/CSS/资源逐字节一致，源构建保持不变，副本正常或异常结束均清理。 |

测试通过真实构建 background 的消息入口，以及注册后的可执行 host 和真实临时 bridge 验证行为；Chrome API、时钟和 CLI 属于受控边界替身。旧网络写入、鉴权、隐藏项目和提醒回归必须保持通过。新增权限和执行域需重新审查 CI 指纹边界，不能只更新摘要消除失败。

N9 是实现前执行域审计发现的必要补充：HTTP 代理不拦截 native host，临时 profile 不隔离系统级 host。保留原 16 项扩展检查并增加 `UI-EXTENSION-NATIVE`；报告声明 `nativeMessagingBlocked: true`、`fixtureRemoved: true` 和副本路径 `isolatedExtension`，记录被修改的 manifest 权限。证据验证器拒绝没有 native 隔离检查/字段的旧报告。此处测试增强用于验证副作用边界，不降低旧断言。

N5 的写入失败合同：已存在且归属本安装的入口和 manifest 更新须逐文件原子替换；文件写入失败保留该文件旧内容、清理临时文件，并允许常规重注册恢复。首次创建继续拒绝覆盖冲突文件。不承诺跨文件事务或断电耐久性。

## 交付检查

1. 主代理锁定测试并验证新增场景能在旧实现上失败。
2. 独立 Codex 高推理实现，禁止修改测试，提交生产代码及安装说明。
3. Standards / Spec 独立审查；修正实现后运行必要回归与全量门禁。
4. 本机注册并记录真实能力验证范围，提交剩余文档和检查结果。不推送、不发布。
