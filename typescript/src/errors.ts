/** Stable machine-readable error codes the API documents. Unknown future values pass through. */
export type ErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'BAD_REQUEST'
  | 'NOT_FOUND'
  | 'RATE_LIMIT_EXCEEDED'
  | 'PREMIUM_REQUIRED'
  | 'CONFLICT'
  | 'SERVICE_UNAVAILABLE'
  | 'INTERNAL_ERROR'
  | 'REQUEST_FAILED'

interface ProblemBody {
  type?: string
  title?: string
  status?: number
  detail?: string
  error_code?: string
  trace_id?: string
}

const API_ERROR_BRAND = Symbol.for('votetracker.sdk.apiError')

/**
 * Thrown for every non-2xx API response. `traceId` is included in the message so it lands in
 * logs and bug reports; quoting it to VoteTracker support identifies the exact request.
 */
export class VoteTrackerApiError extends Error {
  /** Present on every instance, so identity survives duplicate module copies. */
  readonly [API_ERROR_BRAND] = true

  static override [Symbol.hasInstance](value: unknown): boolean {
    return typeof value === 'object' && value !== null && API_ERROR_BRAND in value
  }

  readonly status: number
  readonly errorCode: ErrorCode | (string & {})
  readonly problemType: string
  readonly detail: string
  readonly traceId: string | undefined
  /** Seconds to wait before retrying; present on 429 responses. */
  readonly retryAfter: number | undefined

  constructor(status: number, body: ProblemBody, retryAfter?: number) {
    const detail = body.detail ?? body.title ?? `HTTP ${status}`
    super(body.trace_id ? `${detail} (trace_id=${body.trace_id})` : detail)
    this.name = 'VoteTrackerApiError'
    this.status = status
    this.errorCode = body.error_code ?? 'REQUEST_FAILED'
    this.problemType = body.type ?? 'about:blank'
    this.detail = detail
    this.traceId = body.trace_id
    this.retryAfter = retryAfter
  }
}

export function isVoteTrackerApiError(error: unknown): error is VoteTrackerApiError {
  return typeof error === 'object' && error !== null && API_ERROR_BRAND in error
}
