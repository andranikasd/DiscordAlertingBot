import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  type Message,
} from "discord.js";
import { buildAlertEmbed, buildResolvedFields, buildAcknowledgedFields } from "./embed.js";
import type { AlertApiPayload } from "../types/alert.js";
import { SEVERITY_COLORS } from "../types/alert.js";
import { getStoredAlert, setStoredAlert, getStoredAlertKeys } from "../store/redis.js";
import { clearDedup, setDedupTtl } from "../store/dedup.js";
import { getTroubleshootingGuide, updateAlertEventAck, updateAlertEventResolve } from "../store/postgres.js";
import { getAlertsConfig } from "../services/config.js";
import { handleSlashCommand } from "./commands.js";
import type { FastifyBaseLogger } from "fastify";
import { inc } from "../metrics.js";

let client: Client | null = null;
let readyPromise: Promise<Client> | null = null;

const ACK_BUTTON_CUSTOM_ID = "alert_ack";
const TROUBLESHOOT_BUTTON_CUSTOM_ID = "alert_troubleshoot";
const RESOLVE_BUTTON_CUSTOM_ID = "alert_resolve";
const ACK_MIN_SUPPRESS_MS = 10 * 60 * 1000; // 10 minutes
const MENTION_ESCALATION_INTERVAL_MS = 60 * 1000; // 1 minute
const MENTION_ESCALATION_STEP_MS = 5 * 60 * 1000; // 5 minutes per level

function getToken(): string {
  const token = process.env.DISCORD_BOT_TOKEN?.trim();
  if (!token) throw new Error("DISCORD_BOT_TOKEN is not set");
  return token;
}

function interactionContext(interaction: { user: { id: string; username?: string }; guildId: string | null; channelId: string | null }) {
  return {
    component: "discord",
    interaction: { userId: interaction.user.id, username: interaction.user.username, guildId: interaction.guildId ?? undefined, channelId: interaction.channelId ?? undefined },
  };
}

function getGatewayIntents(): number[] {
  const base = [GatewayIntentBits.Guilds];
  const useMessageIntents = /^(1|true|yes)$/i.test(process.env.DISCORD_USE_MESSAGE_INTENTS ?? "");
  if (useMessageIntents) {
    base.push(GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent);
  }
  return base;
}

