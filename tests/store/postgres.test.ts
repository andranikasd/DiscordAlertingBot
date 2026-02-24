import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockQuery = vi.fn();
const mockPool = { query: mockQuery };

vi.mock("pg", () => ({
  default: {
    Pool: vi.fn(() => mockPool),
  },
}));

import {
  getPool,
  initSchema,
  insertAlertEvent,
  updateAlertEventAck,
  updateAlertEventResolve,
  getAlertStatusTable,
  getAlertsConfigFromDb,
  setAlertsConfigInDb,
  getTroubleshootingGuide,
  setTroubleshootingGuide,
  getAllTroubleshootingGuides,
  getAlertStatusSummary,
  getLastAlertEvent,
  parseAuditLogTtlSeconds,
  runAuditLogCleanup,
} from "../../src/store/postgres.js";
import type { AlertApiPayload } from "../../src/types/alert.js";

const payload: AlertApiPayload = {
  alertId: "fp1",
  resource: "db-1",
  title: "Test",
  description: "desc",
  status: "firing",
  severity: "critical",
  startedAt: "2024-01-01T00:00:00Z",
  channelId: "ch-1",
  ruleName: "HighCPU",
  source: "grafana",
};

let savedDbUrl: string | undefined;

beforeEach(() => {
  savedDbUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://localhost/test";
  vi.clearAllMocks();
  mockQuery.mockResolvedValue({ rows: [] });
});

afterEach(() => {
  if (savedDbUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = savedDbUrl;
});

describe("getPool", () => {
  it("returns a pool instance when DATABASE_URL is set", () => {
    expect(getPool()).toBeDefined();
  });
});

describe("initSchema", () => {
  it("runs all CREATE TABLE and ALTER TABLE queries", async () => {
    await initSchema(mockPool as unknown as import("pg").Pool);
    expect(mockQuery).toHaveBeenCalled();
    const calls = mockQuery.mock.calls.map((c: unknown[]) => (c[0] as string).trim());
    expect(calls.some((c: string) => c.includes("CREATE TABLE IF NOT EXISTS alert_events"))).toBe(true);
    expect(calls.some((c: string) => c.includes("CREATE TABLE IF NOT EXISTS alerts_config"))).toBe(true);
  });
});

describe("insertAlertEvent", () => {
  it("inserts with all payload fields", async () => {
    await insertAlertEvent(payload, "msg-1");
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO alert_events"),
      ["fp1", "db-1", "firing", "msg-1", "ch-1", "critical", "HighCPU", "grafana"]
    );
  });

  it("uses null for missing optional fields", async () => {
    const sparse: AlertApiPayload = { alertId: "fp2", title: "T", status: "firing", startedAt: "2024-01-01T00:00:00Z", channelId: "ch-1" };
    await insertAlertEvent(sparse, null);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.any(String),
      ["fp2", null, "firing", null, "ch-1", null, null, null]
    );
  });
});

describe("updateAlertEventAck", () => {
  it("calls UPDATE with userId, alertId, resource", async () => {
    await updateAlertEventAck("fp1", "db-1", "user-42");
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE alert_events SET acknowledged_by"),
      ["user-42", "fp1", "db-1"]
    );
  });
});

describe("updateAlertEventResolve", () => {
  it("calls UPDATE SET resolved_by", async () => {
    await updateAlertEventResolve("fp1", null, "user-99");
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE alert_events SET resolved_by"),
      ["user-99", "fp1", null]
    );
  });
});

describe("getAlertStatusTable", () => {
  it("returns rows from query", async () => {
    const rows = [{ rule_name: "HighCPU", alert_id: "fp1", resource: null, severity: "critical", last_triggered: new Date(), acknowledged_by: null, resolved_by: null, status: "firing" }];
    mockQuery.mockResolvedValue({ rows });
    const result = await getAlertStatusTable(24);
    expect(result).toEqual(rows);
  });

  it("returns empty array when DATABASE_URL is not set", async () => {
    delete process.env.DATABASE_URL;
    const result = await getAlertStatusTable();
    expect(result).toEqual([]);
  });

  it("returns empty array on query error", async () => {
    mockQuery.mockRejectedValue(new Error("db error"));
    const result = await getAlertStatusTable(24);
    expect(result).toEqual([]);
  });
});

