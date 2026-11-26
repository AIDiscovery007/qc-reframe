<p align="center">
  <img src="browser-extension/assets/brand/reframe.svg" width="88" height="88" alt="QC-Reframe logo" />
</p>

<h1 align="center">QC-Reframe</h1>

<p align="center"><b>看到喜欢的图 → 拿到它的提示词 → 做出你自己的版本。</b></p>

<p align="center"><a href="README.md">English</a> · 简体中文</p>

QC-Reframe 是一个浏览器扩展，加上一个运行在你电脑上的小服务。在任意网页把鼠标停在图片上，点圆形 **R** 按钮，你自己的 Codex（或 Pi）就会细看这张图，写出详细的提示词，这一步叫「逆向」。接着可以直接生成新图，也可以换上你自己的照片做主体。所有内容都保存在你的电脑上。

| 你的主体 | 参考图 | 生成结果 |
| :---: | :---: | :---: |
| <img src="browser-extension/docs/gallery/urban-poster/subject.png" width="240" alt="主体原图：黑发人物" /> | <img src="browser-extension/docs/gallery/urban-poster/reference.png" width="240" alt="参考图：巨型字形都市海报" /> | <a href="browser-extension/docs/gallery/urban-poster/README.md"><img src="browser-extension/docs/gallery/urban-poster/result.png" width="240" alt="生成结果：主体演绎红黑白都市海报" /></a> |

*用本扩展实际生成的案例。[查看完整提示词 →](browser-extension/docs/gallery/urban-poster/README.md)*

## 安装

### 方式一：交给你的 AI Agent（最省事）

把下面这段复制给 Codex、Claude Code、Cursor 或任何能执行终端命令的 Agent：

```text
请帮我安装 QC-Reframe：https://github.com/AIDiscovery007/qc-reframe

1. 检查是否已安装 Node.js 22.15+ 和 npm；没有的话告诉我怎么装。
2. 如果已经装过 QC-Reframe，就升级原来那份，不要再装第二份。
3. macOS 或 Linux 运行：
   curl -fsSL https://github.com/AIDiscovery007/qc-reframe/releases/latest/download/install.sh | bash
   Windows 按仓库里的 browser-extension/docs/INSTALL_WITH_CODEX.md 安装。
4. 检查 Codex CLI 已安装并登录；需要我自己登录时，给我准确的命令。
5. 告诉我扩展文件夹的完整路径，以及在浏览器里加载它的最短步骤。

不要删除我的 QC-Reframe 项目，也不要改我的 Codex 设置。
最后告诉我哪些已经检查过，哪些还要我自己做。
```

### 方式二：一条命令（macOS / Linux）

```bash
curl -fsSL https://github.com/AIDiscovery007/qc-reframe/releases/latest/download/install.sh | bash
```

它会下载最新版、校验文件、安装到 `~/QC-Reframe`，并启动服务。

### 最后一步：加载扩展（只需一次）

1. 打开 `chrome://extensions`，打开右上角的 **开发者模式**。
2. 点 **加载已解压的扩展程序**，选择 `~/QC-Reframe/.output/chrome-mv3`。
   这个文件夹是隐藏的。Mac 上在选择窗口按 <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>G</kbd>，粘贴路径即可，安装器已经帮你复制好了。
3. 用 Codex 内置浏览器？在它的扩展页面加载同一个文件夹。

## 怎么用

1. **打开。** 点浏览器工具栏里的 QC-Reframe 图标，再点 **工作台**。它会自动连上本机服务，不用任何设置。
2. **选模型（只需第一次）。** 打开 **设置中心 → 插件模型**，选 Codex 或 Pi 和一个模型，点 **验证并使用**。这会发一次很短的测试请求。
3. **选图。** 在 Pinterest 或任意网站，把鼠标停在图片上，点圆形 **R** 按钮。选 **立即逆向**，或选 **加入 Reframe** 先存起来。也可以右键图片。
4. **选路径。** 在工作台打开这张图（存起来的图在 **项目记录 → 待逆向**），选你想要的效果：
   - **提取风格**：上传你自己的照片，换上参考图的画风。
   - **完整复刻**：把参考图本身写成提示词。
   - 还可以把你的主体放进参考画面，或把多张图组合在一起。
5. **拿提示词和图片。** 点 **仅逆向** 只要提示词，点 **逆向并生图** 连图一起生成。任务在后台运行，你可以继续浏览，完成后会收到提醒。
6. **随时回来。** 项目、提示词和图片都保存在 `~/QC-Reframe/.local/`。

## 须知

- **需要：** Node.js 22.15+、能加载扩展的 Chrome 或其他 Chromium 浏览器，以及已登录的 [Codex CLI](https://developers.openai.com/codex/cli)。Pi 需要 Node.js 22.19+。生图也可以用 OpenAI 兼容 API、Gemini 或本机 Magpie 网关。一条命令安装支持 macOS 和 Linux；Windows 请从源码安装。
- **重启电脑后：** Mac 上直接打开 QC-Reframe，服务会自己启动。其他系统运行扩展里显示的命令，或 `cd ~/QC-Reframe && npm start`。
- **更新：** 再运行一次安装命令，然后在 `chrome://extensions` 点 QC-Reframe 的重新加载按钮，并刷新已打开的网页。项目都会保留。
- **以前用源码装过 v0.6.0 或更早版本？** 请升级原来那份：把上面的提示词交给 Agent，或按[升级步骤](browser-extension/docs/INSTALL_WITH_CODEX.md#日常启动升级和排错)操作。扩展 ID 现在是固定的，所以要先移除旧的 QC-Reframe 扩展，再加载新的 `.output/chrome-mv3`，只需一次。项目都会保留。
- **停止服务：** `cd ~/QC-Reframe && npm stop`，不会删除任何内容。
- **隐私：** 只有你选的图片会发给你选的 Agent 或生图服务。项目、提示词和图片都存在你的电脑上。逆向得到的是相近的提示词，不是原始提示词。

## 更多

[安装与排错](browser-extension/docs/INSTALL_WITH_CODEX.md) · [功能导览](browser-extension/docs/FEATURES.md) · [使用手册](browser-extension/README.md) · [效果画廊](browser-extension/docs/gallery/README.md) · [更新日志](browser-extension/docs/releases/README.md) · [贡献指南](Contribution.md)
