# Changelog

## [0.2.0](https://github.com/votetracker-bot/sdks/compare/ts-v0.1.0...ts-v0.2.0) (2026-08-14)


### Features

* **ts:** purchases resource and purchase webhook events ([2726cbb](https://github.com/votetracker-bot/sdks/commit/2726cbb508d536bd7156177cea6b00d45f1acf2a))

## 0.1.0 (2026-08-06)

Initial release.

- Typed client for the full integration API: giveaways (create, activate, update, cancel, recurrence, rerolls, listing) and votes (listing, per-user status and latest), with cursor-handling async iterators.
- Webhook verification (`verifyDelivery`) for both forwarding auth modes (SIGNATURE and AUTH_HEADER), typed payloads for all forwarding event types, a `handleEvent` dispatcher, an unknown-event catch-all, and adapters for Express, Fastify and Hono.
- camelCase surface over the snake_case wire format; opaque `externalReward` and vote `query` data pass through untouched.
- Retries with exponential backoff and jitter (429 always, honoring numeric and HTTP-date Retry-After with a 60s clamp; 5xx and network errors for reads or keyed writes) and `VoteTrackerApiError` with stable error codes and trace ids.
- Hardened boundaries: byte-exact signature verification, prototype-pollution-safe casing, cross-realm header support, error identity that survives mixed ESM/CJS graphs.
