import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { validateEnv } from "../src/env.js";

const KEYS = ["DISCORD_BOT_TOKEN", "REDIS_URL", "DATABASE_URL", "SQS_ALERT_QUEUE_URL", "PORT", "LOG_LEVEL"] as const;
type EnvKey = (typeof KEYS)[number];

let saved: Partial<Record<EnvKey, string | undefined>> = {};

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  // Minimal valid state: only required var set, all optional cleared
  process.env.DISCORD_BOT_TOKEN = "test-token";
  for (const k of KEYS.slice(1)) delete process.env[k];
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("validateEnv", () => {
  it("passes with only DISCORD_BOT_TOKEN set", () => {
    expect(() => validateEnv()).not.toThrow();
  });

  it("throws when DISCORD_BOT_TOKEN is absent", () => {
    delete process.env.DISCORD_BOT_TOKEN;
    expect(() => validateEnv()).toThrow(/DISCORD_BOT_TOKEN is required/);
  });

  it("throws when DISCORD_BOT_TOKEN is blank", () => {
    process.env.DISCORD_BOT_TOKEN = "   ";
    expect(() => validateEnv()).toThrow(/DISCORD_BOT_TOKEN is required/);
  });

  it("throws for REDIS_URL with http:// scheme", () => {
    process.env.REDIS_URL = "http://localhost:6379";
    expect(() => validateEnv()).toThrow(/REDIS_URL/);
  });

  it("passes for redis:// scheme", () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    expect(() => validateEnv()).not.toThrow();
  });

  it("passes for rediss:// scheme", () => {
    process.env.REDIS_URL = "rediss://localhost:6380";
    expect(() => validateEnv()).not.toThrow();
  });

  it("throws for DATABASE_URL with mysql:// scheme", () => {
    process.env.DATABASE_URL = "mysql://localhost/db";
    expect(() => validateEnv()).toThrow(/DATABASE_URL/);
  });

  it("passes for postgres:// scheme", () => {
    process.env.DATABASE_URL = "postgres://localhost/db";
    expect(() => validateEnv()).not.toThrow();
  });

  it("passes for postgresql:// scheme", () => {
    process.env.DATABASE_URL = "postgresql://localhost/db";
    expect(() => validateEnv()).not.toThrow();
  });

  it("throws for SQS_ALERT_QUEUE_URL with http:// scheme", () => {
    process.env.SQS_ALERT_QUEUE_URL = "http://sqs.example.com/queue";
    expect(() => validateEnv()).toThrow(/SQS_ALERT_QUEUE_URL/);
  });

  it("passes for https:// SQS URL", () => {
    process.env.SQS_ALERT_QUEUE_URL = "https://sqs.eu-west-1.amazonaws.com/123/queue";
    expect(() => validateEnv()).not.toThrow();
  });

  it("throws when PORT is not a number", () => {
    process.env.PORT = "abc";
    expect(() => validateEnv()).toThrow(/PORT/);
  });

  it("throws when PORT is 0", () => {
    process.env.PORT = "0";
    expect(() => validateEnv()).toThrow(/PORT/);
  });

  it("throws when PORT exceeds 65535", () => {
    process.env.PORT = "65536";
    expect(() => validateEnv()).toThrow(/PORT/);
  });

  it("passes for valid PORT", () => {
    process.env.PORT = "4000";
    expect(() => validateEnv()).not.toThrow();
  });

  it("throws for invalid LOG_LEVEL", () => {
    process.env.LOG_LEVEL = "verbose";
    expect(() => validateEnv()).toThrow(/LOG_LEVEL/);
  });

  it("passes for each valid LOG_LEVEL", () => {
    for (const level of ["fatal", "error", "warn", "info", "debug", "trace", "silent"]) {
      process.env.LOG_LEVEL = level;
      expect(() => validateEnv()).not.toThrow();
    }
  });

  it("collects multiple errors into one message", () => {
    delete process.env.DISCORD_BOT_TOKEN;
    process.env.REDIS_URL = "http://bad";
    let err: Error | null = null;
    try { validateEnv(); } catch (e) { err = e as Error; }
    expect(err?.message).toMatch(/DISCORD_BOT_TOKEN/);
    expect(err?.message).toMatch(/REDIS_URL/);
  });
});