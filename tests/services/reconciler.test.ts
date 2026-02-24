import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/store/redis.js", () => ({
  getStoredAlertKeys: vi.fn(),
  getStoredAlert: vi.fn(),
  setStoredAlert: vi.fn(),
  deleteStoredAlert: vi.fn(),
}));

import { startStateReconciliation } from "../../src/services/reconciler.js";
import * as redis from "../../src/store/redis.js";
import type { Client } from "discord.js";
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

function makeClient(channelImpl?: unknown, messageImpl?: unknown): Client {
  const message = { id: "msg-1" };
  const fetchMessage = messageImpl ?? vi.fn().mockResolvedValue(message);
  const channel = channelImpl ?? {
    isTextBased: () => true,
    isDMBased: () => false,
    messages: { fetch: fetchMessage },
  };
  return {
    isReady: () => true,
    channels: { fetch: vi.fn().mockResolvedValue(channel) },
  } as unknown as Client;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

// Restore real timers after each test to avoid leaks
afterEach(() => {
  vi.useRealTimers();
});

const baseStored = {
  messageId: "msg-1",
  channelId: "ch-1",
  state: "firing" as const,
  updatedAt: "2024-01-01T00:00:00Z",
  ruleName: "HighCPU",
  severity: "critical",
};

describe("startStateReconciliation", () => {
  it("deletes orphaned state when channel is gone", async () => {
    vi.mocked(redis.getStoredAlertKeys).mockResolvedValue(["alert:fp1:default"]);
    vi.mocked(redis.getStoredAlert).mockResolvedValue(baseStored);
    vi.mocked(redis.deleteStoredAlert).mockResolvedValue(undefined);

    const nullChannel = null;
    const client = { isReady: () => true, channels: { fetch: vi.fn().mockResolvedValue(nullChannel) } } as unknown as Client;

    startStateReconciliation(client, mockLog);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);

    expect(redis.deleteStoredAlert).toHaveBeenCalledWith("fp1", undefined);
  });

  it("deletes orphaned state when message returns 10008 (Unknown Message)", async () => {
    vi.mocked(redis.getStoredAlertKeys).mockResolvedValue(["alert:fp1:default"]);
    vi.mocked(redis.getStoredAlert).mockResolvedValue(baseStored);
    vi.mocked(redis.deleteStoredAlert).mockResolvedValue(undefined);

    const err = Object.assign(new Error("Unknown Message"), { code: 10008 });
    const client = makeClient(undefined, vi.fn().mockRejectedValue(err));

    startStateReconciliation(client, mockLog);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);

    expect(redis.deleteStoredAlert).toHaveBeenCalledWith("fp1", undefined);
  });

  it("deletes orphaned state when message returns 10003 (Unknown Channel)", async () => {
    vi.mocked(redis.getStoredAlertKeys).mockResolvedValue(["alert:fp1:default"]);
    vi.mocked(redis.getStoredAlert).mockResolvedValue(baseStored);
    vi.mocked(redis.deleteStoredAlert).mockResolvedValue(undefined);

    const err = Object.assign(new Error("Unknown Channel"), { code: 10003 });
    const client = makeClient(undefined, vi.fn().mockRejectedValue(err));

    startStateReconciliation(client, mockLog);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);

    expect(redis.deleteStoredAlert).toHaveBeenCalledWith("fp1", undefined);
  });

  it("does not delete state for non-gone error codes", async () => {
    vi.mocked(redis.getStoredAlertKeys).mockResolvedValue(["alert:fp1:default"]);
    vi.mocked(redis.getStoredAlert).mockResolvedValue(baseStored);
    vi.mocked(redis.deleteStoredAlert).mockResolvedValue(undefined);
    vi.mocked(redis.setStoredAlert).mockResolvedValue(undefined);

    const err = Object.assign(new Error("Rate limited"), { code: 429 });
    const client = makeClient(undefined, vi.fn().mockRejectedValue(err));

    startStateReconciliation(client, mockLog);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);

    expect(redis.deleteStoredAlert).not.toHaveBeenCalled();
  });

  it("skips resolved alerts", async () => {
    vi.mocked(redis.getStoredAlertKeys).mockResolvedValue(["alert:fp1:default"]);
    vi.mocked(redis.getStoredAlert).mockResolvedValue({ ...baseStored, state: "resolved" });

    startStateReconciliation(makeClient(), mockLog);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);

    expect(redis.deleteStoredAlert).not.toHaveBeenCalled();
  });

  it("skips null stored state", async () => {
    vi.mocked(redis.getStoredAlertKeys).mockResolvedValue(["alert:fp1:default"]);
    vi.mocked(redis.getStoredAlert).mockResolvedValue(null);

    startStateReconciliation(makeClient(), mockLog);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);

    expect(redis.deleteStoredAlert).not.toHaveBeenCalled();
  });

  it("skips malformed keys (less than 3 parts)", async () => {
    vi.mocked(redis.getStoredAlertKeys).mockResolvedValue(["alert:fp1"]);
    vi.mocked(redis.getStoredAlert).mockResolvedValue(baseStored);

    startStateReconciliation(makeClient(), mockLog);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);

    expect(redis.getStoredAlert).not.toHaveBeenCalled();
  });

  it("clears stale threadId when thread no longer accessible", async () => {
    vi.mocked(redis.getStoredAlertKeys).mockResolvedValue(["alert:fp1:default"]);
    vi.mocked(redis.getStoredAlert).mockResolvedValue({ ...baseStored, threadId: "thread-999" });
    vi.mocked(redis.setStoredAlert).mockResolvedValue(undefined);

    let callCount = 0;
    const client = {
      isReady: () => true,
      channels: {
        fetch: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) {
            // Channel fetch succeeds
            return Promise.resolve({
              isTextBased: () => true,
              isDMBased: () => false,
              messages: { fetch: vi.fn().mockResolvedValue({ id: "msg-1" }) },
            });
          }
          // Thread fetch fails
          return Promise.reject(new Error("not found"));
        }),
      },
    } as unknown as Client;

    startStateReconciliation(client, mockLog);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);

    expect(redis.setStoredAlert).toHaveBeenCalledWith("fp1", undefined, expect.objectContaining({ threadId: undefined }));
  });

  it("does not run when client is not ready", async () => {
    vi.mocked(redis.getStoredAlertKeys).mockResolvedValue(["alert:fp1:default"]);

    const notReadyClient = { isReady: () => false } as unknown as Client;
    startStateReconciliation(notReadyClient, mockLog);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);

    expect(redis.getStoredAlertKeys).not.toHaveBeenCalled();
  });

  it("handles errors from getStoredAlertKeys gracefully", async () => {
    vi.mocked(redis.getStoredAlertKeys).mockRejectedValue(new Error("redis error"));

    startStateReconciliation(makeClient(), mockLog);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);

    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "loop_error" }),
      expect.any(String)
    );
  });

  it("uses named resource for keys with resource segment", async () => {
    vi.mocked(redis.getStoredAlertKeys).mockResolvedValue(["alert:fp1:my-resource"]);
    vi.mocked(redis.getStoredAlert).mockResolvedValue(baseStored);
    vi.mocked(redis.deleteStoredAlert).mockResolvedValue(undefined);

    const client = { isReady: () => true, channels: { fetch: vi.fn().mockResolvedValue(null) } } as unknown as Client;

    startStateReconciliation(client, mockLog);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);

    expect(redis.getStoredAlert).toHaveBeenCalledWith("fp1", "my-resource");
  });
});
