import { grafanaAlertSchema, type NormalizedAlert, type SingleAlert } from "../types/grafana.js";
import type { AlertApiPayload } from "../types/alert.js";
import type { AlertTypeConfig } from "../types/config.js";
import { getAlertsConfig } from "./config.js";
import { isDuplicate, clearDedup } from "../store/dedup.js";
import { getStoredAlert, deleteStoredAlert } from "../store/redis.js";
import { sendOrUpdateAlert } from "../discord/client.js";
import { insertAlertEvent } from "../store/postgres.js";
import type { FastifyBaseLogger } from "fastify";
import { inc } from "../metrics.js";

const RESOLVED_NEW_ALERT_AFTER_MS = 30 * 60 * 1000;
const ACK_NEW_INCIDENT_AFTER_MS = 1.5 * 60 * 60 * 1000;

/**
 * Process a single alert payload: dedup, resolve/ack expiry, send to Discord, audit log.
 * Used by both Grafana and SNS pipelines. Never throws; logs errors.
 */
export async function processOneAlertPayload(apiPayload: AlertApiPayload, log: FastifyBaseLogger): Promise<void> {
  const ruleName = apiPayload.ruleName ?? "default";
  inc("alerts_received_total");
  const config = getAlertsConfig()[ruleName];
  if (!config?.channelId) {
    inc("no_config_suppressed_total");
    log.debug({ component: "processor", event: "suppressed", reason: "no_config", ruleName, alertId: apiPayload.alertId }, "alert_suppressed_no_config");
    return;
  }
  const suppressWindowMs = config.suppressWindowMs ?? 5 * 60 * 1000;
  if (apiPayload.status === "resolved") {
    // Always deliver resolved events — never suppress them. Clear the dedup key so the
    // next firing event after this resolve is delivered immediately.
    await clearDedup(apiPayload.alertId);
  } else {
    const duplicate = await isDuplicate(apiPayload.alertId, suppressWindowMs);
    if (duplicate) {
      inc("dedup_suppressed_total");
      log.info({ component: "processor", event: "suppressed", reason: "dedup", alertId: apiPayload.alertId, ruleName }, "alert_suppressed_dedup");
      return;
    }
  }
  const stored = await getStoredAlert(apiPayload.alertId, apiPayload.resource);
  const resolvedAt = stored?.resolvedAt ?? (stored?.state === "resolved" ? stored?.updatedAt : null);
  if (resolvedAt && Date.now() - new Date(resolvedAt).getTime() > RESOLVED_NEW_ALERT_AFTER_MS) {
    await deleteStoredAlert(apiPayload.alertId, apiPayload.resource);
    log.info({ component: "processor", event: "resolved_expired_new_alert", alertId: apiPayload.alertId, ruleName, resolvedAt }, "alert_firing_again_after_resolved_sending_new");
  }
  if (stored?.state === "acknowledged" && stored.acknowledgedAt && Date.now() - new Date(stored.acknowledgedAt).getTime() > ACK_NEW_INCIDENT_AFTER_MS) {
    await deleteStoredAlert(apiPayload.alertId, apiPayload.resource);
    log.info({ component: "processor", event: "ack_expired_new_incident", alertId: apiPayload.alertId, ruleName, acknowledgedAt: stored.acknowledgedAt }, "alert_firing_again_after_ack_sending_new_incident");
  }
  try {
    const messageId = await sendOrUpdateAlert(apiPayload, log);
    inc("alerts_sent_total");
    log.info({ component: "processor", event: "alert_sent", alertId: apiPayload.alertId, ruleName, channelId: config.channelId, messageId, resource: apiPayload.resource, source: apiPayload.source }, "alert_sent");
    if (process.env.DATABASE_URL) {
      await insertAlertEvent(apiPayload, messageId).catch((err) =>
        log.warn({ component: "processor", event: "audit_insert_failed", alertId: apiPayload.alertId, err }, "alert_event_insert_failed")
      );
    }
  } catch (err) {
    inc("discord_errors_total");
    log.error({ component: "processor", event: "alert_failed", alertId: apiPayload.alertId, ruleName, channelId: config.channelId, err }, "alert_failed");
  }
}

const BROKEN_TEMPLATE = /%![\w]*\(<nil>\)/g;
function sanitize(s: string): string {
  return s.replace(BROKEN_TEMPLATE, "N/A").trim();
}

