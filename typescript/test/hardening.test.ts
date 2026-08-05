import { describe, expect, it, vi } from 'vitest'
import { fromWire, toWire } from '../src/casing.js'
import { createVoteTracker, isVoteTrackerApiError } from '../src/index.js'
import { verifyAuthHeader, verifyDelivery, WebhookVerificationError } from '../src/webhooks/index.js'

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers })

function fetchStub(responses: Response[]) {
  const at: number[] = []
  const queue = [...responses]
  const fetch: typeof globalThis.fetch = async () => {
    at.push(Date.now())
    const next = queue.shift()
    if (next === undefined) throw new Error('stub exhausted')
    return next
  }
  return { fetch, at }
}

const client = (fetch: typeof globalThis.fetch, retry?: Parameters<typeof createVoteTracker>[0]['retry']) =>
  createVoteTracker({ apiKey: 'k', integrationId: 'i', fetch, ...(retry === undefined ? {} : { retry }) })

describe('casing safety', () => {
  it('drops keys that would reach Object.prototype', () => {
    const hostile = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"x":1},"guild_id":"1"}')
    const out = fromWire(hostile) as Record<string, unknown>
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
    expect(Object.keys(out)).toEqual(['guildId'])

    const wire = toWire({ __proto__: { admin: true }, guildId: '1' }) as Record<string, unknown>
    expect(Object.keys(wire)).toEqual(['guild_id'])
  })

  it('serializes values that define toJSON, like Date', () => {
    const at = new Date('2026-08-10T18:00:00.000Z')
    expect(toWire({ startsAt: at })).toEqual({ starts_at: '2026-08-10T18:00:00.000Z' })
  })
})

describe('retry behavior', () => {
  it('waits between retries instead of hammering', async () => {
    const { fetch, at } = fetchStub([
      json(500, { error_code: 'INTERNAL_ERROR' }),
      json(500, { error_code: 'INTERNAL_ERROR' }),
      json(200, { items: [], next_cursor: null, has_next: false }),
    ])
    await client(fetch, { maxAttempts: 3, baseDelayMs: 40 }).votes.list()
    expect(at).toHaveLength(3)
    const [first, , third] = at
    expect((third ?? 0) - (first ?? 0)).toBeGreaterThan(5)
  })

  it('honors Retry-After given as an HTTP date, clamped to maxDelayMs', async () => {
    const soon = new Date(Date.now() + 30_000).toUTCString()
    const { fetch, at } = fetchStub([
      json(429, { error_code: 'RATE_LIMIT_EXCEEDED' }, { 'Retry-After': soon }),
      json(200, { service: 'integration-api', status: 'ok' }),
    ])
    await client(fetch, { maxAttempts: 2, maxDelayMs: 30 }).ping()
    const [first, second] = at
    expect((second ?? 0) - (first ?? 0)).toBeGreaterThanOrEqual(20)
  })

  it('rejects a maxAttempts below one instead of throwing undefined later', () => {
    expect(() => client(fetchStub([]).fetch, { maxAttempts: 0 })).toThrow(/at least 1/)
  })

  it('ignores rate limit headers that carry policy syntax', async () => {
    const { fetch } = fetchStub([
      json(
        200,
        { service: 'integration-api', status: 'ok' },
        { 'RateLimit-Limit': '100, 100;w=60', 'RateLimit-Remaining': '99', 'RateLimit-Reset': '1s' },
      ),
    ])
    const vt = client(fetch)
    await vt.ping()
    expect(vt.lastRateLimit).toBeUndefined()
  })

  it('stops paginating when the API repeats a cursor', async () => {
    const page = () => json(200, { items: [{ event_id: 'e1' }], next_cursor: 'same', has_next: true })
    const { fetch } = fetchStub([page(), page(), page()])
    const vt = client(fetch)
    await expect(async () => {
      for await (const _ of vt.giveaways.iterate()) {
        // drain
      }
    }).rejects.toThrow(/same cursor twice/)
  })
})

