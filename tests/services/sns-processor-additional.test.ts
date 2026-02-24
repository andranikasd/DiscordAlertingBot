import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/services/config.js", () => ({
  getAlertsConfig: vi.fn(),
}));
vi.mock("../../src/services/processor.js", () => ({
  processOneAlertPayload: vi.fn(),
}));

import { snsEnvelopeToAlertPayload, deriveEventName, processSnsNotification } from "../../src/services/sns-processor.js";
import * as configModule from "../../src/services/config.js";
import * as processorModule from "../../src/services/processor.js";
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

beforeEach(() => {
  vi.mocked(configModule.getAlertsConfig).mockReturnValue({
    sns: { channelId: "ch-1" },
    CloudWatch_Alarm: { channelId: "ch-2" },
  });
  vi.clearAllMocks();
});

describe("resolved detection (parseResolvedState)", () => {
  it("detects CloudWatch OK state as resolved", () => {
    vi.mocked(configModule.getAlertsConfig).mockReturnValue({ sns: { channelId: "ch-1" } });
    const envelope = {
      Type: "Notification" as const,
      MessageId: "mid-1",
      Message: JSON.stringify({ NewStateValue: "OK", AlarmName: "MyAlarm" }),
      Subject: "sns",
      Timestamp: "2024-01-01T11:00:00Z",
    };
    const payload = snsEnvelopeToAlertPayload(envelope);
    expect(payload?.status).toBe("resolved");
    expect(payload?.resolvedAt).toBe("2024-01-01T11:00:00Z");
  });

  it("detects EventBridge CloudWatch OK state as resolved", () => {
    vi.mocked(configModule.getAlertsConfig).mockReturnValue({ sns: { channelId: "ch-1" } });
    const envelope = {
      Type: "Notification" as const,
      MessageId: "mid-2",
      Message: JSON.stringify({ "detail-type": "sns", detail: { state: { value: "OK" } } }),
      Timestamp: "2024-01-01T12:00:00Z",
    };
    const payload = snsEnvelopeToAlertPayload(envelope);
    expect(payload?.status).toBe("resolved");
    expect(payload?.resolvedAt).toBe("2024-01-01T12:00:00Z");
  });

  it("treats ALARM state as firing", () => {
    vi.mocked(configModule.getAlertsConfig).mockReturnValue({ sns: { channelId: "ch-1" } });
    const envelope = {
      Type: "Notification" as const,
      MessageId: "mid-3",
      Message: JSON.stringify({ NewStateValue: "ALARM" }),
      Subject: "sns",
    };
    const payload = snsEnvelopeToAlertPayload(envelope);
    expect(payload?.status).toBe("firing");
    expect(payload?.resolvedAt).toBeUndefined();
  });

  it("treats non-JSON message as firing", () => {
    vi.mocked(configModule.getAlertsConfig).mockReturnValue({ sns: { channelId: "ch-1" } });
    const envelope = { Type: "Notification" as const, MessageId: "mid-4", Message: "plain text", Subject: "sns" };
    const payload = snsEnvelopeToAlertPayload(envelope);
    expect(payload?.status).toBe("firing");
  });
});

describe("snsEnvelopeToAlertPayload additional paths", () => {
  it("parses severity from MessageAttributes", () => {
    const envelope = {
      Type: "Notification" as const,
      MessageId: "mid",
      Message: "{}",
      Subject: "sns",
      MessageAttributes: { severity: { Type: "String", Value: "critical" } },
    };
    const payload = snsEnvelopeToAlertPayload(envelope);
    expect(payload?.severity).toBe("critical");
  });

  it("parses severity from Message JSON", () => {
    const envelope = {
      Type: "Notification" as const,
      MessageId: "mid",
      Message: JSON.stringify({ severity: "high" }),
      Subject: "sns",
    };
    const payload = snsEnvelopeToAlertPayload(envelope);
    expect(payload?.severity).toBe("high");
  });

  it("extracts AlarmName as resource", () => {
    const envelope = {
      Type: "Notification" as const,
      MessageId: "mid",
      Message: JSON.stringify({ AlarmName: "MyAlarm" }),
      Subject: "sns",
    };
    const payload = snsEnvelopeToAlertPayload(envelope);
    expect(payload?.resource).toBe("MyAlarm");
  });

  it("extracts detail.resource as resource", () => {
    const envelope = {
      Type: "Notification" as const,
      MessageId: "mid",
      Message: JSON.stringify({ detail: { resource: "my-ec2-instance" } }),
      Subject: "sns",
    };
    const payload = snsEnvelopeToAlertPayload(envelope);
    expect(payload?.resource).toBe("my-ec2-instance");
  });

  it("extracts first ARN from detail.resources array", () => {
    const envelope = {
      Type: "Notification" as const,
      MessageId: "mid",
      Message: JSON.stringify({ detail: { resources: [{ ARN: "arn:aws:ec2::123" }] } }),
      Subject: "sns",
    };
    const payload = snsEnvelopeToAlertPayload(envelope);
    expect(payload?.resource).toBe("arn:aws:ec2::123");
  });

  it("uses default eventName title when no Subject", () => {
    const envelope = { Type: "Notification" as const, MessageId: "mid", Message: "{}" };
    const payload = snsEnvelopeToAlertPayload(envelope);
    expect(payload?.title).toBe("Alert: sns");
  });

  it("derives event name from rule_name attribute", () => {
    const envelope = {
      Type: "Notification" as const,
      MessageId: "a",
      Message: "{}",
      MessageAttributes: { rule_name: { Type: "String", Value: "My Rule" } },
    };
    vi.mocked(configModule.getAlertsConfig).mockReturnValue({ My_Rule: { channelId: "ch-1" } });
    expect(deriveEventName(envelope)).toBe("My_Rule");
  });

  it("derives event name from Message.eventName", () => {
    const envelope = { Type: "Notification" as const, MessageId: "a", Message: JSON.stringify({ eventName: "CustomEvent" }) };
    expect(deriveEventName(envelope)).toBe("CustomEvent");
  });

  it("derives event name from Message.source", () => {
    const envelope = { Type: "Notification" as const, MessageId: "a", Message: JSON.stringify({ source: "aws.ec2" }) };
    expect(deriveEventName(envelope)).toBe("aws.ec2");
  });

  it("returns null when Message is too long (truncated to 1500 chars)", () => {
    const longMessage = "x".repeat(2000);
    vi.mocked(configModule.getAlertsConfig).mockReturnValue({ sns: { channelId: "ch-1" } });
    const envelope = { Type: "Notification" as const, MessageId: "mid", Message: longMessage, Subject: "sns" };
    const payload = snsEnvelopeToAlertPayload(envelope);
    expect(payload?.description?.length).toBeLessThanOrEqual(1500);
  });
});

describe("processSnsNotification", () => {
  it("calls processOneAlertPayload when config exists", async () => {
    vi.mocked(processorModule.processOneAlertPayload).mockResolvedValue(undefined);
    const envelope = { Type: "Notification" as const, MessageId: "mid", Message: "body", Subject: "sns" };
    await processSnsNotification(envelope, mockLog);
    expect(processorModule.processOneAlertPayload).toHaveBeenCalled();
  });

  it("logs debug and skips when no config for event", async () => {
    vi.mocked(configModule.getAlertsConfig).mockReturnValue({});
    const envelope = { Type: "Notification" as const, MessageId: "mid", Message: "body", Subject: "UnknownEvent" };
    await processSnsNotification(envelope, mockLog);
    expect(processorModule.processOneAlertPayload).not.toHaveBeenCalled();
    expect(mockLog.debug).toHaveBeenCalled();
  });
});