import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { AlertsConfig, AlertTypeConfig } from "../types/config.js";
import { getAlertsConfigFromDb, setAlertsConfigInDb } from "../store/postgres.js";
import type { FastifyBaseLogger } from "fastify";

const DEFAULT_PATH = "/config/alerts.json";

export function loadAlertsConfig(path?: string): AlertsConfig {
  const configPath = resolve(path ?? process.env.ALERT_CONFIG_PATH ?? DEFAULT_PATH);
  if (!existsSync(configPath)) return {};
  try {
    const raw = readFileSync(configPath, "utf-8");
    const data = JSON.parse(raw) as unknown;
    if (data !== null && typeof data === "object" && !Array.isArray(data)) {
      return data as AlertsConfig;
    }
  } catch {
    // ignore
  }
  return {};
}

let cachedConfig: AlertsConfig | null = null;

export function getAlertsConfig(path?: string): AlertsConfig {
  if (cachedConfig === null) cachedConfig = loadAlertsConfig(path);
  return cachedConfig;
}

export function reloadAlertsConfig(path?: string): AlertsConfig {
  cachedConfig = null;
  return getAlertsConfig(path);
}

export function reloadAlertsConfigSafe(
  path?: string
): { ok: true; config: AlertsConfig } | { ok: false; error: string } {
  const configPath = resolve(path ?? process.env.ALERT_CONFIG_PATH ?? DEFAULT_PATH);
  if (!existsSync(configPath)) return { ok: false, error: `Config file not found: ${configPath}` };
  try {
    const raw = readFileSync(configPath, "utf-8");
    const data = JSON.parse(raw) as unknown;
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      return { ok: false, error: "Config must be a JSON object" };
    }
    cachedConfig = data as AlertsConfig;
    return { ok: true, config: cachedConfig };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function clearAlertsConfigCache(): void {
  cachedConfig = null;
}

export function setAlertsConfigCache(config: AlertsConfig): void {
  cachedConfig = config;
}

function isAlertTypeConfig(v: unknown): v is AlertTypeConfig {
  return (
    v !== null &&
    typeof v === "object" &&
    "channelId" in v &&
    typeof (v as AlertTypeConfig).channelId === "string"
  );
}

export function validateAlertsConfig(
  data: unknown
): { ok: true; config: AlertsConfig } | { ok: false; error: string } {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, error: "Config must be a JSON object" };
  }
  const out: AlertsConfig = {};
  for (const [key, value] of Object.entries(data)) {
    if (!isAlertTypeConfig(value)) {
      return { ok: false, error: `Entry "${key}" must be an object with channelId (string)` };
    }
    out[key] = {
      channelId: value.channelId,
      suppressWindowMs: value.suppressWindowMs,
      importantLabels: value.importantLabels,
      hiddenLabels: value.hiddenLabels,
      thumbnailUrl: value.thumbnailUrl,
      mentions: Array.isArray(value.mentions) ? value.mentions.filter((m): m is string => typeof m === "string") : undefined,
    };
  }
  return { ok: true, config: out };
}

export async function loadAlertsConfigFromDb(): Promise<AlertsConfig | null> {
  if (!process.env.DATABASE_URL) return null;
  try {
    return await getAlertsConfigFromDb();
  } catch {
    return null;
  }
}

export async function bootstrapAlertsConfig(log: FastifyBaseLogger): Promise<void> {
  const fromDb = await loadAlertsConfigFromDb();
  if (fromDb !== null && Object.keys(fromDb).length > 0) {
    cachedConfig = fromDb;
    const entries = Object.keys(fromDb).length;
    log.info({ component: "config", event: "bootstrap", source: "db", entries, keys: Object.keys(fromDb) }, "config_bootstrapped_from_db");
    return;
  }
  const fromFile = loadAlertsConfig();
  cachedConfig = fromFile;
  const entries = Object.keys(fromFile).length;
  log.info({ component: "config", event: "bootstrap", source: "file", entries, keys: Object.keys(fromFile) }, "config_bootstrapped_from_file");
}

export async function saveAlertsConfigToDbAndCache(config: AlertsConfig): Promise<void> {
  if (process.env.DATABASE_URL) {
    await setAlertsConfigInDb(config);
  }
  setAlertsConfigCache(config);
}
