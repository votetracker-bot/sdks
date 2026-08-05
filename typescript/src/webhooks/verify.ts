import { createHmac, timingSafeEqual } from 'node:crypto'
import { fromWire } from '../casing.js'
import type { WebhookEvent } from './events.js'

export type VerificationFailureReason =
  | 'missing_header'
  | 'bad_signature'
  | 'bad_auth_header'
  | 'timestamp_out_of_tolerance'
  | 'invalid_payload'

const WEBHOOK_ERROR_BRAND = Symbol.for('votetracker.sdk.webhookError')

export class WebhookVerificationError extends Error {
  /** Present on every instance, so identity survives duplicate module copies. */
  readonly [WEBHOOK_ERROR_BRAND] = true
  readonly reason: VerificationFailureReason

  static override [Symbol.hasInstance](value: unknown): boolean {
    return typeof value === 'object' && value !== null && WEBHOOK_ERROR_BRAND in value
  }

  constructor(reason: VerificationFailureReason, message: string) {
    super(message)
    this.name = 'WebhookVerificationError'
    this.reason = reason
  }
}

interface VerifyDeliveryBase {
  /**
   * The request body EXACTLY as received, before any JSON parsing. Framework body parsers
   * re-serialize and break the signature; see the adapter modules or the README for how to
   * get the raw body in your framework.
   */
  rawBody: string | Uint8Array
  /** Incoming request headers, read case-insensitively. */
  headers: Record<string, string | string[] | undefined> | Headers
}

/** SIGNATURE mode: the delivery carries X-VT-Signature and X-VT-Timestamp. */
export interface VerifySignatureOptions extends VerifyDeliveryBase {
  /** The signing secret from your forwarding configuration. */
  secret: string
  /**
   * Maximum age difference in seconds between the delivery timestamp and now, in both
   * directions. Default 300. Lowering it tightens replay protection but rejects retries and
   * clock drift sooner.
   */
  toleranceSeconds?: number
  /** Override for tests: current unix time in seconds. */
  now?: number
}

/**
 * AUTH_HEADER mode: the delivery carries the token VoteTracker generated for the destination.
 * There is no timestamp in this mode, so it has no replay protection; SIGNATURE mode is the
 * stronger choice when you can use it.
 */
export interface VerifyAuthHeaderOptions extends VerifyDeliveryBase {
  authHeader: {
    /** The generated token, shown once when the forwarding target is created or rotated. */
    value: string
    /** Header carrying the token. Defaults to `Authorization`, matching the dashboard default. */
    name?: string
  }
}

export type VerifyDeliveryOptions = VerifySignatureOptions | VerifyAuthHeaderOptions

/** The authentication half of the options, for adapters that supply body and headers. */
export type WebhookAuthOptions =
  | Omit<VerifySignatureOptions, keyof VerifyDeliveryBase | 'now'>
  | Omit<VerifyAuthHeaderOptions, keyof VerifyDeliveryBase>

export interface VerifiedDelivery {
  event: WebhookEvent
  /** X-VT-Delivery-Id header, unique per delivery attempt chain. */
  deliveryId?: string
  /** X-VT-Attempt header, 1 for the first attempt. */
  attempt?: number
}

const DEFAULT_TOLERANCE_SECONDS = 300
const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * Authenticates a forwarding delivery and returns the parsed, typed event. Pass `secret` for
 * SIGNATURE mode (hex HMAC-SHA256 over `${timestamp}.${rawBody}`) or `authHeader` for
 * AUTH_HEADER mode. Throws {@link WebhookVerificationError} when the delivery is not
 * authentic; let that become a 401 so VoteTracker's forwarder does not retry forged requests.
 */
