/**
 * Forwarding webhook payloads, hand-written from the forwarding guide
 * (https://developer.votetracker.bot/docs/forwarding). Field names are camelCase here; the
 * wire format is snake_case and gets converted during verification. `externalReward` and
 * `query` are user data and pass through verbatim.
 *
 * Adding a forwarding event type on the backend requires extending this union and the shared
 * fixtures. Unknown types parse into {@link UnknownEvent}, never throw.
 */

export type ProjectType = 'BOT' | 'GAME' | 'SERVER'

export interface WebhookWinner {
  /** Winner id on the voting platform (Discord snowflake for BOT/SERVER, Roblox id for GAME). */
  userPlatformId: string
  /** 1 is the top winner. A reroll replaces the winner at the same rank. */
  rank: number
  entriesAtDraw: number
  /**
   * Discord snowflake for actions on Discord (ping, DM, role). Equals userPlatformId for
   * BOT/SERVER projects; for GAME projects it is the linked Discord account and null or absent
   * when the voter never linked one. Always act on Discord via this field.
   */
  discordId?: string | null
  userName?: string | null
}

interface GiveawayEventBase {
  eventId: string
  guildId: string
  type: string
  prizeText: string
  projectPlatformId: string
  projectType: ProjectType
  projectName?: string | null
}

export interface VoteCreatedEvent {
  eventType: 'VOTE_CREATED'
  occurredAt: string
  data: {
    /** Canonical vote id, stable across forwarding and API backfill. Dedupe on this. */
    id: string
    voteType: 'VOTE_CREATE' | 'WEBHOOK_TEST' | (string & {})
    userPlatformId: string
    projectPlatformId: string
    projectType: ProjectType
    projectName?: string | null
    weight: number
    voteExpiresAt?: string | null
    streakCurrent?: number | null
    isTest: boolean
    /** Query parameters from the vote link, verbatim. Present only when the vote carried any. */
    query?: Record<string, string>
  }
}

export interface EventCreatedEvent {
  eventType: 'EVENT_CREATED'
  occurredAt: string
  data: GiveawayEventBase & {
    startsAt: string
    endsAt: string
    winnerCount: number
    baseEntriesPerVote: number
    /** Owner-defined reward payload, echoed verbatim. Absent when not configured. */
    externalReward?: unknown
    prizeImageUrl?: string | null
    isTest: boolean
  }
}

export interface EventActivatedEvent {
  eventType: 'EVENT_ACTIVATED'
  occurredAt: string
  data: GiveawayEventBase & {
    startsAt: string
    endsAt: string
    winnerCount: number
    baseEntriesPerVote: number
    isTest: boolean
  }
}

export interface EventCancelledEvent {
  eventType: 'EVENT_CANCELLED'
  occurredAt: string
  data: GiveawayEventBase & {
    cancelReason?: string | null
    cancelledAt: string
    isTest: boolean
  }
}

export interface EventCompletedEvent {
  eventType: 'EVENT_COMPLETED'
  occurredAt: string
  data: GiveawayEventBase & {
    endedAt: string
    isTest: boolean
    totalEntries: number
    winners: WebhookWinner[]
  }
}

export interface EventWinnersSelectedEvent {
  eventType: 'EVENT_WINNERS_SELECTED'
  occurredAt: string
  data: GiveawayEventBase & {
    totalEntries: number
    winners: WebhookWinner[]
    /** Owner-defined reward payload, echoed verbatim. Absent when not configured. */
    externalReward?: unknown
    selectedAt: string
    isTest: boolean
  }
}

export interface WinnerReroll {
  rank: number
  previousWinner: WebhookWinner
  newWinner: WebhookWinner
}

export interface EventWinnerRerolledEvent {
  eventType: 'EVENT_WINNER_REROLLED'
  occurredAt: string
  data: GiveawayEventBase & {
    totalEntries: number
    /** Revoke each previousWinner's reward and grant it to the matching newWinner. */
    rerolls: WinnerReroll[]
    /** Full current winner list after the reroll. */
    winners: WebhookWinner[]
    reason?: string | null
    externalReward?: unknown
    rerolledAt: string
  }
}

export interface WebhookTestEvent {
  eventType: 'WEBHOOK_TEST'
  occurredAt: string
  data: { deliveryId: string }
}

/** Catch-all for event types this SDK version does not know yet. */
export interface UnknownEvent {
  eventType: string
  occurredAt: string
  data: unknown
}

export type KnownWebhookEvent =
  | VoteCreatedEvent
  | EventCreatedEvent
  | EventActivatedEvent
  | EventCancelledEvent
  | EventCompletedEvent
  | EventWinnersSelectedEvent
  | EventWinnerRerolledEvent
  | WebhookTestEvent

export type WebhookEvent = KnownWebhookEvent | UnknownEvent

export const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set([
  'VOTE_CREATED',
  'EVENT_CREATED',
  'EVENT_ACTIVATED',
  'EVENT_CANCELLED',
  'EVENT_COMPLETED',
  'EVENT_WINNERS_SELECTED',
  'EVENT_WINNER_REROLLED',
  'WEBHOOK_TEST',
])

/**
 * Narrows away the {@link UnknownEvent} catch-all so a switch on `eventType` resolves to the
 * exact payload type:
 *
 * ```ts
 * if (isKnownEvent(event)) {
 *   switch (event.eventType) {
 *     case 'EVENT_WINNERS_SELECTED': // event.data is fully typed here
 *   }
 * }
 * ```
 */
export function isKnownEvent(event: WebhookEvent): event is KnownWebhookEvent {
  return KNOWN_EVENT_TYPES.has(event.eventType)
}

type EventOf<K extends KnownWebhookEvent['eventType']> = Extract<KnownWebhookEvent, { eventType: K }>

export type EventHandlers = Partial<{
  [K in KnownWebhookEvent['eventType']]: (data: EventOf<K>['data'], event: EventOf<K>) => void | Promise<void>
}> & {
  /** Called for event types this SDK version does not know. Ignoring them is safe. */
  onUnknown?: (event: UnknownEvent) => void | Promise<void>
}

/**
 * Builds a handler that dispatches each event to its own callback. Every callback gets the
 * payload already typed for its event, no manual narrowing:
 *
 * ```ts
 * votetrackerWebhook({ secret }, handleEvent({
 *   VOTE_CREATED: async (vote) => grantCoins(vote.userPlatformId, 100 * vote.weight),
 *   EVENT_WINNERS_SELECTED: async (giveaway) => grantPrizes(giveaway.winners),
 * }))
 * ```
 */
export function handleEvent(handlers: EventHandlers): (delivery: { event: WebhookEvent }) => Promise<void> {
  return async ({ event }) => {
    if (!isKnownEvent(event)) {
      await handlers.onUnknown?.(event)
      return
    }
    const handler = handlers[event.eventType] as
      | ((data: unknown, event: KnownWebhookEvent) => void | Promise<void>)
      | undefined
    await handler?.(event.data, event)
  }
}