export async function getDiscordClient(log: FastifyBaseLogger): Promise<Client> {
  if (client?.isReady()) return client;
  if (readyPromise) return readyPromise;
  const token = getToken();
  const intents = getGatewayIntents();
  const c = new Client({ intents });
  readyPromise = new Promise((resolve, reject) => {
    c.once("clientReady", () => resolve(c));
    c.once("error", reject);
  });
  c.rest.on("rateLimited", (info) => {
    inc("discord_rate_limits_total");
    log.warn(
      { component: "discord", event: "rate_limited", route: info.route, timeToReset: info.timeToReset, limit: info.limit, global: info.global },
      "discord_rate_limited"
    );
  });
  c.on("interactionCreate", async (interaction) => {
    const ctx = () => interactionContext(interaction);
    if (interaction.isChatInputCommand()) {
      log.info({ ...ctx(), event: "slash_command", command: interaction.commandName }, "discord_slash_command_received");
      await handleSlashCommand(interaction, log).catch((err) => {
        log.error({ ...ctx(), event: "slash_command_error", command: interaction.commandName, err }, "discord_slash_command_failed");
      });
      return;
    }
    if (!interaction.isButton()) return;
    const customId = interaction.customId;

    if (customId.startsWith(TROUBLESHOOT_BUTTON_CUSTOM_ID)) {
      const parts = customId.split(":");
      const alertId = parts[1];
      const resource = parts[2] === "" ? undefined : parts[2];
      const stored = await getStoredAlert(alertId, resource);
      if (!stored) {
        log.warn({ ...ctx(), event: "troubleshoot_button", alertId, resource, reason: "stored_not_found" }, "discord_troubleshoot_stored_not_found");
        await interaction.reply({ content: "Alert state not found.", flags: MessageFlags.Ephemeral }).catch(() => {});
        return;
      }
      const ruleName = stored.ruleName ?? "default";
      const content = await getTroubleshootingGuide(ruleName);
      const targetChannelId = stored.threadId ?? stored.channelId;
      const text =
        content?.trim() ||
        `No troubleshooting guide configured for **${ruleName}**. Add one via \`POST /troubleshooting-guide\` with \`alertType: "${ruleName}"\`.`;
      const fullMessage = `## Troubleshooting guide: ${ruleName}\n\n${text}`;
      const DISCORD_MAX_LEN = 2000;
      const chunks: string[] = [];
      for (let i = 0; i < fullMessage.length; i += DISCORD_MAX_LEN) {
        chunks.push(fullMessage.slice(i, i + DISCORD_MAX_LEN));
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
      try {
        const targetChannel = await c.channels.fetch(targetChannelId);
        if (targetChannel?.isTextBased() && !targetChannel.isDMBased()) {
          for (const chunk of chunks) await targetChannel.send({ content: chunk });
          log.info({ ...ctx(), event: "troubleshoot_posted", ruleName, alertId, resource, channelId: targetChannelId }, "discord_troubleshoot_guide_posted");
          await interaction.editReply({ content: "Troubleshooting guide posted in the discussion thread." }).catch(() => {});
        } else {
          log.warn({ ...ctx(), event: "troubleshoot_post_failed", ruleName, reason: "channel_not_text" }, "discord_troubleshoot_channel_invalid");
          await interaction.editReply({ content: "Could not post to the discussion thread." }).catch(() => {});
        }
      } catch (err) {
        log.error({ ...ctx(), event: "troubleshoot_post_error", ruleName, err }, "discord_troubleshoot_post_failed");
        await interaction.editReply({ content: "Failed to post troubleshooting guide." }).catch(() => {});
      }
      return;
    }

    if (customId.startsWith(RESOLVE_BUTTON_CUSTOM_ID)) {
      const parts = customId.split(":");
      const alertId = parts[1];
      const resource = parts[2] === "" ? undefined : parts[2];
      const stored = await getStoredAlert(alertId, resource);
      if (!stored) {
        log.warn({ ...ctx(), event: "resolve_button", alertId, resource, reason: "stored_not_found" }, "discord_resolve_stored_not_found");
        await interaction.reply({ content: "Alert state not found.", flags: MessageFlags.Ephemeral }).catch(() => {});
        return;
      }
      const userId = interaction.user.id;
      log.info({ ...ctx(), event: "resolve_button", alertId, resource }, "discord_alert_resolved");
      await clearDedup(alertId);
      const resolvedAt = new Date().toISOString();
      await setStoredAlert(alertId, resource, {
        ...stored,
        state: "resolved",
        resolvedBy: userId,
        resolvedAt,
        updatedAt: resolvedAt,
      });
      if (process.env.DATABASE_URL) {
        await updateAlertEventResolve(alertId, resource ?? null, userId).catch(() => {});
      }
      const oldEmbed = interaction.message.embeds[0];
      if (!oldEmbed) {
        await interaction.update({ components: [] }).catch(() => {});
        return;
      }
      const embed = new EmbedBuilder()
        .setTitle(oldEmbed.title ?? "Alert")
        .setColor(SEVERITY_COLORS.resolved)
        .setFields(buildResolvedFields(oldEmbed.fields, userId, resolvedAt));
      if (oldEmbed.description) embed.setDescription(oldEmbed.description);
      if (oldEmbed.footer) embed.setFooter({ text: oldEmbed.footer.text });
      if (oldEmbed.timestamp) embed.setTimestamp(new Date(oldEmbed.timestamp));
      // Keep the incident thread: history remains in the thread and main message (Section 9 implemented behavior).
      await interaction.update({ embeds: [embed], components: [] }).catch(() => {});
      return;
    }

    if (!customId.startsWith(ACK_BUTTON_CUSTOM_ID)) return;
    const parts = customId.split(":");
    const alertId = parts[1];
    const resource = parts[2] === "" ? undefined : parts[2];
    const stored = await getStoredAlert(alertId, resource);
    if (!stored) {
      log.warn({ ...ctx(), event: "ack_button", alertId, resource, reason: "stored_not_found" }, "discord_ack_stored_not_found");
      await interaction.reply({ content: "Alert state not found.", flags: MessageFlags.Ephemeral }).catch(() => {});
      return;
    }
    const userId = interaction.user.id;
    log.info({ ...ctx(), event: "ack_button", alertId, resource }, "discord_alert_acknowledged");
    const config = getAlertsConfig();
    const typeConfig = config[stored.ruleName ?? ""];
    const suppressWindowMs = typeConfig?.suppressWindowMs ?? 5 * 60 * 1000;
    const ackSuppressMs = Math.max(suppressWindowMs, ACK_MIN_SUPPRESS_MS);
    await setDedupTtl(alertId, ackSuppressMs);
    const acknowledgedAt = new Date().toISOString();
    await setStoredAlert(alertId, resource, {
      ...stored,
      state: "acknowledged",
      acknowledgedBy: userId,
      acknowledgedAt,
      updatedAt: acknowledgedAt,
    });
    if (process.env.DATABASE_URL) {
      await updateAlertEventAck(alertId, resource ?? null, userId).catch(() => {});
    }
    const oldEmbed = interaction.message.embeds[0];
    if (!oldEmbed) {
      await interaction.update({ components: [] }).catch(() => {});
      return;
    }
    const embed = new EmbedBuilder()
      .setTitle(oldEmbed.title ?? "Alert")
      .setColor(0x3498db)
      .setFields(buildAcknowledgedFields(oldEmbed.fields, userId));
    if (oldEmbed.description) embed.setDescription(oldEmbed.description);
    if (oldEmbed.footer) embed.setFooter({ text: oldEmbed.footer.text });
    if (oldEmbed.timestamp) embed.setTimestamp(new Date(oldEmbed.timestamp));
    // Keep Troubleshoot and Resolve buttons after acknowledge so the alert can still be resolved via UI.
    const remainingRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${TROUBLESHOOT_BUTTON_CUSTOM_ID}:${alertId}:${resource ?? ""}`)
        .setLabel("Troubleshooting guide")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`${RESOLVE_BUTTON_CUSTOM_ID}:${alertId}:${resource ?? ""}`)
        .setLabel("Resolve")
        .setStyle(ButtonStyle.Success)
    );
    await interaction.update({ embeds: [embed], components: [remainingRow] }).catch(() => {});
  });

  await c.login(token);
  client = c;
  return readyPromise;
}

/** Create or update alert message; create thread if configured. Returns message ID. */
export async function sendOrUpdateAlert(
  payload: AlertApiPayload,
  log: FastifyBaseLogger
): Promise<string> {
  const c = await getDiscordClient(log);
  const channelId = payload.channelId;
  const stored = await getStoredAlert(payload.alertId, payload.resource);
  const embedData = buildAlertEmbed(payload);
  const embed = new EmbedBuilder(embedData);
  if (embedData.thumbnail?.url) embed.setThumbnail(embedData.thumbnail.url);

  const row =
    payload.status === "firing"
      ? new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`${ACK_BUTTON_CUSTOM_ID}:${payload.alertId}:${payload.resource ?? ""}`)
            .setLabel("Acknowledge")
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId(`${TROUBLESHOOT_BUTTON_CUSTOM_ID}:${payload.alertId}:${payload.resource ?? ""}`)
            .setLabel("Troubleshooting guide")
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId(`${RESOLVE_BUTTON_CUSTOM_ID}:${payload.alertId}:${payload.resource ?? ""}`)
            .setLabel("Resolve")
            .setStyle(ButtonStyle.Success)
        )
      : undefined;

  const options = { embeds: [embed], components: row ? [row] : [] };

  if (stored?.messageId) {
    try {
      const channel = await c.channels.fetch(channelId);
      if (!channel?.isTextBased() || channel.isDMBased()) {
        log.warn({ component: "discord", event: "edit_skip", alertId: payload.alertId, channelId, reason: "channel_not_text" }, "channel_not_found_or_not_text");
        throw new Error("Channel not found or not text channel");
      }
      const message = await channel.messages.fetch(stored.messageId);
      await message.edit(options);
      let newThreadId: string | undefined = stored.threadId;
      if (payload.status === "firing") {
        const repeatedAt = new Date().toISOString();
        const repeatedFields: Array<{ name: string; value: string; inline: boolean }> = [
          { name: "Time", value: repeatedAt, inline: true },
          { name: "Severity", value: payload.severity ?? "—", inline: true },
        ];
        if (payload.resource) repeatedFields.push({ name: "Resource", value: payload.resource, inline: true });
        const repeatedEmbed = new EmbedBuilder()
          .setColor(0xf1c40f)
          .setTitle("🔁 Alert repeated")
          .addFields(repeatedFields)
          .setTimestamp();
        try {
          let threadChannel: { send: (opts: object) => Promise<unknown> } | null = null;
          if (stored.threadId) {
            const fetched = await c.channels.fetch(stored.threadId);
            if (fetched?.isTextBased() && !fetched.isDMBased()) threadChannel = fetched as { send: (opts: object) => Promise<unknown> };
          }
          if (!threadChannel && !channel.isThread() && "threads" in channel) {
            const newThread = await message.startThread({
              name: `Incident: ${payload.title.slice(0, 50)}`,
              autoArchiveDuration: 60,
            });
            newThreadId = newThread.id;
            threadChannel = newThread;
            log.info({ component: "discord", event: "reopen_new_thread_created", alertId: payload.alertId, threadId: newThreadId }, "reopen_incident_new_thread");
          }
          if (threadChannel) {
            await threadChannel.send({ embeds: [repeatedEmbed] });
            log.info({ component: "discord", event: "alert_repeated_posted", alertId: payload.alertId, threadId: newThreadId ?? stored.threadId }, "alert_repeated_in_thread");
            // Section 10: "After 1 hour" of acknowledged state, post repeat + mention first user.
            const ACK_REMINDER_AFTER_MS = 60 * 60 * 1000;
            if (stored.state === "acknowledged" && stored.acknowledgedAt && Date.now() - new Date(stored.acknowledgedAt).getTime() > ACK_REMINDER_AFTER_MS) {
              const typeConfig = getAlertsConfig()[stored.ruleName ?? ""];
              const firstMention = typeConfig?.mentions?.[0];
              if (firstMention) {
                await threadChannel.send({ content: `This alert was acknowledged but not resolved.\n<@${firstMention}>` }).catch(() => {});
                log.info({ component: "discord", event: "ack_reminder_mention_posted", alertId: payload.alertId, threadId: newThreadId ?? stored.threadId, userId: firstMention }, "ack_reminder_mention_posted");
              }
            }
          }
        } catch (err) {
          log.warn({ component: "discord", event: "alert_repeated_failed", alertId: payload.alertId, threadId: stored.threadId, err }, "alert_repeated_post_failed");
        }
      }
      await setStoredAlert(payload.alertId, payload.resource, {
        messageId: stored.messageId,
        channelId,
        threadId: newThreadId,
        state: payload.status === "resolved" ? "resolved" : payload.status === "acknowledged" ? "acknowledged" : "firing",
        updatedAt: new Date().toISOString(),
        ruleName: payload.ruleName ?? stored.ruleName,
        severity: payload.severity ?? stored.severity,
        acknowledgedBy: stored.acknowledgedBy,
        resolvedBy: stored.resolvedBy,
        resolvedAt: payload.status === "resolved" ? (payload.resolvedAt ?? new Date().toISOString()) : stored.resolvedAt,
        acknowledgedAt: stored.acknowledgedAt,
      });
      log.info({ component: "discord", event: "message_updated", alertId: payload.alertId, messageId: stored.messageId, ruleName: payload.ruleName, status: payload.status }, "message_updated");
      return stored.messageId;
    } catch (err) {
      log.warn({ component: "discord", event: "edit_failed", alertId: payload.alertId, messageId: stored.messageId, err }, "edit_failed_sending_new");
      // fall through to send new message
    }
  }

  const channel = await c.channels.fetch(channelId);
  if (!channel?.isTextBased() || channel.isDMBased()) {
    log.warn({ component: "discord", event: "send_skip", alertId: payload.alertId, channelId, reason: "channel_not_text" }, "channel_not_found_or_not_text");
    throw new Error("Channel not found or not text channel");
  }
  const message = (await channel.send(options)) as Message;
  // Public thread: visible to everyone with channel access (Discord API default for startThread).
  const thread =
    channel.isThread() || !("threads" in channel)
      ? undefined
      : await message.startThread({
          name: `Incident: ${payload.title.slice(0, 50)}`,
          autoArchiveDuration: 60,
        });
  await setStoredAlert(payload.alertId, payload.resource, {
    messageId: message.id,
    channelId,
    threadId: thread?.id,
    state: payload.status === "resolved" ? "resolved" : "firing",
    updatedAt: new Date().toISOString(),
    ruleName: payload.ruleName,
    severity: payload.severity,
  });
  log.info({ component: "discord", event: "message_created", alertId: payload.alertId, messageId: message.id, threadId: thread?.id, ruleName: payload.ruleName, channelId }, "message_created");
  return message.id;
}

export function getAckButtonCustomId(): string {
  return ACK_BUTTON_CUSTOM_ID;
}

/** Run mention escalation: for critical un-resolved alerts with mentions config, ping next user every 5m. */
export function startMentionEscalation(c: Client, log: FastifyBaseLogger): void {
  setInterval(async () => {
    if (!c.isReady()) return;
    try {
      const keys = await getStoredAlertKeys();
      const config = getAlertsConfig();
      for (const key of keys) {
        const parts = key.split(":");
        if (parts.length < 3) continue;
        const alertId = parts[1];
        const resource = parts[2] === "default" ? undefined : parts[2];
        const stored = await getStoredAlert(alertId, resource);
        if (!stored || stored.state === "resolved" || stored.state === "acknowledged") continue;
        if ((stored.severity ?? "").toLowerCase() !== "critical") continue;
        const typeConfig = config[stored.ruleName ?? ""];
        const mentions = typeConfig?.mentions;
        if (!mentions?.length) continue;
        const level = stored.mentionLevel ?? 0;
        if (level >= mentions.length) continue;
        const elapsed = Date.now() - new Date(stored.updatedAt).getTime();
        const threshold = (level + 1) * MENTION_ESCALATION_STEP_MS;
        if (elapsed < threshold) continue;
        const threadId = stored.threadId ?? stored.channelId;
        const userId = mentions[level];
        if (!userId) continue;
        try {
          const ch = await c.channels.fetch(threadId);
          if (ch?.isTextBased() && !ch.isDMBased()) {
            await ch.send({ content: `<@${userId}> Critical alert still not acknowledged or resolved (escalation level ${level + 1}).` });
            // Do NOT update updatedAt here: escalation thresholds are `(level+1) * 5min` from the
            // original updatedAt, so resetting it would push every subsequent level further out.
            await setStoredAlert(alertId, resource, { ...stored, mentionLevel: level + 1 });
            log.info({ component: "discord", event: "mention_escalation", alertId, resource, level: level + 1, userId }, "mention_escalation_sent");
          }
        } catch (err) {
          log.warn({ component: "discord", event: "mention_escalation_failed", alertId, threadId, err }, "mention_escalation_failed");
        }
      }
    } catch (err) {
      log.warn({ component: "discord", event: "mention_escalation_loop_error", err }, "mention_escalation_loop_error");
    }
  }, MENTION_ESCALATION_INTERVAL_MS);
}
