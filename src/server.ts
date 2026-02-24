import Fastify from "fastify";
import { validateEnv } from "./env.js";
import { registerAlertsRoutes } from "./routes/alerts.js";
import { registerConfigRoutes } from "./routes/config.js";
import { getDiscordClient, startMentionEscalation } from "./discord/client.js";
import { startStateReconciliation } from "./services/reconciler.js";
import { registerSlashCommands } from "./discord/commands.js";
import { getPool, initSchema, parseAuditLogTtlSeconds, runAuditLogCleanup } from "./store/postgres.js";
import { bootstrapAlertsConfig } from "./services/config.js";
import { startSqsPoller } from "./services/sqs-poller.js";
import { runAlertsConfigMigration } from "./migration.js";
import { createLoggerOptions } from "./logger.js";
import { metricsText } from "./metrics.js";

validateEnv();

const port = Number(process.env.PORT) || 4000;

const app = Fastify({
  trustProxy: true,
  logger: createLoggerOptions(),
  genReqId: (req) => req.headers["x-request-id"] as string ?? `req-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
});

app.get("/health", async (_, reply) => {
  return reply.send({ status: "ok" });
});

app.get("/metrics", async (_, reply) => {
  return reply.type("text/plain; version=0.0.4").send(metricsText());
});

await registerAlertsRoutes(app);
await registerConfigRoutes(app);

async function start(): Promise<void> {
  if (process.env.DATABASE_URL) {
    try {
      const pool = getPool();
      await initSchema(pool);
      app.log.info({ component: "postgres", event: "schema_ready" }, "postgres_schema_ready");
      await runAlertsConfigMigration(app.log);
      const auditTtlSec = parseAuditLogTtlSeconds();
      if (auditTtlSec != null) {
        const { deleted } = await runAuditLogCleanup(auditTtlSec);
        app.log.info({ component: "postgres", event: "audit_cleanup", ttlSeconds: auditTtlSec, deleted }, "audit_log_cleanup_done");
        const AUDIT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
        setInterval(async () => {
          const { deleted: d } = await runAuditLogCleanup(auditTtlSec);
          if (d > 0) app.log.info({ component: "postgres", event: "audit_cleanup", deleted: d }, "audit_log_cleanup_periodic");
        }, AUDIT_CLEANUP_INTERVAL_MS);
      }
    } catch (err) {
      app.log.warn({ component: "postgres", event: "init_skip", err }, "postgres_init_skip");
    }
  }
  await bootstrapAlertsConfig(app.log);
  try {
    const discordClient = await getDiscordClient(app.log);
    await registerSlashCommands(discordClient, app.log);
    startMentionEscalation(discordClient, app.log);
    startStateReconciliation(discordClient, app.log);
    app.log.info({ component: "discord", event: "ready" }, "discord_bot_ready");
    startSqsPoller(app.log);
  } catch (err) {
    app.log.fatal({ component: "discord", event: "login_failed", err }, "discord_bot_login_failed");
    process.exit(1);
  }
  try {
    await app.listen({ port, host: "0.0.0.0" });
    app.log.info({ component: "http", event: "listening", port, host: "0.0.0.0" }, "server_listening");
  } catch (err) {
    app.log.fatal({ component: "http", event: "listen_failed", err, port }, "server_listen_failed");
    process.exit(1);
  }
}

start();