describe("getAlertsConfigFromDb", () => {
  it("returns config object from DB", async () => {
    const config = { MyAlert: { channelId: "ch-1" } };
    mockQuery.mockResolvedValue({ rows: [{ config }] });
    const result = await getAlertsConfigFromDb();
    expect(result).toEqual(config);
  });

  it("returns null when no rows", async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const result = await getAlertsConfigFromDb();
    expect(result).toBeNull();
  });

  it("returns null when config is not an object", async () => {
    mockQuery.mockResolvedValue({ rows: [{ config: "string" }] });
    const result = await getAlertsConfigFromDb();
    expect(result).toBeNull();
  });

  it("returns null when config is null", async () => {
    mockQuery.mockResolvedValue({ rows: [{ config: null }] });
    const result = await getAlertsConfigFromDb();
    expect(result).toBeNull();
  });

  it("returns null when config is an array", async () => {
    mockQuery.mockResolvedValue({ rows: [{ config: [] }] });
    const result = await getAlertsConfigFromDb();
    expect(result).toBeNull();
  });

  it("returns null on query error", async () => {
    mockQuery.mockRejectedValue(new Error("db error"));
    expect(await getAlertsConfigFromDb()).toBeNull();
  });
});

describe("setAlertsConfigInDb", () => {
  it("calls UPDATE with JSON-serialized config", async () => {
    const config = { Alert: { channelId: "ch-2" } };
    await setAlertsConfigInDb(config);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE alerts_config"),
      [JSON.stringify(config)]
    );
  });
});

describe("getTroubleshootingGuide", () => {
  it("returns markdown content for known rule", async () => {
    mockQuery.mockResolvedValue({ rows: [{ content_markdown: "## Guide" }] });
    const result = await getTroubleshootingGuide("HighCPU");
    expect(result).toBe("## Guide");
  });

  it("returns null when no rows", async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const result = await getTroubleshootingGuide("Unknown");
    expect(result).toBeNull();
  });

  it("returns null when DATABASE_URL is not set", async () => {
    delete process.env.DATABASE_URL;
    expect(await getTroubleshootingGuide("X")).toBeNull();
  });

  it("returns null on query error", async () => {
    mockQuery.mockRejectedValue(new Error("db error"));
    expect(await getTroubleshootingGuide("X")).toBeNull();
  });
});

describe("setTroubleshootingGuide", () => {
  it("runs upsert query", async () => {
    await setTroubleshootingGuide("HighCPU", "## Fix this");
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO troubleshooting_guides"),
      ["HighCPU", "## Fix this"]
    );
  });
});

describe("getAllTroubleshootingGuides", () => {
  it("returns all guides as record", async () => {
    mockQuery.mockResolvedValue({ rows: [{ rule_name: "A", content_markdown: "guide-A" }, { rule_name: "B", content_markdown: "guide-B" }] });
    const result = await getAllTroubleshootingGuides();
    expect(result).toEqual({ A: "guide-A", B: "guide-B" });
  });

  it("returns empty object when DATABASE_URL not set", async () => {
    delete process.env.DATABASE_URL;
    expect(await getAllTroubleshootingGuides()).toEqual({});
  });

  it("returns empty object on query error", async () => {
    mockQuery.mockRejectedValue(new Error("db error"));
    expect(await getAllTroubleshootingGuides()).toEqual({});
  });
});

