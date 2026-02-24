import { describe, it, expect } from "vitest";
import pino from "pino";
import { createLoggerOptions, childLogger } from "../src/logger.js";

describe("createLoggerOptions", () => {
  it("returns an object with a level property", () => {
    const opts = createLoggerOptions();
    expect(typeof opts.level).toBe("string");
  });

  it("includes err and error serializers", () => {
    const opts = createLoggerOptions();
    expect(typeof opts.serializers?.err).toBe("function");
    expect(typeof opts.serializers?.error).toBe("function");
  });

  it("err serializer converts Error to object with message and type", () => {
    const opts = createLoggerOptions();
    const err = new Error("something went wrong");
    const serialized = opts.serializers!.err!(err) as Record<string, unknown>;
    expect(serialized.message).toBe("something went wrong");
    expect(serialized.type).toBe("Error");
    expect(typeof serialized.stack).toBe("string");
  });

  it("err serializer includes code when present", () => {
    const opts = createLoggerOptions();
    const err = Object.assign(new Error("fs error"), { code: "ENOENT" });
    const serialized = opts.serializers!.err!(err) as Record<string, unknown>;
    expect(serialized.code).toBe("ENOENT");
  });

  it("err serializer handles plain object", () => {
    const opts = createLoggerOptions();
    const serialized = opts.serializers!.err!({ raw: "data" }) as Record<string, unknown>;
    expect(serialized.type).toBe("Object");
    expect(serialized.raw).toEqual({ raw: "data" });
  });

  it("err serializer handles primitive string", () => {
    const opts = createLoggerOptions();
    const serialized = opts.serializers!.err!("plain string") as Record<string, unknown>;
    expect(serialized.type).toBe("string");
  });

  it("err serializer handles number", () => {
    const opts = createLoggerOptions();
    const serialized = opts.serializers!.err!(42) as Record<string, unknown>;
    expect(serialized.type).toBe("number");
  });

  it("level formatter returns { level: label }", () => {
    const opts = createLoggerOptions();
    const result = opts.formatters!.level!("warn", 40) as { level: string };
    expect(result).toEqual({ level: "warn" });
  });

  it("bindings formatter redacts token field", () => {
    const opts = createLoggerOptions();
    const result = opts.formatters!.bindings!({ token: "secret-value", pid: 123 }) as Record<string, unknown>;
    expect(result.token).toBe("[REDACTED]");
    expect(result.pid).toBe(123);
  });

  it("bindings formatter redacts password field", () => {
    const opts = createLoggerOptions();
    const result = opts.formatters!.bindings!({ password: "hunter2", user: "admin" }) as Record<string, unknown>;
    expect(result.password).toBe("[REDACTED]");
    expect(result.user).toBe("admin");
  });

  it("bindings formatter redacts authorization field", () => {
    const opts = createLoggerOptions();
    const result = opts.formatters!.bindings!({ authorization: "Bearer xyz" }) as Record<string, unknown>;
    expect(result.authorization).toBe("[REDACTED]");
  });

  it("bindings formatter redacts nested sensitive keys", () => {
    const opts = createLoggerOptions();
    const result = opts.formatters!.bindings!({ nested: { token: "secret", safe: "value" } }) as Record<string, unknown>;
    const nested = result.nested as Record<string, unknown>;
    expect(nested.token).toBe("[REDACTED]");
    expect(nested.safe).toBe("value");
  });

  it("bindings formatter handles arrays", () => {
    const opts = createLoggerOptions();
    const result = opts.formatters!.bindings!({ items: [1, 2, 3] }) as Record<string, unknown>;
    expect(result.items).toEqual([1, 2, 3]);
  });

  it("bindings formatter handles null values", () => {
    const opts = createLoggerOptions();
    const result = opts.formatters!.bindings!({ value: null }) as Record<string, unknown>;
    expect(result.value).toBeNull();
  });

  it("includes redact config with censor", () => {
    const opts = createLoggerOptions();
    expect(opts.redact).toBeDefined();
    if (typeof opts.redact === "object" && opts.redact !== null) {
      expect((opts.redact as { censor: string }).censor).toBe("[REDACTED]");
    }
  });
});

describe("childLogger", () => {
  it("returns a logger with standard log methods", () => {
    const parent = pino({ level: "silent" });
    const child = childLogger(parent, { component: "test" });
    expect(typeof child.info).toBe("function");
    expect(typeof child.warn).toBe("function");
    expect(typeof child.error).toBe("function");
  });

  it("does not throw when context has sensitive keys (they are redacted)", () => {
    const parent = pino({ level: "silent" });
    expect(() => childLogger(parent, { token: "secret", component: "test" })).not.toThrow();
  });

  it("handles empty context object", () => {
    const parent = pino({ level: "silent" });
    expect(() => childLogger(parent, {})).not.toThrow();
  });
});