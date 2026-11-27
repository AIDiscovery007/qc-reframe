import { defineConfig } from "wxt";
import { buildChannel } from "./lib/channel.mjs";

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  // `--mode development` (npm run dev, npm run dev:build) builds the dev extension into .output/chrome-mv3-dev;
  // every other build is the release. Only the identity differs: permissions are the same product either way.
  manifest: ({ mode }) => {
    const channel = buildChannel(mode);
    return {
      name: channel.manifestName,
      short_name: channel.shortName,
      description:
        "选择网页图片，交给本机 Agent 与图片逆向技能，提炼可复用的提示词。",
      // Fixes the extension ID for every unpacked copy, so the local service of the same channel trusts it without setup.
      key: channel.publicKey,
      minimum_chrome_version: "116",
      permissions: ["storage", "contextMenus", "activeTab", "notifications", "offscreen", "alarms", "nativeMessaging", "scripting"],
      host_permissions: ["<all_urls>"],
      action: { default_title: `打开 ${channel.shortName}` },
    };
  },
});
