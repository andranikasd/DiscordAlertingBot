import type { Client } from "discord.js";
import type { FastifyBaseLogger } from "fastify";
import { getStoredAlertKeys, getStoredAlert, setStoredAlert, deleteStoredAlert } from "../store/redis.js";

const RECONCILE_INITIAL_DELAY_MS = 5 * 60 * 1000;   // first run 5 min after startup
const RECONCILE_INTERVAL_MS = 30 * 60 * 1000;        // then every 30 min

// Discord API error codes that mean the resource is permanently gone.
const GONE_CODES = new Set([10003, 10008]); // Unknown Channel, Unknown Message

/**
 * Stale state reconciliation: periodically verify that each active alert's Discord
 * message still exists. If the message or channel is gone (e.g. manually deleted),
 * remove the orphaned Redis state so the next firing event creates a fresh message.
 * Also clears stale threadIds when the thread is no longer accessible.
 *
 * Runs once 5 minutes after startup, then every 30 minutes.
 */
export function startStateReconciliation(c: Client, log: FastifyBaseLogger): void {
  const run = async (): Promise<void> => {
    if (!c.isReady()) return;
    try {
      const keys = await getStoredAlertKeys();
      log.info({ component: "reconciler", event: "start", keyCount: keys.length }, "reconciler_run_start");
      let cleaned = 0;

      for (const key of keys) {
        const parts = key.split(":");
        if (parts.length < 3) continue;
        const alertId = parts[1];
        const resource = parts[2] === "default" ? undefined : parts[2];
        const stored = await getStoredAlert(alertId, resource);
        // Skip already-resolved state — it will expire via Redis TTL naturally.
        if (!stored || stored.state === "resolved") continue;

        try {
          // Verify the channel still exists.
          const channel = await c.channels.fetch(stored.channelId).catch(() => null);
          if (!channel?.isTextBased() || channel.isDMBased()) {
            await deleteStoredAlert(alertId, resource);
            cleaned++;
            log.info({ component: "reconciler", event: "orphan_deleted", alertId, reason: "channel_gone" }, "reconciler_orphan_deleted");
            continue;
          }

          // Verify the message still exists.
          try {
            await channel.messages.fetch(stored.messageId);
          } catch (err: unknown) {
            const code = (err as { code?: number })?.code;
            if (code !== undefined && GONE_CODES.has(code)) {
              await deleteStoredAlert(alertId, resource);
              cleaned++;
              log.info({ component: "reconciler", event: "orphan_deleted", alertId, code, reason: "message_gone" }, "reconciler_orphan_deleted");
              continue;
            }
          }

          // Clear threadId if the thread is no longer accessible.
          if (stored.threadId) {
            const thread = await c.channels.fetch(stored.threadId).catch(() => null);
            if (!thread) {
              await setStoredAlert(alertId, resource, { ...stored, threadId: undefined });
              log.info({ component: "reconciler", event: "thread_cleared", alertId }, "reconciler_thread_id_cleared");
            }
          }
        } catch (err) {
          log.warn({ component: "reconciler", event: "check_failed", alertId, err }, "reconciler_check_failed");
        }
      }

      log.info({ component: "reconciler", event: "done", cleaned }, "reconciler_run_done");
    } catch (err) {
      log.warn({ component: "reconciler", event: "loop_error", err }, "reconciler_loop_error");
    }
  };

  setTimeout(() => {
    void run();
    setInterval(() => void run(), RECONCILE_INTERVAL_MS);
  }, RECONCILE_INITIAL_DELAY_MS);
}