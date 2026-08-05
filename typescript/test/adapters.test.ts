import { readFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { join } from 'node:path'
import express from 'express'
import fastify from 'fastify'
import { Hono } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'
import { votetrackerWebhook as expressWebhook } from '../src/webhooks/adapters/express.js'
import { votetrackerWebhook as fastifyWebhook } from '../src/webhooks/adapters/fastify.js'
import { votetrackerWebhook as honoWebhook } from '../src/webhooks/adapters/hono.js'
import type { VerifiedDelivery } from '../src/webhooks/index.js'

interface Vector {
  secret: string
  raw_body: string
  headers: Record<string, string>
}

const vector = JSON.parse(
  readFileSync(join(__dirname, '../../fixtures/vectors/event_winners_selected.json'), 'utf8'),
) as Vector

// Fixture timestamps are fixed in the past; a huge tolerance keeps adapter tests focused on
// transport wiring (verify.ts's own tests cover the replay window).
const OPTIONS = { secret: vector.secret, toleranceSeconds: Number.MAX_SAFE_INTEGER }

const post = (port: number, path: string, body: string, headers: Record<string, string>) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  })

const listen = (server: Server): Promise<number> =>
  new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('no port')
      resolve(address.port)
    })
  })

describe('framework adapters', () => {
  const cleanups: Array<() => Promise<void> | void> = []
  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()?.()
  })

  it('express: verifies, dispatches typed events, 401s forgeries', async () => {
    const received: VerifiedDelivery[] = []
    const app = express()
    // Documented order: webhook route first, global parsers after.
    app.post(
      '/hooks/vt',
      ...expressWebhook(OPTIONS, (delivery) => {
        received.push(delivery)
      }),
    )
    app.use(express.json())
    const server = app.listen(0, '127.0.0.1')
    cleanups.push(() => new Promise((r) => server.close(() => r())))
    const port = await listen(server)

    const ok = await post(port, '/hooks/vt', vector.raw_body, vector.headers)
    expect(ok.status).toBe(204)
    expect(received[0]?.event.eventType).toBe('EVENT_WINNERS_SELECTED')

    const forged = await post(port, '/hooks/vt', vector.raw_body.replace('87', '88'), vector.headers)
    expect(forged.status).toBe(401)
    expect(received).toHaveLength(1)
  })

  it('hono: accepts AUTH_HEADER mode deliveries', async () => {
    const received: VerifiedDelivery[] = []
    const app = new Hono()
    app.post(
      '/hooks/vt',
      honoWebhook({ authHeader: { value: 'token-123' } }, (delivery) => {
        received.push(delivery)
      }),
    )

    const ok = await app.request('/hooks/vt', {
      method: 'POST',
      headers: { authorization: 'token-123' },
      body: vector.raw_body,
    })
    expect(ok.status).toBe(204)
    expect(received[0]?.event.eventType).toBe('EVENT_WINNERS_SELECTED')

    const forged = await app.request('/hooks/vt', {
      method: 'POST',
      headers: { authorization: 'wrong' },
      body: vector.raw_body,
    })
    expect(forged.status).toBe(401)
  })

  it('fastify: verifies via scoped raw-body parser', async () => {
    const received: VerifiedDelivery[] = []
    const app = fastify()
    await app.register(
      fastifyWebhook({ ...OPTIONS, path: '/hooks/vt' }, (delivery) => {
        received.push(delivery)
      }),
    )
    await app.listen({ port: 0, host: '127.0.0.1' })
    cleanups.push(() => app.close())
    const port = (app.server.address() as { port: number }).port

    const ok = await post(port, '/hooks/vt', vector.raw_body, vector.headers)
    expect(ok.status).toBe(204)
    expect(received[0]?.event.eventType).toBe('EVENT_WINNERS_SELECTED')

    const forged = await post(port, '/hooks/vt', vector.raw_body, {
      ...vector.headers,
      'x-vt-signature': '00',
    })
    expect(forged.status).toBe(401)
  })

  it('hono: verifies from the standard Request', async () => {
    const received: VerifiedDelivery[] = []
    const app = new Hono()
    app.post(
      '/hooks/vt',
      honoWebhook(OPTIONS, (delivery) => {
        received.push(delivery)
      }),
    )

    const ok = await app.request('/hooks/vt', {
      method: 'POST',
      headers: vector.headers,
      body: vector.raw_body,
    })
    expect(ok.status).toBe(204)
    expect(received[0]?.event.eventType).toBe('EVENT_WINNERS_SELECTED')

    const forged = await app.request('/hooks/vt', {
      method: 'POST',
      headers: { ...vector.headers, 'x-vt-timestamp': '1' },
      body: vector.raw_body,
    })
    expect(forged.status).toBe(401)
  })
})
