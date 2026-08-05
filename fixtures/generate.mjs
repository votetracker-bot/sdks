// Regenerates fixtures/vectors. Fixed secret and timestamps keep the output
// deterministic and diffable.
//
//   node fixtures/generate.mjs
//
// Signature: hex HMAC-SHA256 over `${timestamp}.${rawBody}`, sent as
// X-VT-Signature alongside the unix-seconds X-VT-Timestamp.
import { createHmac } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SECRET = 'vt_test_secret_0123456789abcdef'
const TIMESTAMP = 1785950000 // 2026-08-05T04:33:20Z, fixed

const winner = {
  user_platform_id: '223456683337318402',
  rank: 1,
  entries_at_draw: 12,
  discord_id: '223456683337318402',
  user_name: 'xavin',
}

const newWinner = {
  user_platform_id: '199456683337318401',
  rank: 1,
  entries_at_draw: 9,
  discord_id: '199456683337318401',
  user_name: 'newwinner',
}

const base = {
  event_id: 'evt_pub_1234567890',
  guild_id: '706877503645679676',
  type: 'GIVEAWAY',
  prize_text: 'Your configured prize',
  project_platform_id: '479688142908162059',
  project_type: 'BOT',
  project_name: 'Vote Tracker',
}

const payloads = {
  vote_created: {
    event_type: 'VOTE_CREATED',
    occurred_at: '2026-02-25T18:30:00Z',
    data: {
      id: 'vt_vote_2k5k5f2nY1Rk08Jxq8Nqf2Q2f6b2iYwzH0n7qkW9c3Q',
      vote_type: 'VOTE_CREATE',
      user_platform_id: '223456683337318402',
      project_platform_id: '479688142908162059',
      project_type: 'BOT',
      project_name: 'Vote Tracker',
      weight: 1,
      vote_expires_at: '2026-02-26T18:30:00Z',
      streak_current: 4,
      is_test: false,
      query: { guild_id: '811261515891474442', source: 'vote-command' },
    },
  },
  event_created: {
    event_type: 'EVENT_CREATED',
    occurred_at: '2026-02-25T19:00:00Z',
    data: {
      ...base,
      starts_at: '2026-02-25T19:00:00Z',
      ends_at: '2026-02-26T19:00:00Z',
      winner_count: 1,
      base_entries_per_vote: 1,
      external_reward: { kind: 'currency', amount: 500 },
      prize_image_url: 'https://cdn.example.com/prizes/holo-pikachu.png',
      is_test: false,
    },
  },
  event_activated: {
    event_type: 'EVENT_ACTIVATED',
    occurred_at: '2026-02-25T19:00:00Z',
    data: {
      ...base,
      starts_at: '2026-02-25T19:00:00Z',
      ends_at: '2026-02-26T19:00:00Z',
      winner_count: 1,
      base_entries_per_vote: 1,
      is_test: false,
    },
  },
  event_cancelled: {
    event_type: 'EVENT_CANCELLED',
    occurred_at: '2026-02-25T20:00:00Z',
    data: {
      ...base,
      cancel_reason: 'MANUAL_CANCEL',
      cancelled_at: '2026-02-25T20:00:00Z',
      is_test: false,
    },
  },
  event_completed: {
    event_type: 'EVENT_COMPLETED',
    occurred_at: '2026-02-26T19:00:00Z',
    data: {
      ...base,
      ended_at: '2026-02-26T19:00:00Z',
      is_test: false,
      total_entries: 87,
      winners: [winner],
    },
  },
  event_winners_selected: {
    event_type: 'EVENT_WINNERS_SELECTED',
    occurred_at: '2026-02-26T19:00:10Z',
    data: {
      ...base,
      total_entries: 87,
      winners: [winner],
      external_reward: { kind: 'currency', amount: 500 },
      selected_at: '2026-02-26T19:00:10Z',
      is_test: false,
    },
  },
  event_winner_rerolled: {
    event_type: 'EVENT_WINNER_REROLLED',
    occurred_at: '2026-02-26T20:15:00Z',
    data: {
      ...base,
      total_entries: 87,
      rerolls: [{ rank: 1, previous_winner: winner, new_winner: newWinner }],
      winners: [newWinner],
      reason: 'Previous winner left the server',
      external_reward: { kind: 'currency', amount: 500 },
      rerolled_at: '2026-02-26T20:15:00Z',
    },
  },
  webhook_test: {
    event_type: 'WEBHOOK_TEST',
    occurred_at: '2026-02-25T18:45:00Z',
    data: { delivery_id: '7d7a5f2e-1f6b-4a83-9512-d57f8e9f3e7c' },
  },
  // Made-up type: unknown events have to land in the catch-all instead of throwing.
  unknown_event: {
    event_type: 'EVENT_SOMETHING_NEW',
    occurred_at: '2026-02-27T12:00:00Z',
    data: { event_id: 'evt_pub_1234567890', shiny: true },
  },
}

const outDir = join(dirname(fileURLToPath(import.meta.url)), 'vectors')
mkdirSync(outDir, { recursive: true })

for (const [name, payload] of Object.entries(payloads)) {
  const rawBody = JSON.stringify(payload)
  const signature = createHmac('sha256', SECRET).update(`${TIMESTAMP}.${rawBody}`).digest('hex')
  const vector = {
    name,
    secret: SECRET,
    timestamp: TIMESTAMP,
    raw_body: rawBody,
    signature,
    headers: {
      'x-vt-signature': signature,
      'x-vt-timestamp': String(TIMESTAMP),
      'x-vt-delivery-id': `fix-${name}`,
      'x-vt-attempt': '1',
    },
  }
  writeFileSync(join(outDir, `${name}.json`), `${JSON.stringify(vector, null, 2)}\n`)
}

console.log(`wrote ${Object.keys(payloads).length} vectors to ${outDir}`)
