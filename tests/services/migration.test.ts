import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/store/postgres.js", () => ({
  getAlertsConfigFromDb: vi.fn(),
  setAlertsConfigInDb: vi.fn(),
}));

vi.mock("../../src/services/config.js", () => ({
  loadAlertsConfig: vi.fn(),
  validateAlertsConfig: vi.fn(),
}));

import { runAlertsConfigMigration } from "../../src/migration.js";
import * as postgres from "../../src/store/postgres.js";
import * as config from "../../src/services/config.js";
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

let savedDbUrl: string | undefined;

beforeEach(() => {
  savedDbUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  vi.clearAllMocks();
});

afterEach(() => {
  if (savedDbUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = savedDbUrl;
});

describe("runAlertsConfigMigration", () => {
  it("does nothing when DATABASE_URL is not set", async () => {
    await runAlertsConfigMigration(mockLog);
    expect(postgres.getAlertsConfigFromDb).not.toHaveBeenCalled();
  });

  it("skips when merged config is empty", async () => {
    process.env.DATABASE_URL = "postgres://localhost/test";
    vi.mocked(postgres.getAlertsConfigFromDb).mockResolvedValue({});
    vi.mocked(config.loadAlertsConfig).mockReturnValue({});
    vi.mocked(config.validateAlertsConfig).mockReturnValue({ ok: true, config: {} });
    await runAlertsConfigMigration(mockLog);
    expect(postgres.setAlertsConfigInDb).not.toHaveBeenCalled();
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "empty" }),
      expect.any(String)
    );
  });

  it("merges file config over DB config and saves", async () => {
    process.env.DATABASE_URL = "postgres://localhost/test";
    vi.mocked(postgres.getAlertsConfigFromDb).mockResolvedValue({ OldAlert: { channelId: "old-ch" } });
    vi.mocked(config.loadAlertsConfig).mockReturnValue({ NewAlert: { channelId: "new-ch" } });
    vi.mocked(config.validateAlertsConfig).mockReturnValue({
      ok: true,
      config: { OldAlert: { channelId: "old-ch" }, NewAlert: { channelId: "new-ch" } },
    });
    vi.mocked(postgres.setAlertsConfigInDb).mockResolvedValue(undefined);
    await runAlertsConfigMigration(mockLog);
    expect(postgres.setAlertsConfigInDb).toHaveBeenCalled();
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "alerts_config_imported" }),
      expect.any(String)
    );
  });

  it("logs warning when validation fails", async () => {
    process.env.DATABASE_URL = "postgres://localhost/test";
    vi.mocked(postgres.getAlertsConfigFromDb).mockResolvedValue({});
    vi.mocked(config.loadAlertsConfig).mockReturnValue({ Bad: { channelId: "ch" } });
    vi.mocked(config.validateAlertsConfig).mockReturnValue({ ok: false, error: "bad config" });
    await runAlertsConfigMigration(mockLog);
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "alerts_config_validate_failed" }),
      expect.any(String)
    );
    expect(postgres.setAlertsConfigInDb).not.toHaveBeenCalled();
  });

  it("handles null DB config (treats as empty)", async () => {
    process.env.DATABASE_URL = "postgres://localhost/test";
    vi.mocked(postgres.getAlertsConfigFromDb).mockResolvedValue(null);
    vi.mocked(config.loadAlertsConfig).mockReturnValue({ Alert: { channelId: "ch-1" } });
    vi.mocked(config.validateAlertsConfig).mockReturnValue({ ok: true, config: { Alert: { channelId: "ch-1" } } });
    vi.mocked(postgres.setAlertsConfigInDb).mockResolvedValue(undefined);
    await runAlertsConfigMigration(mockLog);
    expect(postgres.setAlertsConfigInDb).toHaveBeenCalled();
  });

  it("catches and logs unexpected errors", async () => {
    process.env.DATABASE_URL = "postgres://localhost/test";
    vi.mocked(postgres.getAlertsConfigFromDb).mockRejectedValue(new Error("connection refused"));
    vi.mocked(config.loadAlertsConfig).mockReturnValue({});
    await runAlertsConfigMigration(mockLog);
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "alerts_config_failed" }),
      expect.any(String)
    );
  });
});
