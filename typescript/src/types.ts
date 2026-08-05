/**
 * Public domain types: camelCase views over the generated wire schema. The generated
 * `IntegrationEventView` style names never leak into user code.
 */
import type { Camelize } from './casing.js'
import type { components } from './generated/schema.js'

type Schemas = components['schemas']

export type Giveaway = Camelize<Schemas['IntegrationEventView']>
export type GiveawayWinner = Camelize<Schemas['IntegrationEventWinnerView']>
export type GiveawayPage = Camelize<Schemas['IntegrationEventPageView']>
export type GiveawayStatus = Giveaway['status']

export type CreateGiveawayRequest = Camelize<Schemas['IntegrationEventCreateRequest']>
export type UpdateGiveawayRequest = Camelize<Schemas['IntegrationEventUpdateRequest']>

export type Vote = Camelize<Schemas['IntegrationVoteView']>
export type VotePage = Camelize<Schemas['IntegrationVotePageView']>
export type VoteStatus = Camelize<Schemas['IntegrationUserVoteStatusView']>
export type LatestVote = Camelize<Schemas['IntegrationUserLatestVoteView']>

export type Ping = Camelize<Schemas['PingResponse']>
export type ProblemResponse = Camelize<Schemas['ProblemResponse']>

/** Rate limit snapshot from the most recent response's RateLimit-* headers. */
export interface RateLimitInfo {
  limit: number
  remaining: number
  /** Raw reset value as sent by the API, for example "1s". */
  reset: string
}

export interface ListGiveawaysParams {
  status?: GiveawayStatus
  /** ISO-8601 lower bound on creation time; pages the full history when omitted. */
  startDate?: string
  cursor?: string
  limit?: number
}

export interface ListVotesParams {
  /**
   * ISO-8601 lower bound, at most 7 days in the past (the API rejects older values; use
   * webhook forwarding or backfill for history). Defaults server-side to the 7-day window.
   */
  startDate?: string
  cursor?: string
  limit?: number
}