function normalizeOne(
  a: SingleAlert,
  groupLabels: Record<string, string>,
  commonLabels: Record<string, string>,
  commonAnnotations: Record<string, string>
): NormalizedAlert {
  const fingerprint =
    a.fingerprint ?? `${a.labels?.alertname ?? "unknown"}-${Date.now()}-${Math.random()}`;
  return {
    id: fingerprint,
    fingerprint,
    status: a.status ?? "firing",
    labels: a.labels ?? {},
    annotations: a.annotations ?? {},
    startsAt: a.startsAt ?? new Date().toISOString(),
    endsAt: a.endsAt ?? "",
    generatorURL: a.generatorURL,
    groupLabels,
    commonLabels,
    commonAnnotations,
  };
}

function getAlertTypeKey(alert: NormalizedAlert): string {
  return alert.labels.alertname ?? alert.labels.alert_type ?? "default";
}

function isMeaningfulEndsAt(endsAt: string): boolean {
  if (!endsAt?.trim()) return false;
  if (/^0001-01-01T00:00:00/i.test(endsAt.trim())) return false;
  return true;
}

function normalizedToApiPayload(alert: NormalizedAlert, config: AlertTypeConfig): AlertApiPayload {
  const status = alert.status === "resolved" ? "resolved" : "firing";
  const severity = (alert.labels.severity ?? "warning").toLowerCase();
  const validSeverity: "critical" | "high" | "warning" | "info" =
    severity === "critical" || severity === "high" || severity === "info" ? severity : "warning";
  const hidden = new Set(config.hiddenLabels ?? []);
  const importantKeys = config.importantLabels ?? [];
  const fields: Array<{ name: string; value: string }> = [];
  if (importantKeys.length > 0) {
    const parts = importantKeys
      .filter((k) => alert.labels[k] != null && alert.labels[k] !== "")
      .map((k) => `${k}: ${alert.labels[k]}`);
    if (parts.length > 0) {
      fields.push({ name: "Key info", value: parts.join(" • ") });
    }
  }
  for (const [k, v] of Object.entries(alert.labels)) {
    if (!hidden.has(k)) fields.push({ name: k, value: v });
  }
  for (const [k, v] of Object.entries(alert.annotations)) {
    fields.push({ name: k, value: sanitize(String(v)) });
  }
  const resource =
    alert.labels.instance ?? alert.labels.DBInstanceIdentifier ?? alert.labels.resource;
  const summary = alert.annotations.summary ?? "";
  const description = alert.annotations.description ?? "";
  const descriptionText = sanitize(summary) || sanitize(description) || "No description";

  const ruleName = alert.labels.alertname ?? "default";
  return {
    alertId: alert.fingerprint,
    resource,
    title: `Alert: ${ruleName}`,
    description: descriptionText,
    status,
    severity: validSeverity,
    fields,
    startedAt: alert.startsAt,
    resolvedAt: isMeaningfulEndsAt(alert.endsAt) ? alert.endsAt : undefined,
    generatorURL: alert.generatorURL,
    channelId: config.channelId,
    ruleName,
    thumbnailUrl: config.thumbnailUrl,
    source: "grafana",
  };
}

/**
 * Parse Grafana webhook, normalize, dedupe, look up config by alert name, post/update in Discord.
 * Never throws; logs and continues. Call with void to return 200 quickly.
 */
export async function processAlerts(rawPayload: unknown, log: FastifyBaseLogger): Promise<void> {
  const parseResult = grafanaAlertSchema.safeParse(rawPayload);
  if (!parseResult.success) {
    log.warn(
      { component: "processor", event: "parse_failed", err: parseResult.error.flatten(), rawKeys: typeof rawPayload === "object" && rawPayload !== null ? Object.keys(rawPayload as object) : [] },
      "alert_failed_invalid_payload"
    );
    return;
  }

  const payload = parseResult.data;
  const config = getAlertsConfig();
  const { groupLabels = {}, commonLabels = {}, commonAnnotations = {} } = payload;
  const alertCount = payload.alerts?.length ?? 0;
  log.info({ component: "processor", event: "batch_received", alertCount, groupLabels: Object.keys(groupLabels) }, "alert_batch_received");

  for (const a of payload.alerts ?? []) {
    const alert = normalizeOne(a, groupLabels, commonLabels, commonAnnotations);
    const alertType = getAlertTypeKey(alert);
    const resource = alert.labels.instance ?? alert.labels.DBInstanceIdentifier ?? alert.labels.resource;
    log.info(
      { component: "processor", event: "alert_received", fingerprint: alert.fingerprint, status: alert.status, alertType, resource },
      "alert_received"
    );

    const typeConfig = config[alertType];
    if (!typeConfig?.channelId) {
      log.debug({ component: "processor", event: "suppressed", reason: "no_config", alertType, fingerprint: alert.fingerprint }, "alert_suppressed_no_config");
      continue;
    }
    const apiPayload = normalizedToApiPayload(alert, typeConfig);
    await processOneAlertPayload(apiPayload, log);
  }
}
