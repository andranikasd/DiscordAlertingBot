import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("../../src/store/postgres.js", () => ({
  getAlertsConfigFromDb: vi.fn(),
  setAlertsConfigInDb: vi.fn(),
}));

import {
  loadAlertsConfig,
  reloadAlertsConfig,
  reloadAlertsConfigSafe,
  clearAlertsConfigCache,
  setAlertsConfigCache,
  validateAlertsConfig,
  bootstrapAlertsConfig,
  saveAlertsConfigToDbAndCache,
  loadAlertsConfigFromDb,
} from "../../src/services/config.js";
import * as postgres from "../../src/store/postgres.js";
import type { FastifyBaseLogger } from "fastify";

const testDir = join(tmpdir(), `discord-alert-bot-cfg-add-${Date.now()}`);

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
  if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });
  clearAlertsConfigCache();
  vi.clearAllMocks();
});

afterEach(() => {
  clearAlertsConfigCache();
  delete process.env.DATABASE_URL;
});

describe("reloadAlertsConfig", () => {
  it("clears cache and returns fresh config", () => {
    const path = join(testDir, "reload.json");
    writeFileSync(path, JSON.stringify({ AlertA: { channelId: "ch-1" } }));
    setAlertsConfigCache({ Old: { channelId: "old" } });
    const config = reloadAlertsConfig(path);
    expect(config.AlertA?.channelId).toBe("ch-1");
    expect(config.Old).toBeUndefined();
  });
});

describe("reloadAlertsConfigSafe error paths", () => {
  it("returns error when file does not exist", () => {
    const result = reloadAlertsConfigSafe(join(testDir, "nonexistent.json"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("not found");
  });

  it("returns error when file contains non-object JSON (array)", () => {
    const path = join(testDir, "array.json");
    writeFileSync(path, JSON.stringify([1, 2, 3]));
    const result = reloadAlertsConfigSafe(path);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("JSON object");
  });

  it("returns error when file contains invalid JSON", () => {
    const path = join(testDir, "bad.json");
    writeFileSync(path, "{ broken json ");
    const result = reloadAlertsConfigSafe(path);
    expect(result.ok).toBe(false);
  });
});

describe("validateAlertsConfig", () => {
  it("returns error for null input", () => {
    const result = validateAlertsConfig(null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("JSON object");
  });

  it("returns error for array input", () => {
    const result = validateAlertsConfig(["a", "b"]);
    expect(result.ok).toBe(false);
  });

  it("returns error for non-object primitive", () => {
    const result = validateAlertsConfig("string");
    expect(result.ok).toBe(false);
  });

  it("returns error for entry with non-string channelId", () => {
    const result = validateAlertsConfig({ Alert: { channelId: 123 } });
    expect(result.ok).toBe(false);
  });

  it("filters mentions to only strings", () => {
    const result = validateAlertsConfig({
      Alert: { channelId: "ch-1", mentions: ["user1", 42, null, "user2"] },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.Alert?.mentions).toEqual(["user1", "user2"]);
    }
  });

  it("accepts config with all optional fields", () => {
    const result = validateAlertsConfig({
      Alert: {
        channelId: "ch-1",
        suppressWindowMs: 60000,
        importantLabels: ["env"],
        hiddenLabels: ["job"],
        thumbnailUrl: "https://example.com/icon.png",
        mentions: ["user1"],
      },
    });
    expect(result.ok).toBe(true);
  });

  it("returns empty config for empty object", () => {
    const result = validateAlertsConfig({});
    expect(result.ok).toBe(true);
    if (result.ok) expect(Object.keys(result.config)).toHaveLength(0);
  });
});

describe("loadAlertsConfig edge cases", () => {
  it("returns empty object when file has non-object JSON", () => {
    const path = join(testDir, "not-obj.json");
    writeFileSync(path, JSON.stringify(42));
    expect(loadAlertsConfig(path)).toEqual({});
  });

  it("returns empty object when file contains invalid JSON", () => {
    const path = join(testDir, "broken.json");
    writeFileSync(path, "{ bad");
    expect(loadAlertsConfig(path)).toEqual({});
  });

  it("returns empty object for non-existent path", () => {
    expect(loadAlertsConfig(join(testDir, "missing-xyz.json"))).toEqual({});
  });
});

describe("loadAlertsConfigFromDb", () => {
  it("returns null when DATABASE_URL is not set", async () => {
    delete process.env.DATABASE_URL;
    expect(await loadAlertsConfigFromDb()).toBeNull();
  });

  it("returns config from DB when DATABASE_URL is set", async () => {
    process.env.DATABASE_URL = "postgres://localhost/test";
    vi.mocked(postgres.getAlertsConfigFromDb).mockResolvedValue({ Alert: { channelId: "ch-db" } });
    const result = await loadAlertsConfigFromDb();
    expect(result?.Alert?.channelId).toBe("ch-db");
  });

  it("returns null when DB throws", async () => {
    process.env.DATABASE_URL = "postgres://localhost/test";
    vi.mocked(postgres.getAlertsConfigFromDb).mockRejectedValue(new Error("db error"));
    expect(await loadAlertsConfigFromDb()).toBeNull();
  });
});

describe("bootstrapAlertsConfig", () => {
  it("uses DB config when DATABASE_URL is set and DB has entries", async () => {
    process.env.DATABASE_URL = "postgres://localhost/test";
    vi.mocked(postgres.getAlertsConfigFromDb).mockResolvedValue({ DBAlert: { channelId: "ch-db" } });
    await bootstrapAlertsConfig(mockLog);
    expect(mockLog.info).toHaveBeenCalledWith(expect.objectContaining({ source: "db" }), expect.any(String));
  });

  it("falls back to file when DB returns empty config", async () => {
    process.env.DATABASE_URL = "postgres://localhost/test";
    vi.mocked(postgres.getAlertsConfigFromDb).mockResolvedValue({});
    await bootstrapAlertsConfig(mockLog);
    expect(mockLog.info).toHaveBeenCalledWith(expect.objectContaining({ source: "file" }), expect.any(String));
  });

  it("falls back to file when DATABASE_URL is not set", async () => {
    delete process.env.DATABASE_URL;
    vi.mocked(postgres.getAlertsConfigFromDb).mockResolvedValue(null);
    await bootstrapAlertsConfig(mockLog);
    expect(mockLog.info).toHaveBeenCalledWith(expect.objectContaining({ source: "file" }), expect.any(String));
  });
});

describe("saveAlertsConfigToDbAndCache", () => {
  it("calls setAlertsConfigInDb when DATABASE_URL is set", async () => {
    process.env.DATABASE_URL = "postgres://localhost/test";
    vi.mocked(postgres.setAlertsConfigInDb).mockResolvedValue(undefined);
    const config = { Alert: { channelId: "ch-1" } };
    await saveAlertsConfigToDbAndCache(config);
    expect(postgres.setAlertsConfigInDb).toHaveBeenCalledWith(config);
  });

  it("does not call setAlertsConfigInDb when DATABASE_URL is not set", async () => {
    delete process.env.DATABASE_URL;
    vi.mocked(postgres.setAlertsConfigInDb).mockResolvedValue(undefined);
    await saveAlertsConfigToDbAndCache({ Alert: { channelId: "ch-1" } });
    expect(postgres.setAlertsConfigInDb).not.toHaveBeenCalled();
  });
});
