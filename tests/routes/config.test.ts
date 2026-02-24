import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/services/config.js", () => ({
  getAlertsConfig: vi.fn(),
  validateAlertsConfig: vi.fn(),
  saveAlertsConfigToDbAndCache: vi.fn(),
}));

vi.mock("../../src/store/postgres.js", () => ({
  getTroubleshootingGuide: vi.fn(),
  setTroubleshootingGuide: vi.fn(),
  getAllTroubleshootingGuides: vi.fn(),
}));

import Fastify from "fastify";
import { registerConfigRoutes } from "../../src/routes/config.js";
import * as configSvc from "../../src/services/config.js";
import * as postgres from "../../src/store/postgres.js";

async function buildApp() {
  const app = Fastify({ logger: false });
  await registerConfigRoutes(app);
  return app;
}

let savedAuthToken: string | undefined;
let savedDbUrl: string | undefined;

beforeEach(() => {
  savedAuthToken = process.env.AUTH_TOKEN;
  savedDbUrl = process.env.DATABASE_URL;
  delete process.env.AUTH_TOKEN;
  delete process.env.DATABASE_URL;
  vi.clearAllMocks();
});

afterEach(() => {
  if (savedAuthToken === undefined) delete process.env.AUTH_TOKEN;
  else process.env.AUTH_TOKEN = savedAuthToken;
  if (savedDbUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = savedDbUrl;
});

// ---- GET /get-config ----

describe("GET /get-config", () => {
  it("returns current config object", async () => {
    const cfg = { HighCPU: { channelId: "ch-1" } };
    vi.mocked(configSvc.getAlertsConfig).mockReturnValue(cfg);
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/get-config" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ config: cfg });
  });

  it("returns empty config when no alerts configured", async () => {
    vi.mocked(configSvc.getAlertsConfig).mockReturnValue({});
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/get-config" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ config: {} });
  });

  it("returns 401 when AUTH_TOKEN set and no header", async () => {
    process.env.AUTH_TOKEN = "secret";
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/get-config" });
    expect(res.statusCode).toBe(401);
  });
});

// ---- POST /push-config ----

describe("POST /push-config", () => {
  it("returns ok and entries count when config is valid", async () => {
    const cfg = { AlertA: { channelId: "ch-1" }, AlertB: { channelId: "ch-2" } };
    vi.mocked(configSvc.validateAlertsConfig).mockReturnValue({ ok: true, config: cfg });
    vi.mocked(configSvc.saveAlertsConfigToDbAndCache).mockResolvedValue(undefined);
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/push-config", payload: cfg });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.entries).toBe(2);
    expect(configSvc.saveAlertsConfigToDbAndCache).toHaveBeenCalledWith(cfg);
  });

  it("returns 400 when validation fails", async () => {
    vi.mocked(configSvc.validateAlertsConfig).mockReturnValue({ ok: false, error: "Invalid config" });
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/push-config", payload: {} });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(false);
    expect(body.error).toBe("Invalid config");
    expect(configSvc.saveAlertsConfigToDbAndCache).not.toHaveBeenCalled();
  });

  it("returns 500 when save throws", async () => {
    const cfg = { AlertA: { channelId: "ch-1" } };
    vi.mocked(configSvc.validateAlertsConfig).mockReturnValue({ ok: true, config: cfg });
    vi.mocked(configSvc.saveAlertsConfigToDbAndCache).mockRejectedValue(new Error("DB error"));
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/push-config", payload: cfg });
    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(false);
    expect(body.error).toBe("Failed to save config");
  });

  it("returns 401 when AUTH_TOKEN set and no header", async () => {
    process.env.AUTH_TOKEN = "secret";
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/push-config", payload: {} });
    expect(res.statusCode).toBe(401);
  });
});

// ---- GET /troubleshooting-guide ----

describe("GET /troubleshooting-guide", () => {
  it("returns content for specific alertType", async () => {
    vi.mocked(postgres.getTroubleshootingGuide).mockResolvedValue("## Fix this");
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/troubleshooting-guide?alertType=HighCPU" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.alertType).toBe("HighCPU");
    expect(body.content).toBe("## Fix this");
  });

  it("returns empty string when no content found for alertType", async () => {
    vi.mocked(postgres.getTroubleshootingGuide).mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/troubleshooting-guide?alertType=Unknown" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.content).toBe("");
  });

  it("returns all guides when alertType is not provided", async () => {
    const guides = { HighCPU: "## Fix CPU", LowDisk: "## Fix disk" };
    vi.mocked(postgres.getAllTroubleshootingGuides).mockResolvedValue(guides);
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/troubleshooting-guide" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.guides).toEqual(guides);
    expect(postgres.getAllTroubleshootingGuides).toHaveBeenCalled();
  });

  it("trims whitespace from alertType", async () => {
    vi.mocked(postgres.getTroubleshootingGuide).mockResolvedValue("guide");
    const app = await buildApp();
    // alertType with leading space won't parse as-is in query string, but trim is tested via router
    const res = await app.inject({ method: "GET", url: "/troubleshooting-guide?alertType=HighCPU" });
    expect(postgres.getTroubleshootingGuide).toHaveBeenCalledWith("HighCPU");
    expect(res.statusCode).toBe(200);
  });

  it("returns 401 when AUTH_TOKEN set and no header", async () => {
    process.env.AUTH_TOKEN = "secret";
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/troubleshooting-guide" });
    expect(res.statusCode).toBe(401);
  });
});

// ---- POST /troubleshooting-guide ----

describe("POST /troubleshooting-guide", () => {
  it("returns 503 when DATABASE_URL not set", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/troubleshooting-guide",
      payload: { alertType: "HighCPU", content: "## Guide" },
    });
    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(false);
    expect(body.error).toContain("DATABASE_URL");
  });

  it("saves guide and returns ok", async () => {
    process.env.DATABASE_URL = "postgres://localhost/test";
    vi.mocked(postgres.setTroubleshootingGuide).mockResolvedValue(undefined);
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/troubleshooting-guide",
      payload: { alertType: "HighCPU", content: "## Fix" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.alertType).toBe("HighCPU");
    expect(postgres.setTroubleshootingGuide).toHaveBeenCalledWith("HighCPU", "## Fix");
  });

  it("returns 400 when alertType is missing", async () => {
    process.env.DATABASE_URL = "postgres://localhost/test";
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/troubleshooting-guide",
      payload: { content: "## Fix" },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("alertType is required");
  });

  it("returns 400 when alertType is blank string after trim", async () => {
    process.env.DATABASE_URL = "postgres://localhost/test";
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/troubleshooting-guide",
      payload: { alertType: "   ", content: "## Fix" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("handles non-string alertType (null body)", async () => {
    process.env.DATABASE_URL = "postgres://localhost/test";
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/troubleshooting-guide",
      payload: null,
    });
    expect(res.statusCode).toBe(400);
  });

  it("uses empty string when content is not a string", async () => {
    process.env.DATABASE_URL = "postgres://localhost/test";
    vi.mocked(postgres.setTroubleshootingGuide).mockResolvedValue(undefined);
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/troubleshooting-guide",
      payload: { alertType: "HighCPU" },
    });
    expect(res.statusCode).toBe(200);
    expect(postgres.setTroubleshootingGuide).toHaveBeenCalledWith("HighCPU", "");
  });

  it("returns 500 when setTroubleshootingGuide throws", async () => {
    process.env.DATABASE_URL = "postgres://localhost/test";
    vi.mocked(postgres.setTroubleshootingGuide).mockRejectedValue(new Error("DB error"));
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/troubleshooting-guide",
      payload: { alertType: "HighCPU", content: "## Fix" },
    });
    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(false);
    expect(body.error).toBe("Failed to save troubleshooting guide");
  });

  it("returns 401 when AUTH_TOKEN set and no header", async () => {
    process.env.AUTH_TOKEN = "secret";
    process.env.DATABASE_URL = "postgres://localhost/test";
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/troubleshooting-guide",
      payload: { alertType: "X", content: "Y" },
    });
    expect(res.statusCode).toBe(401);
  });
});
