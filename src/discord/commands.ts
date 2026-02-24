import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  EmbedBuilder,
  REST,
  Routes,
  MessageFlags,
  ChannelType,
  type Client,
  type Message,
  type PrivateThreadChannel,
  type TextChannel,
  AttachmentBuilder,
} from "discord.js";
import { getAlertStatusTable, getLastAlertEvent } from "../store/postgres.js";
import { renderStatusTableImage } from "./status-table-image.js";
import { setTroubleshootingGuide } from "../store/postgres.js";
import { getAlertsConfig, saveAlertsConfigToDbAndCache } from "../services/config.js";
import type { AlertTypeConfig } from "../types/config.js";

function parseCommaList(s: string | null): string[] | undefined {
  if (!s?.trim()) return undefined;
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}

const GUIDE_SAVE_CMD = "/save";
const GUIDE_CANCEL_CMD = "/cancel";
const GUIDE_SESSION_MS = 60 * 60 * 1000; // 1 hour

/** Active guide-edit sessions: threadId -> { alertName, userId, messages, collector } so /save slash can save from thread. */
export const guideSessions = new Map<
  string,
  { alertName: string; userId: string; messages: Message[]; collector: { stop: (r?: string) => void } }
>();

export function buildGuideMarkdown(messages: Message[]): string {
  const parts: string[] = [];
  const sorted = [...messages].sort(
    (a, b) =>
      a.createdTimestamp - b.createdTimestamp ||
      Number(BigInt(a.id) - BigInt(b.id))
  );
  for (const msg of sorted) {
    const text = msg.content?.trim();
    const isCmd = text === GUIDE_SAVE_CMD || text === GUIDE_CANCEL_CMD;
    for (const att of msg.attachments.values()) {
      if (att.contentType?.startsWith("image/") || /\.(png|jpe?g|gif|webp)$/i.test(att.name ?? "")) {
        parts.push(`\n![${att.name ?? "image"}](${att.url})\n`);
      } else {
        parts.push(`\n[${att.name ?? "attachment"}](${att.url})\n`);
      }
    }
    if (text && !isCmd) {
      parts.push(text);
    }
  }
  return parts.join("\n\n").trim() || "";
}

export function isSaveCommand(raw: string): boolean {
  const s = raw.toLowerCase().trim();
  return s === "/save" || s === "save";
}

export function isCancelCommand(raw: string): boolean {
  const s = raw.toLowerCase().trim();
  return s === "/cancel" || s === "cancel";
}

