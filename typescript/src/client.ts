import createOpenApiClient, { type Client } from 'openapi-fetch'
import { fromWire, toWire } from './casing.js'
import { VoteTrackerApiError } from './errors.js'
import type { paths } from './generated/schema.js'
import type {
  CreateGiveawayRequest,
  Giveaway,
  GiveawayPage,
  LatestVote,
  ListGiveawaysParams,
  ListVotesParams,
  Ping,
  RateLimitInfo,
  UpdateGiveawayRequest,
  Vote,
  VotePage,
  VoteStatus,
} from './types.js'

export interface RetryOptions {
  /** Total attempts including the first one. Default 3, minimum 1. */
  maxAttempts?: number
  /** Base delay for exponential backoff in milliseconds. Default 250. */
  baseDelayMs?: number
  /**
   * Ceiling for any single wait, including a server-provided Retry-After. Default 60000, so a
   * hostile or mistaken header cannot park a request for hours.
   */
  maxDelayMs?: number
}

export interface VoteTrackerOptions {
  /** API key from the dashboard, `vtk_live_...`. */
  apiKey: string
  /** The integration this key belongs to; baked into every request path. */
  integrationId: string
  /** Override for self-hosted testing or proxies. Default `https://developer.votetracker.bot`. */
  baseUrl?: string
  /** Custom fetch implementation; defaults to the global. */
  fetch?: typeof globalThis.fetch
  /**
   * Retry behavior. 429 responses are always retried within the attempt budget (the request
   * was not executed). Network errors and 5xx are retried for reads, and for writes only when
   * an idempotency key makes the retry safe. `false` disables retries entirely.
   */
  retry?: false | RetryOptions
}

export interface CreateGiveawayOptions {
  /**
   * Makes create retries safe: a replay returns the originally created giveaway instead of
   * creating a duplicate. 1 to 128 characters. Strongly recommended for automated creation.
   */
  idempotencyKey?: string
}

interface CallOptions {
  idempotent: boolean
  headers?: Record<string, string>
}

interface WireResult {
  data?: unknown
  error?: unknown
  response: Response
}

/** Shared internals handed to the endpoint groups; not part of the public surface. */
interface ApiContext {
  raw: Client<paths>
  integrationId: string
  execute(call: () => Promise<WireResult>, options: CallOptions): Promise<unknown>
  /** openapi-fetch types the body per path; the runtime value is the snake_case transform. */
  wireBody(body: unknown): never
}

const DEFAULT_BASE_URL = 'https://developer.votetracker.bot'
const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_BASE_DELAY_MS = 250
const DEFAULT_MAX_DELAY_MS = 60_000

export class VoteTracker {
  /** The underlying typed openapi-fetch client, for endpoints not wrapped by the SDK. */
  readonly raw: Client<paths>

  readonly giveaways: GiveawaysApi
  readonly votes: VotesApi

  private readonly maxAttempts: number
  private readonly baseDelayMs: number
  private readonly maxDelayMs: number
  private rateLimit: RateLimitInfo | undefined

  constructor(options: VoteTrackerOptions) {
    if (!options.apiKey) throw new Error('apiKey is required')
    if (!options.integrationId) throw new Error('integrationId is required')

    const retry = options.retry === false ? { maxAttempts: 1 } : (options.retry ?? {})
    const maxAttempts = retry.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new Error('retry.maxAttempts must be an integer of at least 1')
    }
    this.maxAttempts = maxAttempts
    this.baseDelayMs = retry.baseDelayMs ?? DEFAULT_BASE_DELAY_MS
    this.maxDelayMs = retry.maxDelayMs ?? DEFAULT_MAX_DELAY_MS
    this.raw = createOpenApiClient<paths>({
      baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
      headers: { Authorization: `Bearer ${options.apiKey}` },
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    })
    const context: ApiContext = {
      raw: this.raw,
      integrationId: options.integrationId,
      execute: (call, executeOptions) => this.execute(call, executeOptions),
      wireBody: (body) => toWire(body) as never,
    }
    this.giveaways = new GiveawaysApi(context)
    this.votes = new VotesApi(context)
  }

  /** Rate limit state from the most recent response, when the API sent RateLimit-* headers. */
  get lastRateLimit(): RateLimitInfo | undefined {
    return this.rateLimit
  }

  async ping(): Promise<Ping> {
    return this.execute(() => this.raw.GET('/api/v1/system/ping'), { idempotent: true }) as Promise<Ping>
  }

  private async execute(call: () => Promise<WireResult>, options: CallOptions): Promise<unknown> {
    let lastError: unknown
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      let result: WireResult
      try {
        result = await call()
      } catch (error) {
        // Transport failure: the request may not have reached the server.
        lastError = error
        if (options.idempotent && attempt < this.maxAttempts) {
          await sleep(this.backoffMs(attempt))
          continue
        }
        throw error
      }

      this.captureRateLimit(result.response)

      if (result.response.ok) {
        return fromWire(result.data)
      }

      const status = result.response.status
      const retryAfter = parseRetryAfter(result.response)
      const apiError = new VoteTrackerApiError(status, asProblem(result.error), retryAfter)

      const canRetry = attempt < this.maxAttempts && (status === 429 || (status >= 500 && options.idempotent))
      if (!canRetry) throw apiError

      lastError = apiError
      const wait = retryAfter === undefined ? this.backoffMs(attempt) : retryAfter * 1000
      await sleep(Math.min(wait, this.maxDelayMs))
    }
    throw lastError
  }

  /** Exponential backoff with full jitter, so concurrent clients do not retry in lockstep. */
  private backoffMs(attempt: number): number {
    const ceiling = Math.min(this.baseDelayMs * 2 ** (attempt - 1), this.maxDelayMs)
    return Math.random() * ceiling
  }

  private captureRateLimit(response: Response): void {
    const limit = response.headers.get('RateLimit-Limit')
    const remaining = response.headers.get('RateLimit-Remaining')
    const reset = response.headers.get('RateLimit-Reset')
    if (limit === null || remaining === null || reset === null) return
    const parsedLimit = Number(limit)
    const parsedRemaining = Number(remaining)
    if (!Number.isFinite(parsedLimit) || !Number.isFinite(parsedRemaining)) return
    this.rateLimit = { limit: parsedLimit, remaining: parsedRemaining, reset }
  }
}

