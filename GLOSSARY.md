# Reframe 领域词汇

| 名称 | 含义与归属 |
| --- | --- |
| 项目 Project | 以稳定 `projectId` 聚合当前参考图、五条创作路径及历史。图片资产哈希不是项目身份。 |
| 当前输入 Project Input | 项目当前参考图及各路径保存的主体、指令、会话选择。`inputRevision` 用于拒绝并发旧写入，空主体也是有效保存值。 |
| 提示词版本 Job | 一次逆向及其结果，保存当次输入快照；一个版本可以生成多张图片。历史输入不随当前输入变化。 |
| 创作上下文 Creation Context | 项目、路径、提示词版本共同确定的工作状态，负责草稿、当前输入与历史快照的选择顺序。实现位于 `lib/creation-context.ts`。 |
| 输入写入 Input Writer | 单个工作台输入请求的防重入与响应接收规则。上下文离开再返回也视为新上下文；丢弃旧响应不撤销已经发生的持久写入。 |
| 生图会话 Generation Session | 一个挂载中的提示词版本对应的生图交互，管理资格、提交、取消及图片读取；不等于 Codex 会话。实现位于 `lib/generation-session.ts`。 |
| 生图记录 Generation | 绑定一个提示词版本的一次生图，保存语言、尺寸要求、提示词及有序图片引用快照。 |
| 任务运行 Task Runtime | 逆向与生图的执行占用、独立取消信号和终态收尾。取消请求发出后仍占用，直到执行与最终保存完成。 |
| 任务记录 Task Records | 任务 JSON 的提交与重启恢复。保存调用时冻结快照，原子替换成功后发布给任务列表。 |
| 会话素材 Session Context | 用户显式选择的 Codex 会话文字，在逆向提交时冻结。内容是素材，不是执行授权。 |
| 消息策略 Operation Policy | UI 请求的允许来源、通信方式与超时规则；不替代消息参数、发送方或本机 HTTP 鉴权。 |

工程中以 module 表示拥有完整规则的模块、interface 表示调用者使用的入口、seam 表示可替换依赖处、adapter 表示外部实现的适配。depth 衡量入口背后封装的复杂度，locality 衡量修改能否集中完成，leverage 衡量一次修改覆盖的实际调用场景。架构说明见 [browser-extension/docs/architecture.md](browser-extension/docs/architecture.md)。
