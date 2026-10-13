# 项目工程指引

本文件是工程规则入口。**先读规则，再开展工作。** 在设计、实现或审查前，按实际工作类型读取下表对应文档；涉及代码时先读代码规范，跨领域工作须读取所有相关规则，工作范围扩大时先补读新增领域的规则。

例如：调整 UI 前读取代码规范和前端开发规则；将逆向和生图串联、设计涉及前后端的改动前，读取代码规范、前端开发规则和后端开发规则；开展 review 前，再读取 Review 规则。

## 规则索引

| 文档 | 何时读取 | 负责的问题 |
| --- | --- | --- |
| [代码规范](docs/standards/code.md) | 新增、修改或重构生产代码、测试及工具时 | 行为合同、模块归属、状态与类型、副作用、错误、表达及验证 |
| [前端开发规则](docs/standards/frontend.md) | 涉及界面、组件、样式、交互、content script 或扩展 background 时 | 状态与异步归属、提交反馈、宿主隔离、可访问性、性能及扩展权限 |
| [后端开发规则](docs/standards/backend.md) | 涉及 bridge、协议、任务、存储、外部服务或服务管理脚本时 | 信任边界、受理快照、并发与取消、提交、恢复及资源生命周期 |
| [Review 规则](docs/standards/review.md) | 审查代码、测试、工具、配置或规范文档时 | 受审范围、风险、问题证据、严重程度、验证与审查结论 |

四份文档维护长期工程标准；具体产品行为、参数和已有设计取舍仍由 [browser-extension/AGENTS.md](browser-extension/AGENTS.md)及其引用文档维护。发现矛盾时明确指出冲突，根据用户确认的需求同步修正规则与实现，不以新规范静默改变产品行为。

## 工程入口

工程、GitHub 与发布流程见 [Contribution.md](Contribution.md)，领域术语见 [GLOSSARY.md](GLOSSARY.md)，模块边界见[架构说明](browser-extension/docs/architecture.md)。开发诊断、测试辅助和示例预览工具见 [agent-tool/README.md](agent-tool/README.md)，使用前先查已有工具。
