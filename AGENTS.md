# AGENTS.md

## Overview

This project is a Node.js Telegram automation service that links users to client profiles, discovers matching Dice jobs, requests application approval, and processes approved applications through a durable queue. It uses CommonJS JavaScript, Node's built-in test runner, PostgreSQL through `pg`, Playwright or Browserbase for browser automation, SendGrid for OTP email, and a small authenticated HTTP dashboard.

## Project Map

- `index.js`: Application entry point and orchestration layer. Initializes the Telegram bot, dashboard server, queue workers, startup recovery, OTP login flow, job scanning, approval prompts, and application execution.
- `lib/`: Reusable runtime modules.
  - `apply-queue.js`: Supabase-style durable application queue operations, including enqueueing, deduplication, claiming, completion, retry, and status checks.
  - `apply-worker.js`: Concurrent queue worker loops that claim jobs, execute them, record outcomes, and audit events.
  - `browser.js`: Local Playwright and Browserbase browser-provider selection, concurrency limiting, and lifecycle management.
  - `dashboard-server.js`: HTTP routes, operator authentication, session cookies, dashboard queries, timezone handling, and static dashboard asset serving.
  - `dice-apply-questions.js`: Dice application form inspection and profile-driven radio, checkbox, and text-field answers.
  - `job-matching.js`: Deterministic job-title matching and excluded-company filtering helpers.
  - `supabase.js`: PostgreSQL pool and a restricted Supabase-like query builder used by the application.
  - `workflow-state.js`: Persistence for workflow sessions, prompts, decisions, and audit events.
- `public/`: Dashboard frontend assets served by `lib/dashboard-server.js`.
  - `dashboard.html`: Dashboard markup and login form.
  - `dashboard.js`: Dashboard API client, rendering, polling, countdowns, and escaping.
  - `dashboard.css`: Dashboard layout and visual styling.
- `database/migrations/`: SQL migrations for operator accounts/sessions, dashboard indexes, and workflow fields. The tables are already created and being used, this is just for reference.
- `scripts/`: Operational utilities.
  - `import-clients.js`: Imports client records from a JSON file or configured API.
  - `map-client-record.js`: Normalizes imported client and profile records.
  - `create-operator.js`: Creates or updates dashboard operator credentials.
  - `verify-client-lookup.js`: Verifies a client/profile lookup.
  - `smoke-browserbase.js`: Explicit Browserbase connectivity smoke test.
- `test/`: Unit tests using `node:test` and `node:assert/strict`.
- `data/`: Sample import data only. Treat real client exports as sensitive and do not add them to version control.
- `link_telegram.html`: Static Telegram bot linking/QR page.
- `Dockerfile`: Node 22 production container setup, dependency installation, and Playwright Chromium installation.
- `.env.example`: Documented environment-variable template. `.env` is ignored and must remain local.
- `package.json`: npm scripts and runtime dependencies.
- `repomix-output.xml`: Generated read-only repository snapshot; edit the source files instead.

## Build & Test Commands

Run commands from the repository root: `Dice_scaling copy/`.

### Install dependencies

```sh
npm install
```

The Docker build uses the production equivalent:

```sh
npm install --omit=dev
npx playwright install --with-deps chromium
```

### Compile or syntax-check

This is an uncompiled JavaScript project and has no `build` or `compile` script. Validate JavaScript syntax with:

```sh
node --check index.js
node --check lib/*.js
node --check scripts/*.js
node --check test/*.test.js
```

For a production container build:

```sh
docker build -t dice-scaling .
```

### Run tests

Run the complete test suite:

```sh
npm test
```

Run one focused test file:

```sh
node --test test/apply-queue.test.js
node --test test/job-matching.test.js
```

### Run the application and operational scripts

The application requires environment variables from `.env`:

```sh
npm start
npm run import-clients -- ./data/sample-clients.json
npm run create-operator -- --email=operator@example.com --password="at-least-12-characters"
npm run verify-client -- client@example.com
```

