import { describe, it, expect } from "vitest";
import { buildAlertEmbed } from "../../src/discord/embed.js";
import { SEVERITY_COLORS } from "../../src/types/alert.js";
import type { AlertApiPayload } from "../../src/types/alert.js";

const base: AlertApiPayload = {
  alertId: "fp-test-1",
  title: "Test Alert",
  status: "firing",
  severity: "warning",
  startedAt: "2024-01-15T10:00:00Z",
  channelId: "ch-123",
};

describe("buildAlertEmbed", () => {
  describe("colors", () => {
    it("uses critical color for critical firing alerts", () => {
      const embed = buildAlertEmbed({ ...base, severity: "critical" });
      expect(embed.color).toBe(SEVERITY_COLORS.critical);
    });

    it("uses high color for high severity", () => {
      const embed = buildAlertEmbed({ ...base, severity: "high" });
      expect(embed.color).toBe(SEVERITY_COLORS.high);
    });

    it("uses warning color for warning severity", () => {
      const embed = buildAlertEmbed({ ...base, severity: "warning" });
      expect(embed.color).toBe(SEVERITY_COLORS.warning);
    });

    it("uses resolved color when status is resolved regardless of severity", () => {
      const embed = buildAlertEmbed({ ...base, status: "resolved", severity: "critical" });
      expect(embed.color).toBe(SEVERITY_COLORS.resolved);
    });
  });

  describe("truncation", () => {
    it("truncates title to 256 characters", () => {
      const embed = buildAlertEmbed({ ...base, title: "A".repeat(300) });
      expect(embed.title.length).toBeLessThanOrEqual(256);
      expect(embed.title.endsWith("…")).toBe(true);
    });

    it("does not truncate a title within the limit", () => {
      const embed = buildAlertEmbed({ ...base, title: "Short title" });
      expect(embed.title).toBe("Short title");
    });

    it("truncates description to 4096 characters", () => {
      const embed = buildAlertEmbed({ ...base, description: "B".repeat(5000) });
      expect(embed.description!.length).toBeLessThanOrEqual(4096);
      expect(embed.description!.endsWith("…")).toBe(true);
    });

    it("truncates field values to 1024 characters", () => {
      const embed = buildAlertEmbed({ ...base, fields: [{ name: "env", value: "C".repeat(2000) }] });
      const field = embed.fields.find((f) => f.name === "env");
      expect(field?.value.length).toBeLessThanOrEqual(1024);
      expect(field?.value.endsWith("…")).toBe(true);
    });
  });

  describe("required fields", () => {
    it("always includes Status field", () => {
      const embed = buildAlertEmbed(base);
      expect(embed.fields.some((f) => f.name === "Status" && f.value === "firing")).toBe(true);
    });

    it("always includes Started field", () => {
      const embed = buildAlertEmbed(base);
      expect(embed.fields.some((f) => f.name === "Started")).toBe(true);
    });

    it("Status value is 'resolved' for resolved alerts", () => {
      const embed = buildAlertEmbed({ ...base, status: "resolved" });
      const statusField = embed.fields.find((f) => f.name === "Status");
      expect(statusField?.value).toBe("resolved");
    });
  });

  describe("optional fields", () => {
    it("includes Resolved field when resolvedAt is set", () => {
      const embed = buildAlertEmbed({ ...base, resolvedAt: "2024-01-15T11:00:00Z" });
      expect(embed.fields.some((f) => f.name === "Resolved")).toBe(true);
    });

    it("omits Resolved field when resolvedAt is not set", () => {
      const embed = buildAlertEmbed(base);
      expect(embed.fields.some((f) => f.name === "Resolved")).toBe(false);
    });

    it("includes Link field when generatorURL is set", () => {
      const embed = buildAlertEmbed({ ...base, generatorURL: "https://grafana.example.com/alert/1" });
      expect(embed.fields.some((f) => f.name === "Link")).toBe(true);
    });

    it("omits Link field when generatorURL is not set", () => {
      const embed = buildAlertEmbed(base);
      expect(embed.fields.some((f) => f.name === "Link")).toBe(false);
    });
  });

  describe("footer", () => {
    it("includes alertId in footer", () => {
      const embed = buildAlertEmbed(base);
      expect(embed.footer?.text).toContain("fp-test-1");
    });

    it("includes resource in footer when present", () => {
      const embed = buildAlertEmbed({ ...base, resource: "prod-db-1" });
      expect(embed.footer?.text).toContain("prod-db-1");
    });

    it("omits resource separator when resource is absent", () => {
      const embed = buildAlertEmbed(base);
      expect(embed.footer?.text).not.toContain("•");
    });
  });

  describe("thumbnail", () => {
    it("sets thumbnail when thumbnailUrl is provided", () => {
      const embed = buildAlertEmbed({ ...base, thumbnailUrl: "https://example.com/icon.png" });
      expect(embed.thumbnail?.url).toBe("https://example.com/icon.png");
    });

    it("omits thumbnail when thumbnailUrl is empty string", () => {
      const embed = buildAlertEmbed({ ...base, thumbnailUrl: "" });
      expect(embed.thumbnail).toBeUndefined();
    });

    it("omits thumbnail when thumbnailUrl is whitespace only", () => {
      const embed = buildAlertEmbed({ ...base, thumbnailUrl: "   " });
      expect(embed.thumbnail).toBeUndefined();
    });

    it("omits thumbnail when not provided", () => {
      const embed = buildAlertEmbed(base);
      expect(embed.thumbnail).toBeUndefined();
    });
  });

  describe("description", () => {
    it("sets description when provided", () => {
      const embed = buildAlertEmbed({ ...base, description: "Something went wrong" });
      expect(embed.description).toBe("Something went wrong");
    });

    it("omits description when not provided", () => {
      const embed = buildAlertEmbed(base);
      expect(embed.description).toBeUndefined();
    });
  });

  describe("timestamp", () => {
    it("sets timestamp from startedAt", () => {
      const embed = buildAlertEmbed(base);
      expect(embed.timestamp).toBe("2024-01-15T10:00:00.000Z");
    });
  });

  describe("custom fields", () => {
    it("includes all payload fields before Status and Started", () => {
      const embed = buildAlertEmbed({
        ...base,
        fields: [
          { name: "severity", value: "critical" },
          { name: "instance", value: "host-1" },
        ],
      });
      const names = embed.fields.map((f) => f.name);
      expect(names).toContain("severity");
      expect(names).toContain("instance");
    });
  });
});