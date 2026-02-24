import { describe, it, expect } from "vitest";
import { parseSqsSnsBody } from "../../src/types/sns.js";

const validEnvelope = {
  Type: "Notification",
  MessageId: "msg-123",
  Message: "hello",
};

describe("parseSqsSnsBody", () => {
  it("parses a valid JSON string envelope", () => {
    const result = parseSqsSnsBody(JSON.stringify(validEnvelope));
    expect(result).not.toBeNull();
    expect(result?.MessageId).toBe("msg-123");
    expect(result?.Message).toBe("hello");
  });

  it("parses an already-parsed object", () => {
    const result = parseSqsSnsBody(validEnvelope);
    expect(result?.MessageId).toBe("msg-123");
  });

  it("returns null for invalid JSON string", () => {
    expect(parseSqsSnsBody("not-json")).toBeNull();
  });

  it("returns null when Type is not Notification", () => {
    const result = parseSqsSnsBody({ ...validEnvelope, Type: "SubscriptionConfirmation" });
    expect(result).toBeNull();
  });

  it("returns null when MessageId is missing", () => {
    const { MessageId: _, ...rest } = validEnvelope;
    expect(parseSqsSnsBody(rest)).toBeNull();
  });

  it("returns null when Message is missing", () => {
    const { Message: _, ...rest } = validEnvelope;
    expect(parseSqsSnsBody(rest)).toBeNull();
  });

  it("returns null for null input", () => {
    expect(parseSqsSnsBody(null)).toBeNull();
  });

  it("returns null for a number", () => {
    expect(parseSqsSnsBody(42)).toBeNull();
  });

  it("includes optional fields when present", () => {
    const result = parseSqsSnsBody({
      ...validEnvelope,
      Subject: "Test subject",
      TopicArn: "arn:aws:sns:eu-west-1:123:topic",
      Timestamp: "2024-01-01T00:00:00Z",
      MessageAttributes: { severity: { Type: "String", Value: "critical" } },
    });
    expect(result?.Subject).toBe("Test subject");
    expect(result?.MessageAttributes?.severity?.Value).toBe("critical");
  });
});