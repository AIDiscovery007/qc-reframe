# Reframe 提示音来源

- 上游：[akx/Notifications](https://github.com/akx/Notifications/tree/db184d33834a94028b6600d155d312ce7b704e8d)。
- 固定提交：`db184d33834a94028b6600d155d312ce7b704e8d`。
- 导入日期：2026-10-04。
- 使用上游 README 提供的 **CC0 Public Domain** 许可选项；未选择另一项 CC Attribution 3.0。
- 上游将该选项称为 CC0，但其链接指向 Public Domain Mark 1.0；此处如实保留声明及链接，不将其改写成另一份许可文本。完整原文见 [UPSTREAM-README.md](UPSTREAM-README.md)。
- 以下文件均逐字节复制自上游 `OGG/`，保留原名；未剪辑、合成、转码或归一化。中文名称仅供 Reframe 界面显示。
- 选择依据：适合安静创作工作台的短通知，兼顾柔和持续音、和弦、笛/琴类、短促敲击和电子音；避开长旋律、警报及接近满幅的候选。筛选基于原名、解码时长、峰值、RMS 和频谱统计，未做人工听音验收。
- 时长与电平由 FFmpeg/FFprobe 对原始 OGG 解码测得；峰值为 sample peak，非 true peak，实际听感及响度仍由播放音量与设备决定。

| 原始文件 | 中文名 | 时长（秒） | 峰值（dBFS） | RMS（dBFS） | 字节 | SHA256 |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| `Calm.ogg` | 静谧 | 1.656 | -16.74 | -31.54 | 30652 | `e9cfce1c30e7c6b8550c109bcc0b938d33252bbf5a298d9d57f14cfbce1c0262` |
| `Cloud.ogg` | 云朵 | 1.480 | -12.91 | -27.44 | 27428 | `36cd71136475e717d2226829b90fd023a7ff04d4e012e2e998e8b5e90191ec1a` |
| `Chord2.ogg` | 和弦 | 1.229 | -10.78 | -28.78 | 27629 | `6939a29cee1c275b07995c090733969bd5f3eb72f5147d219d358c5d52e54552` |
| `Flit_Flute.ogg` | 轻笛 | 1.962 | -20.59 | -35.44 | 41946 | `84eefec86624ca6a7a1edb3e56a0b72cd80df0b2ca65fec2a4f9f47a5b4552d7` |
| `Glisten.ogg` | 微光 | 2.204 | -16.30 | -32.44 | 49097 | `337d30a51175321cafd0f21d23e2246c964a2773f221c3fb34fe212d07d80cca` |
| `Information_Block.ogg` | 轻叩 | 1.100 | -11.40 | -28.92 | 29638 | `b120f289e4434c84595bef6beacbe96aa7d8d099d824ed242344643a6b7711f8` |
| `Koto.ogg` | 琴弦 | 2.277 | -8.35 | -29.79 | 44888 | `dffc97faeece998c052aa67197a1abe4a853ae7b7072d979f7fdcaab2994dd8a` |
| `Modular.ogg` | 星点 | 1.810 | -13.10 | -32.49 | 40758 | `003d39d81888176a3b81dac0533ef07caff6845f7d7444ba86e07aef6518407f` |
| `Taptap.ogg` | 双拍 | 0.240 | -4.96 | -25.96 | 10649 | `517933e96aba45762e620a78bd3860147057356fec8fed9c9efe5fb393951e81` |
| `Tech.ogg` | 轻讯 | 0.367 | -10.62 | -29.13 | 10134 | `9399642cb02c857c8869c3a7404e1aed0005e66f743ae360fcd8fa4c3081d440` |

音频总大小：**312,819 字节（305.5 KiB）**。
