import { defineConfig } from "wxt";

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "QC-Reframe · 图片风格逆向",
    short_name: "QC-Reframe",
    description:
      "选择网页图片，交给本机 Agent 与图片逆向技能，提炼可复用的提示词。",
    minimum_chrome_version: "116",
    permissions: ["storage", "contextMenus", "activeTab", "notifications", "offscreen", "alarms", "nativeMessaging", "scripting"],
    host_permissions: ["<all_urls>"],
    action: { default_title: "打开 QC-Reframe" },
  },
});
