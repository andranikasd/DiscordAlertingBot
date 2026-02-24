import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@aws-sdk/client-sqs", () => {
  const send = vi.fn();
  return {
    SQSClient: vi.fn(() => ({ send })),
    ReceiveMessageCommand: vi.fn(),
    DeleteMessageCommand: vi.fn(),
    __send: send,
  };
});

vi.mock("../../src/types/sns.js", () => ({
  parseSqsSnsBody: vi.fn(),
}));

vi.mock("../../src/services/sns-processor.js", () => ({
  processSnsNotification: vi.fn(),
}));

vi.mock("../../src/metrics.js", () => ({
  inc: vi.fn(),
}));

import { startSqsPoller, isSqsPollerEnabled } from "../../src/services/sqs-poller.js";
import * as snsTypes from "../../src/types/sns.js";
import * as snsProcessor from "../../src/services/sns-processor.js";
import * as awsSqs from "@aws-sdk/client-sqs";
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

let savedQueueUrl: string | undefined;
let savedSnsQueueUrl: string | undefined;

beforeEach(() => {
  savedQueueUrl = process.env.SQS_ALERT_QUEUE_URL;
  savedSnsQueueUrl = process.env.SNS_QUEUE_URL;
  delete process.env.SQS_ALERT_QUEUE_URL;
  delete process.env.SNS_QUEUE_URL;
  vi.clearAllMocks();
});

afterEach(() => {
  if (savedQueueUrl === undefined) delete process.env.SQS_ALERT_QUEUE_URL;
  else process.env.SQS_ALERT_QUEUE_URL = savedQueueUrl;
  if (savedSnsQueueUrl === undefined) delete process.env.SNS_QUEUE_URL;
  else process.env.SNS_QUEUE_URL = savedSnsQueueUrl;
});

describe("isSqsPollerEnabled", () => {
  it("returns false when no queue URL is set", () => {
    expect(isSqsPollerEnabled()).toBe(false);
  });

  it("returns true when SQS_ALERT_QUEUE_URL is set", () => {
    process.env.SQS_ALERT_QUEUE_URL = "https://sqs.eu-west-1.amazonaws.com/123/queue";
    expect(isSqsPollerEnabled()).toBe(true);
  });

  it("returns true when SNS_QUEUE_URL is set (legacy)", () => {
    process.env.SNS_QUEUE_URL = "https://sqs.eu-west-1.amazonaws.com/123/queue";
    expect(isSqsPollerEnabled()).toBe(true);
  });
});

describe("startSqsPoller", () => {
  it("logs disabled and returns when no queue URL", () => {
    startSqsPoller(mockLog);
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "disabled" }),
      expect.any(String)
    );
  });

  it("logs started when queue URL is configured", () => {
    process.env.SQS_ALERT_QUEUE_URL = "https://sqs.eu-west-1.amazonaws.com/123/test-queue";

    // Mock the SQS send to return no messages immediately to stop the loop
    const sqsSend = (awsSqs as unknown as { __send: ReturnType<typeof vi.fn> }).__send;
    sqsSend.mockResolvedValue({ Messages: [] });

    startSqsPoller(mockLog);
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "started" }),
      expect.any(String)
    );
  });

  it("parses region from SQS URL", () => {
    process.env.SQS_ALERT_QUEUE_URL = "https://sqs.ap-southeast-2.amazonaws.com/123/my-queue";
    const sqsSend = (awsSqs as unknown as { __send: ReturnType<typeof vi.fn> }).__send;
    sqsSend.mockResolvedValue({ Messages: [] });

    startSqsPoller(mockLog);
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.objectContaining({ region: "ap-southeast-2" }),
      expect.any(String)
    );
  });

  it("uses SQS_ALERT_QUEUE_REGION env when set", () => {
    process.env.SQS_ALERT_QUEUE_URL = "https://sqs.us-east-1.amazonaws.com/123/queue";
    process.env.SQS_ALERT_QUEUE_REGION = "eu-central-1";
    const sqsSend = (awsSqs as unknown as { __send: ReturnType<typeof vi.fn> }).__send;
    sqsSend.mockResolvedValue({ Messages: [] });

    startSqsPoller(mockLog);
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.objectContaining({ region: "eu-central-1" }),
      expect.any(String)
    );
    delete process.env.SQS_ALERT_QUEUE_REGION;
  });
});
