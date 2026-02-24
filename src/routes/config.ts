import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { requireAuth } from "./auth.js";
import {
  getAlertsConfig,
  validateAlertsConfig,
  saveAlertsConfigToDbAndCache,
} from "../services/config.js";
import {
  getTroubleshootingGuide,
  setTroubleshootingGuide,
  getAllTroubleshootingGuides,
} from "../store/postgres.js";

export async function registerConfigRoutes(app: FastifyInstance): Promise<void> {
  /** GET /get-config — return current alerts config (from cache: DB or file). Auth required when AUTH_TOKEN set. */
  app.get("/get-config", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!requireAuth(req, reply)) return;
    const config = getAlertsConfig();
    const entries = Object.keys(config).length;
    req.log.info({ component: "http", route: "GET /get-config", event: "get", entries }, "get_config_ok");
    return reply.send({ config });
  });

  /** POST /push-config — validate body, save to DB (if DATABASE_URL) and update in-memory cache. Auth required. */
  app.post<{ Body: unknown }>(
    "/push-config",
    async (req: FastifyRequest<{ Body: unknown }>, reply: FastifyReply) => {
      if (!requireAuth(req, reply)) return;
      const result = validateAlertsConfig(req.body);
      if (!result.ok) {
        req.log.warn({ component: "http", route: "POST /push-config", event: "validation_failed", error: result.error }, "push_config_validation_failed");
        return reply.status(400).send({ ok: false, error: result.error });
      }
      try {
        await saveAlertsConfigToDbAndCache(result.config);
        const entries = Object.keys(result.config).length;
        req.log.info({ component: "http", route: "POST /push-config", event: "pushed", entries, keys: Object.keys(result.config) }, "config_pushed");
        return reply.send({ ok: true, entries });
      } catch (err) {
        req.log.error({ component: "http", route: "POST /push-config", event: "save_failed", err }, "push_config_save_failed");
        return reply.status(500).send({ ok: false, error: "Failed to save config" });
      }
    }
  );

  /** GET /troubleshooting-guide?alertType=RuleName — get markdown guide for an alert type. Auth when AUTH_TOKEN set. */
  app.get<{ Querystring: { alertType?: string } }>(
    "/troubleshooting-guide",
    async (req: FastifyRequest<{ Querystring: { alertType?: string } }>, reply: FastifyReply) => {
      if (!requireAuth(req, reply)) return;
      const alertType = req.query.alertType?.trim();
      if (alertType) {
        const content = await getTroubleshootingGuide(alertType);
        req.log.info({ component: "http", route: "GET /troubleshooting-guide", event: "get", alertType, hasContent: Boolean(content?.length) }, "troubleshooting_guide_get");
        return reply.send({ alertType, content: content ?? "" });
      }
      const guides = await getAllTroubleshootingGuides();
      req.log.info({ component: "http", route: "GET /troubleshooting-guide", event: "list", count: Object.keys(guides).length }, "troubleshooting_guide_list");
      return reply.send({ guides });
    }
  );

  /** POST /troubleshooting-guide — set markdown guide for an alert type. Body: { alertType: string, content: string }. Auth required. */
  app.post<{ Body: unknown }>(
    "/troubleshooting-guide",
    async (req: FastifyRequest<{ Body: unknown }>, reply: FastifyReply) => {
      if (!requireAuth(req, reply)) return;
      if (!process.env.DATABASE_URL) {
        req.log.warn({ component: "http", route: "POST /troubleshooting-guide", event: "unavailable", reason: "no_database" }, "troubleshooting_guide_no_db");
        return reply.status(503).send({ ok: false, error: "DATABASE_URL not set; troubleshooting guides unavailable." });
      }
      const body = req.body as { alertType?: string; content?: string } | null;
      const alertType = typeof body?.alertType === "string" ? body.alertType.trim() : "";
      const content = typeof body?.content === "string" ? body.content : "";
      if (!alertType) {
        req.log.warn({ component: "http", route: "POST /troubleshooting-guide", event: "validation_failed", reason: "missing_alertType" }, "troubleshooting_guide_validation_failed");
        return reply.status(400).send({ ok: false, error: "alertType is required" });
      }
      try {
        await setTroubleshootingGuide(alertType, content);
        req.log.info({ component: "http", route: "POST /troubleshooting-guide", event: "updated", alertType, contentLength: content.length }, "troubleshooting_guide_updated");
        return reply.send({ ok: true, alertType });
      } catch (err) {
        req.log.error({ component: "http", route: "POST /troubleshooting-guide", event: "save_failed", alertType, err }, "troubleshooting_guide_save_failed");
        return reply.status(500).send({ ok: false, error: "Failed to save troubleshooting guide" });
      }
    }
  );
}
