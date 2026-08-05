# @votetracker/sdk

Official TypeScript/JavaScript SDK for the [VoteTracker](https://votetracker.bot) public API and webhook forwarding.

React to votes in real time, run giveaways from your own code, and hand out rewards automatically from typed, verified webhooks.

- One runtime dependency, under 5 kB gzipped. The webhook module has none.
- Works the same from plain JavaScript, with autocomplete.
- Types generated from the published OpenAPI spec, so the client matches the API exactly.

## Install

```sh
npm install @votetracker/sdk
```

Node 18.17 or newer.

## Setup

Everything is configured in the [dashboard](https://votetracker.bot/dashboard/api):

1. Create an API key with the scopes you need (`votes:read`, `events:read`, and `events:write` for giveaway writes).
2. To receive webhooks, add a forwarding target: your publicly reachable endpoint URL, the auth mode (SIGNATURE recommended), and the event types you want. Copy the signing secret or token when it is shown; it appears once.

## Quick start: reward voters as they vote

Every vote reaches your endpoint as a signed `VOTE_CREATED` delivery.

```ts
import express from 'express'
import { handleEvent } from '@votetracker/sdk/webhooks'
import { votetrackerWebhook } from '@votetracker/sdk/webhooks/express'

const app = express()

// Register the webhook route BEFORE global body parsers: verification needs the
// body exactly as sent, and a parser would re-serialize it.
app.post(
  '/webhooks/votetracker',
  ...votetrackerWebhook(
    { secret: process.env.VT_SIGNING_SECRET! },
    handleEvent({
      VOTE_CREATED: async (vote) => {
        // Deliveries can repeat: dedupe on the vote id, which is stable across
        // forwarding retries and the votes API.
        if (await alreadyCredited(vote.id)) return

        await grantCoins(vote.userPlatformId, 100 * vote.weight)
        console.log(`${vote.userPlatformId} voted, streak ${vote.streakCurrent}`)
      },
    }),
  ),
)

app.use(express.json())
app.listen(3000)
```

`handleEvent` hands each callback the event payload directly, fully typed (the whole event, with `eventType` and `occurredAt`, arrives as the second argument). No narrowing by hand.

## Run giveaways and hand out the prizes

Attach any JSON you like as `externalReward`. VoteTracker stores it, never shows it in Discord, and echoes it back verbatim when winners are drawn, so your bot knows exactly what to grant.

```ts
import { createVoteTracker } from '@votetracker/sdk'

const vt = createVoteTracker({
  apiKey: process.env.VT_API_KEY!,          // needs events:write for writes
  integrationId: 'your-integration-id',
})

const ONE_DAY_MS = 24 * 60 * 60 * 1000

await vt.giveaways.create(
  {
    guildId: '610464532967456778',
    announcementChannelId: '763124809637953577',
    startsAt: new Date().toISOString(),
    endsAt: new Date(Date.now() + ONE_DAY_MS).toISOString(),
    winnerCount: 3,
    prizeText: '500 credits',
    externalReward: { kind: 'currency', amount: 500 },
    activate: true,
  },
  { idempotencyKey: 'daily-2026-08-10' },  // makes retries safe
)
```

Then grant on `EVENT_WINNERS_SELECTED`, and follow rerolls so the right people keep the prize:

```ts
handleEvent({
  EVENT_WINNERS_SELECTED: async (giveaway) => {
    for (const winner of giveaway.winners) {
      if (await alreadyGranted(giveaway.eventId, winner.userPlatformId)) continue
      await grantReward(winner.discordId ?? winner.userPlatformId, giveaway.externalReward)
    }
  },

  EVENT_WINNER_REROLLED: async (giveaway) => {
    for (const reroll of giveaway.rerolls) {
      await revokeReward(reroll.previousWinner.userPlatformId)
      await grantReward(reroll.newWinner.userPlatformId, giveaway.externalReward)
    }
  },
})
```

For `GAME` projects `userPlatformId` is the Roblox id and `discordId` is the linked Discord account (null when the voter never linked one). Act on Discord through `discordId`.

## Webhook events

| Event | Fires when | Key fields |
|---|---|---|
| `VOTE_CREATED` | someone votes | `id`, `userPlatformId`, `weight`, `query`, `isTest` |
| `EVENT_CREATED` | a giveaway is announced | `eventId`, `prizeText`, `externalReward`, `prizeImageUrl` |
| `EVENT_ACTIVATED` | a giveaway announcement is (re)published | `eventId`, `startsAt`, `endsAt`, `winnerCount` |
| `EVENT_COMPLETED` | a giveaway ends | `eventId`, `totalEntries`, `winners` |
| `EVENT_WINNERS_SELECTED` | winners are drawn | `winners`, `externalReward`, `selectedAt` |
| `EVENT_WINNER_REROLLED` | a winner is replaced | `rerolls`, `winners`, `reason` |
| `EVENT_CANCELLED` | a giveaway is cancelled | `eventId`, `cancelReason`, `cancelledAt` |
| `WEBHOOK_TEST` | you send a test from the dashboard | `deliveryId` |

Handlers respond automatically: `204` on success, `401` when verification fails (VoteTracker does not retry forged requests), `500` when your handler throws so the delivery is retried with backoff. Only mark work done after it succeeded.

New event types never break an old SDK: callbacks you did not write are simply not called, and `handleEvent({ onUnknown })` sees anything this version does not model.

Prefer handling the event yourself? Narrow with `isKnownEvent` first, otherwise the catch-all member keeps `data` as `unknown`:

```ts
import { isKnownEvent } from '@votetracker/sdk/webhooks'

if (isKnownEvent(event)) {
  switch (event.eventType) {
    case 'EVENT_WINNERS_SELECTED': /* event.data fully typed */ break
  }
}
```

## Both forwarding auth modes

Pick the mode in your forwarding configuration; the SDK takes it in the same place.

```ts
// SIGNATURE (recommended): HMAC over the body, with replay protection
votetrackerWebhook({ secret: process.env.VT_SIGNING_SECRET! }, handler)

// AUTH_HEADER: VoteTracker sends the generated `Bearer vt_...` value in the
// Authorization header, or in the custom header name you configured. The SDK
// accepts your configured value with or without the Bearer prefix.
votetrackerWebhook({ authHeader: { value: process.env.VT_FORWARD_TOKEN! } }, handler)
votetrackerWebhook({ authHeader: { value: token, name: 'X-My-Token' } }, handler)
```

AUTH_HEADER carries no timestamp and therefore no replay protection; prefer SIGNATURE when you can.

Fastify and Hono adapters take the same options:

```ts
import { votetrackerWebhook } from '@votetracker/sdk/webhooks/fastify'
await app.register(votetrackerWebhook({ secret }, handler))
```

```ts
import { votetrackerWebhook } from '@votetracker/sdk/webhooks/hono'
app.post('/webhooks/votetracker', votetrackerWebhook({ secret }, handler))
```

Any other framework: give `verifyDelivery` the raw body and headers.

```ts
import { verifyDelivery } from '@votetracker/sdk/webhooks'

const { event, deliveryId, attempt } = verifyDelivery({
  rawBody,                 // string or bytes, exactly as received
  headers: req.headers,
  secret: process.env.VT_SIGNING_SECRET!,
})
```

## The rest of the API

```ts
await vt.giveaways.list({ status: 'ACTIVE' })
await vt.giveaways.get(eventId)
await vt.giveaways.update(eventId, body)                 // drafts only, full replace
await vt.giveaways.activate(eventId)
await vt.giveaways.cancel(eventId, { cancelReason: '...' })
await vt.giveaways.setRepeating(eventId, true)
await vt.giveaways.rerollWinner(eventId, userPlatformId, { reason: '...' })
await vt.giveaways.rerollAllWinners(eventId, { reason: '...' })

await vt.votes.list({ startDate: '2026-08-01T00:00:00Z' })   // last 7 days
await vt.votes.userStatus(userPlatformId)
await vt.votes.userLatest(userPlatformId)
```

Cursor pagination is handled by the iterators (giveaways newest first, votes oldest first, matching how the API pages):

```ts
for await (const giveaway of vt.giveaways.iterate({ status: 'COMPLETED' })) { /* ... */ }
for await (const vote of vt.votes.iterate({ startDate })) { /* ... */ }
```

`update` replaces the whole configuration: omitted fields are cleared, including `externalReward`. Send the complete desired state, not a patch.

Field names are camelCase in code and snake_case on the wire; the SDK converts both ways. Your `externalReward` payload and vote `query` map are passed through untouched.

## Errors and retries

Non-2xx responses throw `VoteTrackerApiError` with `status`, a stable `errorCode`, `detail` and `traceId`. Quote the `traceId` in support requests; it identifies the exact call.

```ts
import { isVoteTrackerApiError } from '@votetracker/sdk'

try {
  await vt.giveaways.create(body)
} catch (error) {
  if (isVoteTrackerApiError(error) && error.errorCode === 'PREMIUM_REQUIRED') {
    // feature gate, not a bug
  } else {
    throw error
  }
}
```

Retries are on by default and correctness-first: `429` is always retried honoring `Retry-After` (the request was not executed), network errors and `5xx` are retried for reads, and for writes only when you passed an `idempotencyKey`. Turn them off with `retry: false` or tune `retry: { maxAttempts }`. `vt.lastRateLimit` exposes the latest `RateLimit-*` headers.

## Notes

- Plain JavaScript works the same, autocomplete included: `const { createVoteTracker } = require('@votetracker/sdk')`.
- `vt.raw` is the underlying [openapi-fetch](https://github.com/openapi-ts/openapi-typescript) client, typed against the full spec, for anything the SDK does not wrap. Raw calls speak wire snake_case; `toWire` and `fromWire` are exported for the same conversion the SDK applies.
- One naming quirk inherited from the API: the votes list calls the voter `voterPlatformId`, webhooks and the per-user endpoints say `userPlatformId`. Same identifier.

## Documentation

- [API reference](https://developer.votetracker.bot/docs)
- [Giveaways guide](https://developer.votetracker.bot/docs/giveaways)
- [Webhook forwarding guide](https://developer.votetracker.bot/docs/forwarding)
- [Support server](https://votetracker.bot/support)

## License

MIT
