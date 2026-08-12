# Rbackend

## Dealett Market Intelligence

Dealett AI uses a separated market-data model so it can reason about Swedish telecom claims without confusing public market knowledge with offers Dealett can actually sell.

### Data Files

- `data/operators.json` is the broad Swedish telecom market reference. It contains operator-level facts such as brand type, network used, supported customer segments, 5G/eSIM support flags and verification status.
- `data/plans.json` is the runtime source of truth for mobile operators, plans, prices, family terms, streaming and international benefits. The normalized JSON copies must remain byte-for-byte identical to it.
- `data/partner-offers.json` is only for Dealett sellable offers. Rows should stay inactive until the operator, plan, reward and source have been verified.
- `data/market-rules.json` defines claim-classification rules and placeholder heuristic ranges for judging customer price claims. These ranges are not real offers.
- `data/market-verification-checklist.json` defines the manual verification scope for Telia, Tele2, Telenor and Tre. It lists the categories and plan fields that must be checked by a human before data can be trusted in production.
- `docs/market-verification-checklist.md` is the human-readable checklist for manual operator/category verification.

### AI Behavior Rules

Dealett AI should use this data for judgment, not accusation. If a customer claims a very low price, the assistant should never say the customer is lying. It should ask whether the price is a campaign, family/shared plan, student discount, senior discount, employer-paid plan, old retained contract, bundled discount or temporary winback offer.

If the customer already has a clearly better deal than Dealett can beat, Dealett AI should say that keeping the current deal may be the best consumer-side advice.

### AI chat

The chat requires `OPENAI_API_KEY` on the backend. `OPENAI_MODEL` is optional; the default response model is `gpt-5.6-terra`. Qualification extraction uses `gpt-5.6-luna` by default and can be overridden with `OPENAI_ANALYSIS_MODEL`.

Every assistant answer is generated through the OpenAI Responses API with Structured Outputs. The first model call updates the customer's qualification, the shared `offer-calculator.js` performs all recommendation math, and a second model call explains the exact result using the website knowledge and mobile-plan catalog. API failures return an error and never substitute a scripted assistant reply.

The quiz and chat both call the same calculator. Run these checks after changing recommendation or chat behavior:

```bash
npm run test:recommendations
npm run test:chat-dynamic
npm run test:recommendation-parity
npm run test:chat-ui-response
```

### Maintenance

Prices, segments, plan details, reward amounts and source URLs must be updated regularly. Placeholder values are allowed for structure and development. Fake verified prices are not allowed. Only mark data as `verified` when the row has a current source URL and has been manually checked.

Run the manual verification report before updating production-facing market data. The report writes both JSON and Markdown output in `reports/` and flags placeholder rows, missing source URLs, missing dates, missing prices and incomplete operator/category coverage.

The market update pipeline framework lives in `scripts/market-data/`. Collectors currently return `status: "not_implemented"` and do not scrape. Running `npm run market:update` saves raw placeholder snapshots in `data/market/raw/`, normalized output in `data/market/normalized/`, and update reports in `data/market/reports/`. The command is dry-run by default and leaves `data/plans.json` unchanged. Later, apply mode can be enabled with `MARKET_APPLY=true npm run market:update`; even then, verified rows are not overwritten automatically and all changes are reported.

### Commands

```bash
npm run validate:market
npm run market:verification-report
npm run market:update
npm run test:market
```
