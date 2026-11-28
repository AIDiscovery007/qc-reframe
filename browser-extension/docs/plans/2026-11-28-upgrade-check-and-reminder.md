# 主动检查更新与新版本提醒

## 授权与范围

用户在 v0.8.1 之后要求补两条升级路径（2026-11-28 确认方案）：

1. **主动检查并选择更新**：在「设置中心 › 本机连接」能明显地手动检查最新版本，看到这一版的更新内容后，自己决定升级还是跳过。
2. **发版后主动提醒**：维护者发布新的正式 Release 后，已安装的用户不打开插件也能知道有新版本，并可选择升级或跳过。

延续 [开发版隔离与插件内升级](2026-11-27-dev-channel-and-upgrade.md) 的检查、受理和安装器，不改升级执行、签名与回滚。

## 平台证据与限制

- 没有自建服务器，无法从维护者实时推送到用户。提醒依靠用户本机定时检查 GitHub 最新正式 Release：只推 main、预发布或草稿都不会提醒，因为插件内升级只接受签名的正式版本。维护者「推送新版本」就是按 [Contribution.md](../../../Contribution.md#发布新版本先提交再发布) 发布 Release。
- 检查经本机服务发出。Chrome 与本机服务都在运行时才会检查；服务未运行时后台不唤醒它，也不报错。
- MV3 service worker 会被回收，定时用 `chrome.alarms`；闹钟已存在时不重建，避免每次 worker 启动都把下一次检查往后推。
- 未认证的 GitHub API 每个 IP 每小时限 60 次。服务每小时最多自动检查一次，后台每 30 分钟问一次本机服务，因此发版后约一到一个半小时内提醒。
- 系统通知受浏览器与操作系统权限限制。通知不可用时仍保留图标角标与侧栏提示。Chrome 与 Codex 内置浏览器各自运行一个扩展，各自提醒一次。

## 设计

### 服务（`bridge/upgrade.mjs`）

- 自动检查间隔由一天改为一小时；手动检查仍是同一分钟最多一次。
- 最新版本增加 `notes`：取 Release 正文的二级标题作为更新要点，去掉「升级方式与数据」「验证与已知限制」这两节固定内容，去掉 Markdown 标记，最多 6 条、每条最多 60 字符，按纯文本返回，界面不渲染 HTML。正文没有可用标题时为空数组。
- 新增「跳过此版本」：`POST /upgrade/settings { skippedVersion }`，值为版本号或 `null`，保存在 `.local/config/upgrade.json`，服务重启后仍有效。只能跳过当前最新版本。
- `GET /upgrade` 增加 `skippedVersion` 与 `remind`。`remind` 在有新版本、自动检查打开且该版本未被跳过时为真。跳过只影响提醒，设置页仍可升级到被跳过的版本；出现更新的版本时重新提醒。

### 扩展后台（`lib/upgrade-reminder.ts`）

- 后台每 30 分钟用已保存的配对令牌请求 `GET /upgrade?check=auto`；没有令牌或服务不可达时跳过，不唤醒服务。
- 需要提醒时：图标角标显示 `NEW`，并对每个版本只发一次系统通知「QC-Reframe X 可用」，带「查看并升级」「跳过此版本」。已提醒的版本记在 `storage.local`，worker 重启不重复通知。
- 点通知或「查看并升级」打开「设置中心 › 本机连接」；「跳过此版本」请求服务记录跳过，然后清除角标和通知。
- 设置页、侧栏读到的状态同样更新角标；用户已在界面看到的版本记为已提醒，不再弹系统通知。
- 不再需要提醒（已升级、已跳过、关闭自动检查）时清除角标与通知。
- 角标由任务提醒模块统一绘制：有未查看的任务结果时显示数量，否则在有新版本时显示 `NEW`。

### 设置页（`ServiceUpgrade.tsx`）

- 「检查更新」改为与版本信息同一行的次要按钮，检查中显示「正在检查…」。
- 有新版本时显示当前与最新版本、更新要点、「升级到 X」「查看更新说明」和「跳过此版本」；已跳过时说明「不再提醒 X，仍可随时升级」。
- 开关改为「自动检查并提醒新版本」，说明每小时向 GitHub 读取一次最新正式版本信息，不发送项目、图片或配对信息。

## 验收场景

**主动检查**

- **user checks for updates from settings and sees what is new**
  Given 安装 0.8.1，GitHub 最新正式版本为 0.9.0
  When 在「本机连接」点「检查更新」
  Then 显示 0.8.1 → 0.9.0、更新要点、「升级到 0.9.0」「查看更新说明」「跳过此版本」

- **user checks for updates and is already current**
  Given GitHub 最新正式版本就是当前版本
  When 点「检查更新」
  Then 显示「已是最新正式版本（0.8.1）」，不提供升级

- **user checks for updates while GitHub is unreachable**
  Given 网络不可用
  When 点「检查更新」
  Then 显示「无法检查更新」，按钮恢复后可以重试，其他功能不受影响

- **user checks for updates while GitHub limits this network's queries**
  Given 同一网络的其他程序用完了 GitHub 未认证接口每小时 60 次的额度（2026-11-28 在开发机实际遇到，GitHub 返回 403 且剩余额度为 0）
  When 点「检查更新」
  Then 显示「GitHub 暂时限制了本网络的查询次数，约 N 分钟后可重试」，而不是「网络不可用」；其他拒绝仍按网络或服务问题提示

- **user skips a release from settings and can still upgrade to it**
  Given 设置页提供 0.9.0
  When 点「跳过此版本」
  Then 侧栏「新版本」和图标 `NEW` 消失，不再为 0.9.0 发系统通知；设置页仍可「升级到 0.9.0」
  And 服务重启后仍记得跳过；0.9.1 发布后重新提醒

**发版后提醒**

- **user is reminded of a new release without opening the extension**
  Given 自动检查打开，Chrome 与本机服务在运行，0.9.0 刚发布
  When 后台定时检查
  Then 图标显示 `NEW`，弹出一次「QC-Reframe 0.9.0 可用」通知，带「查看并升级」「跳过此版本」

- **user is reminded only once per release**
  Given 0.9.0 已提醒过
  When 之后的定时检查或 worker 重启
  Then 不再弹通知，`NEW` 保留到升级或跳过

- **user opens the upgrade from the reminder**
  When 点通知或「查看并升级」
  Then 打开「设置中心 › 本机连接」，显示「升级到 0.9.0」

- **user skips a release from the reminder**
  When 点通知上的「跳过此版本」
  Then 服务记录跳过通知上写的那个版本，通知关闭，`NEW` 消失；服务不可达时 `NEW` 保留，可在设置页跳过
  And 通知显示后若出现更新的版本，旧通知被撤回，点旧通知不会跳过任何版本（PR 评审发现）

- **user on an older service is not reminded in the background**
  Given 本机服务较旧，状态里没有 `remind`，无法说明用户是否关闭了提醒
  When 后台检查
  Then 不显示 `NEW`、不弹通知；侧栏仍按原兼容规则提示新版本

- **user keeps seeing unread task results on the icon**
  Given 有 2 个未查看的任务结果且有新版本
  Then 图标显示 2；看完结果后显示 `NEW`

- **user who turned off automatic checks gets no reminder**
  Given 关闭「自动检查并提醒新版本」
  When 后台定时检查
  Then 不联系 GitHub，不显示 `NEW`，不弹通知

- **user whose service is stopped is not disturbed**
  Given 本机服务未运行
  When 后台定时检查
  Then 不唤醒服务、不弹错误，已有的 `NEW` 保留

- **user who denied notifications still sees the badge**
  Given 系统通知权限被拒绝
  When 发现新版本
  Then 只显示 `NEW` 和侧栏提示

- **user stops being reminded after upgrading**
  Given 已升级到 0.9.0
  When 后台再次读取状态
  Then `NEW` 与通知清除

- **user is not reminded of anything that is not a stable release**
  Given 维护者只推送 main，或发布预发布、草稿
  When 后台检查
  Then 不提醒

## 验证计划

- 服务：在 [upgrade.test.mjs](../../tests/upgrade.test.mjs) 用本机假 GitHub 覆盖每小时节流、更新要点的提取与清洗、跳过的校验与持久化、`remind` 的各个条件。
- 扩展规则：在 [service-upgrade.test.mjs](../../tests/service-upgrade.test.mjs) 覆盖提醒判断与旧服务兼容。
- 后台：用 VM 与假 `browser` 覆盖闹钟不重建、每版本只通知一次、通知按钮、跳过失败、服务不可达、权限拒绝和角标优先级。
- 界面：preview 场景覆盖主动检查、更新要点、跳过与已是最新；真实系统通知与图标角标须在 Chrome 实机查看。
- 最后运行完整回归，不调用真实模型。
