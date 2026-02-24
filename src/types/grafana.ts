import { z } from "zod";

/** Grafana webhook payload (Alerting / Unified Alerting) */
export const grafanaAlertSchema = z.object({
  receiver: z.string().optional(),
  status: z.string().optional(),
  alerts: z.array(
    z.object({
      status: z.string().optional(),
      labels: z.record(z.string()).optional().default({}),
      annotations: z.record(z.string()).optional().default({}),
      startsAt: z.string().optional(),
      endsAt: z.string().optional(),
      generatorURL: z.string().optional(),
      fingerprint: z.string().optional(),
    })
  ),
  groupLabels: z.record(z.string()).optional().default({}),
  commonLabels: z.record(z.string()).optional().default({}),
  commonAnnotations: z.record(z.string()).optional().default({}),
  externalURL: z.string().optional(),
  version: z.string().optional(),
  groupKey: z.string().optional(),
  truncatedAlerts: z.number().optional(),
});

export type GrafanaAlertPayload = z.infer<typeof grafanaAlertSchema>;
export type SingleAlert = GrafanaAlertPayload["alerts"][number];

/** Normalized internal alert for processing */
export interface NormalizedAlert {
  id: string;
  fingerprint: string;
  status: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  startsAt: string;
  endsAt: string;
  generatorURL?: string;
  groupLabels: Record<string, string>;
  commonLabels: Record<string, string>;
  commonAnnotations: Record<string, string>;
}
