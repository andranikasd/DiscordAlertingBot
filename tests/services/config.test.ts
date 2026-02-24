import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadAlertsConfig,
  getAlertsConfig,
  reloadAlertsConfigSafe,
  clearAlertsConfigCache,
  validateAlertsConfig,
} from "../../src/services/config.js";

const testDir = join(tmpdir(), `discord-alert-bot-config-${Date.now()}`);

describe("config", () => {
  beforeEach(() => {
    if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });
    clearAlertsConfigCache();
  });

  afterEach(() => {
    clearAlertsConfigCache();
  });

  it("returns empty object when file does not exist", () => {
    const config = loadAlertsConfig(join(testDir, "missing.json"));
    expect(config).toEqual({});
  });

  it("loads valid alerts.json with channelId", () => {
    const path = join(testDir, "alerts.json");
    writeFileSync(
      path,
      JSON.stringify({
        RdsCpuUtilizationHigh: { channelId: "123", suppressWindowMs: 600000 },
      })
    );
    const config = loadAlertsConfig(path);
    expect(config.RdsCpuUtilizationHigh?.channelId).toBe("123");
  });

  it("reloadAlertsConfigSafe validates and updates cache", () => {
    const path = join(testDir, "safe.json");
    writeFileSync(path, JSON.stringify({ default: { channelId: "456" } }));
    const result = reloadAlertsConfigSafe(path);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.default?.channelId).toBe("456");
  });

  it("getAlertsConfig loads from path when cache is empty", () => {
    const path = join(testDir, "get-config.json");
    writeFileSync(path, JSON.stringify({ MyAlert: { channelId: "789" } }));
    const config = getAlertsConfig(path);
    expect(config.MyAlert?.channelId).toBe("789");
  });

  it("getAlertsConfig returns cached config after reloadAlertsConfigSafe", () => {
    const path = join(testDir, "cached.json");
    writeFileSync(path, JSON.stringify({ cached: { channelId: "999" } }));
    const result = reloadAlertsConfigSafe(path);
    expect(result.ok).toBe(true);
    const config = getAlertsConfig(path);
    expect(config.cached?.channelId).toBe("999");
  });

  it("validateAlertsConfig accepts valid config", () => {
    const result = validateAlertsConfig({
      MyAlert: { channelId: "123", suppressWindowMs: 60000, importantLabels: ["env"] },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.MyAlert?.channelId).toBe("123");
      expect(result.config.MyAlert?.importantLabels).toEqual(["env"]);
    }
  });

  it("validateAlertsConfig rejects entry without channelId", () => {
    const result = validateAlertsConfig({ Bad: { suppressWindowMs: 1000 } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("channelId");
  });
});