import { DEV_EXTENSION_ID, DEV_EXTENSION_PUBLIC_KEY, EXTENSION_ID, EXTENSION_PUBLIC_KEY } from "./extension-identity.mjs";

// Two identities that can run side by side on one computer: the release a user installs, and the dev build of a
// source checkout. Each owns its extension ID, port, launcher and build folder, so neither reaches the other.
// The extension takes its channel from the build mode; the service only from an explicit `--dev` / ALCHEMY_CHANNEL.
export const channels = Object.freeze({
  release: Object.freeze({
    name: "release", port: 43187, hostName: "com.qc.reframe", launcherFile: "native-launcher",
    extensionId: EXTENSION_ID, publicKey: EXTENSION_PUBLIC_KEY, outputDir: ".output/chrome-mv3",
    manifestName: "QC-Reframe · 图片风格逆向", shortName: "QC-Reframe",
    commands: Object.freeze({ setup: "npm run setup", start: "npm start", stop: "npm stop", status: "npm run status" }),
  }),
  dev: Object.freeze({
    name: "dev", port: 43197, hostName: "com.qc.reframe.dev", launcherFile: "native-launcher-dev",
    extensionId: DEV_EXTENSION_ID, publicKey: DEV_EXTENSION_PUBLIC_KEY, outputDir: ".output/chrome-mv3-dev",
    manifestName: "QC-Reframe Dev · 开发版", shortName: "QC-Reframe Dev",
    commands: Object.freeze({ setup: "npm run dev:setup", start: "npm run dev:start", stop: "npm run dev:stop", status: "npm run dev:status" }),
  }),
});

/** The service's channel. Unset is the release; anything other than the two names is refused, never guessed. */
export function serviceChannel(value) {
  if (value === undefined || value === "" || value === "release") return channels.release;
  if (value === "dev") return channels.dev;
  throw new Error("ALCHEMY_CHANNEL 只能是 dev 或 release。");
}

/** The extension's channel: WXT's development mode builds the dev extension, every other mode the release. */
export function buildChannel(mode) {
  return mode === "development" ? channels.dev : channels.release;
}
