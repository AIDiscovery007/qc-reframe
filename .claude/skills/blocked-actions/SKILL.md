---
name: blocked-actions
description: Use when an action is blocked (permission denial, HTTP 403, proxy or network refusal) or needs the repository owner's GitHub admin rights, and when writing a workflow whose run publishes, releases or deploys.
---

# 受阻操作与不可撤销工作流

## 操作受阻

1. **定位拦截层。**引用错误原文，判定属于哪一层：

   | 错误原文特征 | 拦截层 | 解法 |
   | --- | --- | --- |
   | `denied by the Claude Code auto mode classifier`，或权限提示被拒 | 会话权限策略 | 向用户说明要做的具体操作，请求一次明确授权；授权后重试一次 |
   | `not permitted through this proxy` | 云端 GitHub 代理 | 授权和环境设置都无效，换执行路径（第 2 步） |
   | `no rule or network setting allows this host` | 环境网络策略 | 用 `update_environment` 申请放行该确切域名 |

   完成标准：已写明拦截层及其依据的错误原文。

2. **借用户本机身份执行。**云端代理固定拦截仓库管理接口：规则集、分支保护、Secrets、删除分支。这类操作走用户电脑：
   - 当场重新调用 `list_computer_folders`，之前的空结果或拒绝结果都可能已过期；遇到 `repository_trust_required` 时，按提示调用 `confirm_repository_trust`。
   - 接入任一在线目录，用 `_host` 在那台机器上运行 `gh api …`。`gh` 读取的是用户本机的登录身份，与所在目录无关。
   - 只有在没有在线机器时，才把完整命令交给用户自己运行。

3. **从云端回读确认。**用只读 API 核对改动已生效，例如 `gh api repos/OWNER/REPO/rules/branches/main`，再向用户报告。

## 不可撤销工作流

凡是触发即发布、发版或部署的工作流，都同时提供一个演练入口：用 `workflow_dispatch` 跑完全部关卡，在不可撤销的那一步之前停下，并把"将要执行的内容"写进运行摘要。参考实现见 `.github/workflows/release.yml` 的 `REHEARSAL`。

完成标准：演练已在 GitHub 上实际运行并通过。本地演练只算准备，不算验证。
