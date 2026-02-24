import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import type { AlertApiPayload } from "../../src/types/alert.js";

vi.mock("../../src/services/config.js", () => ({
  getAlertsConfig: vi.fn(),
}));
vi.mock("../../src/store/dedup.js", () => ({
  isDuplicate: vi.fn(),
}));
vi.mock("../../src/store/redis.js", () => ({
  getStoredAlert: vi.fn(),
  deleteStoredAlert: vi.fn(),
}));
vi.mock("../../src/discord/client.js", () => ({
  sendOrUpdateAlert: vi.fn(),
}));
vi.mock("../../src/store/postgres.js", () => ({
  insertAlertEvent: vi.fn(),
}));

import { processOneAlertPayload } from "../../src/services/processor.js";
import * as configModule from "../../src/services/config.js";
import * as dedupModule from "../../src/store/dedup.js";
import * as redisModule from "../../src/store/redis.js";
import * as discordClient from "../../src/discord/client.js";
import * as postgresModule from "../../src/store/postgres.js";

const mockLog = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
  child: vi.fn(),
} as unknown as FastifyBaseLogger;

const basePayload: AlertApiPayload = {
  alertId: "fp1",
  resource: "db-prod-1",
  title: "Alert: HighCPU",
  description: "CPU high",
  status: "firing",
  severity: "critical",
  startedAt: new Date().toISOString(),
  channelId: "chan1",
  ruleName: "HighCPU",
  source: "grafana",
};

beforeEach(() => {
  vi.mocked(configModule.getAlertsConfig).mockReturnValue({
    HighCPU: { channelId: "chan1", suppressWindowMs: 300000 },
  });
  vi.mocked(dedupModule.isDuplicate).mockResolvedValue(false);
  vi.mocked(redisModule.getStoredAlert).mockResolvedValue(null);
  vi.mocked(redisModule.deleteStoredAlert).mockResolvedValue(undefined);
  vi.mocked(discordClient.sendOrUpdateAlert).mockResolvedValue("msg-1");
  vi.mocked(postgresModule.insertAlertEvent).mockResolvedValue(undefined);
  delete process.env.DATABASE_URL;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("processOneAlertPayload", () => {
  it("suppresses alert when no config entry exists for ruleName", async () => {
    vi.mocked(configModule.getAlertsConfig).mockReturnValue({});
    await processOneAlertPayload(basePayload, mockLog);
    expect(dedupModule.isDuplicate).not.toHaveBeenCalled();
    expect(discordClient.sendOrUpdateAlert).not.toHaveBeenCalled();
  });

  it("suppresses alert when dedup reports duplicate", async () => {
    vi.mocked(dedupModule.isDuplicate).mockResolvedValue(true);
    await processOneAlertPayload(basePayload, mockLog);
    expect(discordClient.sendOrUpdateAlert).not.toHaveBeenCalled();
  });

  it("sends alert when no stored state (new incident)", async () => {
    await processOneAlertPayload(basePayload, mockLog);
    expect(discordClient.sendOrUpdateAlert).toHaveBeenCalledWith(basePayload, mockLog);
  });

  it("deletes stored alert and creates new when resolved more than 30 minutes ago", async () => {
    const resolvedAt = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    vi.mocked(redisModule.getStoredAlert).mockResolvedValue({
      messageId: "old-msg",
      channelId: "chan1",
      state: "resolved",
      resolvedAt,
      updatedAt: resolvedAt,
    });
    await processOneAlertPayload(basePayload, mockLog);
    expect(redisModule.deleteStoredAlert).toHaveBeenCalledWith(basePayload.alertId, basePayload.resource);
    expect(discordClient.sendOrUpdateAlert).toHaveBeenCalled();
  });

  it("does not delete stored alert when resolved within 30 minutes (reuses thread)", async () => {
    const resolvedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    vi.mocked(redisModule.getStoredAlert).mockResolvedValue({
      messageId: "old-msg",
      channelId: "chan1",
      state: "resolved",
      resolvedAt,
      updatedAt: resolvedAt,
    });
    await processOneAlertPayload(basePayload, mockLog);
    expect(redisModule.deleteStoredAlert).not.toHaveBeenCalled();
    expect(discordClient.sendOrUpdateAlert).toHaveBeenCalled();
  });

  it("deletes stored alert and creates new incident when acknowledged more than 1.5 hours ago", async () => {
    const acknowledgedAt = new Date(Date.now() - 91 * 60 * 1000).toISOString();
    vi.mocked(redisModule.getStoredAlert).mockResolvedValue({
      messageId: "old-msg",
      channelId: "chan1",
      state: "acknowledged",
      acknowledgedAt,
      updatedAt: acknowledgedAt,
    });
    await processOneAlertPayload(basePayload, mockLog);
    expect(redisModule.deleteStoredAlert).toHaveBeenCalledWith(basePayload.alertId, basePayload.resource);
    expect(discordClient.sendOrUpdateAlert).toHaveBeenCalled();
  });

  it("does not delete stored alert when acknowledged within 1.5 hours (repeats in thread)", async () => {
    const acknowledgedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    vi.mocked(redisModule.getStoredAlert).mockResolvedValue({
      messageId: "old-msg",
      channelId: "chan1",
      state: "acknowledged",
      acknowledgedAt,
      updatedAt: acknowledgedAt,
    });
    await processOneAlertPayload(basePayload, mockLog);
    expect(redisModule.deleteStoredAlert).not.toHaveBeenCalled();
    expect(discordClient.sendOrUpdateAlert).toHaveBeenCalled();
  });

  it("calls insertAlertEvent when DATABASE_URL is set", async () => {
    process.env.DATABASE_URL = "postgres://localhost/test";
    await processOneAlertPayload(basePayload, mockLog);
    expect(postgresModule.insertAlertEvent).toHaveBeenCalledWith(basePayload, "msg-1");
  });

  it("does not call insertAlertEvent when DATABASE_URL is not set", async () => {
    await processOneAlertPayload(basePayload, mockLog);
    expect(postgresModule.insertAlertEvent).not.toHaveBeenCalled();
  });

  it("logs error and does not throw when sendOrUpdateAlert fails", async () => {
    vi.mocked(discordClient.sendOrUpdateAlert).mockRejectedValue(new Error("discord error"));
    await expect(processOneAlertPayload(basePayload, mockLog)).resolves.toBeUndefined();
    expect(mockLog.error).toHaveBeenCalled();
  });

  it("uses 'default' ruleName fallback when ruleName is absent from payload", async () => {
    vi.mocked(configModule.getAlertsConfig).mockReturnValue({
      default: { channelId: "chan-default", suppressWindowMs: 300000 },
    });
    const payload: AlertApiPayload = { ...basePayload, ruleName: undefined };
    await processOneAlertPayload(payload, mockLog);
    expect(discordClient.sendOrUpdateAlert).toHaveBeenCalled();
  });

  it("sets source=grafana on payloads built by the Grafana processor", async () => {
    await processOneAlertPayload({ ...basePayload, source: "grafana" }, mockLog);
    expect(discordClient.sendOrUpdateAlert).toHaveBeenCalledWith(
      expect.objectContaining({ source: "grafana" }),
      mockLog
    );
  });
});