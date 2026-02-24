# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest (`master`) | Yes |
| Older releases | No — please upgrade to the latest release |

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Please report them privately via [GitHub's private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability):

1. Go to the **Security** tab of this repository.
2. Click **Report a vulnerability**.
3. Fill in the details and submit.

You will receive a response within **72 hours**. If the vulnerability is confirmed, a fix will be prioritised and a patched release published as soon as possible. You will be credited in the release notes unless you prefer to remain anonymous.

## Scope

Issues in scope include, but are not limited to:

- Authentication bypass on HTTP endpoints (e.g. `AUTH_TOKEN` not enforced)
- Unauthorised access to Discord channels or threads via bot interactions
- Remote code execution or command injection through alert payloads
- Secrets or credentials leaking in logs or API responses
- Dependency vulnerabilities with a clear exploit path

Out of scope:

- Vulnerabilities requiring physical access to the host
- Issues in infrastructure you control (your own Redis, PostgreSQL, AWS account)
- Rate-limiting or denial-of-service from your own Grafana/SNS sources
- Social engineering

## Security Considerations for Self-Hosting

- Always set `AUTH_TOKEN` in production — without it, the HTTP API is unauthenticated.
- Do not expose the bot's HTTP port (`4000`) directly to the internet without TLS termination and network-level access controls.
- Use least-privilege IAM credentials for the SQS poller — only `sqs:ReceiveMessage`, `sqs:DeleteMessage`, `sqs:GetQueueAttributes`.
- Never commit `.env` or any file containing `DISCORD_BOT_TOKEN`, `DATABASE_URL`, or `AUTH_TOKEN`.
- Rotate your Discord bot token immediately if it is ever accidentally exposed.
