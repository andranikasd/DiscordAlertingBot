/** Per-alert-type config from alerts.json (key = Grafana alert rule name) */
export interface AlertTypeConfig {
  /** Discord channel ID where the bot posts this alert type */
  channelId: string;
  /** Suppress duplicate (same fingerprint) within this many ms */
  suppressWindowMs?: number;
  /** Label keys to show in a compact "Key info" field first */
  importantLabels?: string[];
  /** Label keys to hide from the main Labels section */
  hiddenLabels?: string[];
  /** Optional thumbnail URL for the alert embed */
  thumbnailUrl?: string;
  /** Discord user IDs to mention in order when critical alert is not ack'd/resolved: first after 5m, second after 10m, etc. */
  mentions?: string[];
}

export type AlertsConfig = Record<string, AlertTypeConfig>;
