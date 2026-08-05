import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { raw } from 'express'
import type { VerifiedDelivery, WebhookAuthOptions } from '../verify.js'
import { verifyDelivery, WebhookVerificationError } from '../verify.js'

/** Accepts either forwarding auth mode: `{ secret }` or `{ authHeader: { value, name? } }`. */
export type ExpressWebhookOptions = WebhookAuthOptions & {
  /** Maximum accepted body size. Default 1mb, matching the other adapters. */
  bodyLimit?: string | number
}

export type ExpressWebhookHandler = (delivery: VerifiedDelivery, req: Request) => void | Promise<void>

/**
 * Route-level middleware chain for receiving forwarding webhooks in Express.
 * Signature verification needs the body EXACTLY as sent, so register the webhook route
 * BEFORE any global body parser; a global `express.json()` mounted first consumes the stream
 * and re-serialization breaks the signature:
 *
 * ```ts
 * app.post('/webhooks/votetracker', ...votetrackerWebhook({ secret }, handleEvent({
 *   EVENT_WINNERS_SELECTED: async (giveaway) => grantRewards(giveaway.winners),
 * })))
 * app.use(express.json()) // global parsers go after the webhook route
 * ```
 *
 * Responses: 204 on success, 401 on failed verification (the forwarder will not retry forged
 * requests), 500 when the handler throws (the forwarder retries with backoff).
 */
export function votetrackerWebhook(
  options: ExpressWebhookOptions,
  handler: ExpressWebhookHandler,
): RequestHandler[] {
  const parseRaw = raw({ type: () => true, limit: options.bodyLimit ?? '1mb' })
  const receive = (req: Request, res: Response, next: NextFunction): void => {
    if (!(req.body instanceof Uint8Array)) {
      next(
        new Error(
          'votetrackerWebhook needs the raw request body, but another body parser already consumed it. ' +
            'Register the webhook route before global body parsers like express.json().',
        ),
      )
      return
    }
    let delivery: VerifiedDelivery
    try {
      delivery = verifyDelivery({ ...options, rawBody: req.body, headers: req.headers })
    } catch (error) {
      if (error instanceof WebhookVerificationError) {
        res.status(401).end()
        return
      }
      next(error)
      return
    }

    Promise.resolve(handler(delivery, req))
      .then(() => res.status(204).end())
      .catch(next)
  }
  return [parseRaw, receive]
}
