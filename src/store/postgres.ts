import pg from "pg";
import type { AlertApiPayload } from "../types/alert.js";
import type { AlertsConfig } from "../types/config.js";

const { Pool } = pg;
let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required");
    pool = new Pool({ connectionString, max: 5 });
  }
  return pool;
}

export async function initSchema(pool: pg.Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS alert_events (
      id SERIAL PRIMARY KEY,
      alert_id TEXT NOT NULL,
      resource TEXT,
      status TEXT NOT NULL,
      message_id TEXT,
      channel_id TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE alert_events ADD COLUMN IF NOT EXISTS severity TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE alert_events ADD COLUMN IF NOT EXISTS rule_name TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE alert_events ADD COLUMN IF NOT EXISTS acknowledged_by TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE alert_events ADD COLUMN IF NOT EXISTS resolved_by TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE alert_events ADD COLUMN IF NOT EXISTS source TEXT`).catch(() => {});
  await pool.query(`
    CREATE TABLE IF NOT EXISTS alerts_config (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      config JSONB NOT NULL DEFAULT '{}',
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    INSERT INTO alerts_config (id, config) VALUES (1, '{}')
    ON CONFLICT (id) DO NOTHING
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS troubleshooting_guides (
      rule_name TEXT PRIMARY KEY,
      content_markdown TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

export async function insertAlertEvent(
  payload: AlertApiPayload,
  messageId: string | null
): Promise<void> {
  const p = getPool();
  await p.query(
    `INSERT INTO alert_events (alert_id, resource, status, message_id, channel_id, severity, rule_name, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      payload.alertId,
      payload.resource ?? null,
      payload.status,
      messageId,
      payload.channelId,
      payload.severity ?? null,
      payload.ruleName ?? null,
      payload.source ?? null,
    ]
  );
}

export async function updateAlertEventAck(alertId: string, resource: string | null, userId: string): Promise<void> {
  const p = getPool();
  await p.query(
    `UPDATE alert_events SET acknowledged_by = $1
     WHERE id = (SELECT id FROM alert_events WHERE alert_id = $2 AND (resource IS NOT DISTINCT FROM $3) ORDER BY created_at DESC LIMIT 1)`,
    [userId, alertId, resource]
  );
}

export async function updateAlertEventResolve(alertId: string, resource: string | null, userId: string): Promise<void> {
  const p = getPool();
  await p.query(
    `UPDATE alert_events SET resolved_by = $1, status = 'resolved'
     WHERE id = (SELECT id FROM alert_events WHERE alert_id = $2 AND (resource IS NOT DISTINCT FROM $3) ORDER BY created_at DESC LIMIT 1)`,
    [userId, alertId, resource]
  );
}

export interface AlertStatusRow {
  rule_name: string | null;
  alert_id: string;
  resource: string | null;
  severity: string | null;
  last_triggered: Date;
  acknowledged_by: string | null;
  resolved_by: string | null;
  status: string;
}

export async function getAlertStatusTable(hoursAgo = 24): Promise<AlertStatusRow[]> {
  if (!process.env.DATABASE_URL) return [];
  try {
    const p = getPool();
    const r = await p.query<AlertStatusRow>(
      `SELECT DISTINCT ON (alert_id, resource)
         rule_name, alert_id, resource, severity, created_at AS last_triggered, acknowledged_by, resolved_by, status
       FROM alert_events
       WHERE created_at > NOW() - INTERVAL '1 hour' * $1
       ORDER BY alert_id, resource, created_at DESC`,
      [hoursAgo]
    );
    return r.rows;
  } catch {
    return [];
  }
}

export async function getAlertsConfigFromDb(): Promise<AlertsConfig | null> {
  try {
    const p = getPool();
    const r = await p.query<{ config: unknown }>(
      `SELECT config FROM alerts_config WHERE id = 1`
    );
    if (r.rows.length === 0) return null;
    const raw = r.rows[0].config;
    if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
      return raw as AlertsConfig;
    }
    return null;
  } catch {
    return null;
  }
}

export async function setAlertsConfigInDb(config: AlertsConfig): Promise<void> {
  const p = getPool();
  await p.query(
    `UPDATE alerts_config SET config = $1::jsonb, updated_at = NOW() WHERE id = 1`,
    [JSON.stringify(config)]
  );
}

export async function getTroubleshootingGuide(ruleName: string): Promise<string | null> {
  if (!process.env.DATABASE_URL) return null;
  try {
    const p = getPool();
    const r = await p.query<{ content_markdown: string }>(
      `SELECT content_markdown FROM troubleshooting_guides WHERE rule_name = $1`,
      [ruleName]
    );
    if (r.rows.length === 0) return null;
    return r.rows[0].content_markdown ?? "";
  } catch {
    return null;
  }
}

export async function setTroubleshootingGuide(ruleName: string, contentMarkdown: string): Promise<void> {
  const p = getPool();
  await p.query(
    `INSERT INTO troubleshooting_guides (rule_name, content_markdown, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (rule_name) DO UPDATE SET content_markdown = $2, updated_at = NOW()`,
    [ruleName, contentMarkdown]
  );
}

export async function getAllTroubleshootingGuides(): Promise<Record<string, string>> {
  if (!process.env.DATABASE_URL) return {};
  try {
    const p = getPool();
    const r = await p.query<{ rule_name: string; content_markdown: string }>(
      `SELECT rule_name, content_markdown FROM troubleshooting_guides`
    );
    const out: Record<string, string> = {};
    for (const row of r.rows) out[row.rule_name] = row.content_markdown ?? "";
    return out;
  } catch {
    return {};
  }
}

export interface AlertStatusSummary {
  byStatus: Record<string, number>;
  total: number;
  since: string;
}

export async function getAlertStatusSummary(hoursAgo = 24): Promise<AlertStatusSummary | null> {
  if (!process.env.DATABASE_URL) return null;
  try {
    const p = getPool();
    const r = await p.query<{ status: string; count: string }>(
      `SELECT status, COUNT(*)::text AS count
       FROM alert_events
       WHERE created_at > NOW() - INTERVAL '1 hour' * $1
       GROUP BY status`,
      [hoursAgo]
    );
    const byStatus: Record<string, number> = {};
    let total = 0;
    for (const row of r.rows) {
      const n = parseInt(row.count, 10) || 0;
      byStatus[row.status] = n;
      total += n;
    }
    const since = new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
    return { byStatus, total, since };
  } catch {
    return null;
  }
}

export interface LastAlertRow {
  alert_id: string;
  resource: string | null;
  status: string;
  channel_id: string;
  created_at: Date;
}

export async function getLastAlertEvent(): Promise<LastAlertRow | null> {
  if (!process.env.DATABASE_URL) return null;
  try {
    const p = getPool();
    const r = await p.query<LastAlertRow>(
      `SELECT alert_id, resource, status, channel_id, created_at
       FROM alert_events ORDER BY created_at DESC LIMIT 1`
    );
    if (r.rows.length === 0) return null;
    return r.rows[0];
  } catch {
    return null;
  }
}

/**
 * Parse AUDIT_LOG_TTL env: "90d", "30d", "365d" or seconds number. Returns seconds or null if unset/invalid.
 */
export function parseAuditLogTtlSeconds(): number | null {
  const raw = process.env.AUDIT_LOG_TTL?.trim();
  if (!raw) return null;
  const match = raw.match(/^(\d+)(d|days?)?$/i);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  if (Number.isNaN(n) || n <= 0) return null;
  if (match[2]?.toLowerCase().startsWith("d")) return n * 24 * 60 * 60;
  return n;
}

/**
 * Delete alert_events older than TTL. Call with seconds from parseAuditLogTtlSeconds(); no-op if ttlSeconds null.
 */
export async function runAuditLogCleanup(ttlSeconds: number | null): Promise<{ deleted: number }> {
  if (!process.env.DATABASE_URL || ttlSeconds == null || ttlSeconds <= 0) return { deleted: 0 };
  try {
    const p = getPool();
    const r = await p.query<{ count: string }>(
      `WITH deleted AS (
         DELETE FROM alert_events WHERE created_at < NOW() - ($1::bigint || ' seconds')::interval
         RETURNING id
       ) SELECT COUNT(*)::text AS count FROM deleted`,
      [ttlSeconds]
    );
    const deleted = parseInt(r.rows[0]?.count ?? "0", 10) || 0;
    return { deleted };
  } catch {
    return { deleted: 0 };
  }
}