describe('error identity across module copies', () => {
  it('recognizes an error object from a duplicate copy of the SDK', async () => {
    const foreign = { [Symbol.for('votetracker.sdk.apiError')]: true, status: 402 }
    expect(isVoteTrackerApiError(foreign)).toBe(true)
    expect(foreign instanceof (await import('../src/index.js')).VoteTrackerApiError).toBe(true)
  })
})

describe('webhook auth hardening', () => {
  const body = JSON.stringify({ event_type: 'WEBHOOK_TEST', occurred_at: '2026-01-01T00:00:00Z', data: {} })

  it('refuses an empty secret or empty token', () => {
    expect(() => verifyDelivery({ rawBody: body, headers: {}, secret: '' })).toThrow(WebhookVerificationError)
    expect(() =>
      verifyDelivery({ rawBody: body, headers: { authorization: '' }, authHeader: { value: '' } }),
    ).toThrow(WebhookVerificationError)
    expect(verifyAuthHeader('', '')).toBe(false)
  })

  it('refuses both auth modes at once instead of silently using the weaker one', () => {
    expect(() =>
      verifyDelivery({
        rawBody: body,
        headers: { authorization: 'tok' },
        secret: 'wrong',
        authHeader: { value: 'tok' },
      } as never),
    ).toThrow(/not both/)
  })

  it('reads headers from a foreign-realm Headers implementation', () => {
    class ForeignHeaders {
      constructor(private readonly map: Record<string, string>) {}
      get(name: string): string | null {
        return this.map[name.toLowerCase()] ?? null
      }
    }
    const token = 'tok'
    const delivery = verifyDelivery({
      rawBody: body,
      headers: new ForeignHeaders({ authorization: token }) as unknown as Headers,
      authHeader: { value: token },
    })
    expect(delivery.event.eventType).toBe('WEBHOOK_TEST')
  })

  it('rejects a body with bytes prepended to the signed payload', async () => {
    const { createHmac } = await import('node:crypto')
    const secret = 's3cret'
    const timestamp = 1785950000
    const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
    const headers = { 'x-vt-signature': signature, 'x-vt-timestamp': String(timestamp) }

    expect(verifyDelivery({ rawBody: body, headers, secret, now: timestamp }).event.eventType).toBe(
      'WEBHOOK_TEST',
    )

    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(body)])
    expect(() => verifyDelivery({ rawBody: withBom, headers, secret, now: timestamp })).toThrow(
      WebhookVerificationError,
    )
  })
})

describe('AUTH_HEADER token shape', () => {
  const body = JSON.stringify({ event_type: 'WEBHOOK_TEST', occurred_at: '2026-01-01T00:00:00Z', data: {} })
  // The dashboard generates the value with the prefix baked in.
  const generated = 'Bearer vt_0123456789abcdef'

  it('matches whether the configured value kept the Bearer prefix or not', () => {
    for (const configured of [generated, 'vt_0123456789abcdef']) {
      const delivery = verifyDelivery({
        rawBody: body,
        headers: { authorization: generated },
        authHeader: { value: configured },
      })
      expect(delivery.event.eventType).toBe('WEBHOOK_TEST')
    }
  })

  it('still rejects a wrong token in either form', () => {
    for (const wrong of ['Bearer vt_wrong', 'vt_wrong']) {
      expect(() =>
        verifyDelivery({
          rawBody: body,
          headers: { authorization: generated },
          authHeader: { value: wrong },
        }),
      ).toThrow(WebhookVerificationError)
    }
  })
})

describe('adapters do not disclose why verification failed', () => {
  it('answers a bare 401', async () => {
    const { Hono } = await import('hono')
    const { votetrackerWebhook } = await import('../src/webhooks/adapters/hono.js')
    const app = new Hono()
    app.post('/h', votetrackerWebhook({ authHeader: { value: 'right' } }, vi.fn()))
    const response = await app.request('/h', {
      method: 'POST',
      headers: { authorization: 'wrong' },
      body: '{}',
    })
    expect(response.status).toBe(401)
    expect(await response.text()).toBe('')
  })
})
