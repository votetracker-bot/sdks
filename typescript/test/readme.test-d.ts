import { describe, expectTypeOf, it } from 'vitest'
import type { EventWinnersSelectedEvent, VoteCreatedEvent, WebhookEvent } from '../src/webhooks/index.js'
import { handleEvent, isKnownEvent } from '../src/webhooks/index.js'

// Compile checks for the exact snippets the README shows; fails when either side drifts.
describe('documented handler patterns', () => {
  it('handleEvent gives each callback its own payload type', () => {
    handleEvent({
      VOTE_CREATED: (vote) => {
        expectTypeOf(vote).toEqualTypeOf<VoteCreatedEvent['data']>()
        expectTypeOf(vote.id).toEqualTypeOf<string>()
        expectTypeOf(vote.query).toEqualTypeOf<Record<string, string> | undefined>()
      },
      EVENT_WINNERS_SELECTED: (giveaway) => {
        expectTypeOf(giveaway).toEqualTypeOf<EventWinnersSelectedEvent['data']>()
        expectTypeOf(giveaway.winners[0]?.discordId).toEqualTypeOf<string | null | undefined>()
      },
      onUnknown: (event) => {
        expectTypeOf(event.data).toEqualTypeOf<unknown>()
      },
    })
  })

  it('isKnownEvent narrows a manual switch', () => {
    const handle = (event: WebhookEvent): void => {
      if (!isKnownEvent(event)) return
      if (event.eventType === 'EVENT_WINNERS_SELECTED') {
        expectTypeOf(event.data.totalEntries).toEqualTypeOf<number>()
      }
    }
    expectTypeOf(handle).toBeFunction()
  })
})
