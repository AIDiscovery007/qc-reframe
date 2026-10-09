import { defineConfig } from "wxt";

if (process.env.REFRAME_TEST_COVERAGE === "1" && process.argv.includes("zip")) {
  throw new Error("Coverage source maps must not enter release ZIPs; unset REFRAME_TEST_COVERAGE.");
}

export default defineConfig({
  vite: () => ({ build: { sourcemap: process.env.REFRAME_TEST_COVERAGE === "1" ? "hidden" : false } }),
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "QC-Reframe · 图片风格逆向",
    short_name: "QC-Reframe",
    description:
      "选择网页图片，交给本机 Codex 与图片逆向技能，提炼可复用的提示词。",
    minimum_chrome_version: "116",
    permissions: ["storage", "contextMenus", "activeTab", "notifications", "offscreen", "alarms"],
    host_permissions: ["<all_urls>"],
    action: { default_title: "打开 QC-Reframe" },
  },
});