export function verifyDelivery(options: VerifyDeliveryOptions): VerifiedDelivery {
  if ('authHeader' in options && 'secret' in options) {
    throw new WebhookVerificationError(
      'invalid_payload',
      'Pass either secret (SIGNATURE mode) or authHeader (AUTH_HEADER mode), not both',
    )
  }

  const rawBytes = typeof options.rawBody === 'string' ? encoder.encode(options.rawBody) : options.rawBody

  if ('authHeader' in options) {
    if (options.authHeader.value === '') {
      throw new WebhookVerificationError('bad_auth_header', 'The configured auth header value is empty')
    }
    const name = options.authHeader.name ?? 'authorization'
    const received = header(options.headers, name.toLowerCase())
    if (received === undefined) {
      throw new WebhookVerificationError('missing_header', `Missing ${name} header`)
    }
    if (!verifyAuthHeader(received, options.authHeader.value)) {
      throw new WebhookVerificationError('bad_auth_header', 'Auth header does not match')
    }
    return delivery(parseEnvelope(rawBytes), options.headers)
  }

  if (options.secret === '') {
    throw new WebhookVerificationError('bad_signature', 'The configured signing secret is empty')
  }

  const signature = header(options.headers, 'x-vt-signature')
  const timestampRaw = header(options.headers, 'x-vt-timestamp')
  if (signature === undefined || timestampRaw === undefined) {
    throw new WebhookVerificationError('missing_header', 'Missing X-VT-Signature or X-VT-Timestamp header')
  }

  const timestamp = Number.parseInt(timestampRaw, 10)
  if (!Number.isFinite(timestamp)) {
    throw new WebhookVerificationError('timestamp_out_of_tolerance', 'X-VT-Timestamp is not a unix timestamp')
  }
  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS
  const now = options.now ?? Math.floor(Date.now() / 1000)
  if (Math.abs(now - timestamp) > tolerance) {
    throw new WebhookVerificationError(
      'timestamp_out_of_tolerance',
      `Delivery timestamp ${timestamp} outside tolerance of ${tolerance}s`,
    )
  }

  const expected = createHmac('sha256', options.secret).update(`${timestampRaw}.`).update(rawBytes).digest()
  const provided = hexToBytes(signature)
  if (provided === undefined || provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new WebhookVerificationError('bad_signature', 'Signature does not match the delivery body')
  }

  return delivery(parseEnvelope(rawBytes), options.headers)
}

function parseEnvelope(rawBytes: Uint8Array): WebhookEvent {
  let payload: unknown
  try {
    payload = JSON.parse(decoder.decode(rawBytes))
  } catch {
    throw new WebhookVerificationError('invalid_payload', 'Delivery body is not valid JSON')
  }
  if (
    typeof payload !== 'object' ||
    payload === null ||
    typeof (payload as { event_type?: unknown }).event_type !== 'string' ||
    typeof (payload as { occurred_at?: unknown }).occurred_at !== 'string'
  ) {
    throw new WebhookVerificationError('invalid_payload', 'Delivery body is not a forwarding envelope')
  }
  // Unknown event types intentionally parse into the UnknownEvent member of the union.
  return fromWire(payload) as WebhookEvent
}

function delivery(
  event: WebhookEvent,
  headers: Record<string, string | string[] | undefined> | Headers,
): VerifiedDelivery {
  const deliveryId = header(headers, 'x-vt-delivery-id')
  const attemptRaw = header(headers, 'x-vt-attempt')
  const attempt = attemptRaw === undefined ? Number.NaN : Number.parseInt(attemptRaw, 10)
  return {
    event,
    ...(deliveryId === undefined ? {} : { deliveryId }),
    ...(Number.isFinite(attempt) ? { attempt } : {}),
  }
}

/**
 * Compares a received AUTH_HEADER token against the expected one in constant time for equal
 * lengths. A length mismatch returns early, so token length is not hidden; the token value is.
 *
 * VoteTracker generates the value as `Bearer vt_...` with the prefix included, and people copy
 * it with or without that prefix, so both forms are accepted on either side.
 */
export function verifyAuthHeader(received: string | undefined, expected: string): boolean {
  if (received === undefined || expected === '') return false
  if (tokensEqual(received, expected)) return true
  return tokensEqual(stripBearer(received), stripBearer(expected))
}

function tokensEqual(a: string, b: string): boolean {
  const left = encoder.encode(a)
  const right = encoder.encode(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

function stripBearer(value: string): string {
  return value.startsWith('Bearer ') ? value.slice(7) : value
}

function header(
  headers: Record<string, string | string[] | undefined> | Headers,
  name: string,
): string | undefined {
  // Duck-typed: a Headers from another realm fails instanceof and exposes no own entries.
  const getter = (headers as Headers).get
  if (typeof getter === 'function') {
    return getter.call(headers, name) ?? undefined
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) {
      return Array.isArray(value) ? value[0] : value
    }
  }
  return undefined
}

function hexToBytes(hex: string): Uint8Array | undefined {
  if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) return undefined
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}
