import { describe, it, expect } from "vitest";
import { inc, metricsText } from "../src/metrics.js";

describe("metricsText", () => {
  it("returns a string ending with newline", () => {
    const text = metricsText();
    expect(typeof text).toBe("string");
    expect(text.endsWith("\n")).toBe(true);
  });

  it("contains # TYPE counter comment for each metric", () => {
    const text = metricsText();
    const typeLines = text.split("\n").filter((l) => l.startsWith("# TYPE"));
    expect(typeLines.length).toBeGreaterThan(0);
    for (const line of typeLines) {
      expect(line).toMatch(/# TYPE \w+ counter/);
    }
  });

  it("includes all expected counter names", () => {
    const text = metricsText();
    const expected = [
      "alerts_received_total",
      "alerts_sent_total",
      "dedup_suppressed_total",
      "no_config_suppressed_total",
      "discord_errors_total",
      "sqs_messages_processed_total",
      "discord_rate_limits_total",
    ];
    for (const name of expected) {
      expect(text).toContain(name);
    }
  });

  it("each counter line has a numeric value", () => {
    const text = metricsText();
    const valueLines = text.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
    for (const line of valueLines) {
      const parts = line.split(" ");
      expect(parts).toHaveLength(2);
      expect(Number.isNaN(Number(parts[1]))).toBe(false);
    }
  });
});

describe("inc", () => {
  it("increments the named counter by 1", () => {
    const before = extractCounter(metricsText(), "discord_errors_total");
    inc("discord_errors_total");
    const after = extractCounter(metricsText(), "discord_errors_total");
    expect(after).toBe(before + 1);
  });

  it("increments independently for different counters", () => {
    const b1 = extractCounter(metricsText(), "alerts_sent_total");
    const b2 = extractCounter(metricsText(), "discord_rate_limits_total");
    inc("alerts_sent_total");
    inc("alerts_sent_total");
    inc("discord_rate_limits_total");
    expect(extractCounter(metricsText(), "alerts_sent_total")).toBe(b1 + 2);
    expect(extractCounter(metricsText(), "discord_rate_limits_total")).toBe(b2 + 1);
  });
});

function extractCounter(text: string, name: string): number {
  const match = text.match(new RegExp(`^${name} (\\d+)$`, "m"));
  return Number(match?.[1] ?? 0);
}