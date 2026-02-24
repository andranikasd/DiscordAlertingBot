# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

---

## [1.0.0] - 2026-02-24

### Added

- Multi-source alert ingestion: Grafana webhook (`POST /alerts`) and AWS SNS via SQS long-polling.
- Rich Discord embeds with severity-coded colours, key fields, footer, and optional thumbnail.
- Update-in-place: same alert edits the existing Discord message instead of posting duplicates.
- Per-incident public threads created automatically for every new alert.
- Interactive buttons: **Acknowledge**, **Troubleshooting guide**, **Resolve**.
- Mention escalation for critical unacknowledged alerts on a configurable 5-minute schedule.
- Configurable deduplication suppress window per alert rule (Redis-backed).
- Repeat handling: reuse thread within 30 min of resolution; new incident after that.
- Audit log: every lifecycle event written to PostgreSQL (`alert_events` table).
- Per-rule alert routing config (`alerts.json`) with channel, suppress window, labels, and mentions.
- Config hot-reload via `POST /reload` (file) and `POST /push-config` (database).
- Slash commands: `/status`, `/last`, `/get-alert`, `/add-alert`, `/add-guide`, `/save`, `/delete-this`.
- Troubleshooting guides stored in PostgreSQL, posted to incident thread on button click.
- HTTP API: `/health`, `/alerts`, `/reload`, `/get-config`, `/push-config`, `/troubleshooting-guide`, `/metrics`.
- Prometheus-compatible in-memory metrics endpoint (`GET /metrics`).
- Stale state reconciliation loop: verifies Discord messages still exist, cleans up orphaned Redis entries.
- Configurable audit log retention via `AUDIT_LOG_TTL` environment variable.
- Multi-stage Docker build with non-root user and health check.
- Structured JSON logging with Pino and sensitive key redaction.
- Comprehensive test suite with Vitest — all external dependencies mocked.

[Unreleased]: https://github.com/andranik_grigroyan/DiscordAlertingBot/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/andranik_grigroyan/DiscordAlertingBot/releases/tag/v1.0.0
