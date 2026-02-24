const VALID_LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

/**
 * Validate required and format-sensitive environment variables at startup.
 * Throws with a descriptive message listing all failures if any are invalid.
 */
export function validateEnv(): void {
  const errors: string[] = [];

  if (!process.env.DISCORD_BOT_TOKEN?.trim()) {
    errors.push("DISCORD_BOT_TOKEN is required");
  }

  if (process.env.REDIS_URL && !/^rediss?:\/\//.test(process.env.REDIS_URL)) {
    errors.push("REDIS_URL must start with redis:// or rediss://");
  }

  if (process.env.DATABASE_URL && !/^postgres(ql)?:\/\//.test(process.env.DATABASE_URL)) {
    errors.push("DATABASE_URL must start with postgres:// or postgresql://");
  }

  if (process.env.SQS_ALERT_QUEUE_URL && !/^https:\/\//.test(process.env.SQS_ALERT_QUEUE_URL)) {
    errors.push("SQS_ALERT_QUEUE_URL must start with https://");
  }

  const rawPort = process.env.PORT;
  if (rawPort !== undefined) {
    const port = Number(rawPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      errors.push(`PORT must be an integer between 1 and 65535 (got "${rawPort}")`);
    }
  }

  const logLevel = process.env.LOG_LEVEL;
  if (logLevel && !VALID_LOG_LEVELS.includes(logLevel as (typeof VALID_LOG_LEVELS)[number])) {
    errors.push(`LOG_LEVEL must be one of: ${VALID_LOG_LEVELS.join(", ")} (got "${logLevel}")`);
  }

  if (errors.length > 0) {
    throw new Error(`Environment validation failed:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
  }
}