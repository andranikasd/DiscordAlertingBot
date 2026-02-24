import { describe, it, expect, beforeEach, vi } from "vitest";
import { deriveEventName, snsEnvelopeToAlertPayload } from "../../src/services/sns-processor.js";
import * as config from "../../src/services/config.js";

vi.mock("../../src/services/config.js", () => ({
  getAlertsConfig: vi.fn(),
}));

describe("sns-processor", () => {
  beforeEach(() => {
    vi.mocked(config.getAlertsConfig).mockReturnValue({
      sns: { channelId: "123", suppressWindowMs: 300000 },
      CloudWatch_Alarm: { channelId: "456" },
      "AWS_Health_Event": { channelId: "789" },
    });
  });

  describe("deriveEventName", () => {
    it("uses Subject when present", () => {
      const envelope = { Type: "Notification" as const, MessageId: "a", Message: "{}", Subject: "AWS Health Event" };
      expect(deriveEventName(envelope)).toBe("AWS_Health_Event");
    });

    it("uses MessageAttributes.event_type when Subject missing", () => {
      const envelope = {
        Type: "Notification" as const,
        MessageId: "a",
        Message: "{}",
        MessageAttributes: { event_type: { Type: "String", Value: "CloudWatch-Alarm" } },
      };
      expect(deriveEventName(envelope)).toBe("CloudWatch-Alarm");
    });

    it("uses parsed Message detail-type when JSON", () => {
      const envelope = { Type: "Notification" as const, MessageId: "a", Message: JSON.stringify({ "detail-type": "EC2 State Change" }) };
      expect(deriveEventName(envelope)).toBe("EC2_State_Change");
    });

    it("returns default when nothing matches", () => {
      const envelope = { Type: "Notification" as const, MessageId: "a", Message: "plain text" };
      expect(deriveEventName(envelope)).toBe("sns");
    });
  });

  describe("snsEnvelopeToAlertPayload", () => {
    it("returns null when no config for event name", () => {
      vi.mocked(config.getAlertsConfig).mockReturnValue({});
      const envelope = { Type: "Notification" as const, MessageId: "mid", Message: "body", Subject: "UnknownEvent" };
      expect(snsEnvelopeToAlertPayload(envelope)).toBeNull();
    });

    it("builds payload with channelId and ruleName from config", () => {
      const envelope = { Type: "Notification" as const, MessageId: "mid", Message: "alert body", Subject: "sns", Timestamp: "2026-02-11T12:00:00Z" };
      const payload = snsEnvelopeToAlertPayload(envelope);
      expect(payload).not.toBeNull();
      expect(payload?.channelId).toBe("123");
      expect(payload?.ruleName).toBe("sns");
      expect(payload?.alertId).toBe("mid");
      expect(payload?.description).toBe("alert body");
      expect(payload?.status).toBe("firing");
      expect(payload?.severity).toBe("warning");
    });

    it("uses Subject for title when present", () => {
      vi.mocked(config.getAlertsConfig).mockReturnValue({ Critical_Issue: { channelId: "999" } });
      const envelope = { Type: "Notification" as const, MessageId: "m", Message: "desc", Subject: "Critical Issue" };
      const payload = snsEnvelopeToAlertPayload(envelope);
      expect(payload?.title).toBe("Alert: Critical Issue");
      expect(payload?.ruleName).toBe("Critical_Issue");
      expect(payload?.channelId).toBe("999");
    });

    it("sets source=sns on all SNS payloads", () => {
      const envelope = { Type: "Notification" as const, MessageId: "mid", Message: "body", Subject: "sns" };
      const payload = snsEnvelopeToAlertPayload(envelope);
      expect(payload?.source).toBe("sns");
    });
  });
});