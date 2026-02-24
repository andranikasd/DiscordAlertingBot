import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { processAlerts } from "../services/processor.js";
import { reloadAlertsConfigSafe } from "../services/config.js";
import { requireAuth } from "./auth.js";

export async function registerAlertsRoutes(app: FastifyInstance): Promise<void> {
  /** Grafana webhook: POST /alerts with Grafana payload. Returns 200 immediately; processes in background. */
  app.post<{ Body: unknown }>("/alerts", async (req: FastifyRequest<{ Body: unknown }>, reply: FastifyReply) => {
    if (!requireAuth(req, reply)) return;
    req.log.info({ component: "http", route: "POST /alerts", event: "received" }, "alerts_webhook_received");
    void processAlerts(req.body, req.log);
    return reply.status(200).send({ received: true });
  });

  /** Reload alerts.json without restart */
  const handleReload = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!requireAuth(req, reply)) return;
    const result = reloadAlertsConfigSafe();
    if (!result.ok) {
      req.log.warn({ component: "http", route: "reload", event: "reload_failed", error: result.error }, "config_reload_failed");
      return reply.status(400).send({ ok: false, error: result.error });
    }
    const entries = Object.keys(result.config).length;
    req.log.info({ component: "http", route: "reload", event: "reloaded", entries }, "config_reloaded");
    return reply.send({ ok: true, entries });
  };

  app.get("/reload", handleReload);
  app.post("/reload", handleReload);
}
