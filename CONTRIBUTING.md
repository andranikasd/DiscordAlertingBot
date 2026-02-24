# Contributing to Discord Alert Bot

Thank you for your interest in contributing! This document covers everything you need to get started.

---

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Branching Strategy](#branching-strategy)
- [Commit Conventions](#commit-conventions)
- [Development Workflow](#development-workflow)
- [Running Tests](#running-tests)
- [Submitting a Pull Request](#submitting-a-pull-request)
- [Reporting Issues](#reporting-issues)

---

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating you agree to uphold it.

---

## Getting Started

**Prerequisites:**

- Node.js ≥ 20
- npm ≥ 10
- Redis (for integration testing with a real bot)
- PostgreSQL (optional — for audit log and config features)

```bash
# 1. Fork and clone
git clone https://github.com/<your-fork>/DiscordAlertingBot.git
cd DiscordAlertingBot

# 2. Install dependencies
npm install

# 3. Copy env file and fill in required values
cp .env.example .env

# 4. Start in watch mode
npm run dev
```

---

## Branching Strategy

| Branch | Purpose |
|--------|---------|
| `master` | Stable, production-ready code. Protected — no direct pushes. |
| `feat/<short-description>` | New features |
| `fix/<short-description>` | Bug fixes |
| `chore/<short-description>` | Maintenance, dependency updates, tooling |
| `docs/<short-description>` | Documentation-only changes |
| `refactor/<short-description>` | Internal refactors with no behaviour change |

Always branch from `master`:

```bash
git checkout master
git pull origin master
git checkout -b feat/my-new-feature
```

---

## Commit Conventions

This project uses [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <short summary>

[optional body]

[optional footer]
```

**Types:**

| Type | When to use |
|------|------------|
| `feat` | A new feature |
| `fix` | A bug fix |
| `docs` | Documentation only |
| `refactor` | Code change with no feature or fix |
| `test` | Adding or updating tests |
| `chore` | Build process, dependencies, tooling |
| `ci` | CI configuration changes |
| `perf` | Performance improvements |

**Examples:**

```
feat(sns): add support for EventBridge CloudWatch Alarms
fix(escalation): stop escalation loop when alert is deleted from Redis
docs(readme): add docker-compose example
test(processor): add coverage for ack expiry window
chore(deps): bump discord.js from 14.14.1 to 14.15.0
```

**Rules:**

- Use the imperative mood in the summary: "add", not "added" or "adds"
- Keep the summary under 72 characters
- Reference issues in the footer: `Closes #42`

---

## Development Workflow

```bash
# Lint
npm run lint

# Type-check
npx tsc --noEmit

# Build
npm run build

# Run tests
npm test

# Watch mode (tests)
npm test -- --watch
```

**Project structure:**

```
src/
├── discord/     Discord client, embeds, commands
├── routes/      Fastify HTTP routes
├── services/    Business logic (processor, config, SQS poller)
├── store/       Redis and PostgreSQL adapters
└── types/       Zod schemas and TypeScript types
tests/           Mirror of src/ — one test file per source file
config/          Example alert routing config
docs/            Additional documentation
```

**Adding a new alert source:**

1. Create `src/services/{source}-processor.ts` — normalize to `AlertApiPayload`, call `processOneAlertPayload`.
2. Create `src/routes/{source}.ts` (webhook) or `src/services/{source}-poller.ts` (polling loop).
3. Wire up in `src/server.ts`.
4. Add tests in `tests/services/{source}-processor.test.ts`.

No changes to the Discord layer, dedup, Redis state, or audit log are needed — they are source-agnostic.

---

## Running Tests

All external dependencies (Discord.js, Redis, PostgreSQL, SQS) are mocked in tests. No live services are required.

```bash
npm test                 # run all tests once
npm test -- --watch      # watch mode
npm test -- --coverage   # with coverage report
```

Tests mirror `src/` in `tests/`. When adding new functionality, add corresponding tests. Aim for meaningful coverage of branches and error paths, not just happy paths.

---

## Submitting a Pull Request

1. Create a branch from `master` following the [branching strategy](#branching-strategy).
2. Make your changes and commit them following the [commit conventions](#commit-conventions).
3. Ensure all checks pass locally:
   ```bash
   npm run lint && npx tsc --noEmit && npm test && npm run build
   ```
4. Add an entry to `CHANGELOG.md` under `[Unreleased]`.
5. Push your branch and open a pull request against `master`.
6. Fill in the PR template — link related issues, describe the change, and confirm the checklist.
7. A maintainer will review your PR. Address any requested changes by pushing new commits (do not force-push after review has started).

---

## Reporting Issues

Use the GitHub issue tracker:

- **Bug report** — something is not working as expected.
- **Feature request** — suggest a new capability or improvement.

Before opening an issue, please search existing ones to avoid duplicates. When reporting a bug, always redact any sensitive information (tokens, Discord IDs, credentials) from logs and config snippets.
