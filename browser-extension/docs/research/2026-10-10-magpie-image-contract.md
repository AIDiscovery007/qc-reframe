# Magpie Images 静态接口契约（I0 研究）

研究日期：2026-10-10。固定源码版本：`793af762424c6c360a0bf61236d7f7b63eb10433`。本文只记录公开官方文档与源码，**不代表安装版本、本机连通性、两个实际来源生图或模型能力已经验证**；静态研究不能使 I0 通过。官网当前文档可能随主分支变化，结论以固定提交的实现为准。

## 对 Reframe 的直接结论

- 采用独立 Magpie 来源，统一调用 Images API，供应商凭证和协议转换交给 Magpie。完整模型 ID 原样保存、发送；不要按名称猜 Google 来源或自行去掉 provider 前缀。
- 本机应用身份可使用 `Authorization: Bearer magpie-reframe` 与明确的 `User-Agent`；这不是供应商 API Key，也不是受控 gateway key。可用性不能通过“非空供应商 key”假定。
- `size` **没有跨来源一致的冒号比例语义**：Google 原生与 Chat 转换会处理比例；Images 转发原样发送。真实双源验收前不能承诺同一比例参数被两端接受。
- 所有输入图统一使用重复 `image[]`，按快照顺序提交；固定 `n=1`。目录的 image-input 字段不包含最大附图数量，不足以证明七图可用。
- 不能通过 `response_format=b64_json` 保证网关仅返回 base64。URL 仍须按 Reframe 既有下载限制验收；不能因本地网关自动放宽远端图片下载策略。
- 单次客户端调用可能触发网关内部协议切换或订阅账户切换。取消仅证明本地停止等待/请求上下文取消，不证明供应商未执行或不会计费。

## 地址、身份与模型发现

