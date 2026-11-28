<p align="center">
  <img src="browser-extension/assets/brand/reframe.svg" width="88" height="88" alt="QC-Reframe logo" />
</p>

<h1 align="center">QC-Reframe</h1>

<p align="center"><b>See an image you like → get its prompt → make your own version.</b></p>

<p align="center">English · <a href="README.zh-CN.md">简体中文</a></p>

QC-Reframe is a browser extension with a small service on your computer. Hover over any image on the web and click the round **R** button. Your own Codex, Pi or Claude Code agent studies the image and writes a detailed prompt for it; the app calls this "reversing". Then generate a new image, with your own photo as the subject if you like. Everything stays on your computer.

| Your subject | Reference | Result |
| :---: | :---: | :---: |
| <img src="browser-extension/docs/gallery/urban-poster/subject.png" width="240" alt="Subject photo: a person with black hair" /> | <img src="browser-extension/docs/gallery/urban-poster/reference.png" width="240" alt="Reference: a city poster built from giant letters" /> | <a href="browser-extension/docs/gallery/urban-poster/README.md"><img src="browser-extension/docs/gallery/urban-poster/result.png" width="240" alt="Result: the subject in the red, black and white city poster" /></a> |

*A real example made with the extension. [See the full prompt →](browser-extension/docs/gallery/urban-poster/README.md)*

## Install

### Option 1: ask your AI agent (easiest)

Copy this into Codex, Claude Code, Cursor or any agent that can run terminal commands:

```text
Install QC-Reframe for me: https://github.com/AIDiscovery007/qc-reframe

1. Check that Node.js 22.15+ and npm are installed. If not, tell me how to install them.
2. If QC-Reframe is already installed, upgrade that copy instead of making a second one.
3. On macOS or Linux, run:
   curl -fsSL https://github.com/AIDiscovery007/qc-reframe/releases/latest/download/install.sh | bash
   On Windows, follow browser-extension/docs/INSTALL_WITH_CODEX.md in the repo.
4. Check that the Codex CLI is installed and logged in. If I must log in myself, give me the exact command.
5. Give me the full path of the extension folder and the shortest steps to load it in my browser.

Don't delete my QC-Reframe projects or change my Codex settings.
At the end, tell me what you checked and what I still need to do.
```

### Option 2: one command (macOS / Linux)

```bash
curl -fsSL https://github.com/AIDiscovery007/qc-reframe/releases/latest/download/install.sh | bash
```

It downloads the latest release, checks it, installs it to `~/QC-Reframe` and starts the service.

### Last step: load the extension (once)

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and choose `~/QC-Reframe/.output/chrome-mv3`.
   This folder is hidden. On a Mac, press <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>G</kbd> in the file picker and paste the path. The installer has already copied it for you.
3. Using the built-in browser in Codex? Load the same folder from its extensions page.

## How to use

The app's labels are in Chinese, so each step shows the Chinese text in brackets.

1. **Open it.** Click the QC-Reframe icon in the browser toolbar, then **Workspace** (工作台). It connects to the service by itself, with no setup.
2. **Pick a model (first time only).** Open **Settings** (设置中心) → **Models** (插件模型). Choose Codex, Pi or Claude Code and a model, then click **Verify and use** (验证并使用). This sends one short test request.
3. **Grab an image.** On Pinterest or any website, hover over an image and click the round **R** button. Choose **Reverse now** (立即逆向), or **Add to Reframe** (加入 Reframe) to save it for later. You can also right-click the image.
4. **Choose a path.** In the workspace, open the image (saved images are in **Projects** (项目记录) → **To reverse** (待逆向)). Pick what you want:
   - **Extract style** (提取风格): upload your own photo and give it the look of the reference.
   - **Full recreate** (完整复刻): describe the reference image itself. In the workspace you can also pick **Edit original** (原图编辑): Reframe lists what can be changed (face, pose, background, text…), you fill in the changes, and the original is edited instead of redrawn.
   - There are also paths to put your subject into the reference scene, or to combine several images.
5. **Get your prompt and image.** Click **Reverse only** (仅逆向) to get just the prompt, or **Reverse and generate** (逆向并生图) to make the image too. Jobs run in the background, so you can keep browsing. You get a notice when one finishes.
6. **Come back any time.** Your projects, prompts and images are saved in `~/QC-Reframe/.local/`.

## Good to know

- **You need:** Node.js 22.15+, Chrome or another Chromium browser that can load extensions, and the [Codex CLI](https://developers.openai.com/codex/cli), logged in. Pi needs Node.js 22.19+. Claude Code needs the [Claude Code CLI](https://code.claude.com/docs/en/setup), logged in; it reverses images but cannot generate them. Images can also be generated with an OpenAI-compatible API, Gemini or a local Magpie gateway. The one-command install works on macOS and Linux; on Windows, install from source.
- **After a restart:** on a Mac, just open QC-Reframe and the service starts by itself. On other systems, run the command the extension shows, or `cd ~/QC-Reframe && npm start`.
- **Update:** from v0.8.0, open **Settings** (设置中心) → **Local connection** (本机连接), click **Check for updates** (检查更新), and click **Upgrade** (升级到) when a new version is found. After a release, the extension icon shows **NEW** and one system notification appears; you can also skip that version. The extension reloads by itself; refresh open pages afterwards. On v0.7.0 or earlier, run the install command again, then click reload on QC-Reframe in `chrome://extensions` and refresh open pages. Your projects stay.
- **Installed v0.6.0 or earlier from source?** Update that copy instead: give your agent the prompt above, or follow the [upgrade steps](browser-extension/docs/INSTALL_WITH_CODEX.md#日常启动升级和排错). The extension now has a fixed ID, so remove the old QC-Reframe extension once and load the new `.output/chrome-mv3`. Your projects are kept.
- **Stop the service:** `cd ~/QC-Reframe && npm stop`. Nothing is deleted.
- **Privacy:** projects, prompts and images are stored on your computer, but the model does not run offline. At most once an hour the local service asks GitHub for the latest release, sending no project data; you can turn this off in Local connection (本机连接). What you choose to send goes to the agent or image service you picked: the images, your own photos and your instructions, and in session creation (会话创作) the user messages and assistant replies of the conversations you select. Reversing gives a close prompt, not the original one. [Data details →](browser-extension/README.md#图片与数据)

## More

The detailed docs are in Chinese.

[Install and troubleshooting](browser-extension/docs/INSTALL_WITH_CODEX.md) · [Features](browser-extension/docs/FEATURES.md) · [User guide](browser-extension/README.md) · [Gallery](browser-extension/docs/gallery/README.md) · [Release notes](browser-extension/docs/releases/README.md) · [Contributing](Contribution.md)
