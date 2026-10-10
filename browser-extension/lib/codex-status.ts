export type RecoverySection = "cli" | "pi-cli" | "models" | "generation" | "connection";
export type Compatibility = {
  checkedAt?: string | null;
  error?: string;
  features: Record<string, { status: "supported" | "unsupported" | "unknown"; message?: string }>;
};
export type CliStatus = {
  agent?: "codex" | "pi"; canInstall?: boolean;
  installed: boolean; version: string | null; latestVersion: string | null; executable?: string | null;
  source: "managed" | "npm" | "homebrew" | "standalone" | "app" | "custom" | "missing";
  canUpdate?: boolean; updateAvailable: boolean; checkedAt?: string | null; detectedAt?: string | null;
  checkError?: string | null; reason?: string | null; command?: string | null;
  comparisonReference?: string;
  instructions?: { command?: string; loginCommand?: string; url?: string; message: string };
  compatibility?: Compatibility;
  operation?: { status: "running" | "completed" | "failed"; stage: string; error?: string; startedAt: string; finishedAt?: string } | null;
};

// Historical task errors are persisted as text; recovery must also work after reload.
export function recoverySection(message = ""): RecoverySection | undefined {
  if (/Codex 内置生图/.test(message)) return "cli";
  if (/生图 API|API Key|生图渠道|Gemini/.test(message)) return "generation";
  if (/Pi.*(?:CLI|安装|版本|升级|更新|无法运行|无法启动|路径)/i.test(message)) return "pi-cli";
  if (/Pi|逆向 Agent/.test(message)) return "models";
  if (/本机服务|配对码|图片逆向技能|ALCHEMY_SKILL_PATH|IMAGEGEN_SKILL_PATH/.test(message)) return "connection";
  if (/刷新模型列表|重新验证|请先.*登录|账号|账户|额度|reasoning[._\s-]+effort/i.test(message)) return "models";
  if (/CLI|Codex.*(?:版本|升级|更新|不支持|无法运行|无法启动|安装)|app-server|experimentalApi|method not found/i.test(message)) return "cli";
  if (/模型|推理强度|登录|账号|账户|额度/.test(message)) return "models";
}

export function cliLabel(cli: CliStatus) {
  if (cli.operation?.status === "running") return cli.operation.stage || "正在更新";
  if (cli.operation?.status === "failed") return cli.operation.stage || "升级未完成";
  if (!cli.installed) return "需要安装 CLI";
  if (!cli.version) return "需要检查安装";
  if (cli.updateAvailable) return cli.comparisonReference ? "有新版可供参考" : "有新版本";
  if (cli.checkError) return "暂时无法检查更新";
  if (cli.operation?.status === "completed") return "升级完成";
  if (cli.comparisonReference) return "已检测安装版本";
  return cli.latestVersion && cli.checkedAt ? "当前渠道无更新" : "已安装";
}

export function compatibilityMessage(value?: Compatibility) {
  if (!value) return "";
  const names: Record<string, string> = { models: "模型列表", reverse: "图片逆向", generation: "生图", sessions: "会话创作" };
  const missing = Object.entries(value.features).filter(([, feature]) => feature.status === "unsupported").map(([key]) => names[key] || key);
  if (missing.length) return `${missing.join("、")}所需接口不受当前 CLI 支持，请更新后重新检测。其他功能可继续使用。`;
  if (Object.values(value.features).some(feature => feature.status === "unknown")) return value.error || "暂时无法确认功能接口，仍可尝试使用；遇到问题可重新检测。";
  return "功能接口检查通过；实际可用性仍取决于登录、模型与账户权限。";
}
