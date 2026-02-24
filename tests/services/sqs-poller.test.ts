import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { isSqsPollerEnabled } from "../../src/services/sqs-poller.js";

vi.mock("../../src/services/sns-processor.js", () => ({
  processSnsNotification: vi.fn(),
}));
vi.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: vi.fn(),
  ReceiveMessageCommand: vi.fn(),
  DeleteMessageCommand: vi.fn(),
}));

const QUEUE_URL = "https://sqs.eu-west-1.amazonaws.com/123456789012/alert-queue";

beforeEach(() => {
  delete process.env.SQS_ALERT_QUEUE_URL;
  delete process.env.SNS_QUEUE_URL;
  delete process.env.SQS_ALERT_QUEUE_REGION;
  delete process.env.AWS_REGION;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("isSqsPollerEnabled", () => {
  it("returns false when SQS_ALERT_QUEUE_URL is not set", () => {
    expect(isSqsPollerEnabled()).toBe(false);
  });

  it("returns true when SQS_ALERT_QUEUE_URL is set", () => {
    process.env.SQS_ALERT_QUEUE_URL = QUEUE_URL;
    expect(isSqsPollerEnabled()).toBe(true);
  });

  it("returns true when SNS_QUEUE_URL is set (legacy alias)", () => {
    process.env.SNS_QUEUE_URL = QUEUE_URL;
    expect(isSqsPollerEnabled()).toBe(true);
  });

  it("returns false when env var is set to empty string", () => {
    process.env.SQS_ALERT_QUEUE_URL = "   ";
    expect(isSqsPollerEnabled()).toBe(false);
  });
});