# Operations API v1

All API responses are JSON unless the route ends in `.csv`. API responses include `X-Correlation-ID`, `Cache-Control: no-store`, restrictive browser security headers, and allowlisted CORS headers. Workflow values are stable `snake_case` strings.

## Public routes

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/public/v1/environment` | Explicit mode/repository classification |
| GET | `/api/public/v1/health/live` | Process liveness |
| GET | `/api/public/v1/health/ready` | Repository readiness |
| POST | `/api/public/v1/conversations` | Create a conversation and opaque token |
| POST | `/api/public/v1/conversations/:id/messages` | Token-protected user/assistant turn |
| POST | `/api/public/v1/quotes` | Authoritative server-side offer snapshot |
| POST | `/api/public/v1/orders` | Idempotent transactional capture |
| POST | `/api/orders` | Compatibility alias for the same capture service |
| POST | `/api/chat` | Existing chat contract plus optional durable conversation metadata |

### Conversation turn

An initial client history can be sent with stable IDs, sequences, and timestamps. The server seeds it only when it creates the conversation, then enforces contiguous sequencing.

```json
{
  "conversationId": "browser-session-123",
  "messages": [
    { "id": "greeting-1", "sequence": 1, "role": "assistant", "content": "Hej!", "createdAt": "2026-08-29T08:00:00Z" }
  ],
  "clientMessage": { "id": "user-1", "sequence": 2, "createdAt": "2026-08-29T08:01:00Z" },
  "message": "Jämför abonnemang"
}
```

The assistant metadata remains flat for checkout compatibility:

```json
{
  "conversationId": "...",
  "conversationToken": "opaque-secret",
  "source": "demo-simulated",
  "simulated": true,
  "messageMetadata": {
    "id": "...",
    "sequence": 3,
    "createdAt": "2026-08-29T08:01:01.000Z",
    "model": "demo-simulated"
  },
  "userMessageMetadata": { "id": "...", "sequence": 2, "createdAt": "..." }
}
```

Send `conversationToken` in the body or `X-Conversation-Token` header for every existing public conversation.

### Order capture

Send `Idempotency-Key: <8-200 safe characters>`. The compatibility envelope accepts `agreement`, `customer`/`contact`, `cartItems`, `participants`, `phoneNumbers`/`portedNumbers`, `numberHandling`, `questionnaire`, `recommendation`, `calculation`, nested `attribution`/`source`, and an optional conversation snapshot. Submitted commercial data is retained in a bounded `untrusted_submitted_evidence` snapshot but is never used as authoritative pricing.

The server validates catalog offers, calculates exact integer minor units, snapshots catalog/rules/benefits, records separate order/operator/commission/gift-card histories, creates ledgers/outbox/audit records, encrypts sensitive PostgreSQL fields, and archives a complete token-authorized conversation in one transaction.

The public response is intentionally minimal:

```json
{
  "ok": true,
  "duplicate": false,
  "replayed": false,
  "orderId": "019...",
  "orderNumber": "DLT-2026-000101",
  "orderReference": "DLT-2026-000101",
  "publicReference": "7C4M...",
  "status": "submitted",
  "acceptedAt": "2026-08-29T08:10:00.000Z",
  "storedAt": "2026-08-29T08:10:00.000Z",
  "testMode": true,
  "simulated": true
}
```

Replay returns HTTP 200 and the same receipt. A different request with the same key returns `IDEMPOTENCY_CONFLICT`. Client `status` and `testMode` are ignored.

## Protected routes

Demo mode uses `X-Demo-User`; live mode fails with `AUTH_NOT_CONFIGURED` until OIDC is wired. Canonical roles are Owner, Operations Manager, Sales Manager, Seller, Customer Support, Finance, Compliance/GDPR, Offers & Content Manager, Analyst/Read-only, and Operator/Partner.

| Audience | Routes |
| --- | --- |
| Admin | `/api/admin/v1/session`, `/overview`, `/orders`, `/orders/:id`, `/orders/:id/transitions`, `/orders/export.csv`, `/orders/:id/reports`, `/reports/:id`, `/audit`, resource collections, mock integration simulation |
| Customer | `/api/customer/v1/session`, `/orders`, `/orders/:id`, `/orders/export.csv` (own customer only) |
| Partner | `/api/partner/v1/session`, `/orders`, `/orders/:id`, `/orders/:id/transitions`, `/orders/export.csv` (own tenant only) |

Representative protected order fields are stable across repositories:

```json
{
  "id": "...",
  "orderNumber": "DLT-2026-000101",
  "publicReference": "...",
  "partnerOrganizationId": "...",
  "monthlyValueMinor": 29900,
  "giftCardValueMinor": 0,
  "status": "submitted",
  "operatorStatus": "not_ready",
  "commissionStatus": "expected",
  "giftCardStatus": "not_eligible",
  "version": 1
}
```

Partner/analyst/finance views mask customer contacts and participant numbers. Only the owning customer or an actor with `sensitive_data.view` receives full contact data. Manual operator reports additionally require `sensitive_data.view`.

### Transition request

```json
{
  "machine": "operator",
  "to": "ready_for_submission",
  "reason": "Validated by operations",
  "note": "Optional internal note",
  "version": 3
}
```

Add `"confirmed": true` for consequential terminal, reversal, paid/clawback, cancellation, rejection, completion, or delivered transitions. Commission/gift adjustments accept decimal `amount` values and store exact minor units; values with more than two fractional digits are rejected.

## Simulated integrations

`POST /api/admin/v1/integrations/:slug/simulate` is demo-only and returns top-level `simulated: true` and `liveActionPerformed: false`. Live `/api/bankid/*` compatibility routes return `INTEGRATION_NOT_CONFIGURED` until a backend-verifying adapter is installed. Demo BankID data is always marked simulated and can never satisfy live capture.
