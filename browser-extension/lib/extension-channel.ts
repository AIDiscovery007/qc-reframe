import { buildChannel } from "./channel.mjs";

/** This build's identity: the dev build reaches only the dev service and launcher, the release only the release ones. */
export const extensionChannel = buildChannel(import.meta.env?.MODE);