function runGuideSave(
  thread: { send: (content: string) => Promise<Message | null> },
  alertName: string,
  messages: Message[],
  log: { info: (o: object, msg?: string) => void; error: (o: object, msg?: string) => void },
  baseCtx: Record<string, unknown>
): void {
  const content = buildGuideMarkdown(messages);
  setTroubleshootingGuide(alertName, content)
    .then(() => {
      thread.send(`Saved. Guide for **${alertName}** has been updated.`).catch(() => {});
      log.info({ ...baseCtx, outcome: "ok", alertName, contentLength: content.length }, "slash_add_guide_ok");
    })
    .catch((err) => {
      log.error({ ...baseCtx, outcome: "failed", alertName, err }, "slash_add_guide_failed");
      thread.send(`Failed to save: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
    });
}

function runGuideCollector(
  thread: PrivateThreadChannel,
  userId: string,
  alertName: string,
  log: { info: (o: object, msg?: string) => void; error: (o: object, msg?: string) => void },
  baseCtx: Record<string, unknown>
): void {
  const collected: Message[] = [];
  const collector = thread.createMessageCollector({
    filter: (m) => m.author.id === userId,
    time: GUIDE_SESSION_MS,
  });
  guideSessions.set(thread.id, { alertName, userId, messages: collected, collector });
  collector.on("collect", (m) => {
    const raw = m.content?.trim() ?? "";
    if (isCancelCommand(raw)) {
      thread.send("Cancelled. You can archive this thread.").catch(() => {});
      log.info({ ...baseCtx, outcome: "cancelled", alertName }, "slash_add_guide_cancelled");
      guideSessions.delete(thread.id);
      collector.stop("cancel");
      return;
    }
    if (isSaveCommand(raw)) {
      runGuideSave(thread, alertName, collected, log, baseCtx);
      guideSessions.delete(thread.id);
      collector.stop("save");
      return;
    }
    collected.push(m);
  });
  collector.on("end", (_collected, reason) => {
    guideSessions.delete(thread.id);
    if (reason === "time") {
      thread.send("Session timed out. Use /add-guide again to continue.").catch(() => {});
      log.info({ ...baseCtx, outcome: "timeout", alertName }, "slash_add_guide_timeout");
    }
  });
}

export const SLASH_COMMANDS = [
  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Show status of all alerts (last 24h from audit log)"),
  new SlashCommandBuilder()
    .setName("last")
    .setDescription("Show the most recent alert from the audit log"),
  new SlashCommandBuilder()
    .setName("get-alert")
    .setDescription("Show alert config: one rule or all (alerts.json / DB)")
    .addStringOption((o) =>
      o.setName("name").setDescription("Alert rule name (omit to list all)").setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName("add-alert")
    .setDescription("Add a new alert rule to the config (alerts.json / DB)")
    .addStringOption((o) =>
      o.setName("name").setDescription("Alert rule name (e.g. RdsCpuUtilizationHigh)").setRequired(true)
    )
    .addStringOption((o) =>
      o.setName("channel_id").setDescription("Discord channel ID where alerts will be posted").setRequired(true)
    )
    .addIntegerOption((o) =>
      o.setName("suppress_minutes").setDescription("Dedupe window in minutes (default 5)").setRequired(false)
    )
    .addStringOption((o) =>
      o.setName("important_labels").setDescription("Comma-separated label keys for Key info (e.g. env,instance,severity)").setRequired(false)
    )
    .addStringOption((o) =>
      o.setName("hidden_labels").setDescription("Comma-separated label keys to hide (e.g. alertname,job)").setRequired(false)
    )
    .addStringOption((o) =>
      o.setName("thumbnail_url").setDescription("Optional thumbnail URL for the alert embed").setRequired(false)
    )
    .addStringOption((o) =>
      o.setName("mentions").setDescription("Comma-separated Discord user IDs for escalation (critical alert: ping after 5m, 10m, …)").setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName("add-guide")
    .setDescription("Add or edit a troubleshooting guide. Opens a thread; use /save or /cancel when done.")
    .addStringOption((o) =>
      o.setName("alert_name").setDescription("Alert rule name (e.g. RdsCpuUtilizationHigh)").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("save")
    .setDescription("Save the guide in this thread (use in a guide thread from /add-guide)"),
  new SlashCommandBuilder()
    .setName("delete-this")
    .setDescription("Delete this thread (only works inside a thread)"),
].map((c) => c.toJSON());

/** Register slash commands with Discord (call once after client is ready). */
export async function registerSlashCommands(
  client: Client,
  log: { info: (o: object, msg?: string) => void; warn: (o: object, msg?: string) => void }
): Promise<void> {
  const token = client.token ?? process.env.DISCORD_BOT_TOKEN?.trim();
  if (!token) {
    throw new Error("Cannot register commands: no token (client.token or DISCORD_BOT_TOKEN)");
  }
  let appId = client.application?.id;
  if (!appId && client.application) {
    try {
      await client.application.fetch();
      appId = client.application.id;
    } catch {
      // ignore
    }
  }
  if (!appId) {
    throw new Error("Cannot register commands: missing application id (ensure bot is fully ready)");
  }
  const rest = new REST().setToken(token);
  const guildId = process.env.DISCORD_GUILD_ID?.trim();
  try {
    if (guildId) {
      await rest.put(Routes.applicationGuildCommands(appId, guildId), { body: SLASH_COMMANDS });
      log.info({ guildId, count: SLASH_COMMANDS.length }, "slash_commands_registered_guild");
    } else {
      await rest.put(Routes.applicationCommands(appId), { body: SLASH_COMMANDS });
      log.info({ count: SLASH_COMMANDS.length }, "slash_commands_registered_global");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = err && typeof err === "object" && "status" in err ? (err as { status: number }).status : undefined;
    log.warn({ component: "discord", event: "slash_register_failed", appId, guildId: guildId ?? "global", err, status }, "slash_commands_register_failed");
    throw new Error(`Failed to register slash commands: ${msg}`);
  }
}

function cmdContext(interaction: ChatInputCommandInteraction) {
  return {
    component: "discord",
    event: "slash_command",
    command: interaction.commandName,
    userId: interaction.user.id,
    username: interaction.user.username,
    guildId: interaction.guildId ?? undefined,
    channelId: interaction.channelId ?? undefined,
  };
}

export async function handleSlashCommand(interaction: ChatInputCommandInteraction, log: { info: (o: object, msg?: string) => void; warn: (o: object, msg?: string) => void; error: (o: object, msg?: string) => void }): Promise<void> {
  const name = interaction.commandName;
  const ctx = () => cmdContext(interaction);

  if (name === "status") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
    const rows = await getAlertStatusTable(24);
    if (!process.env.DATABASE_URL) {
      log.warn({ ...ctx(), outcome: "unavailable", reason: "no_database" }, "slash_status_no_data");
      await interaction.editReply({ content: "Alert status unavailable (database not configured)." }).catch(() => {});
      return;
    }
    log.info({ ...ctx(), outcome: "ok", rowCount: rows.length }, "slash_status_ok");
    const imageBuffer = renderStatusTableImage(rows);
    const embed = new EmbedBuilder()
      .setTitle("Alert status (last 24h)")
      .setColor(0x3498db)
      .setFooter({ text: `${rows.length} alert(s)` });
    if (imageBuffer) {
      const filename = "alert-status.png";
      const attachment = new AttachmentBuilder(imageBuffer, { name: filename });
      embed.setImage(`attachment://${filename}`);
      await interaction.editReply({ embeds: [embed], files: [attachment] }).catch(() => {});
    } else {
      const pad = (s: string, n: number) => (s ?? "").slice(0, n).padEnd(n);
      const NAME_W = 24;
      const SEV_W = 10;
      const TIME_W = 16;
      const ACK_W = 8;
      const RES_W = 8;
      const header = pad("Alert name", NAME_W) + pad("Severity", SEV_W) + pad("Last triggered", TIME_W) + pad("Ack", ACK_W) + pad("Resolved", RES_W);
      const sep = "-".repeat(NAME_W + SEV_W + TIME_W + ACK_W + RES_W);
      const body = rows
        .slice(0, 25)
        .map((r) => {
          const alertName = r.rule_name?.trim() || `(id: ${r.alert_id.slice(0, 8)})`;
          const sev = (r.severity ?? "—").trim();
          const at = r.last_triggered instanceof Date ? r.last_triggered.toISOString().replace("T", " ").slice(0, 16) : String(r.last_triggered).slice(0, 16);
          const ack = r.acknowledged_by ? "Yes" : "—";
          const res = r.resolved_by ? "Yes" : "—";
          return pad(alertName, NAME_W) + pad(sev, SEV_W) + pad(at, TIME_W) + pad(ack, ACK_W) + pad(res, RES_W);
        })
        .join("\n");
      const tableContent = rows.length === 0 ? "No alerts in the last 24 hours." : [header, sep, body].join("\n");
      const wrapped = "```\n" + (tableContent.length > 4060 ? tableContent.slice(0, 4055) + "\n…" : tableContent) + "\n```";
      embed.setDescription(wrapped);
      await interaction.editReply({ embeds: [embed] }).catch(() => {});
    }
    return;
  }

  if (name === "get-alert") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
    const ruleName = interaction.options.getString("name")?.trim();
    const config = getAlertsConfig();
    if (ruleName) {
      const entry = config[ruleName];
      if (!entry) {
        log.info({ ...ctx(), outcome: "not_found", ruleName }, "slash_get_alert_not_found");
        await interaction.editReply({ content: `No alert config found for **${ruleName}**.` }).catch(() => {});
        return;
      }
      const lines = [
        `**${ruleName}**`,
        `channelId: \`${entry.channelId}\``,
        ...(entry.suppressWindowMs != null ? [`suppressWindowMs: ${entry.suppressWindowMs}`] : []),
        ...(entry.importantLabels?.length ? [`importantLabels: ${entry.importantLabels.join(", ")}`] : []),
        ...(entry.hiddenLabels?.length ? [`hiddenLabels: ${entry.hiddenLabels.join(", ")}`] : []),
        ...(entry.thumbnailUrl ? [`thumbnailUrl: ${entry.thumbnailUrl}`] : []),
        ...(entry.mentions?.length ? [`mentions: ${entry.mentions.join(", ")}`] : []),
      ];
      const embed = new EmbedBuilder()
        .setTitle("Alert config")
        .setColor(0x3498db)
        .setDescription(lines.join("\n"));
      log.info({ ...ctx(), outcome: "ok", ruleName }, "slash_get_alert_ok");
      await interaction.editReply({ embeds: [embed] }).catch(() => {});
      return;
    }
    const keys = Object.keys(config);
    if (keys.length === 0) {
      await interaction.editReply({ content: "No alert rules configured." }).catch(() => {});
      return;
    }
    const summary = keys.map((k) => `• **${k}** → \`${config[k].channelId}\``).join("\n");
    const embed = new EmbedBuilder()
      .setTitle("Alert config (all)")
      .setColor(0x3498db)
      .setDescription(summary.slice(0, 4000))
      .setFooter({ text: `${keys.length} rule(s). Use /get-alert name:<rule> for details.` });
    log.info({ ...ctx(), outcome: "ok", count: keys.length }, "slash_get_alert_list_ok");
    await interaction.editReply({ embeds: [embed] }).catch(() => {});
    return;
  }

  if (name === "save") {
    const channel = interaction.channel;
    if (!channel?.isThread?.()) {
      await interaction.reply({ content: "Use this command inside a guide thread (created with /add-guide).", flags: MessageFlags.Ephemeral }).catch(() => {});
      return;
    }
    const session = guideSessions.get(channel.id);
    if (!session) {
      await interaction.reply({ content: "No active guide session in this thread. Use /add-guide to start one.", flags: MessageFlags.Ephemeral }).catch(() => {});
      return;
    }
    if (session.userId !== interaction.user.id) {
      await interaction.reply({ content: "Only the user who started this guide can save.", flags: MessageFlags.Ephemeral }).catch(() => {});
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
    runGuideSave(channel, session.alertName, session.messages, log, ctx());
    session.collector.stop("save");
    guideSessions.delete(channel.id);
    await interaction.editReply({ content: "Guide save started. Check the thread for confirmation." }).catch(() => {});
    return;
  }

  if (name === "delete-this") {
    const channel = interaction.channel;
    if (!channel?.isThread?.()) {
      await interaction.reply({ content: "Use this command inside a thread to delete it.", flags: MessageFlags.Ephemeral }).catch(() => {});
      return;
    }
    await interaction.reply({ content: "Deleting this thread…", flags: MessageFlags.Ephemeral }).catch(() => {});
    try {
      await channel.delete();
    } catch (err) {
      const msg = err && typeof err === "object" && "message" in err ? String((err as Error).message) : String(err);
      log.error({ ...ctx(), threadId: channel.id, err }, "slash_delete_this_failed");
      const userMsg =
        msg.includes("Missing") || msg.includes("permission") || msg.includes("50013")
          ? "Failed to delete thread: the bot needs **Manage Threads** permission in this server. Ask an admin to grant it."
          : `Failed to delete thread: ${msg}`;
      await interaction.followUp({ content: userMsg, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    return;
  }

  if (name === "add-guide") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
    if (!process.env.DATABASE_URL) {
      await interaction.editReply({ content: "Troubleshooting guides are not available (database not configured)." }).catch(() => {});
      return;
    }
    const alertName = interaction.options.getString("alert_name", true).trim();
    if (!alertName) {
      await interaction.editReply({ content: "`alert_name` is required." }).catch(() => {});
      return;
    }
    const channel = interaction.channel?.isThread?.() ? interaction.channel.parent : interaction.channel;
    const textChannel = channel && "threads" in channel ? (channel as TextChannel) : null;
    if (!textChannel) {
      await interaction.editReply({ content: "This channel does not support threads. Use a text channel." }).catch(() => {});
      return;
    }
    try {
      // Private thread: only the actioner can see/write (guide editing).
      const created = await textChannel.threads.create({
        name: `Guide: ${alertName.slice(0, 50)}`,
        type: ChannelType.PrivateThread,
        reason: "Guide editing",
      });
      await created.members.add(interaction.user.id);
      const intro = [
        `**Troubleshooting guide for \`${alertName}\`**`,
        "Type your guide below (markdown is supported). You can attach images.",
        "When you're done: use the **/save** slash command to save, or type **/cancel** to discard. Use **/delete-this** to delete this thread.",
        "Session times out after 1 hour of inactivity.",
      ].join("\n\n");
      await created.send(intro);
      await interaction.editReply({
        content: `A private thread was created. Go there to write your guide: <#${created.id}>`,
      }).catch(() => {});
      runGuideCollector(created as PrivateThreadChannel, interaction.user.id, alertName, log, ctx());
    } catch (err) {
      log.error({ ...ctx(), outcome: "error", alertName, err }, "slash_add_guide_thread_failed");
      await interaction.editReply({
        content: `Failed to create thread: ${err instanceof Error ? err.message : String(err)}`,
      }).catch(() => {});
    }
    return;
  }

  if (name === "last") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
    const row = await getLastAlertEvent();
    if (!row) {
      log.info({ ...ctx(), outcome: "empty", reason: "no_events" }, "slash_last_empty");
      await interaction.editReply({ content: "No alerts in the audit log yet." }).catch(() => {});
      return;
    }
    log.info({ ...ctx(), outcome: "ok", alertId: row.alert_id, status: row.status }, "slash_last_ok");
    const embed = new EmbedBuilder()
      .setTitle("Last alert")
      .setColor(0xe67e22)
      .addFields(
        { name: "Alert ID", value: row.alert_id, inline: true },
        { name: "Status", value: row.status, inline: true },
        { name: "Resource", value: row.resource ?? "—", inline: true },
        { name: "Channel ID", value: row.channel_id, inline: false },
        { name: "Created", value: new Date(row.created_at).toISOString(), inline: false }
      );
    await interaction.editReply({ embeds: [embed] }).catch(() => {});
    return;
  }

  if (name === "add-alert") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
    const ruleName = interaction.options.getString("name", true).trim();
    const channelId = interaction.options.getString("channel_id", true).trim();
    const suppressMinutes = interaction.options.getInteger("suppress_minutes");
    const importantLabels = parseCommaList(interaction.options.getString("important_labels"));
    const hiddenLabels = parseCommaList(interaction.options.getString("hidden_labels"));
    const thumbnailUrl = interaction.options.getString("thumbnail_url")?.trim();
    const mentions = parseCommaList(interaction.options.getString("mentions"));
    if (!ruleName || !channelId) {
      log.warn({ ...ctx(), outcome: "validation_failed", ruleName, reason: "missing_name_or_channel_id" }, "slash_add_alert_validation_failed");
      await interaction.editReply({ content: "`name` and `channel_id` are required." }).catch(() => {});
      return;
    }
    const entry: AlertTypeConfig = {
      channelId,
      ...(suppressMinutes != null && suppressMinutes > 0 ? { suppressWindowMs: suppressMinutes * 60 * 1000 } : {}),
      ...(importantLabels?.length ? { importantLabels } : {}),
      ...(hiddenLabels?.length ? { hiddenLabels } : {}),
      ...(thumbnailUrl ? { thumbnailUrl } : {}),
      ...(mentions?.length ? { mentions } : {}),
    };
    try {
      const config = { ...getAlertsConfig(), [ruleName]: entry };
      await saveAlertsConfigToDbAndCache(config);
      log.info({ ...ctx(), outcome: "ok", ruleName, channelId, suppressMinutes: suppressMinutes ?? undefined, entries: Object.keys(config).length }, "slash_add_alert_ok");
      const parts = [`Added alert **${ruleName}** → channel \`${channelId}\``];
      if (suppressMinutes != null && suppressMinutes > 0) parts.push(`suppress ${suppressMinutes} min`);
      if (importantLabels?.length) parts.push(`important labels: ${importantLabels.join(", ")}`);
      if (hiddenLabels?.length) parts.push(`hidden labels: ${hiddenLabels.join(", ")}`);
      if (thumbnailUrl) parts.push("thumbnail set");
      if (mentions?.length) parts.push(`mentions: ${mentions.length} user(s)`);
      const persisted = process.env.DATABASE_URL ? " (saved to DB)" : " (in-memory only; set DATABASE_URL to persist)";
      await interaction.editReply({
        content: parts.join(" • ") + persisted + ".",
      }).catch(() => {});
    } catch (err) {
      log.error({ ...ctx(), outcome: "error", ruleName, channelId, err }, "slash_add_alert_failed");
      await interaction.editReply({
        content: `Failed to add alert: ${err instanceof Error ? err.message : String(err)}`,
      }).catch(() => {});
    }
    return;
  }
}
