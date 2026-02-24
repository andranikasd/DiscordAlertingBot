/**
 * Tests for renderStatusTableImage.
 *
 * The module loads "canvas" via `createRequire(import.meta.url)` — Node's native CJS
 * require() — which Vitest's vi.mock() does NOT intercept. Tests therefore run against
 * the real canvas rendering path (canvas is an optional dependency installed in this
 * project). All reachable rendering branches are exercised; the two unreachable null
 * paths (canvas package absent / getContext returning null) are noted in comments.
 */
import { describe, it, expect } from "vitest";
import { renderStatusTableImage } from "../../src/discord/status-table-image.js";
import type { AlertStatusRow } from "../../src/store/postgres.js";

/** PNG magic bytes header */
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function makeRow(overrides: Partial<AlertStatusRow> = {}): AlertStatusRow {
  return {
    alert_id: "alert-001",
    rule_name: "HighCPU",
    resource: null,
    severity: "critical",
    last_triggered: new Date("2024-06-01T12:00:00Z"),
    acknowledged_by: null,
    resolved_by: null,
    status: "firing",
    ...overrides,
  };
}

describe("renderStatusTableImage", () => {
  it("returns a PNG Buffer for empty rows list", () => {
    const result = renderStatusTableImage([]);
    expect(result).toBeInstanceOf(Buffer);
    expect(result!.subarray(0, 8)).toEqual(PNG_HEADER);
  });

  it("returns a PNG Buffer for a single row with all fields", () => {
    const result = renderStatusTableImage([makeRow()]);
    expect(result).toBeInstanceOf(Buffer);
    expect(result!.subarray(0, 8)).toEqual(PNG_HEADER);
  });

  it("returns a PNG Buffer when acknowledged_by and resolved_by are set", () => {
    const result = renderStatusTableImage([
      makeRow({ acknowledged_by: "user-1", resolved_by: "user-2" }),
    ]);
    expect(result).toBeInstanceOf(Buffer);
  });

  it("returns a PNG Buffer when rule_name is absent (uses alert_id fallback)", () => {
    const result = renderStatusTableImage([
      makeRow({ rule_name: null as unknown as string, alert_id: "abcdefgh-1234" }),
    ]);
    expect(result).toBeInstanceOf(Buffer);
  });

  it("returns a PNG Buffer when severity is null", () => {
    const result = renderStatusTableImage([
      makeRow({ severity: null as unknown as string }),
    ]);
    expect(result).toBeInstanceOf(Buffer);
  });

  it("returns a PNG Buffer with a very long rule_name (exercises truncation)", () => {
    const result = renderStatusTableImage([
      makeRow({ rule_name: "A".repeat(100) }),
    ]);
    expect(result).toBeInstanceOf(Buffer);
  });

  it("returns a PNG Buffer for multiple rows (exercises alternating row colours)", () => {
    const rows = [
      makeRow({ rule_name: "HighCPU" }),
      makeRow({ rule_name: "LowDisk" }),
      makeRow({ rule_name: "HighMem" }),
    ];
    const result = renderStatusTableImage(rows);
    expect(result).toBeInstanceOf(Buffer);
  });

  it("slices to MAX_ROWS (25) without error when more than 25 rows supplied", () => {
    const rows = Array.from({ length: 30 }, (_, i) =>
      makeRow({ alert_id: `id-${i}`, rule_name: `Rule${i}` })
    );
    const result = renderStatusTableImage(rows);
    expect(result).toBeInstanceOf(Buffer);
  });

  it("handles a Date object for last_triggered", () => {
    const result = renderStatusTableImage([
      makeRow({ last_triggered: new Date("2024-01-15T08:45:00Z") }),
    ]);
    expect(result).toBeInstanceOf(Buffer);
  });

  it("handles a string timestamp for last_triggered (non-Date path)", () => {
    const result = renderStatusTableImage([
      makeRow({ last_triggered: "2024-01-15T08:45:00Z" as unknown as Date }),
    ]);
    expect(result).toBeInstanceOf(Buffer);
  });

  it("handles null last_triggered gracefully", () => {
    const result = renderStatusTableImage([
      makeRow({ last_triggered: null as unknown as Date }),
    ]);
    expect(result).toBeInstanceOf(Buffer);
  });

  it("returns a larger buffer for more rows than for zero rows", () => {
    const empty = renderStatusTableImage([]);
    const withRows = renderStatusTableImage(
      Array.from({ length: 10 }, (_, i) => makeRow({ rule_name: `Rule${i}` }))
    );
    expect(empty).toBeInstanceOf(Buffer);
    expect(withRows).toBeInstanceOf(Buffer);
    // More rows → taller canvas → larger PNG
    expect(withRows!.length).toBeGreaterThan(empty!.length);
  });

  it("returns a Buffer when severity is a long string (exercises severity truncation)", () => {
    const result = renderStatusTableImage([
      makeRow({ severity: "critical-very-long-severity-value" }),
    ]);
    expect(result).toBeInstanceOf(Buffer);
  });
});