describe("getAlertStatusSummary", () => {
  it("returns summary with byStatus counts", async () => {
    mockQuery.mockResolvedValue({ rows: [{ status: "firing", count: "3" }, { status: "resolved", count: "1" }] });
    const result = await getAlertStatusSummary(24);
    expect(result?.byStatus).toEqual({ firing: 3, resolved: 1 });
    expect(result?.total).toBe(4);
    expect(result?.since).toBeDefined();
  });

  it("returns null when DATABASE_URL not set", async () => {
    delete process.env.DATABASE_URL;
    expect(await getAlertStatusSummary()).toBeNull();
  });

  it("returns null on query error", async () => {
    mockQuery.mockRejectedValue(new Error("db error"));
    expect(await getAlertStatusSummary(24)).toBeNull();
  });
});

describe("getLastAlertEvent", () => {
  it("returns the latest alert event", async () => {
    const row = { alert_id: "fp1", resource: null, status: "firing", channel_id: "ch-1", created_at: new Date() };
    mockQuery.mockResolvedValue({ rows: [row] });
    const result = await getLastAlertEvent();
    expect(result?.alert_id).toBe("fp1");
  });

  it("returns null when no rows", async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    expect(await getLastAlertEvent()).toBeNull();
  });

  it("returns null when DATABASE_URL not set", async () => {
    delete process.env.DATABASE_URL;
    expect(await getLastAlertEvent()).toBeNull();
  });

  it("returns null on query error", async () => {
    mockQuery.mockRejectedValue(new Error("db error"));
    expect(await getLastAlertEvent()).toBeNull();
  });
});

describe("parseAuditLogTtlSeconds", () => {
  let saved: string | undefined;
  beforeEach(() => { saved = process.env.AUDIT_LOG_TTL; delete process.env.AUDIT_LOG_TTL; });
  afterEach(() => { if (saved === undefined) delete process.env.AUDIT_LOG_TTL; else process.env.AUDIT_LOG_TTL = saved; });

  it("returns null when AUDIT_LOG_TTL is not set", () => {
    expect(parseAuditLogTtlSeconds()).toBeNull();
  });

  it("parses days format '90d'", () => {
    process.env.AUDIT_LOG_TTL = "90d";
    expect(parseAuditLogTtlSeconds()).toBe(90 * 24 * 60 * 60);
  });

  it("parses 'days' format", () => {
    process.env.AUDIT_LOG_TTL = "30days";
    expect(parseAuditLogTtlSeconds()).toBe(30 * 24 * 60 * 60);
  });

  it("parses raw seconds number", () => {
    process.env.AUDIT_LOG_TTL = "3600";
    expect(parseAuditLogTtlSeconds()).toBe(3600);
  });

  it("returns null for invalid format", () => {
    process.env.AUDIT_LOG_TTL = "invalid";
    expect(parseAuditLogTtlSeconds()).toBeNull();
  });

  it("returns null for zero", () => {
    process.env.AUDIT_LOG_TTL = "0";
    expect(parseAuditLogTtlSeconds()).toBeNull();
  });
});

describe("runAuditLogCleanup", () => {
  it("returns deleted count from query", async () => {
    mockQuery.mockResolvedValue({ rows: [{ count: "5" }] });
    const result = await runAuditLogCleanup(30 * 24 * 60 * 60);
    expect(result.deleted).toBe(5);
  });

  it("returns 0 when DATABASE_URL is not set", async () => {
    delete process.env.DATABASE_URL;
    expect((await runAuditLogCleanup(3600)).deleted).toBe(0);
  });

  it("returns 0 when ttlSeconds is null", async () => {
    expect((await runAuditLogCleanup(null)).deleted).toBe(0);
  });

  it("returns 0 when ttlSeconds is 0", async () => {
    expect((await runAuditLogCleanup(0)).deleted).toBe(0);
  });

  it("returns 0 on query error", async () => {
    mockQuery.mockRejectedValue(new Error("db error"));
    expect((await runAuditLogCleanup(3600)).deleted).toBe(0);
  });
});