/** Factory alternative to `new VoteTracker(...)`. */
export function createVoteTracker(options: VoteTrackerOptions): VoteTracker {
  return new VoteTracker(options)
}

class GiveawaysApi {
  constructor(private readonly vt: ApiContext) {}

  async list(params: ListGiveawaysParams = {}): Promise<GiveawayPage> {
    return this.vt.execute(
      () =>
        this.vt.raw.GET('/api/v1/integrations/{integration_id}/events', {
          params: {
            path: { integration_id: this.vt.integrationId },
            query: compact({
              status: params.status,
              cursor: params.cursor,
              start_date: params.startDate,
              limit: params.limit,
            }),
          },
        }),
      { idempotent: true },
    ) as Promise<GiveawayPage>
  }

  /** Iterates giveaways newest-first across pages. */
  async *iterate(params: Omit<ListGiveawaysParams, 'cursor'> = {}): AsyncGenerator<Giveaway> {
    let cursor: string | undefined
    do {
      const page = await this.list({ ...params, ...(cursor === undefined ? {} : { cursor }) })
      yield* page.items
      cursor = nextCursor(page, cursor)
    } while (cursor !== undefined)
  }

  async get(eventId: string): Promise<Giveaway> {
    return this.vt.execute(
      () =>
        this.vt.raw.GET('/api/v1/integrations/{integration_id}/events/{event_id}', {
          params: { path: { integration_id: this.vt.integrationId, event_id: eventId } },
        }),
      { idempotent: true },
    ) as Promise<Giveaway>
  }

  async create(body: CreateGiveawayRequest, options: CreateGiveawayOptions = {}): Promise<Giveaway> {
    return this.vt.execute(
      () =>
        this.vt.raw.POST('/api/v1/integrations/{integration_id}/events/giveaways', {
          params: { path: { integration_id: this.vt.integrationId } },
          ...(options.idempotencyKey === undefined
            ? {}
            : { headers: { 'Idempotency-Key': options.idempotencyKey } }),
          body: this.vt.wireBody(body),
        }),
      // Safe to retry only when a replayable idempotency key is present.
      { idempotent: options.idempotencyKey !== undefined },
    ) as Promise<Giveaway>
  }

  async activate(eventId: string): Promise<Giveaway> {
    return this.vt.execute(
      () =>
        this.vt.raw.POST('/api/v1/integrations/{integration_id}/events/{event_id}/activate', {
          params: { path: { integration_id: this.vt.integrationId, event_id: eventId } },
        }),
      { idempotent: false },
    ) as Promise<Giveaway>
  }

  /**
   * Replaces the giveaway configuration. Omitted fields are cleared, including
   * `externalReward`, so send the complete desired state rather than a patch. Drafts only.
   */
  async update(eventId: string, body: UpdateGiveawayRequest): Promise<Giveaway> {
    return this.vt.execute(
      () =>
        this.vt.raw.PUT('/api/v1/integrations/{integration_id}/events/{event_id}', {
          params: { path: { integration_id: this.vt.integrationId, event_id: eventId } },
          body: this.vt.wireBody(body),
        }),
      { idempotent: false },
    ) as Promise<Giveaway>
  }

  async cancel(eventId: string, options: { cancelReason?: string } = {}): Promise<Giveaway> {
    return this.vt.execute(
      () =>
        this.vt.raw.POST('/api/v1/integrations/{integration_id}/events/{event_id}/cancel', {
          params: { path: { integration_id: this.vt.integrationId, event_id: eventId } },
          body: this.vt.wireBody({ cancelReason: options.cancelReason ?? null }),
        }),
      { idempotent: false },
    ) as Promise<Giveaway>
  }

