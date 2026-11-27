export type ChannelName = "release" | "dev";
export type Channel = Readonly<{
  name: ChannelName; port: number; hostName: string; launcherFile: string;
  extensionId: string; publicKey: string; outputDir: string; manifestName: string; shortName: string;
  commands: Readonly<{ setup: string; start: string; stop: string; status: string }>;
}>;
export const channels: Readonly<Record<ChannelName, Channel>>;
export function serviceChannel(value: string | undefined): Channel;
export function buildChannel(mode: string | undefined): Channel;
