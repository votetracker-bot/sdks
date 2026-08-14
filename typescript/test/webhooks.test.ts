import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type {
  EventWinnersSelectedEvent,
  PurchaseCreatedEvent,
  PurchaseRefundedEvent,
  VoteCreatedEvent,
} from '../src/webhooks/index.js'
import { KNOWN_EVENT_TYPES, verifyDelivery, WebhookVerificationError } from '../src/webhooks/index.js'

interface Vector {
  name: string
  secret: string
  timestamp: number
  raw_body: string
  signature: string
  headers: Record<string, string>
}

const vectorsDir = join(__dirname, '../../fixtures/vectors')
const vectors: Vector[] = readdirSync(vectorsDir).map(
  (file) => JSON.parse(readFileSync(join(vectorsDir, file), 'utf8')) as Vector,
)

const verify = (vector: Vector, overrides: Partial<Parameters<typeof verifyDelivery>[0]> = {}) =>
  verifyDelivery({
    rawBody: vector.raw_body,
    headers: vector.headers,
    secret: vector.secret,
    now: vector.timestamp,
    ...overrides,
  })

describe('verifyDelivery against shared fixtures', () => {
  it.each(vectors.map((v) => [v.name, v] as const))('accepts %s', (_name, vector) => {
    const delivery = verify(vector)
    expect(delivery.deliveryId).toBe(`fix-${vector.name}`)
    expect(delivery.attempt).toBe(1)
    expect(delivery.event.occurredAt).toBeTypeOf('string')
  })

  it('parses winners with user data preserved', () => {
    const vector = vectors.find((v) => v.name === 'event_winners_selected')
    if (vector === undefined) throw new Error('missing vector')
    const { event } = verify(vector)
    expect(event.eventType).toBe('EVENT_WINNERS_SELECTED')
    const data = (event as EventWinnersSelectedEvent).data
    expect(data.winners[0]?.userPlatformId).toBe('223456683337318402')
    expect(data.externalReward).toEqual({ kind: 'currency', amount: 500 })
  })

  it('keeps vote query parameter keys verbatim', () => {
    const vector = vectors.find((v) => v.name === 'vote_created')
    if (vector === undefined) throw new Error('missing vector')
    const { event } = verify(vector)
    const data = (event as VoteCreatedEvent).data
    expect(data.query).toEqual({ guild_id: '811261515891474442', source: 'vote-command' })
  })

  it('parses a purchase creation with the external config kept opaque', () => {
    const vector = vectors.find((v) => v.name === 'purchase_created')
    if (vector === undefined) throw new Error('missing vector')
    const { event } = verify(vector)
    expect(event.eventType).toBe('PURCHASE_CREATED')
    const data = (event as PurchaseCreatedEvent).data
    expect(data.purchaseId).toBe('pch_pub_9876543210')
    expect(data.item.externalConfig).toEqual({ role_id: '1470745867945513004' })
    expect(data.buyer.userPlatformId).toBe('223456683337318402')
    expect(data.requiresFulfillment).toBe(true)
  })

  it('parses a purchase refund', () => {
    const vector = vectors.find((v) => v.name === 'purchase_refunded')
    if (vector === undefined) throw new Error('missing vector')
    const { event } = verify(vector)
    expect(event.eventType).toBe('PURCHASE_REFUNDED')
    const data = (event as PurchaseRefundedEvent).data
    expect(data.reason).toBe('FULFILLMENT_TIMEOUT')
    expect(data.priceRefunded).toBe(500)
  })

  it('parses unknown event types into the catch-all instead of throwing', () => {
    const vector = vectors.find((v) => v.name === 'unknown_event')
    if (vector === undefined) throw new Error('missing vector')
    const { event } = verify(vector)
    expect(event.eventType).toBe('EVENT_SOMETHING_NEW')
    expect(KNOWN_EVENT_TYPES.has(event.eventType)).toBe(false)
  })
})

