# Sending alerts from Grafana to the Discord Alert Bot

Grafana sends alerts to the bot via a **webhook contact point**. The bot expects Grafana’s default webhook payload on **POST /alerts**.

---

## 1. Webhook URL (contact point URL)

Use **one** of these, depending on how you reach the bot:

| Where Grafana runs | Contact point URL |
|--------------------|-------------------|
| Same Docker network as the bot | `http://discord-alert-bot:4000/alerts` |
| Behind your nginx (e.g. teampowerdmarc) | `https://alertmanager.teampowerdmarc.internal/alerts` or `http://alertmanager.teampowerdmarc.internal/alerts` |
| Local / dev | `http://localhost:4000/alerts` |

- **HTTP Method:** `POST` (Grafana Webhook default).
- Grafana will send its **built-in webhook payload** (alert list, labels, annotations, etc.). The bot parses it; you don’t need to change the payload format.

---

## 2. Auth (if you set `AUTH_TOKEN`)

If the bot is started with `AUTH_TOKEN`, Grafana must send that token on every request:

1. In the contact point, add an **optional HTTP header**:
   - **Header:** `Authorization`
   - **Value:** `Bearer YOUR_AUTH_TOKEN`  
     (replace `YOUR_AUTH_TOKEN` with the same value as the bot’s `AUTH_TOKEN`)

Without this, the bot returns **401 Unauthorized** and the alert is not processed.

---

## 3. Create the contact point in Grafana

1. **Alerting** (bell icon) → **Contact points** → **New contact point**.
2. **Name:** e.g. `Discord Alert Bot`.
3. **Integration:** **Webhook**.
4. **URL:** one of the URLs from the table above (e.g. `http://discord-alert-bot:4000/alerts`).
5. **HTTP Method:** `POST`.
6. If you use auth: add header **Authorization** = **Bearer YOUR_AUTH_TOKEN**.
7. **Save**. Optionally use **Test** to send a test notification.

---

## 4. Alert rule name = config key

The bot routes alerts by **alert name**. Grafana sends this as the **`alertname`** label.

- In **Alert rules**, the **name** you give the rule (e.g. `RdsCpuUtilizationHigh`) becomes `alertname`.
- In the bot’s config (file or **GET/POST /get-config** and **POST /push-config**), the **key** for that alert must match that name.

Example: if the rule is named **RdsCpuUtilizationHigh**, you need an entry in config:

```json
{
  "RdsCpuUtilizationHigh": {
    "channelId": "YOUR_DISCORD_CHANNEL_ID"
  }
}
```

So: **Grafana rule name** = **config key** = **Discord channel** (via `channelId`).

---

## 5. Create an alert rule in Grafana

1. **Alerting** → **Alert rules** → **New alert rule**.
2. **Name:** e.g. `RdsCpuUtilizationHigh` (this must match the config key above).
3. **Folder:** e.g. “Infrastructure”.
4. **Query + condition:** your data source, query, and threshold (e.g. RDS CPU > 80% for 5m).
5. **Annotations (recommended):**
   - **Summary:** e.g. `RDS CPU usage is critically high`
   - **Description:** e.g. `CPU is {{ $values.A.Value }}% on {{ $labels.instance }}. Threshold 80%.`  
     (Avoid templates that can produce `%!f(<nil>)`; the bot will show N/A for those.)
6. **Contact point:** select the one you created (e.g. **Discord Alert Bot**).
7. **Save**.

When the rule fires or resolves, Grafana POSTs to `/alerts`; the bot normalizes the payload, dedupes, looks up `RdsCpuUtilizationHigh` in config, and posts (or updates) the message in the Discord channel for that `channelId`.

---

## 6. Verify

1. Trigger the rule (e.g. exceed threshold for the “For” duration) or use **Test** on the contact point.
2. Check the Discord channel for the message.
3. Check bot logs for `alert_received`, `alert_sent`, or `alert_suppressed_*` / `alert_failed`.

---

## Summary

| Step | Action |
|------|--------|
| 1 | Pick the bot URL (e.g. `http://discord-alert-bot:4000/alerts` or your nginx URL). |
| 2 | If using auth, use header `Authorization: Bearer YOUR_AUTH_TOKEN`. |
| 3 | In Grafana, create a **Contact point** (Webhook) with that URL (and header). |
| 4 | Ensure the bot config has an entry whose **key** = your Grafana **rule name** (e.g. `RdsCpuUtilizationHigh`) with the right `channelId`. |
| 5 | Create the **Alert rule** with that name and attach the contact point. |

Grafana sends alerts automatically when rules fire or resolve; no extra “send” step is needed once the contact point and rule are set.