The Browserbase smoke test is integration-only and requires valid Browserbase configuration:

```sh
npm run smoke-browserbase
```

Do not run integration commands against production data unless explicitly requested and the target environment is confirmed.

### Linting

No linter or `lint` npm script is configured in `package.json`. Do not claim linting has passed. Use the syntax checks above and `npm test` unless a linter is deliberately added as a separate, reviewed change.

## Code Style & Guidelines

- Use plain JavaScript with CommonJS `require()` and `module.exports`; do not introduce TypeScript, ESM, or a framework without an explicit architectural decision.
- Use two-space indentation, semicolons, single-quoted strings, and trailing commas in multiline objects/calls, matching existing files.
- Use descriptive camelCase names for variables and functions, PascalCase only for imported constructors/classes, and UPPER_SNAKE_CASE for module-level timing/configuration constants.
- Prefer small named functions and dependency injection, as used by `createApplyQueue`, `createWorkflowStateStore`, and `createDashboardServer`.
- Keep database access behind the existing `supabase.js` client abstraction or the existing dashboard `pg` pool boundary. Use parameterized SQL for raw queries and validate SQL identifiers through the existing helper.
- Keep workflow state durable in PostgreSQL. Do not rely on in-memory state for correctness across restarts; in-memory state in `index.js` is a runtime coordination cache.
- Preserve queue idempotency and deduplication by client/job URL. Queue transitions must correctly distinguish queued, running, completed, failed, and retryable work.
- Keep browser-provider behavior behind `lib/browser.js`. Always close pages, contexts, and browser handles in `finally` blocks, and preserve Browserbase concurrency limits.
- Keep Telegram/API transport concerns separate from job matching, queueing, profile mapping, and application-question rules where practical.
- Escape user/database-controlled values before inserting them into dashboard HTML. Preserve the existing `escapeHtml` pattern for rendered values.
- Normalize imported data through `scripts/map-client-record.js`; preserve raw payloads and convert invalid or empty values to the established null representation.
- Add or update focused tests in `test/` for behavior changes. Prefer deterministic fakes over live databases, Telegram, Dice, SendGrid, Browserbase, or external HTTP services.
- Test failure paths and boundary conditions for retries, prompt expiry, duplicate jobs, missing profile fields, invalid imports, and session recovery when those paths are changed.
- Avoid arbitrary sleeps in tests. Do not add comments that merely narrate obvious code; comments should explain non-obvious constraints only.

## Security & Guardrails

- Never modify `.env`, credentials, access tokens, browser storage states, or other secret-bearing files. Never write secrets, OTPs, passwords, database URLs, or API tokens into source files, tests, logs, fixtures, or documentation.
- Never edit `repomix-output.xml`; it is a generated read-only snapshot. Modify the original repository files instead.
- Treat `data/sample-clients.json`, imported client records, resumes, phone numbers, email addresses, and database exports as sensitive. Do not add real client data to tests or commit new sensitive fixtures.
- Never call live Telegram, Dice, Supabase/PostgreSQL, SendGrid, Browserbase, or external APIs from unit tests. Use fakes and isolated fixtures. Integration tests require explicit approval and safe test credentials/data.
- Do not remove, weaken, skip, or rewrite failing tests merely to obtain a green result. Fix the implementation or document the failure and its cause.
- Do not alter database migrations, schema assumptions, deployment files, or environment-variable contracts for an unrelated feature or test change.
- Do not change authentication, OTP validation, session-cookie flags, SQL parameterization, HTML escaping, or browser cleanup in a way that reduces security or reliability.
- Do not expose client information, session data, queue errors, credentials, or tokens through new dashboard responses, Telegram messages, or logs.
- Do not commit changes, create branches, reset the worktree, or revert unrelated user changes unless explicitly requested.
- Keep changes within the requested module and its tests. Any necessary production change must be the smallest root-cause fix and must include a regression test when feasible.
