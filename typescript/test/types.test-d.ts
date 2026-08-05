import { describe, expectTypeOf, it } from 'vitest'
import type { CreateGiveawayRequest, Giveaway, GiveawayPage, GiveawayWinner, Vote } from '../src/index.js'
import type { EventWinnersSelectedEvent, WebhookEvent, WebhookWinner } from '../src/webhooks/index.js'
import { isKnownEvent } from '../src/webhooks/index.js'

// Locks the spec's required/nullable contract as it flows through generation and Camelize.
describe('domain types', () => {
  it('always-present response fields are non-optional', () => {
    expectTypeOf<Giveaway['eventId']>().toEqualTypeOf<string>()
    expectTypeOf<Giveaway['guildId']>().toEqualTypeOf<string>()
    expectTypeOf<Giveaway['winnerCount']>().toEqualTypeOf<number>()
    expectTypeOf<Giveaway['status']>().toEqualTypeOf<
      'DRAFT' | 'SCHEDULED' | 'ACTIVE' | 'COMPLETING' | 'COMPLETED' | 'CANCELLED'
    >()
    expectTypeOf<Vote['voterPlatformId']>().toEqualTypeOf<string>()
  })

  it('defaulted wire fields are optional', () => {
    expectTypeOf<Giveaway['repeating']>().toEqualTypeOf<boolean | undefined>()
    expectTypeOf<Giveaway['baseEntriesPerVote']>().toEqualTypeOf<number | undefined>()
  })

  it('nullable fields carry null', () => {
    expectTypeOf<GiveawayWinner['discordId']>().toEqualTypeOf<string | null | undefined>()
    expectTypeOf<Giveaway['announcementError']>().toEqualTypeOf<string | null | undefined>()
    expectTypeOf<GiveawayPage['nextCursor']>().toEqualTypeOf<string | null>()
  })

  it('create request requires the core fields as camelCase', () => {
    expectTypeOf<CreateGiveawayRequest['guildId']>().toEqualTypeOf<string>()
    expectTypeOf<CreateGiveawayRequest['prizeText']>().toEqualTypeOf<string>()
    expectTypeOf<CreateGiveawayRequest['externalReward']>().toEqualTypeOf<unknown>()
  })
})

describe('webhook union', () => {
  it('narrows to the exact payload behind the isKnownEvent guard', () => {
    const handle = (event: WebhookEvent): void => {
      if (isKnownEvent(event) && event.eventType === 'EVENT_WINNERS_SELECTED') {
        expectTypeOf(event).toEqualTypeOf<EventWinnersSelectedEvent>()
        expectTypeOf(event.data.winners[0]).toEqualTypeOf<WebhookWinner | undefined>()
        expectTypeOf(event.data.externalReward).toEqualTypeOf<unknown>()
      }
    }
    expectTypeOf(handle).toBeFunction()
  })
})
