import type { AlertApiPayload } from "../types/alert.js";
import type { SnsNotificationEnvelope } from "../types/sns.js";
import { getAlertsConfig } from "./config.js";
import { processOneAlertPayload } from "./processor.js";
import type { FastifyBaseLogger } from "fastify";

const DEFAULT_EVENT_NAME = "sns";
const MAX_DESCRIPTION_LEN = 1500;
const VALID_SEVERITIES = ["critical", "high", "warning", "info"] as const;

function normalizeEventName(s: string | undefined): string {
  if (!s?.trim()) return DEFAULT_EVENT_NAME;
  return s.trim().replace(/\s+/g, "_");
}

/**
 * Derive alert rule name (event name) from SNS envelope for config lookup.
 * Order: Subject → MessageAttributes.event_type / rule_name → parsed Message.detail-type / source → default.
 */
export function deriveEventName(envelope: SnsNotificationEnvelope): string {
  if (envelope.Subject?.trim()) return normalizeEventName(envelope.Subject);
  const attrs = envelope.MessageAttributes;
  if (attrs?.event_type?.Value?.trim()) return normalizeEventName(attrs.event_type.Value);
  if (attrs?.rule_name?.Value?.trim()) return normalizeEventName(attrs.rule_name.Value);
  try {
    const msg = JSON.parse(envelope.Message) as unknown;
    if (msg && typeof msg === "object") {
      const o = msg as Record<string, unknown>;
      if (typeof o["detail-type"] === "string" && o["detail-type"]) return normalizeEventName(o["detail-type"]);
      if (typeof o.source === "string" && o.source) return normalizeEventName(o.source);
      if (typeof o.eventName === "string" && o.eventName) return normalizeEventName(o.eventName);
    }
  } catch {
    // ignore
  }
  return DEFAULT_EVENT_NAME;
}

function parseSeverity(envelope: SnsNotificationEnvelope): "critical" | "high" | "warning" | "info" {
  const attrs = envelope.MessageAttributes;
  const fromAttr = attrs?.severity?.Value?.toLowerCase() ?? attrs?.Severity?.Value?.toLowerCase();
  if (fromAttr && VALID_SEVERITIES.includes(fromAttr as (typeof VALID_SEVERITIES)[number])) return fromAttr as (typeof VALID_SEVERITIES)[number];
  try {
    const msg = JSON.parse(envelope.Message) as unknown;
    if (msg && typeof msg === "object") {
      const o = msg as Record<string, unknown>;
      const s = String(o.severity ?? o.Severity ?? "").toLowerCase();
      if (VALID_SEVERITIES.includes(s as (typeof VALID_SEVERITIES)[number])) return s as (typeof VALID_SEVERITIES)[number];
    }
  } catch {
    // ignore
  }
  return "warning";
}

function parseResource(envelope: SnsNotificationEnvelope): string | undefined {
  try {
    const msg = JSON.parse(envelope.Message) as unknown;
    if (msg && typeof msg === "object") {
      const o = msg as Record<string, unknown>;
      if (typeof o.AlarmName === "string") return o.AlarmName;
      const detail = o.detail as Record<string, unknown> | undefined;
      if (detail && typeof detail.resource === "string") return detail.resource;
      const resources = detail?.resources;
      if (Array.isArray(resources) && resources.length > 0) {
        const first = resources[0] as { ARN?: string } | undefined;
        if (first?.ARN) return first.ARN;
      }
    }
  } catch {
    // ignore
  }
  return undefined;
}

/**
 * Detect resolved state from SNS message body.
 * Supports:
 *   - CloudWatch alarm: NewStateValue === "OK"
 *   - EventBridge CloudWatch Alarms: detail.state.value === "OK"
 */
function parseResolvedState(envelope: SnsNotificationEnvelope): { status: "firing" | "resolved"; resolvedAt?: string } {
  try {
    const msg = JSON.parse(envelope.Message) as unknown;
    if (msg && typeof msg === "object") {
      const o = msg as Record<string, unknown>;
      if (o.NewStateValue === "OK") {
        return { status: "resolved", resolvedAt: envelope.Timestamp };
      }
      const detail = o.detail as Record<string, unknown> | undefined;
      if (detail) {
        const state = detail.state as Record<string, unknown> | undefined;
        if (state?.value === "OK") {
          return { status: "resolved", resolvedAt: envelope.Timestamp };
        }
      }
    }
  } catch {
    // ignore unparseable Message
  }
  return { status: "firing" };
}

function buildFieldsFromMessage(message: string): Array<{ name: string; value: string }> {
  const fields: Array<{ name: string; value: string }> = [];
  try {
    const msg = JSON.parse(message) as unknown;
    if (msg && typeof msg === "object") {
      const o = msg as Record<string, unknown>;
      for (const [k, v] of Object.entries(o)) {
        if (v === undefined || v === null) continue;
        const val = typeof v === "object" ? JSON.stringify(v).slice(0, 500) : String(v).slice(0, 500);
        fields.push({ name: k, value: val });
      }
    }
  } catch {
    // ignore
  }
  return fields.slice(0, 20);
}

/**
 * Build a single AlertApiPayload from an SNS Notification envelope.
 */
export function snsEnvelopeToAlertPayload(envelope: SnsNotificationEnvelope): AlertApiPayload | null {
  const eventName = deriveEventName(envelope);
  const config = getAlertsConfig()[eventName];
  if (!config?.channelId) {
    return null;
  }
  const description = envelope.Message.slice(0, MAX_DESCRIPTION_LEN);
  const resource = parseResource(envelope);
  const severity = parseSeverity(envelope);
  const startedAt = envelope.Timestamp ?? new Date().toISOString();
  const fields = buildFieldsFromMessage(envelope.Message);
  const alertId = envelope.MessageId + (resource ? `:${resource.slice(0, 64)}` : "");
  const { status, resolvedAt } = parseResolvedState(envelope);

  const payload: AlertApiPayload = {
    alertId,
    resource,
    title: envelope.Subject?.trim() ? `Alert: ${envelope.Subject.trim()}` : `Alert: ${eventName}`,
    description: description || "No description",
    status,
    severity,
    fields: fields.length > 0 ? fields : undefined,
    startedAt,
    resolvedAt,
    channelId: config.channelId,
    ruleName: eventName,
    thumbnailUrl: config.thumbnailUrl,
    source: "sns",
  };
  return payload;
}

/**
 * Process one SNS Notification envelope: derive event name, build payload, run shared processor.
 */
export async function processSnsNotification(envelope: SnsNotificationEnvelope, log: FastifyBaseLogger): Promise<void> {
  const eventName = deriveEventName(envelope);
  const payload = snsEnvelopeToAlertPayload(envelope);
  if (!payload) {
    log.debug({ component: "sns_processor", event: "no_config", eventName, messageId: envelope.MessageId }, "sns_no_config_for_event");
    return;
  }
  log.info({ component: "sns_processor", event: "processing", eventName, messageId: envelope.MessageId, alertId: payload.alertId }, "sns_notification_processing");
  await processOneAlertPayload(payload, log);
}
