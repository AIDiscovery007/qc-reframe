# UIUX 变更与门禁维护

代码中的CSS、组件与布局是实现来源，catalog登记设计意图和独立验收关系，生成目录用于查找。新功能先查context与生产组件状态样例；缺少合法变体时补充组件和对应场景，不能复制样式绕过规范。

## 人类改变设计时

1. 明确意图、表面和允许差异，修改实际token/组件/布局；检查所有消费者的继承作用域。
2. 同步catalog的来源、关系与场景。改变几何规则时同步probe的独立期望及正反例；不能直接以当前测量作为正确答案。
3. `node agent-tool/ui.mjs sync`并复核目录差异。运行`change --files PATH … --reason "设计依据" --output /absolute/proposed.json`创建记录，不覆盖历史记录。
4. 运行`gate --tier browser`；共享token或不确定依赖保守检查全部场景。用`inspect --scenario ID --no-build`定位失败，先读规则/期望/实际，再看祖先rect、computed style和截图。`change --record FILE`检验来源hash与规则/场景映射未变化。
5. 在变更记录的evidence中附实际报告路径、结果和验证边界，交监工复核。视觉变化另外提出候选，逐场景由人类审阅后接受。`reviewStatus: proposed`不能作为已批准证据。
6. 后续来源或场景映射变化需创建新提案/重新审阅。历史记录作为历史证据保存，不要求旧记录永远匹配新源码。

## 分层门禁

- `gate --tier quick`：新增裸品牌色、未定义变量、非法CSS装载、过期目录、失效/到期例外都失败。旧裸色警告保持可见。
- `gate --tier browser`：再运行所有登记预览状态/几何/行为、隔离真实扩展；生成视觉候选便于复核，但不声称像素验收。
- `gate --tier full`：再要求3个核心场景像素比较通过；缺基线、环境/fixture失配或差异均失败。

`--base REF`指定增量基准，默认HEAD并包含工作区与未跟踪文件。CI使用PR base SHA；无可用基准时使用Git空树比较，不能静默退回HEAD漏检；浏览器层始终保守全量，不从不完整影响图推断可跳过。错误退出1、参数错误退出2；所有报告记录具体失败和证据路径。

CI首次运行上传Linux候选且明确标出视觉待审阅。下载artifact后先看候选HTML、来源与环境，再依次执行三个明确场景的`accept`，基线目录使用`browser-extension/docs/uiux/visual-baselines/linux`。任一Linux manifest入库后CI自动启用完整视觉检查，另可手动require_visual强制检查；不能只接受一个场景就宣称全部通过。macOS基线放`visual-baselines/darwin`，本地full显式传`--baseline-dir`。CI/操作系统升级导致环境不兼容时重新审阅，不放宽阈值。

CI任务需在远端实际运行后才能认定CI通过；分支保护/必需检查设置由仓库维护者配置。该实施不自动推送、发布或更改远端策略。

## 精确例外

[exceptions.json](exceptions.json)初始为空。只允许记录已存在的warning，字段为`ruleId/file/line/expected/actual/reason/owner/reviewCondition/expires`；路径禁止通配符、日期为YYYY-MM-DD、按UTC日期在到期当日失败。例外不会隐藏finding，也不能把error降级。位置变化、问题已消失或重复条目均要求复核并清理，不允许无限期“大目录忽略”。

## 边界与回归

`node --test browser-extension/tests/ui-*.test.mjs`验证静态、目录、命令、例外、变更记录与像素正反例；`node --test agent-tool/ui/*.test.mjs`验证真实Chromium几何、状态与扩展加载/失败/清理，需要先verify生成当前构建指纹。

真实扩展不打开生产closed ShadowRoot做内部测量；系统原生picker、屏幕阅读器、全部业务状态、真实模型和用户profile均不在声明范围。后续新增缺陷应增加可重复场景和失败反例，不能用扩大视觉容差或删除断言消除失败。
