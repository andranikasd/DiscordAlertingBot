import { describe, it, expect } from "vitest";
import { buildResolvedFields, buildAcknowledgedFields } from "../../src/discord/embed.js";

const baseFields = [
  { name: "Status", value: "firing", inline: true },
  { name: "Started", value: "2024-01-15T10:00:00Z", inline: true },
  { name: "severity", value: "critical", inline: true },
];

describe("buildResolvedFields", () => {
  it("removes the old Status field", () => {
    const fields = buildResolvedFields(baseFields, "user-1", "2024-01-15T11:00:00Z");
    const statusFields = fields.filter((f) => f.name === "Status");
    expect(statusFields).toHaveLength(1);
    expect(statusFields[0].value).toBe("resolved");
  });

  it("removes Resolved by if already present", () => {
    const existing = [...baseFields, { name: "Resolved by", value: "<@old>", inline: true }];
    const fields = buildResolvedFields(existing, "user-2", "2024-01-15T11:00:00Z");
    expect(fields.filter((f) => f.name === "Resolved by")).toHaveLength(1);
  });

  it("removes Resolved at if already present", () => {
    const existing = [...baseFields, { name: "Resolved at", value: "old-time", inline: true }];
    const fields = buildResolvedFields(existing, "user-3", "2024-01-15T11:00:00Z");
    expect(fields.filter((f) => f.name === "Resolved at")).toHaveLength(1);
  });

  it("appends Resolved by with user mention", () => {
    const fields = buildResolvedFields(baseFields, "user-42", "2024-01-15T11:00:00Z");
    const resolvedBy = fields.find((f) => f.name === "Resolved by");
    expect(resolvedBy?.value).toBe("<@user-42>");
  });

  it("formats Resolved at as YYYY-MM-DD HH:MM:SS (no T separator)", () => {
    const fields = buildResolvedFields(baseFields, "user-1", "2024-01-15T11:30:45Z");
    const resolvedAt = fields.find((f) => f.name === "Resolved at");
    expect(resolvedAt?.value).toBe("2024-01-15 11:30:45");
  });

  it("preserves non-status fields", () => {
    const fields = buildResolvedFields(baseFields, "user-1", "2024-01-15T11:00:00Z");
    expect(fields.some((f) => f.name === "Started")).toBe(true);
    expect(fields.some((f) => f.name === "severity")).toBe(true);
  });

  it("all returned fields have inline: boolean (not null/undefined)", () => {
    const withNull = [{ name: "env", value: "prod", inline: null }];
    const fields = buildResolvedFields(withNull, "user-1", "2024-01-15T11:00:00Z");
    for (const f of fields) {
      expect(typeof f.inline).toBe("boolean");
    }
  });

  it("Status, Resolved by, Resolved at are inline: true", () => {
    const fields = buildResolvedFields(baseFields, "user-1", "2024-01-15T11:00:00Z");
    for (const name of ["Status", "Resolved by", "Resolved at"]) {
      expect(fields.find((f) => f.name === name)?.inline).toBe(true);
    }
  });
});

describe("buildAcknowledgedFields", () => {
  it("removes the old Status field and adds acknowledged", () => {
    const fields = buildAcknowledgedFields(baseFields, "user-1");
    const statusFields = fields.filter((f) => f.name === "Status");
    expect(statusFields).toHaveLength(1);
    expect(statusFields[0].value).toBe("acknowledged");
  });

  it("removes Acknowledged by if already present", () => {
    const existing = [...baseFields, { name: "Acknowledged by", value: "<@old>", inline: true }];
    const fields = buildAcknowledgedFields(existing, "user-2");
    expect(fields.filter((f) => f.name === "Acknowledged by")).toHaveLength(1);
  });

  it("appends Acknowledged by with user mention", () => {
    const fields = buildAcknowledgedFields(baseFields, "user-99");
    const ackBy = fields.find((f) => f.name === "Acknowledged by");
    expect(ackBy?.value).toBe("<@user-99>");
  });

  it("preserves non-status fields", () => {
    const fields = buildAcknowledgedFields(baseFields, "user-1");
    expect(fields.some((f) => f.name === "Started")).toBe(true);
    expect(fields.some((f) => f.name === "severity")).toBe(true);
  });

  it("does not include Resolved by or Resolved at", () => {
    const fields = buildAcknowledgedFields(baseFields, "user-1");
    expect(fields.some((f) => f.name === "Resolved by")).toBe(false);
    expect(fields.some((f) => f.name === "Resolved at")).toBe(false);
  });

  it("all returned fields have inline: boolean (not null/undefined)", () => {
    const withNull = [{ name: "env", value: "prod", inline: null }];
    const fields = buildAcknowledgedFields(withNull, "user-1");
    for (const f of fields) {
      expect(typeof f.inline).toBe("boolean");
    }
  });

  it("Status and Acknowledged by are inline: true", () => {
    const fields = buildAcknowledgedFields(baseFields, "user-1");
    for (const name of ["Status", "Acknowledged by"]) {
      expect(fields.find((f) => f.name === name)?.inline).toBe(true);
    }
  });
});