  async setRepeating(eventId: string, repeating: boolean): Promise<Giveaway> {
    return this.vt.execute(
      () =>
        this.vt.raw.PUT('/api/v1/integrations/{integration_id}/events/{event_id}/repeating', {
          params: { path: { integration_id: this.vt.integrationId, event_id: eventId } },
          body: this.vt.wireBody({ repeating }),
        }),
      { idempotent: false },
    ) as Promise<Giveaway>
  }

  async rerollWinner(
    eventId: string,
    userPlatformId: string,
    options: { reason: string },
  ): Promise<Giveaway> {
    return this.vt.execute(
      () =>
        this.vt.raw.POST(
          '/api/v1/integrations/{integration_id}/events/{event_id}/winners/{user_platform_id}/reroll',
          {
            params: {
              path: {
                integration_id: this.vt.integrationId,
                event_id: eventId,
                user_platform_id: userPlatformId,
              },
            },
            body: this.vt.wireBody({ reason: options.reason }),
          },
        ),
      { idempotent: false },
    ) as Promise<Giveaway>
  }

  async rerollAllWinners(eventId: string, options: { reason: string }): Promise<Giveaway> {
    return this.vt.execute(
      () =>
        this.vt.raw.POST('/api/v1/integrations/{integration_id}/events/{event_id}/winners/reroll', {
          params: { path: { integration_id: this.vt.integrationId, event_id: eventId } },
          body: this.vt.wireBody({ reason: options.reason }),
        }),
      { idempotent: false },
    ) as Promise<Giveaway>
  }
}

class VotesApi {
  constructor(private readonly vt: ApiContext) {}

  async list(params: ListVotesParams = {}): Promise<VotePage> {
    return this.vt.execute(
      () =>
        this.vt.raw.GET('/api/v1/integrations/{integration_id}/votes', {
          params: {
            path: { integration_id: this.vt.integrationId },
            query: compact({ cursor: params.cursor, start_date: params.startDate, limit: params.limit }),
          },
        }),
      { idempotent: true },
    ) as Promise<VotePage>
  }

  /** Iterates votes oldest-first across pages (the votes list pages forward). */
  async *iterate(params: Omit<ListVotesParams, 'cursor'> = {}): AsyncGenerator<Vote> {
    let cursor: string | undefined
    do {
      const page = await this.list({ ...params, ...(cursor === undefined ? {} : { cursor }) })
      yield* page.items
      cursor = nextCursor(page, cursor)
    } while (cursor !== undefined)
  }

  async userStatus(userPlatformId: string): Promise<VoteStatus> {
    return this.vt.execute(
      () =>
        this.vt.raw.GET('/api/v1/integrations/{integration_id}/votes/users/{user_platform_id}/status', {
          params: { path: { integration_id: this.vt.integrationId, user_platform_id: userPlatformId } },
        }),
      { idempotent: true },
    ) as Promise<VoteStatus>
  }

  async userLatest(userPlatformId: string): Promise<LatestVote> {
    return this.vt.execute(
      () =>
        this.vt.raw.GET('/api/v1/integrations/{integration_id}/votes/users/{user_platform_id}/latest', {
          params: { path: { integration_id: this.vt.integrationId, user_platform_id: userPlatformId } },
        }),
      { idempotent: true },
    ) as Promise<LatestVote>
  }
}

/**
 * Advances the cursor, stopping when the page repeats it: a server that never moves the cursor
 * would otherwise turn iteration into an endless request loop.
 */
function nextCursor(
  page: { hasNext: boolean; nextCursor: string | null },
  previous: string | undefined,
): string | undefined {
  if (!page.hasNext || page.nextCursor === null) return undefined
  if (page.nextCursor === previous) {
    throw new Error('Pagination stopped: the API returned the same cursor twice')
  }
  return page.nextCursor
}

/** Drops undefined entries so optional query/header params satisfy exactOptionalPropertyTypes. */
function compact<T extends Record<string, unknown>>(value: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) out[key] = entry
  }
  return out as { [K in keyof T]?: Exclude<T[K], undefined> }
}

function asProblem(error: unknown): {
  type?: string
  title?: string
  status?: number
  detail?: string
  error_code?: string
  trace_id?: string
} {
  return typeof error === 'object' && error !== null ? error : {}
}

function parseRetryAfter(response: Response): number | undefined {
  const header = response.headers.get('Retry-After')
  if (header === null) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return Math.max(0, seconds)
  // RFC 9110 also allows an HTTP-date, which proxies and CDNs do send.
  const date = Date.parse(header)
  return Number.isNaN(date) ? undefined : Math.max(0, (date - Date.now()) / 1000)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    // Never keep a process alive just to finish a backoff.
    timer.unref?.()
  })
}
