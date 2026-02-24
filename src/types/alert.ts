import { z } from "zod";

/** Payload from Alert Processor (POST /alerts) */
export const alertApiSchema = z.object({
  alertId: z.string(),
  resource: z.string().optional(),
  title: z.string(),
  description: z.string().optional(),
  status: z.enum(["firing", "resolved", "acknowledged"]),
  severity: z.enum(["critical", "high", "warning", "info"]).optional(),
  fields: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
  startedAt: z.string(),
  resolvedAt: z.string().optional(),
  generatorURL: z.string().optional(),
  channelId: z.string(),
  /** Grafana rule name (e.g. RdsCpuUtilizationHigh) for troubleshooting guide lookup */
  ruleName: z.string().optional(),
  /** Optional thumbnail URL for the embed */
  thumbnailUrl: z.string().optional(),
  /**
   * Alert source — identifies which ingestion pipeline produced this payload.
   * Set by each source processor: "grafana", "sns", etc.
   * Stored in the audit log so ops can filter by origin.
   */
  source: z.string().optional(),
});

export type AlertApiPayload = z.infer<typeof alertApiSchema>;

export type AlertState = "firing" | "acknowledged" | "resolved";

export interface StoredAlert {
  messageId: string;
  channelId: string;
  threadId?: string;
  state: AlertState;
  updatedAt: string;
  /** Grafana rule name for troubleshooting guide lookup */
  ruleName?: string;
  /** Discord user ID who acknowledged */
  acknowledgedBy?: string;
  /** Discord user ID who resolved */
  resolvedBy?: string;
  /** Severity for escalation (critical → mentions) */
  severity?: string;
  /** Next mention index (0 = first user after 5m, 1 = second after 10m, ...) */
  mentionLevel?: number;
  /** When the alert was resolved (ISO timestamp); used to decide new vs reminder when it fires again */
  resolvedAt?: string;
  /** When the alert was acknowledged (ISO timestamp); used for >1h reminder when it fires again */
  acknowledgedAt?: string;
}

/** Discord embed color by severity (decimal) */
export const SEVERITY_COLORS: Record<string, number> = {
  critical: 0xe74c3c, // red
  high: 0xe67e22,    // orange
  warning: 0xf1c40f, // yellow
  info: 0x3498db,    // blue
  resolved: 0x2ecc71, // green
};
