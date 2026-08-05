# VoteTracker SDKs

Official SDKs for the [VoteTracker](https://votetracker.bot) public API and webhook forwarding.

- [TypeScript / JavaScript](typescript/): `@votetracker/sdk`

## Repository layout

- `spec/openapi.json`: OpenAPI snapshot the SDK types are generated from
- `fixtures/`: signed webhook test vectors used by the SDK test suites (fixed dummy secret, regenerate with `node fixtures/generate.mjs`)
- one folder per language, each independently packaged and versioned

## Documentation

- [API reference](https://developer.votetracker.bot/docs)
- [Giveaways guide](https://developer.votetracker.bot/docs/giveaways)
- [Webhook forwarding guide](https://developer.votetracker.bot/docs/forwarding)
