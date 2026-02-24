import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/services/processor.js", () => ({
  processAlerts: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/services/config.js", () => ({
  reloadAlertsConfigSafe: vi.fn(),
}));

import Fastify from "fastify";
import { registerAlertsRoutes } from "../../src/routes/alerts.js";
import * as processor from "../../src/services/processor.js";
import * as config from "../../src/services/config.js";

async function buildApp() {
  const app = Fastify({ logger: false });
  await registerAlertsRoutes(app);
  return app;
}

let savedAuthToken: string | undefined;

beforeEach(() => {
  savedAuthToken = process.env.AUTH_TOKEN;
  delete process.env.AUTH_TOKEN;
  vi.clearAllMocks();
});

afterEach(() => {
  if (savedAuthToken === undefined) delete process.env.AUTH_TOKEN;
  else process.env.AUTH_TOKEN = savedAuthToken;
});

describe("POST /alerts", () => {
  it("returns 200 and fires processAlerts in background", async () => {
    const app = await buildApp();
    const body = { alerts: [] };
    const res = await app.inject({ method: "POST", url: "/alerts", payload: body });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ received: true });
    expect(processor.processAlerts).toHaveBeenCalledWith(body, expect.anything());
  });

  it("returns 401 when AUTH_TOKEN set and no Authorization header", async () => {
    process.env.AUTH_TOKEN = "secret";
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/alerts", payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it("returns 200 when AUTH_TOKEN set and correct Bearer token provided", async () => {
    process.env.AUTH_TOKEN = "mysecret";
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/alerts",
      payload: { alerts: [] },
      headers: { Authorization: "Bearer mysecret" },
    });
    expect(res.statusCode).toBe(200);
    expect(processor.processAlerts).toHaveBeenCalled();
  });
});

describe("GET /reload", () => {
  it("returns ok and entry count on successful reload", async () => {
    vi.mocked(config.reloadAlertsConfigSafe).mockReturnValue({
      ok: true,
      config: { AlertA: { channelId: "ch-1" }, AlertB: { channelId: "ch-2" } },
    });
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/reload" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.entries).toBe(2);
  });

  it("returns 400 when reload fails", async () => {
    vi.mocked(config.reloadAlertsConfigSafe).mockReturnValue({
      ok: false,
      error: "File not found",
    });
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/reload" });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(false);
    expect(body.error).toBe("File not found");
  });

  it("returns 401 when AUTH_TOKEN set and no header", async () => {
    process.env.AUTH_TOKEN = "token";
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/reload" });
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /reload", () => {
  it("returns ok on successful reload via POST", async () => {
    vi.mocked(config.reloadAlertsConfigSafe).mockReturnValue({
      ok: true,
      config: { AlertA: { channelId: "ch-1" } },
    });
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/reload", payload: {} });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.entries).toBe(1);
  });

  it("returns 401 when AUTH_TOKEN set and no header via POST", async () => {
    process.env.AUTH_TOKEN = "token";
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/reload", payload: {} });
    expect(res.statusCode).toBe(401);
  });
});
