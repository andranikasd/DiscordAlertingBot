import { createRequire } from "module";
import type { AlertStatusRow } from "../store/postgres.js";

const requireMod = createRequire(import.meta.url);

/** Minimal type for createCanvas return; avoids referencing "canvas" so build works without it. */
type CreateCanvasFn = (width: number, height: number) => {
  getContext(contextId: "2d"): Ctx2D | null;
  toBuffer(mimeType?: string): Buffer;
};

/** Lazy load canvas (optional dependency; may be missing in Docker). */
function getCreateCanvas(): CreateCanvasFn | null {
  try {
    const canvas = requireMod("canvas");
    return canvas.createCanvas ?? null;
  } catch {
    return null;
  }
}

const PAD = 16;
const ROW_HEIGHT = 24;
const FONT_SIZE = 14;
const FONT = `${FONT_SIZE}px sans-serif`;

/** Pixel widths for columns (Alert name, Severity, Last triggered, Ack, Resolved). */
const COLS = [200, 80, 140, 50, 70] as const;
const TOTAL_WIDTH = COLS.reduce((a, b) => a + b, 0) + PAD * 2;
const HEADER_HEIGHT = ROW_HEIGHT + 8;
const SEP_HEIGHT = 2;
const MAX_ROWS = 25;

/** Context-like type for measuring and drawing text (canvas 2d context). */
interface Ctx2D {
  font: string;
  textBaseline: string;
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  measureText(text: string): { width: number };
  fillRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
}
function truncate(ctx: Ctx2D, text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  const t = String(text ?? "").trim() || "—";
  if (ctx.measureText(t).width <= maxWidth) return t;
  const ellipsis = "…";
  let s = t;
  while (s.length > 0 && ctx.measureText(s + ellipsis).width > maxWidth) s = s.slice(0, -1);
  return s ? s + ellipsis : ellipsis;
}

function formatTime(d: Date | unknown): string {
  if (d instanceof Date) return d.toISOString().replace("T", " ").slice(0, 16);
  return String(d ?? "").slice(0, 16) || "—";
}

/**
 * Renders the status table as a PNG image. Returns buffer or null on failure.
 */
export function renderStatusTableImage(rows: AlertStatusRow[]): Buffer | null {
  const createCanvas = getCreateCanvas();
  if (!createCanvas) return null;
  try {
    const displayRows = rows.slice(0, MAX_ROWS);
    const rowCount = displayRows.length;
    const tableHeight =
      PAD + HEADER_HEIGHT + SEP_HEIGHT + (rowCount === 0 ? ROW_HEIGHT : rowCount * ROW_HEIGHT) + PAD;
    const width = TOTAL_WIDTH;
    const height = tableHeight;

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    ctx.font = FONT;
    ctx.textBaseline = "middle";

    // Background
    ctx.fillStyle = "#2f3136";
    ctx.fillRect(0, 0, width, height);

    let y = PAD;

    // Header row
    ctx.fillStyle = "#1e2124";
    ctx.fillRect(0, 0, width, HEADER_HEIGHT + PAD);
    ctx.fillStyle = "#ffffff";
    ctx.font = `bold ${FONT_SIZE}px sans-serif`;
    let x = PAD;
    const headers = ["Alert name", "Severity", "Last triggered", "Ack", "Resolved"];
    for (let i = 0; i < COLS.length; i++) {
      ctx.fillText(truncate(ctx, headers[i], COLS[i] - 4), x, y + ROW_HEIGHT / 2);
      x += COLS[i];
    }
    y += HEADER_HEIGHT;

    // Separator line
    ctx.strokeStyle = "#4f545c";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PAD, y);
    ctx.lineTo(width - PAD, y);
    ctx.stroke();
    y += SEP_HEIGHT;

    if (rowCount === 0) {
      ctx.fillStyle = "#b9bbbe";
      ctx.font = FONT;
      ctx.fillText("No alerts in the last 24 hours.", PAD, y + ROW_HEIGHT / 2);
    } else {
      ctx.font = FONT;
      for (let r = 0; r < rowCount; r++) {
        const row = displayRows[r];
        const alertName = row.rule_name?.trim() || `(id: ${row.alert_id.slice(0, 8)})`;
        const sev = (row.severity ?? "—").trim();
        const at = formatTime(row.last_triggered);
        const ack = row.acknowledged_by ? "Yes" : "—";
        const res = row.resolved_by ? "Yes" : "—";

        if (r % 2 === 1) {
          ctx.fillStyle = "#36393f";
          ctx.fillRect(0, y, width, ROW_HEIGHT);
        }
        ctx.fillStyle = "#dcddde";
        x = PAD;
        const cells = [alertName, sev, at, ack, res];
        for (let i = 0; i < COLS.length; i++) {
          const cellText = truncate(ctx, cells[i], COLS[i] - 4);
          ctx.fillText(cellText, x, y + ROW_HEIGHT / 2);
          x += COLS[i];
        }
        y += ROW_HEIGHT;
      }
    }

    return canvas.toBuffer("image/png");
  } catch {
    return null;
  }
}
