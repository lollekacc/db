# Dealett backend

This service keeps the existing calculator, chat, translation, feedback, BankID demo, and legacy compatibility behavior while adding a versioned operations platform API. PostgreSQL is the live system of record. The in-memory repository is available only as the explicit `DEMO_MODE=true`/test adapter and contains fictional data.

## Runtime modes

Copy `.env.example` to `.env` and choose one mode deliberately:

```bash
# Fictional local demo
DEMO_MODE=true
DEALETT_REPOSITORY=memory

# Live-authority boundary (authentication and identity adapters must be configured before use)
DEMO_MODE=false
DEALETT_REPOSITORY=postgres
DATABASE_URL=postgresql://...
DEALETT_DATA_ENCRYPTION_KEY=<exactly 32 bytes encoded as base64>
```

PostgreSQL 15 or newer is required. The migrations use `UNIQUE NULLS NOT DISTINCT` and security-invoker views. Wildcard CORS origins are rejected. If platform mode is requested but invalid, `/api/orders` and versioned routes fail closed instead of falling back to JSON files.

Start the service with `npm start`. In demo mode, AI fallback responses are visibly labeled with `source`, `model`, and `simulated` values of `demo-simulated`, `demo-simulated`, and `true`. No live integration is called by a simulate endpoint.

## Database lifecycle

```bash
npm run db:migrate
npm run db:migrate:down -- 1

# Deterministic fictional seed (PostgreSQL writes require these explicit settings)
NODE_ENV=development DEMO_MODE=true DEALETT_REPOSITORY=postgres npm run db:seed

# Destructive reset additionally requires a demo/test database name and confirmation
NODE_ENV=development DEMO_MODE=true DEALETT_REPOSITORY=postgres \
RESET_DEMO_CONFIRM=RESET_FICTIONAL_DEMO_DATA npm run db:reset-demo

# Inspect legacy JSON before importing it into immutable preservation tables
npm run db:import-legacy
node scripts/import-legacy-json.js --apply
```

Seed/reset is forbidden in `NODE_ENV=production`. Reset refuses database names that do not contain `demo` or `test`. The deterministic PostgreSQL seed includes linked customers, conversations/messages, orders and four workflow histories, commission and gift-card ledgers, support, GDPR, RBAC, catalog/rules, integrations, metrics, and settings.

## API and security contracts

See [docs/operations-api.md](docs/operations-api.md) for routes and representative payloads. Important boundaries:

- `POST /api/public/v1/orders` and `/api/orders` require `Idempotency-Key`; only a minimal receipt is returned or persisted for replay.
- Existing conversations require their opaque token for reads, appends, reconciliation, and order archival. Archived messages and order snapshots are append-only.
- A new conversation may use a client identifier, but identifier collisions return `CONVERSATION_ID_CONFLICT` unless the existing token is supplied.
- A tokenless, empty client conversation ID is treated as “no chat” and does not block checkout. Truncated fallback transcripts are rejected as recoverable rather than archived partially.
- Multiple distinct offers currently fail closed with `MULTI_OFFER_CONSENT_REQUIRED`; a family plan may still have multiple participants. This prevents one offer/consent from being silently applied to unrelated lines.
- Live order capture requires both backend-verified identity evidence and backend-verified registered consent document versions/hashes. Browser BankID evidence is ignored outside demo mode.
- Partner/customer queries are tenant-scoped in both repository logic and PostgreSQL RLS. Unset RLS session context denies order access. Non-sensitive roles receive masked order/contact DTOs and masked CSV exports.
- Consequential terminal, financial, and delivery transitions require `confirmed=true` in addition to a reason and optimistic version.

## Verification

```bash
npm run check
npm test
# equivalent full handoff command
npm run test:all
```

Migration tests execute every up/down file and deterministic seed twice in PostgreSQL-compatible PGlite. They also run against an isolated real PostgreSQL schema when `DEALETT_TEST_DATABASE_URL` is set:

```bash
DEALETT_TEST_DATABASE_URL=postgresql://localhost/dealett_test npm run test:migrations
```

During this implementation, the same complete up/down suite was also verified on disposable PostgreSQL 16.14. The optional test remains the repeatable way to verify a target PostgreSQL installation.

The existing recommendation/chat parity suites remain part of `npm test`. OpenAI-backed chat still requires `OPENAI_API_KEY`; outside demo mode, an unavailable AI service returns an error and never substitutes a scripted answer.

## Launch configuration audit

### Public preview release

The HTTP server defaults to `PUBLIC_PREVIEW=true`. It serves only catalogue and stateless comparison routes; order routes return `423 ORDERS_DISABLED`, and identity, account, chat, newsletter and other non-catalogue APIs return `423 PREVIEW_ONLY`. It skips database startup/migrations in this mode, even if stale platform or AI configuration exists. An explicit demo configuration cannot override the preview restriction.

Preview capability, liveness and readiness endpoints (`/api/public/v1/environment`, `/api/public/v1/health/live`, `/api/public/v1/health/ready`) remain available when `DEALETT_CONVERSATION_STORAGE_ONLY=true`. They report preview readiness and disabled orders without accessing the checkout platform or database. This does not certify sales readiness. Keep the conversation-only flag as configured; disabling it to work around an environment-route 404 can expose unrelated platform routes.

`LIVE_ORDERS_ENABLED` defaults to false independently. Turning preview off cannot enable real orders by itself. The legacy JSON order-write route has been removed from the HTTP server; live orders must pass the existing platform identity and document checks. Local integration tests explicitly use `publicPreview: false` to test the non-preview implementation.

Run `npm run test:preview` for the server boundary. Run `npm run build:preview` in `../df` to produce the static public package, then `npm run preview` here for a loopback-only review. The static preview does not call this backend at all. Publish the static directory, and deploy the backend gate separately if an existing backend is already publicly reachable. A successful local check does not change a running deployment.

Run `npm run check:launch` from this directory with the intended environment variables to inspect local launch prerequisites. It makes no external requests, prints no secrets, and exits with status 1 while prerequisites or external verification remain pending. It does not load `.env`, prove mailbox delivery, approve operator documents, or certify a production deployment.

`npm run test:launch` verifies catalogue-to-order commitment consistency, configured reward values, and newsletter persistence and consent. Newsletter signup is closed unless `NEWSLETTER_SIGNUP_ENABLED=true`; enable it only after durable storage, mailing, retention and unsubscribe handling are ready. The public receipt contains no subscriber details and does not disclose whether the address was already registered. A corrupt subscriber store fails closed instead of being replaced.

The legacy BankID endpoints only simulate identities under an explicit platform demo configuration. Conversation-only storage does not enable them. A real identity adapter and authenticated customer API are still required for live use.
