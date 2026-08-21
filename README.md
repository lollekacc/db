# Rbackend

## AI chat

The chat requires `OPENAI_API_KEY` on the backend. `OPENAI_MODEL` is optional; the default response model is `gpt-5.6-terra`. Qualification extraction uses `gpt-5.6-luna` by default and can be overridden with `OPENAI_ANALYSIS_MODEL`.

Every assistant answer is generated through the OpenAI Responses API with Structured Outputs. The first model call updates the customer's qualification, the shared `offer-calculator.js` performs all recommendation math, and a second model call explains the exact result using the website knowledge and mobile-plan catalog. API failures return an error and never substitute a scripted assistant reply.

Set `DEALETT_DATA_DIR` to a mounted persistent directory in production. Orders, newsletter subscriptions, and chat feedback use that directory; without it they use the local `data` directory.

The quiz and chat both call the same calculator. Run these checks after changing recommendation or chat behavior:

```bash
npm run test:recommendations
npm run test:chat-dynamic
npm run test:recommendation-parity
npm run test:chat-ui-response
```
