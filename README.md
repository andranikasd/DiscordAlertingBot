# Discord Alert Bot

Production-grade incident alert delivery bot for Discord. Receives normalized alert payloads from multiple sources (Grafana webhooks, AWS SNS/SQS), posts rich embed messages to configured channels, creates per-incident discussion threads, and provides interactive **Acknowledge / Troubleshoot / Resolve** buttons with full lifecycle management.

---

## Table of Contents

- [Features](#features)
- [Architecture](#architecture)
- [Directory Structure](#directory-structure)
- [Configuration](#configuration)
- [Alert Routing Config (alerts.json)](#alert-routing-config-alertsjson)
- [Alert Lifecycle](#alert-lifecycle)
- [Escalation](#escalation)
- [Alert Sources](#alert-sources)
  - [Grafana Webhook](#grafana-webhook)
  - [AWS SNS via SQS](#aws-sns-via-sqs)
  - [Adding a New Source](#adding-a-new-source)
- [HTTP API](#http-api)
- [Discord Bot Setup](#discord-bot-setup)
- [Slash Commands](#slash-commands)
- [Troubleshooting Guides](#troubleshooting-guides)
- [Development](#development)
- [Docker](#docker)
- [Testing](#testing)
- [Audit Log Retention](#audit-log-retention)
- [Logging](#logging)

---

## Features

- **Multi-source ingestion** — Grafana webhook (`POST /alerts`) and AWS SNS via SQS long-polling run through the same pipeline.
- **Rich Discord embeds** — severity colour, title, description, key fields, footer with alert ID and resource, thumbnail.
- **Update-in-place** — the same alert (fingerprint + resource) edits the existing Discord message instead of posting duplicates.
- **Per-incident threads** — a public discussion thread is created under every new alert message.
- **Interactive buttons** — firing alerts show three buttons:
  - **Acknowledge** — records who acknowledged and when; stops escalation; keeps Troubleshoot and Resolve buttons visible.
  - **Troubleshooting guide** — posts the stored markdown guide for that rule into the incident thread.
  - **Resolve** — marks the alert resolved (green embed, no buttons); thread is kept for history.
- **Mention escalation** — critical unacknowledged alerts ping configured Discord users on a 5-minute schedule.
- **Deduplication** — configurable suppress window per rule; Redis-backed.
- **Repeat handling** — reuses existing thread within 30 min of resolution; creates a fresh incident after that.
- **Audit log** — every alert event is written to PostgreSQL with alert ID, resource, status, severity, rule name, source, and who acked/resolved.
- **Configurable routing** — each alert rule maps to its own Discord channel, suppress window, escalation users, and embed options.
- **Config hot-reload** — `POST /reload` or `POST /push-config` without restarting.

---

## Architecture

```
Grafana ──────────► POST /alerts ──────────┐
                                            │
AWS SNS ──► SQS ──► SQS Poller ────────────┤
                                            │
                                     processOneAlertPayload()
                                            │
                              ┌─────────────▼──────────────┐
                              │   Dedup (Redis)             │
                              │   Lifecycle check (Redis)   │
                              │   sendOrUpdateAlert()       │
                              │   insertAlertEvent (PG)     │
                              └─────────────┬──────────────┘
                                            │
                                    Discord.js client
                                            │
                              ┌─────────────▼──────────────┐
                              │  Channel message           │
                              │  Incident thread           │
                              │  Acknowledge / Resolve     │
                              │  Mention escalation loop   │
                              └────────────────────────────┘
```

| Layer | Technology | Purpose |
|-------|-----------|---------|
| HTTP server | Fastify | Grafana webhook, config API |
| Discord client | discord.js v14 | Messages, threads, button interactions, slash commands |
| State store | Redis (ioredis) | Alert state (messageId, threadId, status, escalation level) — 7-day TTL |
| Dedup store | Redis | Suppress duplicate alerts within configurable window |
| Audit / config | PostgreSQL (pg) | `alert_events`, `alerts_config`, `troubleshooting_guides` |
| AWS ingestion | @aws-sdk/client-sqs | Long-poll SQS queue for SNS notifications |
| Validation | Zod | Grafana payload, SNS envelope, alerts config |
| Logging | Pino | Structured JSON with sensitive-key redaction |

---

## Directory Structure

```
discord-alert-bot/
├── src/
│   ├── discord/
│   │   ├── client.ts          # Discord client, sendOrUpdateAlert, button handlers, escalation
│   │   ├── commands.ts        # Slash command handlers (/status, /last, /add-alert, /add-guide, /save, /delete-this)
│   │   ├── embed.ts           # Alert embed builder
│   │   └── status-table-image.ts  # Canvas-based /status PNG (optional)
│   ├── routes/
│   │   ├── alerts.ts          # POST /alerts, GET|POST /reload
│   │   ├── auth.ts            # Bearer token middleware
│   │   └── config.ts          # GET /get-config, POST /push-config, /troubleshooting-guide
│   ├── services/
│   │   ├── config.ts          # Alert config load, cache, validate, bootstrap
│   │   ├── processor.ts       # Grafana normalizer + shared processOneAlertPayload()
│   │   ├── sns-processor.ts   # SNS envelope → AlertApiPayload
│   │   └── sqs-poller.ts      # SQS long-poll loop
│   ├── store/
│   │   ├── redis.ts           # Alert state CRUD (SCAN-based key listing)
│   │   ├── dedup.ts           # Duplicate suppression
│   │   └── postgres.ts        # Schema init, audit log, config, guides
│   ├── types/
│   │   ├── alert.ts           # AlertApiPayload (Zod), StoredAlert, SEVERITY_COLORS
│   │   ├── config.ts          # AlertTypeConfig, AlertsConfig
│   │   ├── grafana.ts         # Grafana webhook schema
│   │   └── sns.ts             # SNS Notification envelope schema
│   ├── logger.ts              # Pino with redaction
│   ├── migration.ts           # alerts.json → DB migration on startup
│   └── server.ts              # Fastify bootstrap, startup sequence
├── tests/
│   ├── discord/commands.test.ts
│   ├── services/
│   │   ├── config.test.ts
│   │   ├── processor.test.ts
│   │   ├── sns-processor.test.ts
│   │   └── sqs-poller.test.ts
│   └── types/grafana.test.ts
├── config/
│   └── alerts.json            # Example alert routing config
├── Dockerfile
├── tsconfig.json              # Production build (src/ only)
├── tsconfig.test.json         # Type-check src/ + tests/ together
└── vitest.config.ts
```

---

## Configuration

All configuration is via environment variables.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DISCORD_BOT_TOKEN` | **Yes** | — | Bot token from the Discord Developer Portal |
| `REDIS_URL` | **Yes** | `redis://localhost:6379` | Redis connection string |
| `DATABASE_URL` | No | — | PostgreSQL connection string. Enables audit log, config persistence, and troubleshooting guides |
| `AUTH_TOKEN` | No | — | When set, all API endpoints require `Authorization: Bearer <token>` |
| `DEFAULT_CHANNEL_ID` | No | — | Fallback Discord channel ID when the payload does not include one |
| `DISCORD_GUILD_ID` | No | — | Guild ID for instant guild-scoped slash command registration (recommended). Without it, commands are global and take up to 1 hour to propagate |
| `DISCORD_USE_MESSAGE_INTENTS` | No | — | Set to `true` to enable the Message Content privileged intent (needed for in-thread `/save` text collection in `/add-guide`) |
| `SQS_ALERT_QUEUE_URL` | No | — | Full SQS queue URL. When set, the bot polls this queue for SNS notifications |
| `SQS_ALERT_QUEUE_REGION` | No | Derived from URL or `AWS_REGION` | AWS region of the SQS queue (e.g. `eu-west-1` when the queue is in a different region from the bot) |
| `AWS_REGION` | No | — | Default AWS region for SDK credential chain |
| `ALERT_CONFIG_PATH` | No | `config/alerts.json` | Override the default alert routing config file path |
| `AUDIT_LOG_TTL` | No | — | Audit log retention: `90d`, `30d`, `365d` or seconds (e.g. `7776000`). Records older than the TTL are deleted on startup and hourly |
| `PORT` | No | `4000` | HTTP server port |
| `LOG_LEVEL` | No | `info` | Pino log level: `trace`, `debug`, `info`, `warn`, `error`, `fatal` |
| `NODE_ENV` | No | `development` | Set to `production` for JSON logs; any other value uses pino-pretty |

---

## Alert Routing Config (alerts.json)

Each entry maps an alert rule name to a Discord channel and behaviour options. The config is loaded from file on startup, merged with any entries previously saved to PostgreSQL, and cached in memory.

```json
{
  "RdsCpuUtilizationHigh": {
    "channelId": "1234567890123456789",
    "suppressWindowMs": 600000,
    "importantLabels": ["instance", "environment", "severity"],
    "hiddenLabels": ["alertname", "DBInstanceIdentifier", "job"],
    "thumbnailUrl": "https://cdn.example.com/rds-icon.png",
    "mentions": ["123456789012345678", "987654321098765432"]
  },
  "default": {
    "channelId": "1234567890123456789",
    "suppressWindowMs": 300000
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `channelId` | string | **Required.** Discord channel to post alerts to |
| `suppressWindowMs` | number | Dedup window in milliseconds. Identical alerts within this window are dropped. Default: 300000 (5 min) |
| `importantLabels` | string[] | Labels displayed first in a "Key info" field |
| `hiddenLabels` | string[] | Labels omitted from the embed entirely |
| `thumbnailUrl` | string | URL for the embed thumbnail image |
| `mentions` | string[] | Discord user IDs to mention during critical alert escalation, in order |

The `default` entry acts as a catch-all for unmatched rule names.

---

## Alert Lifecycle

Each alert is uniquely identified by:

```
incidentKey = alertId + ":" + (resource ?? "default")
```

### States

| State | Description |
|-------|-------------|
| `firing` | Active and unresolved. Three buttons are visible. Escalation is running for critical alerts |
| `acknowledged` | Someone is investigating. Escalation stops. Troubleshoot and Resolve buttons remain visible |
| `resolved` | Fixed. Green embed, no buttons. Thread is kept for history |

### State transitions

```
new alert → FIRING
FIRING → [Acknowledge button] → ACKNOWLEDGED
FIRING → [Resolve button or monitoring resolved event] → RESOLVED
ACKNOWLEDGED → [Resolve button or monitoring resolved event] → RESOLVED
```

### Repeat handling

| Previous state | Time since last event | Behaviour |
|---|---|---|
| `resolved` | ≤ 30 min | Reuse existing message and thread; post `🔁 Alert repeated` embed in thread |
| `resolved` | > 30 min | Create new alert message and new incident thread |
| `acknowledged` | ≤ 1 hour | Reuse existing thread; post `🔁 Alert repeated` in thread only, no mention |
| `acknowledged` | > 1 hour (≤ 1.5 h) | Reuse existing thread; post `🔁 Alert repeated` + `@firstMentionUser` |
| `acknowledged` | > 1.5 hours | Treat as new incident: clear stored state, new message, new thread |

### Thread behaviour

Incident threads are **public** and are created automatically for every new alert message. When an alert is resolved, **the thread is kept** — it serves as a permanent audit trail for the incident. Use `/delete-this` inside a thread to remove it manually if needed.

---

## Escalation

Applies only to **critical** alerts that are in the `firing` state (not acknowledged or resolved).

Timing is measured from when the alert was last posted to Discord (`updatedAt`):

| Time elapsed | Action |
|---|---|
| 5 min | Mention `mentions[0]` in the incident thread |
| 10 min | Mention `mentions[1]` |
| 15 min | Mention `mentions[2]` |
| +5 min per level | Continue through the `mentions` array |

The escalation loop runs every 60 seconds. Once all configured users have been mentioned, escalation stops. Acknowledging the alert stops escalation immediately.

---

## Alert Sources

### Grafana Webhook

Configure a Grafana contact point of type **Webhook** pointing to:

```
POST http://<bot-host>:4000/alerts
Authorization: Bearer <AUTH_TOKEN>
```

The alert rule name used for config lookup is taken from `labels.alertname` (or `labels.alert_type` as a fallback).

### AWS SNS via SQS

**Preferred ingestion pattern for AWS:** SNS → SQS → bot polls SQS (no inbound HTTP from AWS required).

**Setup:**

1. In the same region as your SNS topic (e.g. `eu-west-1`), create an SQS queue and subscribe it to the topic.
2. Set on the bot:
   ```
   SQS_ALERT_QUEUE_URL=https://sqs.eu-west-1.amazonaws.com/123456789012/alert-queue
   SQS_ALERT_QUEUE_REGION=eu-west-1   # only needed when the bot runs in a different region
   ```
3. Grant the bot's IAM identity `sqs:ReceiveMessage`, `sqs:DeleteMessage`, `sqs:GetQueueAttributes` on the queue ARN.

**Event name → config key** — derived in this priority order:

1. SNS `Subject` (spaces replaced with `_`, e.g. `AWS Health Event` → `AWS_Health_Event`)
2. `MessageAttributes.event_type.Value`
3. `MessageAttributes.rule_name.Value`
4. Parsed `Message` JSON: `detail-type`, then `source`, then `eventName`
5. Fallback: `sns` (matches a `"sns"` entry in `alerts.json`)

Add entries in `alerts.json` (or via `/add-alert`) whose keys match these derived names:

```json
{
  "CloudWatch-Alarm": { "channelId": "...", "mentions": ["..."] },
  "AWS_Health_Event": { "channelId": "...", "suppressWindowMs": 300000 },
  "sns":              { "channelId": "..." }
}
```

### Adding a New Source

The shared pipeline is `processOneAlertPayload(payload, log)` in `src/services/processor.ts`. Adding a new source requires three files:

1. **`src/services/{source}-processor.ts`** — parse the source-specific payload, normalise to `AlertApiPayload`, set `source: "{source}"`, call `processOneAlertPayload`.
2. **`src/routes/{source}.ts`** (HTTP webhook) **or** **`src/services/{source}-poller.ts`** (polling loop) — ingestion mechanism.
3. Wire up in **`src/server.ts`**: register the route or start the poller after Discord is ready.

No changes are needed to the Discord layer, dedup, Redis state, or audit log — they are all source-agnostic.

---

## HTTP API

All endpoints return JSON. When `AUTH_TOKEN` is set, every endpoint requires `Authorization: Bearer <token>`.

### `GET /health`

Health check. No auth required.

```json
{ "status": "ok" }
```

---

### `POST /alerts`

Grafana webhook endpoint. Processes alerts asynchronously (returns `200` immediately).

**Body:** Grafana Alertmanager webhook payload.

```json
{ "received": true }
```

---

### `GET /reload` · `POST /reload`

Reload `alerts.json` from disk into the in-memory cache (does not affect DB config).

```json
{ "ok": true, "entries": 3 }
```

---

### `GET /get-config`

Returns the current in-memory alerts config.

```json
{
  "config": {
    "RdsCpuUtilizationHigh": { "channelId": "...", "suppressWindowMs": 600000 }
  }
}
```

---

### `POST /push-config`

Validate, save to PostgreSQL (if `DATABASE_URL` is set), and update the in-memory cache.

**Body:** Same shape as `alerts.json`.

```json
{ "ok": true, "entries": 3 }
```

On validation failure: `400 { "ok": false, "error": "..." }`.

---

### `GET /troubleshooting-guide?alertType=<name>`

Returns the markdown guide for a single alert type, or all guides when `alertType` is omitted.

```json
{ "alertType": "RdsCpuUtilizationHigh", "content": "# Runbook\n\n..." }
```

```json
{ "guides": { "RdsCpuUtilizationHigh": "...", "HighMemory": "..." } }
```

---

### `POST /troubleshooting-guide`

Upsert a markdown guide for an alert type. Requires `DATABASE_URL`.

**Body:**

```json
{ "alertType": "RdsCpuUtilizationHigh", "content": "# Runbook\n\n1. Check CloudWatch..." }
```

```json
{ "ok": true, "alertType": "RdsCpuUtilizationHigh" }
```

---

## Discord Bot Setup

1. Open the [Discord Developer Portal](https://discord.com/developers/applications), create a new Application, and add a Bot.
2. Copy the **Bot Token** → `DISCORD_BOT_TOKEN`.
3. Under **Bot → Privileged Gateway Intents**, enable **Message Content Intent** only if you set `DISCORD_USE_MESSAGE_INTENTS=true` (needed for in-thread text collection in `/add-guide`). The bot works without it — users use the `/save` slash command instead.
4. Under **OAuth2 → URL Generator**, select scopes **`bot`** and **`applications.commands`**, then select permissions:
   - Send Messages
   - Embed Links
   - Read Message History
   - Create Public Threads
   - Manage Threads *(needed for `/add-guide` private threads and `/delete-this`)*
   - Manage Messages
5. Open the generated URL to invite the bot to your server.
6. Enable **Developer Mode** (User Settings → Advanced) to right-click channels and copy IDs for `channelId`.

---

## Slash Commands

Registered automatically at startup. Set `DISCORD_GUILD_ID` for instant guild-scoped registration; without it, global registration can take up to 1 hour.

| Command | Description | Requires DB |
|---------|-------------|-------------|
| `/status` | Table image (or text fallback) of all alerts in the last 24 hours — rule name, severity, last triggered, acknowledged by, resolved by | Yes |
| `/last` | Most recent alert from the audit log | Yes |
| `/get-alert [name]` | Show config for one rule (`name`) or list all rules | No |
| `/add-alert` | Add a new alert rule. Options: `name`, `channel_id`, `suppress_minutes`, `important_labels`, `hidden_labels`, `thumbnail_url`, `mentions` | Yes (to persist) |
| `/add-guide` | Start a troubleshooting guide session in a new private thread. Type your guide content, then `/save` to commit or `/cancel` to abort | Yes |
| `/save` | Save the guide in the current `/add-guide` thread | Yes |
| `/delete-this` | Delete the current thread | No |

---

## Troubleshooting Guides

Guides are markdown documents stored in the `troubleshooting_guides` PostgreSQL table, keyed by rule name.

**To add or update a guide:**

- Via HTTP: `POST /troubleshooting-guide` with `{ "alertType": "RuleName", "content": "..." }`
- Via Discord: run `/add-guide alert_name:RuleName` in a text channel, type the guide in the created private thread, then `/save`

When a user clicks the **Troubleshooting guide** button on an alert embed, the guide is posted into the incident thread (chunked for Discord's 2000-character limit). If no guide exists, a "not configured" message is posted instead.

---

## Development

**Prerequisites:** Node.js ≥ 20, Redis, (optional) PostgreSQL.

```bash
# Install dependencies
npm install

# Start with hot-reload
npm run dev

# Lint
npm run lint

# Build
npm run build

# Run built output
npm start
```

**Minimal `.env` for local development:**

```env
DISCORD_BOT_TOKEN=your_bot_token
REDIS_URL=redis://localhost:6379
# DATABASE_URL=postgres://localhost:5432/alertbot   # optional
# DISCORD_GUILD_ID=your_server_id                   # optional, for instant slash commands
LOG_LEVEL=debug
```

---

## Docker

**Multi-stage build** — builder compiles TypeScript; runtime image contains only the compiled JS and production dependencies. Runs as a non-root user (`app:app`).

```bash
# Build
docker build -t discord-alert-bot .

# Run
docker run -d \
  -e DISCORD_BOT_TOKEN=... \
  -e REDIS_URL=redis://redis:6379 \
  -e DATABASE_URL=postgres://... \
  -p 4000:4000 \
  discord-alert-bot
```

**Health check:** `GET /health` → `{ "status": "ok" }`. Configured in the Dockerfile with a 30-second interval.

**In a Compose stack:**

```bash
docker compose up -d redis-alert-bot postgres-alert-bot discord-alert-bot
```

---

## Testing

Tests live in `tests/` and mirror the `src/` structure. The test tsconfig (`tsconfig.test.json`) extends the main tsconfig so editors type-check both trees together.

```bash
npm test              # run all tests once
npm test -- --watch   # watch mode
```

All external dependencies (Discord.js, Redis, PostgreSQL, SQS) are mocked. Test files:

| File | What it covers |
|------|---------------|
| `tests/services/processor.test.ts` | `processOneAlertPayload`: no-config suppression, dedup, resolved/ack expiry windows, audit log, error handling |
| `tests/services/sns-processor.test.ts` | `deriveEventName` (Subject / MessageAttributes / Message JSON / default), payload building, `source` field |
| `tests/services/sqs-poller.test.ts` | `isSqsPollerEnabled` with all env var combinations |
| `tests/services/config.test.ts` | File loading, cache, safe reload, validation |
| `tests/discord/commands.test.ts` | All slash command handlers and guide markdown helpers |
| `tests/types/grafana.test.ts` | Grafana Zod schema validation |

---

## Audit Log Retention

Every alert lifecycle event is written to the `alert_events` PostgreSQL table with columns: `alert_id`, `resource`, `status`, `message_id`, `channel_id`, `severity`, `rule_name`, `source`, `acknowledged_by`, `resolved_by`, `created_at`.

Configure automatic cleanup with `AUDIT_LOG_TTL`:

```env
AUDIT_LOG_TTL=90d    # 90 days (recommended for production)
AUDIT_LOG_TTL=30d    # 30 days
AUDIT_LOG_TTL=365d   # 1 year
```

Cleanup runs once on startup and then every hour. Without `AUDIT_LOG_TTL`, records accumulate indefinitely.

---

## Logging

Structured JSON (Pino). In development (`NODE_ENV` not `production`), logs are pretty-printed via pino-pretty.

Every log line includes `component`, `event`, and relevant domain fields. Sensitive keys (`token`, `password`, `authorization`, `secret`, `api_key`) are automatically redacted.

```json
{
  "level": "info",
  "time": "2026-02-18T10:00:00.000Z",
  "component": "processor",
  "event": "alert_sent",
  "alertId": "fp1",
  "ruleName": "RdsCpuUtilizationHigh",
  "channelId": "123456789",
  "messageId": "msg-789",
  "resource": "db-prod-1",
  "source": "grafana",
  "msg": "alert_sent"
}
```

Set `LOG_LEVEL=debug` to see suppressed alerts (`alert_suppressed_dedup`, `alert_suppressed_no_config`).