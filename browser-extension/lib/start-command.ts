// The offline hint: where this installation lives and the one command that starts it with the same data.
// The paths stay in the background and extension pages; web-page panels never receive them.
export const startLocationKey = "serviceStartLocation";

/** The installation folder, plus the data folder when the service uses one other than the installation's own `.local`. */
export type StartLocation = { installDir: string; dataDir?: string };

const shellPath = (value: unknown): value is string =>
  typeof value === "string" && value.startsWith("/") && value.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(value);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** A POSIX shell command that restarts this installation on the same data, or null when none is known or safe to show. */
export function startCommand(location: unknown): string | null {
  if (!location || typeof location !== "object" || Array.isArray(location)) return null;
  const { installDir, dataDir } = location as Record<string, unknown>;
  // A data folder that cannot be shown safely must not fall back to the default, which would open an empty store.
  if (!shellPath(installDir) || (dataDir !== undefined && !shellPath(dataDir))) return null;
  return `cd ${quote(installDir)} && ${dataDir === undefined ? "" : `ALCHEMY_DATA_DIR=${quote(dataDir)} `}npm start`;
}

/** Splits the start location from a health response so the UI only ever sees the rest. */
export function splitStartLocation<T>(health: T): { health: T; location?: StartLocation } {
  if (!health || typeof health !== "object" || Array.isArray(health) || !("installDir" in health || "dataDir" in health)) return { health };
  const { installDir, dataDir, ...rest } = health as Record<string, unknown>;
  const location = dataDir === undefined ? { installDir } : { installDir, dataDir };
  return { health: rest as T, location: startCommand(location) ? location as StartLocation : undefined };
}
