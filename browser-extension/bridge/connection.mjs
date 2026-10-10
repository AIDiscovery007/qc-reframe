import { createHash } from "node:crypto";

// Chromium GenerateIdForPath hashes the native path bytes; Windows uppercases only the drive letter.
// https://chromium.googlesource.com/chromium/src/+/refs/heads/main/components/crx_file/id_util.cc
export function extensionOrigin(path, platform = process.platform) {
  const windows = platform === "win32";
  const normalized = windows ? path.replace(/^[a-z]:/, drive => drive.toUpperCase()) : path;
  const id = createHash("sha256").update(normalized, windows ? "utf16le" : "utf8")
    .digest("hex").slice(0, 32).replace(/[0-9a-f]/g, value => String.fromCharCode(97 + parseInt(value, 16)));
  return `chrome-extension://${id}`;
}

export function connectionOrigins(extensionPath, extensionId = "") {
  if (extensionId && !/^[a-p]{32}$/.test(extensionId)) throw new Error("ALCHEMY_EXTENSION_ID 须为浏览器显示的 32 位扩展 ID。");
  return new Set([extensionOrigin(extensionPath), ...(extensionId ? [`chrome-extension://${extensionId}`] : [])]);
}
