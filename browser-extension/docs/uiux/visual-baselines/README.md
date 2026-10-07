# 视觉基线与审阅

这里存放明确审阅后接受的 PNG 与逐场景 manifest。初始截图没有默认批准；候选只生成在 OS 临时目录，不自动写入本目录。

核心场景为 `workspace-wide`、`workspace-narrow`、`popup`。独立库 [visual.mjs](../../../../agent-tool/ui/visual.mjs) 提供：

```js
await compareVisual(report, { baselineDirectory, scenarioIds: ['popup'] });
const candidate = await proposeVisual(report, { baselineDirectory, scenarioIds: ['popup'] });
// 仅在已有明确授权、完成截图与差异复核后调用；不因候选生成成功自动接受。
await acceptVisual(candidate.directory, {
  baselineDirectory, scenario: 'popup', reason: '实际变更与审阅理由', reviewer: '实际审阅者',
});
```

省略 `scenarioIds` 时比较或提议三个核心场景；接受操作必须逐个指定 `scenario`。填写 `reviewer` 不证明人类授权，工具不判断姓名真实性，也不会把 agent 的自检虚构为人类验收。调用者须核实本次已有授权。测试中的 `test fixture` 只用于合成图片，不批准产品截图。

每项保存于 `<scenario>/manifest.json` 与 `baseline-<SHA256>.png`：包括环境 key、视口、PNG 指纹/尺寸、源码/构建/fixture/检查器指纹、固定差异策略、审阅者、理由、时间和旧版本审阅历史。图片按内容寻址；manifest 原子替换，同场景并发接受会被锁拒绝，其他场景不变。

读取已有基线时完整验证环境字段及重算 key、所有来源指纹类型、revision/dirty、实际 PNG 尺寸与指纹、审阅记录与历史。缺失或错误元数据会失败，不能仅凭像素相同通过。只有 `manifest.json` 确实不存在时才初始化；manifest 已存在但 PNG 缺失等损坏会拒绝接受，原 manifest 和历史保持不变。

环境 key 包括 `platform`、`arch`、`osRelease`、浏览器完整版本、`headless`、DPR、locale、timezone、motion、previewShell、viewport、真实字体测量指纹 `fontsHash`（场景值优先于报告环境值）。缺失元数据、场景或有效报告不能通过；环境/字体/fixture 不兼容或缺基线返回 `uncovered`。缺失证据、错误指纹等返回 `failed`。上层门禁须将这两种结果都视为未通过。

固定策略：转为 sRGB RGBA 后，任一通道差异大于 8 即标记该像素；允许差异像素数为 0。不同尺寸直接失败，不缩放、不遮罩、不自动放宽阈值。微小通道噪声容差不是感知色差算法，也不等同 Playwright 的 YIQ threshold。必要策略调整须代码审阅并重新明确接受受影响基线。

比较与候选目录含 `index.html`、`visual.json`、before/after/diff PNG；候选额外含 `candidate.json`。HTML 展示和最终接受共用同一份 `<scenario>.after.png`，不再次读取原始报告截图、不另存可能不一致的 candidate PNG。候选 manifest 绑定该图片和审阅 HTML 的 SHA256；接受前复核二者，变动后必须重新生成并审阅。旧版 `.candidate.png` 候选不再接受。HTML 展示环境、源码与审阅元数据，图像可点开原尺寸；洋红标记超阈值像素。缺基线或环境不匹配时不输出虚假的成功差异图。保留临时目录供复核，清理由使用者按需执行。

[Playwright 官方视觉比较文档](https://playwright.dev/docs/test-snapshots)说明浏览器渲染会受操作系统、浏览器和执行环境影响，因此基线必须在同一受控环境比较。本模块复用 `sharp`，不引入另一套浏览器 runner；真实产品外观仍需人类复核。
