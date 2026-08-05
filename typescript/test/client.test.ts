import { describe, expect, it } from 'vitest'
import { createVoteTracker, isVoteTrackerApiError, VoteTrackerApiError } from '../src/index.js'

interface Recorded {
  url: string
  method: string
  headers: Headers
  body: string | null
}

/** Scripted fetch stub: pops one response per call, records every request. */
function fetchStub(responses: Response[]): { fetch: typeof globalThis.fetch; requests: Recorded[] } {
  const requests: Recorded[] = []
  const queue = [...responses]
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    requests.push({
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: request.method === 'GET' ? null : await request.text(),
    })
    const next = queue.shift()
    if (next === undefined) throw new Error('fetch stub exhausted')
    return next
  }
  return { fetch, requests }
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': status >= 400 ? 'application/problem+json' : 'application/json', ...headers },
  })

const options = (fetch: typeof globalThis.fetch, retry?: false) => ({
  apiKey: 'vtk_live_test',
  integrationId: 'int_1',
  fetch,
  ...(retry === undefined ? {} : { retry }),
})

describe('client requests', () => {
  it('sends auth, converts params and responses between casings', async () => {
    const { fetch, requests } = fetchStub([
      json(200, {
        items: [{ event_id: 'e1', guild_id: 'g1', status: 'ACTIVE', external_reward: { my_key: 1 } }],
        next_cursor: null,
        has_next: false,
      }),
    ])
    const vt = createVoteTracker(options(fetch))

    const page = await vt.giveaways.list({ status: 'ACTIVE', startDate: '2026-01-01T00:00:00Z' })

    const request = requests[0]
    if (request === undefined) throw new Error('no request recorded')
    expect(request.url).toContain('/api/v1/integrations/int_1/events?')
    expect(request.url).toContain('status=ACTIVE')
    expect(request.url).toContain('start_date=2026-01-01')
    expect(request.headers.get('authorization')).toBe('Bearer vtk_live_test')

    expect(page.hasNext).toBe(false)
    expect(page.items[0]?.eventId).toBe('e1')
    // Opaque payload keys survive untouched.
    expect(page.items[0]?.externalReward).toEqual({ my_key: 1 })
  })

  it('snake_cases request bodies and sends the idempotency key', async () => {
    const { fetch, requests } = fetchStub([json(201, { event_id: 'e2' })])
    const vt = createVoteTracker(options(fetch))

    await vt.giveaways.create(
      {
        guildId: '610464532967456778',
        startsAt: '2026-08-06T18:00:00Z',
        endsAt: '2026-08-07T18:00:00Z',
        winnerCount: 1,
        prizeText: '500 credits',
        externalReward: { card_id: 'holo' },
        activate: true,
      },
      { idempotencyKey: 'create-1' },
    )

    const request = requests[0]
    if (request === undefined) throw new Error('no request recorded')
    expect(request.headers.get('idempotency-key')).toBe('create-1')
    const body = JSON.parse(request.body ?? '{}')
    expect(body.guild_id).toBe('610464532967456778')
    expect(body.winner_count).toBe(1)
    expect(body.external_reward).toEqual({ card_id: 'holo' })
    expect(body.guildId).toBeUndefined()
  })

  it('maps problem responses to VoteTrackerApiError', async () => {
    const { fetch } = fetchStub([
      json(402, {
        type: 'https://developer.votetracker.bot/problems/premium-required',
        title: 'Payment Required',
        status: 402,
        detail: 'Premium feature used without premium',
        error_code: 'PREMIUM_REQUIRED',
        trace_id: 'trace123',
      }),
    ])
    const vt = createVoteTracker(options(fetch, false))

    const error = await vt.giveaways.get('e1').catch((e: unknown) => e)
    expect(isVoteTrackerApiError(error)).toBe(true)
    const apiError = error as VoteTrackerApiError
    expect(apiError.status).toBe(402)
    expect(apiError.errorCode).toBe('PREMIUM_REQUIRED')
    expect(apiError.message).toContain('trace123')
  })

  it('retries 429 honoring Retry-After and surfaces rate limit info', async () => {
    const { fetch, requests } = fetchStub([
      json(
        429,
        { error_code: 'RATE_LIMIT_EXCEEDED', detail: 'slow down' },
        { 'Retry-After': '0', 'RateLimit-Limit': '120', 'RateLimit-Remaining': '0', 'RateLimit-Reset': '1s' },
      ),
      json(
        200,
        { service: 'integration-api', status: 'ok' },
        { 'RateLimit-Limit': '120', 'RateLimit-Remaining': '119', 'RateLimit-Reset': '1s' },
      ),
    ])
    const vt = createVoteTracker(options(fetch))

    const ping = await vt.ping()
    expect(ping.status).toBe('ok')
    expect(requests).toHaveLength(2)
    expect(vt.lastRateLimit).toEqual({ limit: 120, remaining: 119, reset: '1s' })
  })

  it('does not retry a write without an idempotency key', async () => {
    const { fetch, requests } = fetchStub([json(503, { error_code: 'SERVICE_UNAVAILABLE' })])
    const vt = createVoteTracker(options(fetch))

    await expect(vt.giveaways.activate('e1')).rejects.toThrow(VoteTrackerApiError)
    expect(requests).toHaveLength(1)
  })

  it('retries reads on 5xx', async () => {
    const { fetch, requests } = fetchStub([
      json(500, { error_code: 'INTERNAL_ERROR' }),
      json(200, { items: [], next_cursor: null, has_next: false }),
    ])
    const vt = createVoteTracker(options(fetch))

    const page = await vt.votes.list()
    expect(page.items).toEqual([])
    expect(requests).toHaveLength(2)
  })
})

describe('pagination', () => {
  it('iterates until hasNext is false, threading the cursor', async () => {
    const { fetch, requests } = fetchStub([
      json(200, { items: [{ event_id: 'e1' }], next_cursor: 'c1', has_next: true }),
      json(200, { items: [{ event_id: 'e2' }], next_cursor: null, has_next: false }),
    ])
    const vt = createVoteTracker(options(fetch))

    const ids: string[] = []
    for await (const giveaway of vt.giveaways.iterate()) ids.push(giveaway.eventId)

    expect(ids).toEqual(['e1', 'e2'])
    expect(requests[1]?.url).toContain('cursor=c1')
  })
})
