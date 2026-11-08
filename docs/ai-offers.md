# Community AI offers through Bot

OpenVibe Link's `ai` plugin can offer a person's local models to the network. Bot is the transport and the reporter:

- **Report** — `server/jobs/offers.js` `buildAi()` reads every live Network-paired device whose
  `capabilities.ai.ai.offer.enabled` is true and publishes one offer per machine to Network's
  `POST /internal/ai/offers/report` (`source: bot`) with the owner, models, hours, concurrency, credit price, audience,
  ready flag and health. It is a separate report from the worker/desk `platform.resource-offer@1` set, sent by the same
  publisher (`createAiOfferReporter`, `server/network.js`).
- **Dispatch** — `POST /api/v1/machines/:id/commands` with `kind: ai` reaches a machine only from OpenVibe.AI
  (`svc:ai`, `bot.machine.ai`). A machine's own models need `ai_models` (the owner's "Let my AI use this computer's
  models" switch). A **community** run is marked with the `community/<model>` model prefix and is allowed when the
  machine's own offer is enabled: the offer is the opt-in, and the Link plugin enforces hours, concurrency and its
  model list. The prefix never reaches the local model server.

The command's value is `bot.command@1`, which is closed to extra fields, so the prefix carries the community flag
without changing the contract. The offer itself is not a `platform.resource-offer@1`: that contract closes `detail`
for kind node/provider and cannot carry a model list, hours, a price and an audience. Network has the dedicated
`platform_ai_offers` table.

Test: `node test/community-ai.test.js`.
