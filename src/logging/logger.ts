export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const COLORS: Record<LogLevel, string> = {
  debug: "\x1b[90m",   // gray
  info: "\x1b[36m",    // cyan
  warn: "\x1b[33m",    // yellow
  error: "\x1b[31m",   // red
};

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

let globalLevel: LogLevel = "info";

export function setGlobalLogLevel(level: LogLevel) {
  globalLevel = level;
}

export function createLogger(scope: string): Logger {
  function log(level: LogLevel, msg: string, data?: Record<string, unknown>) {
    if (LEVELS[level] < LEVELS[globalLevel]) return;

    const time = new Date().toISOString().slice(11, 23);
    const color = COLORS[level];
    const prefix = `${color}${time}${RESET} ${BOLD}[${scope}]${RESET}`;
    const levelTag = `${color}${level.toUpperCase().padEnd(5)}${RESET}`;

    let line = `${prefix} ${levelTag} ${msg}`;
    if (data && Object.keys(data).length > 0) {
      line += ` ${formatData(data)}`;
    }

    console.log(line);
  }

  return {
    debug: (msg, data) => log("debug", msg, data),
    info: (msg, data) => log("info", msg, data),
    warn: (msg, data) => log("warn", msg, data),
    error: (msg, data) => log("error", msg, data),
    child: (childScope) => createLogger(`${scope}:${childScope}`),
  };
}

function formatData(data: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === "number") {
      parts.push(`${key}=${value}`);
    } else if (typeof value === "string") {
      parts.push(`${key}="${value}"`);
    } else {
      parts.push(`${key}=${JSON.stringify(value)}`);
    }
  }
  return `\x1b[90m(${parts.join(", ")})\x1b[0m`;
}