| 项目 | 固定版本证据及实现约束 |
| --- | --- |
| 地址发现 | 默认 `127.0.0.1:3425`；官方建议只读配置中的端口，`GET /api/hello` 确认名称和版本。OpenAI 风格 base URL 带 `/v1`；根地址也应规范化后仅拼接一次 `/v1`。[docs/integrating.md:20–42](https://github.com/yetone/magpie/blob/793af762424c6c360a0bf61236d7f7b63eb10433/docs/integrating.md#L20-L42) |
| 实际路由 | 注册 `GET /v1/models` 和 `/models`，`POST /v1/images/generations` 与 `/images/generations`、`POST /v1/images/edits` 与 `/images/edits`。[internal/gateway/gateway.go:488–519](https://github.com/yetone/magpie/blob/793af762424c6c360a0bf61236d7f7b63eb10433/internal/gateway/gateway.go#L488-L519) |
| root / v1 兼容 | Magpie 自身的 remote-magpie 来源会把 root、`/v1`、已知完整 endpoint 规范化到 root，并生成 root+`/v1`。这是其内部来源配置的行为，不是要求 Reframe 接受任意 URL。[internal/provider/remote_magpie.go:68–102](https://github.com/yetone/magpie/blob/793af762424c6c360a0bf61236d7f7b63eb10433/internal/provider/remote_magpie.go#L68-L102) |
| 应用身份 | `magpie-<app-id>` 标记应用；缺失时使用 User-Agent 首词。受控 gateway key 与供应商 key 分开。[docs/integrating.md:44–52](https://github.com/yetone/magpie/blob/793af762424c6c360a0bf61236d7f7b63eb10433/docs/integrating.md#L44-L52)；[docs/reference.md:355–369](https://github.com/yetone/magpie/blob/793af762424c6c360a0bf61236d7f7b63eb10433/docs/reference.md#L355-L369) |
| 鉴权边界 | loopback 可以接受任意 token；有效受控 key 才归属于该 key 身份。远端未共享为 403；共享或绑定网络后无有效 key 为 401；转发头可能使 loopback 请求被判断为远端。不要把本机身份 token 当作远端授权。[internal/gateway/lan.go:234–305](https://github.com/yetone/magpie/blob/793af762424c6c360a0bf61236d7f7b63eb10433/internal/gateway/lan.go#L234-L305)；[docs/reference.md:444–455](https://github.com/yetone/magpie/blob/793af762424c6c360a0bf61236d7f7b63eb10433/docs/reference.md#L444-L455) |
| 生图目录 | `GET /v1/models` 带 `X-Magpie-Drawers: 1`，响应 `data` 增加生图条目。条目有 `kind: image`、`id: provider/model`、`owned_by`、`display_name`、`magpie_label`、`modalities.output: [image]`；只有 `m.Images` 时 input 含 image。应筛 image kind 和 image output，不能把视觉输入文本模型当成生图模型。[internal/gateway/gateway.go:747–768](https://github.com/yetone/magpie/blob/793af762424c6c360a0bf61236d7f7b63eb10433/internal/gateway/gateway.go#L747-L768)；[internal/gateway/gateway.go:795–840](https://github.com/yetone/magpie/blob/793af762424c6c360a0bf61236d7f7b63eb10433/internal/gateway/gateway.go#L795-L840)；[internal/provider/remote_magpie.go:105–120](https://github.com/yetone/magpie/blob/793af762424c6c360a0bf61236d7f7b63eb10433/internal/provider/remote_magpie.go#L105-L120) |
| 目录不是探活 | Drawers 合并目录、来源列表及按名称识别的模型；不是逐个调用验证。image 条目拼接也未显示最大输入图数或尺寸清单。请求阶段仍可 403/404，目录存在不等于当前 key 有权调用。[internal/gateway/draw.go:127–193](https://github.com/yetone/magpie/blob/793af762424c6c360a0bf61236d7f7b63eb10433/internal/gateway/draw.go#L127-L193)；[internal/gateway/draw.go:304–315](https://github.com/yetone/magpie/blob/793af762424c6c360a0bf61236d7f7b63eb10433/internal/gateway/draw.go#L304-L315) |
| 模型 ID | 有斜杠时直接走 provider resolver；裸名按可用来源寻找，可能随来源变化。Reframe 使用目录返回的完整 ID，避免裸名歧义；响应 model 不应标成“已证明的实际上游模型”。[internal/gateway/draw.go:76–90](https://github.com/yetone/magpie/blob/793af762424c6c360a0bf61236d7f7b63eb10433/internal/gateway/draw.go#L76-L90)；[internal/gateway/draw.go:339–365](https://github.com/yetone/magpie/blob/793af762424c6c360a0bf61236d7f7b63eb10433/internal/gateway/draw.go#L339-L365) |

官网当前 [Integrate your app](https://usemagpie.ai/docs/integrate) 对应用身份和单一 Magpie 来源提供相同方向的集成说明；它不是 Images 能力的完整契约，且不是安装版本证据。

## 请求与图片顺序

生成采用 JSON `/v1/images/generations`；编辑采用 multipart `/v1/images/edits`。网关要求非空 prompt；edit 无图为 400；n 缺省或小于等于零时变为 1，大于 4 时拒绝。Reframe 应明确传 `n=1`，避免依赖补默认。支持 `model/prompt/size/quality/background/output_format/n`，multipart 支持 mask。[internal/gateway/draw.go:256–276](https://github.com/yetone/magpie/blob/793af762424c6c360a0bf61236d7f7b63eb10433/internal/gateway/draw.go#L256-L276)；[internal/gateway/draw.go:382–465](https://github.com/yetone/magpie/blob/793af762424c6c360a0bf61236d7f7b63eb10433/internal/gateway/draw.go#L382-L465)

multipart 读取时先遍历所有 `image`，再遍历所有 `image[]`；每组内部按文件列表顺序加入。**混用两种键不能保留跨组原始顺序**。Reframe 全部以 `image[]` 传输可以保持当前快照顺序。转给普通 Images 上游时，单图使用 `image`，多图仍用 `image[]`；Google 转换按同一数组顺序构建 inlineData。这里没有按“主体/参考”自动推断身份，角色说明必须在 Reframe 提示词和快照中保留。[internal/gateway/draw.go:396–406](https://github.com/yetone/magpie/blob/793af762424c6c360a0bf61236d7f7b63eb10433/internal/gateway/draw.go#L396-L406)；[internal/gateway/draw.go:851–889](https://github.com/yetone/magpie/blob/793af762424c6c360a0bf61236d7f7b63eb10433/internal/gateway/draw.go#L851-L889)；[internal/gateway/draw.go:1079–1097](https://github.com/yetone/magpie/blob/793af762424c6c360a0bf61236d7f7b63eb10433/internal/gateway/draw.go#L1079-L1097)

解析器没有通用附图数量上限检查；`ParseMultipartForm(64 MiB)` 是内存阈值，不是七图能力保证。每个真实模型的总图片数、大小与用途仍需 I0/I2 验证。[internal/gateway/draw.go:382–410](https://github.com/yetone/magpie/blob/793af762424c6c360a0bf61236d7f7b63eb10433/internal/gateway/draw.go#L382-L410)

## size 与协议转换

| 路径 | 实际行为 |
| --- | --- |
| 普通 Images API | `size` 原样写到 JSON 或 multipart；不会把 `3:4` 换成像素。[internal/gateway/draw.go:819–830](https://github.com/yetone/magpie/blob/793af762424c6c360a0bf61236d7f7b63eb10433/internal/gateway/draw.go#L819-L830)；[internal/gateway/draw.go:850–857](https://github.com/yetone/magpie/blob/793af762424c6c360a0bf61236d7f7b63eb10433/internal/gateway/draw.go#L850-L857) |
| Google 官方 Gemini API | 只有来源 chat host 为 `generativelanguage.googleapis.com` 且模型含 gemini 才由该选择器优先走原生 generateContent；`size` 经 aspectOf 到 `imageConfig.aspectRatio`。Google 兼容代理不保证命中这条分支。[internal/gateway/draw.go:548–569](https://github.com/yetone/magpie/blob/793af762424c6c360a0bf61236d7f7b63eb10433/internal/gateway/draw.go#L548-L569)；[internal/gateway/draw.go:1090–1101](https://github.com/yetone/magpie/blob/793af762424c6c360a0bf61236d7f7b63eb10433/internal/gateway/draw.go#L1090-L1101) |
| Chat 转换 | 使用 `image_config.aspect_ratio`；提示词也追加比例；模型可否遵循仍由上游决定。[internal/gateway/draw.go:973–1000](https://github.com/yetone/magpie/blob/793af762424c6c360a0bf61236d7f7b63eb10433/internal/gateway/draw.go#L973-L1000) |
| 比例算法 | 含冒号的值去首尾空格直接返回，**不验证比例是否在列表内**；像素宽高转换为十个预设比率中对数差最小者。空值/auto 无比例。因此“语法被网关接受”不等于模型支持。[internal/gateway/draw.go:1236–1271](https://github.com/yetone/magpie/blob/793af762424c6c360a0bf61236d7f7b63eb10433/internal/gateway/draw.go#L1236-L1271) |

Reframe 应保存用户原始比例与本次实际发送 size。若两端不能统一接受冒号值，应先缩小已验证参数范围或在 Magpie 侧完善转换；不在 Reframe 新增供应商分支来隐藏差异。

## 响应、超时与重试

网关返回 `created/model/data/usage`；data 每项含 `b64_json`+`mime_type` 或 `url`，可含 `revised_prompt`；附带的文本放顶层 text。上游 Images 的 model 字段并未被解析用来证明真实模型，顶层 model 是网关用 provider ID 和解析后的模型 ID 重建的。Reframe 应称其“网关报告模型”。[internal/gateway/draw.go:340–365](https://github.com/yetone/magpie/blob/793af762424c6c360a0bf61236d7f7b63eb10433/internal/gateway/draw.go#L340-L365)；[internal/gateway/draw.go:899–935](https://github.com/yetone/magpie/blob/793af762424c6c360a0bf61236d7f7b63eb10433/internal/gateway/draw.go#L899-L935)

JSON 的 response_format 被读入结构体，但未进入内部 drawing；向普通 Images 上游只有 dall-e 名称分支主动要求 b64_json。URL 输出不会在响应归一化时强制下载成 base64。调用方必须准备验证 URL 分支和空图/坏 base64/非图片数据。[internal/gateway/draw.go:417–436](https://github.com/yetone/magpie/blob/793af762424c6c360a0bf61236d7f7b63eb10433/internal/gateway/draw.go#L417-L436)；[internal/gateway/draw.go:819–830](https://github.com/yetone/magpie/blob/793af762424c6c360a0bf61236d7f7b63eb10433/internal/gateway/draw.go#L819-L830)；[internal/gateway/draw.go:917–935](https://github.com/yetone/magpie/blob/793af762424c6c360a0bf61236d7f7b63eb10433/internal/gateway/draw.go#L917-L935)

处理器在请求解析和路由后创建 **5 分钟**上下文，继承 HTTP 请求上下文；上游请求用 NewRequestWithContext，断开可取消等待，尚不等于撤回供应商作业。该期限不等于整个客户端提交到响应的完整墙钟期限。请求上下文出错时 sendWith 可统一表述为“未在 5 分钟内回答”，Reframe 应优先区分自身取消状态。[internal/gateway/draw.go:39–44](https://github.com/yetone/magpie/blob/793af762424c6c360a0bf61236d7f7b63eb10433/internal/gateway/draw.go#L39-L44)；[internal/gateway/draw.go:321–326](https://github.com/yetone/magpie/blob/793af762424c6c360a0bf61236d7f7b63eb10433/internal/gateway/draw.go#L321-L326)；[internal/gateway/draw.go:695–733](https://github.com/yetone/magpie/blob/793af762424c6c360a0bf61236d7f7b63eb10433/internal/gateway/draw.go#L695-L733)

已确认的网关额外尝试范围：

- 一般 API 路径返回 404/405 时，Images 与 Chat 可互换尝试；Google 原生分支不进入该 fallback。[internal/gateway/draw.go:646–669](https://github.com/yetone/magpie/blob/793af762424c6c360a0bf61236d7f7b63eb10433/internal/gateway/draw.go#L646-L669)
- 订阅账户 401/402/403/429 可切换下一个账户；本路径明确移除 provider 的 fallback 模型。普通独立 key 路径直接 draw，不能从文本路由说明推断所有 Images 请求都会轮换 key/模型。[internal/gateway/draw.go:577–633](https://github.com/yetone/magpie/blob/793af762424c6c360a0bf61236d7f7b63eb10433/internal/gateway/draw.go#L577-L633)；[internal/gateway/draw.go:636–644](https://github.com/yetone/magpie/blob/793af762424c6c360a0bf61236d7f7b63eb10433/internal/gateway/draw.go#L636-L644)
- Google/Chat 的 n 通过 eachDrawing 并行执行 n 次；n=1 是一次该 ask，不是保证上游只会有一次网络尝试。[internal/gateway/draw.go:1198–1233](https://github.com/yetone/magpie/blob/793af762424c6c360a0bf61236d7f7b63eb10433/internal/gateway/draw.go#L1198-L1233)
- 普通 Provider.Do 最终调用 HTTP client；订阅插件可替换 transport/client，网关 RPM transport 是等待和转发。本研究不把文本 API 的一般重试策略套用到 Images，也不承诺所有插件或底层网络无重试。[internal/provider/plugins.go:571–585](https://github.com/yetone/magpie/blob/793af762424c6c360a0bf61236d7f7b63eb10433/internal/provider/plugins.go#L571-L585)；[internal/gateway/rpm.go:248–264](https://github.com/yetone/magpie/blob/793af762424c6c360a0bf61236d7f7b63eb10433/internal/gateway/rpm.go#L248-L264)

## I0 必须补齐的真实证据

实际 Magpie 版本、根地址/鉴权模式、两个完整来源/模型 ID；各来源至少一张文生图和一张附图结果；请求的原始比例与实际 size、返回 MIME/尺寸/模型字段、顺序与主体保真检查；明确多图数量上限的证据或标为未知；失败/断网/取消/URL 分支的验证方式。合成 fixture、源码检查或 stub 能证明接口假设，不能替代两条真实来源链路通过。
