import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { VerifiedDelivery, WebhookAuthOptions } from '../verify.js'
import { verifyDelivery, WebhookVerificationError } from '../verify.js'

/** Accepts either forwarding auth mode: `{ secret }` or `{ authHeader: { value, name? } }`. */
export type FastifyWebhookOptions = WebhookAuthOptions & {
  /** Route path to register. Default `/webhooks/votetracker`. */
  path?: string
}

export type FastifyWebhookHandler = (
  delivery: VerifiedDelivery,
  request: FastifyRequest,
) => void | Promise<void>

/**
 * Fastify plugin for receiving forwarding webhooks. Registers its own scoped content type
 * parser that keeps the raw body, so the rest of the app keeps normal JSON parsing:
 *
 * ```ts
 * await app.register(votetrackerWebhook({ secret }, handleEvent({
 *   EVENT_WINNERS_SELECTED: async (giveaway) => grantRewards(giveaway.winners),
 * })))
 * ```
 *
 * Responses: 204 on success, 401 on failed verification, 500 when the handler throws (the
 * forwarder retries with backoff).
 */
export function votetrackerWebhook(options: FastifyWebhookOptions, handler: FastifyWebhookHandler) {
  return async function votetrackerWebhookPlugin(app: FastifyInstance): Promise<void> {
    app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
      done(null, body)
    })
    app.post(options.path ?? '/webhooks/votetracker', async (request, reply) => {
      let delivery: VerifiedDelivery
      try {
        delivery = verifyDelivery({ ...options, rawBody: request.body as string, headers: request.headers })
      } catch (error) {
        if (error instanceof WebhookVerificationError) {
          return reply.status(401).send()
        }
        throw error
      }
      await handler(delivery, request)
      return reply.status(204).send()
    })
  }
}
