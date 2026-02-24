import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/services/config.js", () => ({
  getAlertsConfig: vi.fn(),
}));
vi.mock("../../src/store/dedup.js", () => ({
  isDuplicate: vi.fn(),
  clearDedup: vi.fn(),
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
vi.mock("../../src/metrics.js", () => ({
  inc: vi.fn(),
}));

import { processAlerts } from "../../src/services/processor.js";
import * as configModule from "../../src/services/config.js";
import * as dedupModule from "../../src/store/dedup.js";
import * as redisModule from "../../src/store/redis.js";
import * as discordClient from "../../src/discord/client.js";
import type { FastifyBaseLogger } from "fastify";

const mockLog = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
  child: vi.fn(),
} as unknown as FastifyBaseLogger;

const validGrafanaPayload = {
  receiver: "discord",
  status: "firing",
  alerts: [
    {
      status: "firing",
      labels: { alertname: "HighCPU", severity: "critical", instance: "host-1" },
      annotations: { summary: "CPU is high", description: "CPU over 90%" },
      startsAt: "2024-01-01T10:00:00Z",
      endsAt: "0001-01-01T00:00:00Z",
      fingerprint: "abc123",
      generatorURL: "https://grafana.example.com/alert/1",
    },
  ],
  groupLabels: { alertname: "HighCPU" },
  commonLabels: { severity: "critical" },
  commonAnnotations: {},
};

beforeEach(() => {
  vi.mocked(configModule.getAlertsConfig).mockReturnValue({
    HighCPU: { channelId: "ch-1", suppressWindowMs: 300000 },
  });
  vi.mocked(dedupModule.isDuplicate).mockResolvedValue(false);
  vi.mocked(dedupModule.clearDedup).mockResolvedValue(undefined);
  vi.mocked(redisModule.getStoredAlert).mockResolvedValue(null);
  vi.mocked(redisModule.deleteStoredAlert).mockResolvedValue(undefined);
  vi.mocked(discordClient.sendOrUpdateAlert).mockResolvedValue("msg-1");
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("processAlerts (Grafana webhook)", () => {
  it("logs warning and returns for invalid payload", async () => {
    await processAlerts({ not_valid: true }, mockLog);
    expect(mockLog.warn).toHaveBeenCalled();
    expect(discordClient.sendOrUpdateAlert).not.toHaveBeenCalled();
  });

  it("processes a valid firing alert", async () => {
    await processAlerts(validGrafanaPayload, mockLog);
    expect(discordClient.sendOrUpdateAlert).toHaveBeenCalled();
  });

  it("skips alerts with no matching config", async () => {
    vi.mocked(configModule.getAlertsConfig).mockReturnValue({});
    await processAlerts(validGrafanaPayload, mockLog);
    expect(discordClient.sendOrUpdateAlert).not.toHaveBeenCalled();
  });

  it("handles payload with empty alerts array", async () => {
    await processAlerts({ ...validGrafanaPayload, alerts: [] }, mockLog);
    expect(discordClient.sendOrUpdateAlert).not.toHaveBeenCalled();
  });

  it("handles resolved alerts with meaningful endsAt", async () => {
    const resolved = {
      ...validGrafanaPayload,
      status: "resolved",
      alerts: [
        {
          ...validGrafanaPayload.alerts[0],
          status: "resolved",
          endsAt: "2024-01-01T11:00:00Z",
        },
      ],
    };
    await processAlerts(resolved, mockLog);
    expect(discordClient.sendOrUpdateAlert).toHaveBeenCalledWith(
      expect.objectContaining({ status: "resolved", resolvedAt: "2024-01-01T11:00:00Z" }),
      mockLog
    );
  });

  it("does not set resolvedAt for zero-value endsAt", async () => {
    const resolved = {
      ...validGrafanaPayload,
      alerts: [
        {
          ...validGrafanaPayload.alerts[0],
          status: "resolved",
          endsAt: "0001-01-01T00:00:00Z",
        },
      ],
    };
    await processAlerts(resolved, mockLog);
    expect(discordClient.sendOrUpdateAlert).toHaveBeenCalledWith(
      expect.objectContaining({ resolvedAt: undefined }),
      mockLog
    );
  });

  it("processes multiple alerts in one batch", async () => {
    vi.mocked(configModule.getAlertsConfig).mockReturnValue({
      HighCPU: { channelId: "ch-1" },
      LowMemory: { channelId: "ch-2" },
    });
    const payload = {
      ...validGrafanaPayload,
      alerts: [
        validGrafanaPayload.alerts[0],
        {
          status: "firing",
          labels: { alertname: "LowMemory", severity: "warning" },
          annotations: { summary: "Memory low" },
          startsAt: "2024-01-01T10:00:00Z",
          endsAt: "0001-01-01T00:00:00Z",
          fingerprint: "def456",
        },
      ],
    };
    await processAlerts(payload, mockLog);
    expect(discordClient.sendOrUpdateAlert).toHaveBeenCalledTimes(2);
  });

  it("generates fingerprint for alerts without one", async () => {
    const noFP = {
      ...validGrafanaPayload,
      alerts: [{ ...validGrafanaPayload.alerts[0], fingerprint: undefined }],
    };
    await processAlerts(noFP, mockLog);
    expect(discordClient.sendOrUpdateAlert).toHaveBeenCalled();
  });

  it("sets severity to 'info' when label is 'info'", async () => {
    const payload = {
      ...validGrafanaPayload,
      alerts: [{ ...validGrafanaPayload.alerts[0], labels: { alertname: "HighCPU", severity: "info" } }],
    };
    await processAlerts(payload, mockLog);
    expect(discordClient.sendOrUpdateAlert).toHaveBeenCalledWith(
      expect.objectContaining({ severity: "info" }),
      mockLog
    );
  });

  it("defaults severity to 'warning' for unknown label values", async () => {
    const payload = {
      ...validGrafanaPayload,
      alerts: [{ ...validGrafanaPayload.alerts[0], labels: { alertname: "HighCPU", severity: "catastrophic" } }],
    };
    await processAlerts(payload, mockLog);
    expect(discordClient.sendOrUpdateAlert).toHaveBeenCalledWith(
      expect.objectContaining({ severity: "warning" }),
      mockLog
    );
  });
});
