export type LogLevel = "error" | "warn" | "info" | "debug";

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

let currentLevel: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function enabled(level: LogLevel): boolean {
  return LEVEL_WEIGHT[level] <= LEVEL_WEIGHT[currentLevel];
}

function write(
  level: Exclude<LogLevel, "debug">,
  message: string,
  meta?: unknown,
): void {
  if (!enabled(level)) return;
  const suffix = meta === undefined ? "" : ` ${safeStringify(meta)}`;
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${message}${suffix}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, inner) => {
      if (typeof inner === "bigint") return inner.toString();
      if (inner instanceof Error) {
        return { name: inner.name, message: inner.message };
      }
      return inner;
    });
  } catch {
    return "[unserializable]";
  }
}

export const logger = {
  error(message: string, meta?: unknown): void {
    write("error", message, meta);
  },
  warn(message: string, meta?: unknown): void {
    write("warn", message, meta);
  },
  info(message: string, meta?: unknown): void {
    write("info", message, meta);
  },
  debug(message: string, meta?: unknown): void {
    if (!enabled("debug")) return;
    console.debug(`[${new Date().toISOString()}] DEBUG ${message}`, meta ?? "");
  },
};
