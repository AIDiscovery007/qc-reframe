import { channels } from "../lib/channel.mjs";

/** Extension origins that may receive the pairing token: the channel's fixed-key ID plus one optionally approved ID. */
export function connectionOrigins(extensionId = "", channel = channels.release) {
  if (extensionId && !/^[a-p]{32}$/.test(extensionId)) throw new Error("ALCHEMY_EXTENSION_ID 须为浏览器显示的 32 位扩展 ID。");
  return new Set([`chrome-extension://${channel.extensionId}`, ...(extensionId ? [`chrome-extension://${extensionId}`] : [])]);
}
