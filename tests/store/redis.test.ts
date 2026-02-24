import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRedisInstance = {
  get: vi.fn(),
  setex: vi.fn(),
  del: vi.fn(),
  scan: vi.fn(),
};

vi.mock("ioredis", () => ({
  Redis: vi.fn(() => mockRedisInstance),
}));

// Import after mock so the module picks up the mocked Redis constructor.
// We use a fresh import by isolating each test file in its own worker (vitest default).
import { getStoredAlert, setStoredAlert, deleteStoredAlert, getStoredAlertKeys } from "../../src/store/redis.js";
import type { StoredAlert } from "../../src/types/alert.js";

const baseAlert: StoredAlert = {
  messageId: "msg-1",
  channelId: "ch-1",
  state: "firing",
  updatedAt: "2024-01-01T00:00:00Z",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getStoredAlert", () => {
  it("returns null when key does not exist", async () => {
    mockRedisInstance.get.mockResolvedValue(null);
    expect(await getStoredAlert("fp1")).toBeNull();
  });

  it("parses and returns stored alert", async () => {
    mockRedisInstance.get.mockResolvedValue(JSON.stringify(baseAlert));
    const result = await getStoredAlert("fp1");
    expect(result?.messageId).toBe("msg-1");
    expect(result?.state).toBe("firing");
  });

  it("uses 'default' resource key when resource is undefined", async () => {
    mockRedisInstance.get.mockResolvedValue(JSON.stringify(baseAlert));
    await getStoredAlert("fp1");
    expect(mockRedisInstance.get).toHaveBeenCalledWith("alert:fp1:default");
  });

  it("uses resource in key when provided", async () => {
    mockRedisInstance.get.mockResolvedValue(null);
    await getStoredAlert("fp1", "db-prod");
    expect(mockRedisInstance.get).toHaveBeenCalledWith("alert:fp1:db-prod");
  });

  it("returns null for invalid JSON", async () => {
    mockRedisInstance.get.mockResolvedValue("not-json{{");
    expect(await getStoredAlert("fp1")).toBeNull();
  });
});

describe("setStoredAlert", () => {
  it("stores with 7-day TTL using default resource key", async () => {
    mockRedisInstance.setex.mockResolvedValue("OK");
    await setStoredAlert("fp1", undefined, baseAlert);
    const TTL = 7 * 24 * 60 * 60;
    expect(mockRedisInstance.setex).toHaveBeenCalledWith("alert:fp1:default", TTL, JSON.stringify(baseAlert));
  });

  it("stores with named resource key", async () => {
    mockRedisInstance.setex.mockResolvedValue("OK");
    await setStoredAlert("fp1", "instance-1", baseAlert);
    expect(mockRedisInstance.setex).toHaveBeenCalledWith("alert:fp1:instance-1", expect.any(Number), expect.any(String));
  });
});

describe("deleteStoredAlert", () => {
  it("deletes using default resource key", async () => {
    mockRedisInstance.del.mockResolvedValue(1);
    await deleteStoredAlert("fp1");
    expect(mockRedisInstance.del).toHaveBeenCalledWith("alert:fp1:default");
  });

  it("deletes using provided resource key", async () => {
    mockRedisInstance.del.mockResolvedValue(1);
    await deleteStoredAlert("fp1", "rds-1");
    expect(mockRedisInstance.del).toHaveBeenCalledWith("alert:fp1:rds-1");
  });
});

describe("getStoredAlertKeys", () => {
  it("returns all keys using cursor-based SCAN", async () => {
    mockRedisInstance.scan
      .mockResolvedValueOnce(["42", ["alert:a:default", "alert:b:default"]])
      .mockResolvedValueOnce(["0", ["alert:c:resource"]]);
    const keys = await getStoredAlertKeys();
    expect(keys).toEqual(["alert:a:default", "alert:b:default", "alert:c:resource"]);
    expect(mockRedisInstance.scan).toHaveBeenCalledTimes(2);
  });

  it("returns empty array when no keys exist", async () => {
    mockRedisInstance.scan.mockResolvedValue(["0", []]);
    expect(await getStoredAlertKeys()).toEqual([]);
  });

  it("handles single-page scan (cursor 0 from the start)", async () => {
    mockRedisInstance.scan.mockResolvedValue(["0", ["alert:fp1:default"]]);
    const keys = await getStoredAlertKeys();
    expect(keys).toHaveLength(1);
  });
});
