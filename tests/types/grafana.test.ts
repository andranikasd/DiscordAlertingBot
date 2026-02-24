import { describe, it, expect } from "vitest";
import { grafanaAlertSchema } from "../../src/types/grafana.js";

describe("grafanaAlertSchema", () => {
  it("accepts minimal valid payload with empty alerts", () => {
    const result = grafanaAlertSchema.safeParse({ alerts: [] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.alerts).toEqual([]);
    }
  });

  it("accepts full Grafana-style payload", () => {
    const payload = {
      alerts: [
        {
          status: "firing",
          labels: { alertname: "RdsCpuUtilizationHigh", instance: "db-1" },
          annotations: { summary: "RDS CPU high" },
          fingerprint: "fp1",
        },
      ],
      groupLabels: {},
      commonLabels: {},
      commonAnnotations: {},
    };
    const result = grafanaAlertSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.alerts).toHaveLength(1);
      expect(result.data.alerts[0].labels.alertname).toBe("RdsCpuUtilizationHigh");
    }
  });

  it("rejects non-array alerts", () => {
    const result = grafanaAlertSchema.safeParse({ alerts: "not-array" });
    expect(result.success).toBe(false);
  });
});