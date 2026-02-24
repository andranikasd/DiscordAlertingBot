import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/store/redis.js", () => ({
  getRedis: vi.fn(),
}));

import { isDuplicate, clearDedup, setDedupTtl } from "../../src/store/dedup.js";
import * as redisStore from "../../src/store/redis.js";
import type { Redis } from "ioredis";

const mockRedis = {
  get: vi.fn(),
  setex: vi.fn(),
  del: vi.fn(),
};

beforeEach(() => {
  vi.mocked(redisStore.getRedis).mockReturnValue(mockRedis as unknown as Redis);
  vi.clearAllMocks();
});

describe("isDuplicate", () => {
  it("returns false and records when not seen before", async () => {
    mockRedis.get.mockResolvedValue(null);
    mockRedis.setex.mockResolvedValue("OK");
    const result = await isDuplicate("fp1", 5000);
    expect(result).toBe(false);
    expect(mockRedis.setex).toHaveBeenCalledWith("dedup:fp1", 5, "1");
  });

  it("returns true when fingerprint is already recorded", async () => {
    mockRedis.get.mockResolvedValue("1");
    const result = await isDuplicate("fp1", 5000);
    expect(result).toBe(true);
    expect(mockRedis.setex).not.toHaveBeenCalled();
  });

  it("rounds up sub-second TTL to 1 second minimum", async () => {
    mockRedis.get.mockResolvedValue(null);
    mockRedis.setex.mockResolvedValue("OK");
    await isDuplicate("fp2", 100); // 100 ms → 1 s
    expect(mockRedis.setex).toHaveBeenCalledWith("dedup:fp2", 1, "1");
  });

  it("converts milliseconds to seconds correctly", async () => {
    mockRedis.get.mockResolvedValue(null);
    mockRedis.setex.mockResolvedValue("OK");
    await isDuplicate("fp3", 5 * 60 * 1000); // 5 min = 300 s
    expect(mockRedis.setex).toHaveBeenCalledWith("dedup:fp3", 300, "1");
  });
});

describe("clearDedup", () => {
  it("deletes the dedup key", async () => {
    mockRedis.del.mockResolvedValue(1);
    await clearDedup("fp1");
    expect(mockRedis.del).toHaveBeenCalledWith("dedup:fp1");
  });
});

describe("setDedupTtl", () => {
  it("calls setex with converted TTL in seconds", async () => {
    mockRedis.setex.mockResolvedValue("OK");
    await setDedupTtl("fp1", 10 * 60 * 1000); // 10 min = 600 s
    expect(mockRedis.setex).toHaveBeenCalledWith("dedup:fp1", 600, "1");
  });

  it("enforces 1 second minimum", async () => {
    mockRedis.setex.mockResolvedValue("OK");
    await setDedupTtl("fp1", 0);
    expect(mockRedis.setex).toHaveBeenCalledWith("dedup:fp1", 1, "1");
  });
});