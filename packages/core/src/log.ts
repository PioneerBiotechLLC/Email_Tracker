type Level = "debug" | "info" | "warn" | "error";
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const lvl = (process.env.LOG_LEVEL as Level | undefined) ?? "info";
  return order[lvl] ?? 20;
}

function emit(level: Level, scope: string, msg: string, data?: Record<string, unknown>) {
  if (order[level] < threshold()) return;
  const ts = new Date().toISOString();
  const extra = data && Object.keys(data).length ? " " + JSON.stringify(data) : "";
  const line = `${ts} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}${extra}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

/** Tiny structured logger. Never pass email bodies to it. */
export function createLogger(scope: string) {
  return {
    debug: (msg: string, data?: Record<string, unknown>) => emit("debug", scope, msg, data),
    info: (msg: string, data?: Record<string, unknown>) => emit("info", scope, msg, data),
    warn: (msg: string, data?: Record<string, unknown>) => emit("warn", scope, msg, data),
    error: (msg: string, data?: Record<string, unknown>) => emit("error", scope, msg, data),
  };
}
export type Logger = ReturnType<typeof createLogger>;
