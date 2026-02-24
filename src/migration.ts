import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadAlertsConfig } from "./services/config.js";
import { validateAlertsConfig } from "./services/config.js";
import { getAlertsConfigFromDb, setAlertsConfigInDb } from "./store/postgres.js";
import type { AlertsConfig } from "./types/config.js";
import type { FastifyBaseLogger } from "fastify";

/** First path that exists wins; else last. */
const DEFAULT_PATHS = ["/config/alerts.json"];

/**
 * Config file path: ALERT_CONFIG_PATH env, else config/alerts.json relative to cwd, else /config/alerts.json.
 */
function getAlertsConfigFilePath(): string {
  if (process.env.ALERT_CONFIG_PATH) return resolve(process.env.ALERT_CONFIG_PATH);
  const cwdPath = resolve(process.cwd(), "config", "alerts.json");
  if (existsSync(cwdPath)) return cwdPath;
  for (const p of DEFAULT_PATHS) if (existsSync(p)) return p;
  return cwdPath;
}

/**
 * When the app is connected to the DB, import alerts.json fully into the database.
 * - Loads from file (ALERT_CONFIG_PATH or config/alerts.json or /config/alerts.json).
 * - Merges with existing DB config (file wins for same keys; DB-only keys from /add-alert are kept).
 * - Writes merged config to DB so file content is present and add-alert additions persist.
 * Call after initSchema(), before bootstrapAlertsConfig().
 */
export async function runAlertsConfigMigration(log: FastifyBaseLogger): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  try {
    const path = getAlertsConfigFilePath();
    const fileConfig = loadAlertsConfig(path);
    const fromDb = await getAlertsConfigFromDb();
    const dbConfig: AlertsConfig = fromDb ?? {};
    const merged: AlertsConfig = { ...dbConfig, ...fileConfig };
    const validated = validateAlertsConfig(merged);
    if (!validated.ok) {
      log.warn({ component: "migration", event: "alerts_config_validate_failed", error: validated.error }, "alerts_config_migration_validation_failed");
      return;
    }
    if (Object.keys(merged).length === 0) {
      log.info({ component: "migration", event: "alerts_config_skip", reason: "empty" }, "alerts_config_migration_skip_empty");
      return;
    }
    await setAlertsConfigInDb(validated.config);
    const fileKeys = Object.keys(fileConfig).length;
    log.info(
      { component: "migration", event: "alerts_config_imported", path, fileKeys, totalKeys: Object.keys(merged).length },
      "alerts_config_migration_done"
    );
  } catch (err) {
    log.warn({ component: "migration", event: "alerts_config_failed", err }, "alerts_config_migration_failed");
  }
}
