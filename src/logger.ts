import pino from "pino";

const LOG_LEVEL = process.env.LOG_LEVEL ?? "info";
const NODE_ENV = process.env.NODE_ENV ?? "development";

/** Serialize errors with message, stack, type, and optional code for consistent log shape */
function serializeErr(err: unknown): object {
  if (err instanceof Error) {
    return {
      type: err.constructor?.name ?? "Error",
      message: err.message,
      stack: err.stack,
      ...(err && "code" in err && typeof (err as { code: string }).code === "string"
        ? { code: (err as { code: string }).code }
        : {}),
    };
  }
  if (typeof err === "object" && err !== null) {
    return { type: "Object", raw: err };
  }
  return { type: typeof err, value: err };
}

/** Redact sensitive keys from any object (nested). Keys are case-insensitive. */
const SENSITIVE_KEYS = [
  "token",
  "authorization",
  "cookie",
  "password",
  "secret",
  "api_key",
  "apikey",
  "discord_bot_token",
  "auth_token",
];
const SENSITIVE_PATTERN = new RegExp(
  SENSITIVE_KEYS.join("|"),
  "i"
);

function redact(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(redact);
  if (typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (SENSITIVE_PATTERN.test(k)) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = redact(v);
      }
    }
    return out;
  }
  return obj;
}

/** Base context included in every log line */
const baseContext = {
  service: "discord-alert-bot",
  env: NODE_ENV,
};

/** Pino options compatible with Fastify's logger (configuration object only). */
export type LoggerOptions = pino.LoggerOptions;

/** Create logger options for Fastify. Fastify creates the logger from this; do not pass a pino instance. */
export function createLoggerOptions(): LoggerOptions {
  const options: LoggerOptions = {
    level: LOG_LEVEL,
    base: baseContext,
    serializers: {
      err: (err: unknown) => serializeErr(err),
      error: (err: unknown) => serializeErr(err),
    },
    formatters: {
      level: (label) => ({ level: label }),
      bindings: (bindings) => redact(bindings) as pino.Bindings,
    },
    redact: {
      paths: ["req.headers.authorization", "req.headers.cookie", "*.token", "*.password"],
      censor: "[REDACTED]",
    },
  };
  if (NODE_ENV !== "production") {
    options.transport = {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "SYS:standard",
        messageFormat: "{msg}",
        ignore: "pid,hostname,service,env",
      },
    };
  }
  return options;
}

/** Create a child logger with bound context (e.g. component, requestId, alertId). Use when you have a logger instance. */
export function childLogger(
  parent: pino.Logger,
  context: Record<string, unknown>
): pino.Logger {
  return parent.child(redact(context) as object);
}

export type AppLogger = pino.Logger;
