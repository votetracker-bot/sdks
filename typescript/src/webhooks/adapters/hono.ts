import type { Context, Handler } from 'hono'
import type { VerifiedDelivery, WebhookAuthOptions } from '../verify.js'
import { verifyDelivery, WebhookVerificationError } from '../verify.js'

/** Accepts either forwarding auth mode: `{ secret }` or `{ authHeader: { value, name? } }`. */
export type HonoWebhookOptions = WebhookAuthOptions

export type HonoWebhookHandler = (delivery: VerifiedDelivery, c: Context) => void | Promise<void>

/**
 * Hono route handler for receiving forwarding webhooks:
 *
 * ```ts
 * app.post('/webhooks/votetracker', votetrackerWebhook({ secret }, handleEvent({
 *   EVENT_WINNERS_SELECTED: async (giveaway) => grantRewards(giveaway.winners),
 * })))
 * ```
 *
 * Responses: 204 on success, 401 on failed verification, 500 when the handler throws (the
 * forwarder retries with backoff).
 */
export function votetrackerWebhook(options: HonoWebhookOptions, handler: HonoWebhookHandler): Handler {
  return async (c) => {
    const rawBody = await c.req.text()
    let delivery: VerifiedDelivery
    try {
      delivery = verifyDelivery({ ...options, rawBody, headers: c.req.raw.headers })
    } catch (error) {
      if (error instanceof WebhookVerificationError) {
        return c.body(null, 401)
      }
      throw error
    }
    await handler(delivery, c)
    return c.body(null, 204)
  }
}
