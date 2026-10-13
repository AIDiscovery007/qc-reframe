# 待发布

本轮内容已归入 [v0.5.0 版本说明](v0.5.0.md)，包含多 Agent、自动连接、独立生图渠道及 Magpie 工作流。验证结果与已知限制见该版本说明。

本文件仅记录 v0.5.0 之后的新改动。

- macOS Codex 可通过 `npm run launcher:install -- codex` 注册本机启动器，打开 Reframe 时按需启动 bridge，再沿用原 HTTP 自动连接。新增 `nativeMessaging` 权限，需重新加载扩展；注册和撤销说明见[安装指引](../INSTALL_WITH_CODEX.md#macos-codex打开时按需启动)。
- 并发打开共用启动；既有服务、令牌和数据保留。后台提醒不唤起服务，网络写入失败不重放；不安装、登录或调用 CLI/模型，不配置开机自启。
- 实际 Codex 调用尚未验证。隔离 UI 验证工具加载仅移除 Native Messaging 权限的临时副本，禁止唤起真实宿主；原生宿主由临时注册、假 CLI 和独立 bridge 验证。执行域指纹须由维护者重新审查，不自动更新。