describe('verifyDelivery rejections', () => {
  const vector = vectors.find((v) => v.name === 'event_created')
  if (vector === undefined) throw new Error('missing vector')

  const reasonOf = (fn: () => unknown): string => {
    try {
      fn()
    } catch (error) {
      if (error instanceof WebhookVerificationError) return error.reason
      throw error
    }
    throw new Error('expected a WebhookVerificationError')
  }

  it('rejects a tampered body', () => {
    const tampered = vector.raw_body.replace('"winner_count":1', '"winner_count":100')
    expect(reasonOf(() => verify(vector, { rawBody: tampered }))).toBe('bad_signature')
  })

  it('rejects a wrong secret', () => {
    expect(reasonOf(() => verify(vector, { secret: 'not-the-secret' }))).toBe('bad_signature')
  })

  it('rejects a signature of the wrong length without throwing internally', () => {
    expect(reasonOf(() => verify(vector, { headers: { ...vector.headers, 'x-vt-signature': 'abcd' } }))).toBe(
      'bad_signature',
    )
  })

  it('rejects deliveries outside the tolerance window in both directions', () => {
    expect(reasonOf(() => verify(vector, { now: vector.timestamp + 301 }))).toBe('timestamp_out_of_tolerance')
    expect(reasonOf(() => verify(vector, { now: vector.timestamp - 301 }))).toBe('timestamp_out_of_tolerance')
    expect(verify(vector, { now: vector.timestamp + 299 }).event.eventType).toBe('EVENT_CREATED')
  })

  it('honors a custom tolerance', () => {
    expect(reasonOf(() => verify(vector, { now: vector.timestamp + 11, toleranceSeconds: 10 }))).toBe(
      'timestamp_out_of_tolerance',
    )
  })

  it('rejects missing headers', () => {
    expect(reasonOf(() => verify(vector, { headers: {} }))).toBe('missing_header')
  })

  it('reads headers case-insensitively and from Headers instances', () => {
    const upper = Object.fromEntries(Object.entries(vector.headers).map(([k, v]) => [k.toUpperCase(), v]))
    expect(verify(vector, { headers: upper }).event.eventType).toBe('EVENT_CREATED')
    expect(verify(vector, { headers: new Headers(vector.headers) }).event.eventType).toBe('EVENT_CREATED')
  })

  it('accepts the body as bytes', () => {
    const bytes = new TextEncoder().encode(vector.raw_body)
    expect(verify(vector, { rawBody: bytes }).event.eventType).toBe('EVENT_CREATED')
  })
})

describe('AUTH_HEADER mode', () => {
  const vector = vectors.find((v) => v.name === 'event_created')
  if (vector === undefined) throw new Error('missing vector')
  const TOKEN = 'vt_forward_token_abc123'

  const verifyToken = (headers: Record<string, string>, authHeader: { value: string; name?: string }) =>
    verifyDelivery({ rawBody: vector.raw_body, headers, ...{ authHeader } })

  it('accepts a delivery carrying the generated token', () => {
    const delivery = verifyToken({ authorization: TOKEN, 'x-vt-attempt': '2' }, { value: TOKEN })
    expect(delivery.event.eventType).toBe('EVENT_CREATED')
    expect(delivery.attempt).toBe(2)
  })

  it('supports a custom header name, case-insensitively', () => {
    const delivery = verifyToken({ 'X-Custom-Token': TOKEN }, { value: TOKEN, name: 'X-Custom-Token' })
    expect(delivery.event.eventType).toBe('EVENT_CREATED')
  })

  it('rejects a wrong or missing token', () => {
    expect(() => verifyToken({ authorization: 'nope' }, { value: TOKEN })).toThrow(WebhookVerificationError)
    try {
      verifyToken({ authorization: 'nope' }, { value: TOKEN })
    } catch (error) {
      expect((error as WebhookVerificationError).reason).toBe('bad_auth_header')
    }
    try {
      verifyToken({}, { value: TOKEN })
    } catch (error) {
      expect((error as WebhookVerificationError).reason).toBe('missing_header')
    }
  })

  it('does not accept a signed delivery without the token', () => {
    expect(() => verifyToken(vector.headers, { value: TOKEN })).toThrow(WebhookVerificationError)
  })
})
