import type { AlertApiPayload } from "../types/alert.js";
import { SEVERITY_COLORS } from "../types/alert.js";

export interface EmbedData {
  title: string;
  description?: string;
  color: number;
  fields: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: { text: string };
  timestamp?: string;
  thumbnail?: { url: string };
}

const EMBED_LIMITS = { title: 256, description: 4096, fieldValue: 1024 };

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function severityColor(payload: AlertApiPayload): number {
  if (payload.status === "resolved") return SEVERITY_COLORS.resolved;
  const sev = (payload.severity ?? "warning").toLowerCase();
  return SEVERITY_COLORS[sev] ?? SEVERITY_COLORS.warning;
}

type EmbedField = { name: string; value: string; inline?: boolean | null };
type ResolvedField = { name: string; value: string; inline: boolean };

/**
 * Build the resolved state field list from an existing embed's fields.
 * Replaces Status / Resolved-by / Resolved-at fields with fresh values.
 * Pure function — no side effects.
 */
export function buildResolvedFields(
  existingFields: EmbedField[],
  userId: string,
  resolvedAt: string
): ResolvedField[] {
  const filtered = existingFields.filter(
    (f) => f.name !== "Status" && f.name !== "Resolved by" && f.name !== "Resolved at"
  );
  return [
    ...filtered.map((f) => ({ name: f.name, value: f.value, inline: f.inline ?? true })),
    { name: "Status", value: "resolved", inline: true },
    { name: "Resolved by", value: `<@${userId}>`, inline: true },
    { name: "Resolved at", value: resolvedAt.slice(0, 19).replace("T", " "), inline: true },
  ];
}

/**
 * Build the acknowledged state field list from an existing embed's fields.
 * Replaces Status / Acknowledged-by fields with fresh values.
 * Pure function — no side effects.
 */
export function buildAcknowledgedFields(
  existingFields: EmbedField[],
  userId: string
): ResolvedField[] {
  const filtered = existingFields.filter(
    (f) => f.name !== "Status" && f.name !== "Acknowledged by"
  );
  return [
    ...filtered.map((f) => ({ name: f.name, value: f.value, inline: f.inline ?? true })),
    { name: "Status", value: "acknowledged", inline: true },
    { name: "Acknowledged by", value: `<@${userId}>`, inline: true },
  ];
}

export function buildAlertEmbed(payload: AlertApiPayload): EmbedData {
  const color = severityColor(payload);
  const title = truncate(payload.title, EMBED_LIMITS.title);
  const description = payload.description
    ? truncate(payload.description, EMBED_LIMITS.description)
    : undefined;

  const fields: Array<{ name: string; value: string; inline?: boolean }> = [];
  if (payload.fields?.length) {
    for (const f of payload.fields) {
      fields.push({
        name: truncate(f.name, 256),
        value: truncate(f.value, EMBED_LIMITS.fieldValue),
        inline: true,
      });
    }
  }
  fields.push(
    { name: "Status", value: payload.status, inline: true },
    { name: "Started", value: payload.startedAt, inline: true }
  );
  if (payload.resolvedAt) {
    fields.push({ name: "Resolved", value: payload.resolvedAt, inline: true });
  }
  if (payload.generatorURL) {
    fields.push({ name: "Link", value: truncate(payload.generatorURL, EMBED_LIMITS.fieldValue), inline: false });
  }

  const footer = `Alert ID: ${payload.alertId}${payload.resource ? ` • ${payload.resource}` : ""}`;

  const data: EmbedData = {
    title,
    description,
    color,
    fields,
    footer: { text: truncate(footer, 2048) },
    timestamp: new Date(payload.startedAt).toISOString(),
  };
  if (payload.thumbnailUrl?.trim()) {
    data.thumbnail = { url: payload.thumbnailUrl.trim().slice(0, 2048) };
  }
  return data;
}
