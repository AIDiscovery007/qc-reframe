// The offline hint: where this installation lives and the one command that starts it.
// The path stays in the background and extension pages; web-page panels never receive it.
export const installDirKey = "serviceInstallDir";

/** A POSIX shell command for an absolute installation path, or null when none is known or safe to show. */
export function startCommand(dir: unknown): string | null {
  if (typeof dir !== "string" || !dir.startsWith("/") || dir.length > 1024 || /[\u0000-\u001f\u007f]/.test(dir)) return null;
  return `cd '${dir.replaceAll("'", "'\\''")}' && npm start`;
}

/** Splits the installation path from a health response so the UI only ever sees the rest. */
export function splitInstallDir<T>(health: T): { health: T; installDir?: string } {
  if (!health || typeof health !== "object" || Array.isArray(health) || !("installDir" in health)) return { health };
  const { installDir, ...rest } = health as Record<string, unknown>;
  return { health: rest as T, installDir: startCommand(installDir) ? installDir as string : undefined };
}
