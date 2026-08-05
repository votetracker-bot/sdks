import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { camelToSnakeKey, fromWire, snakeToCamelKey, toWire } from '../src/casing.js'

describe('key conversion', () => {
  it('round-trips every property name in the OpenAPI spec', () => {
    // If a future API field breaks the mechanical casing rule, this fails at regen.
    const spec = JSON.parse(readFileSync(join(__dirname, '../../spec/openapi.json'), 'utf8')) as {
      components: { schemas: Record<string, unknown> }
    }
    const names = new Set<string>()
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const item of node) walk(item)
        return
      }
      if (node !== null && typeof node === 'object') {
        const properties = (node as { properties?: Record<string, unknown> }).properties
        if (properties !== undefined) {
          for (const name of Object.keys(properties)) names.add(name)
        }
        for (const value of Object.values(node)) walk(value)
      }
    }
    walk(spec.components.schemas)

    expect(names.size).toBeGreaterThan(50)
    for (const name of names) {
      expect(camelToSnakeKey(snakeToCamelKey(name))).toBe(name)
    }
  })
})

describe('toWire / fromWire', () => {
  it('converts nested objects and arrays', () => {
    const wire = toWire({
      guildId: '1',
      roleEntryMultipliers: [{ roleId: '2', multiplierPercent: 200 }],
    })
    expect(wire).toEqual({
      guild_id: '1',
      role_entry_multipliers: [{ role_id: '2', multiplier_percent: 200 }],
    })
    expect(fromWire(wire)).toEqual({
      guildId: '1',
      roleEntryMultipliers: [{ roleId: '2', multiplierPercent: 200 }],
    })
  })

  it('passes external_reward through verbatim in both directions', () => {
    const reward = { card_tiers: { '1': { card_id: 'holo' } }, mixedCase_key: [1, 2] }
    const wire = toWire({ externalReward: reward }) as { external_reward: unknown }
    expect(wire.external_reward).toEqual(reward)
    const back = fromWire({ external_reward: reward }) as { externalReward: unknown }
    expect(back.externalReward).toEqual(reward)
  })

  it('passes vote query maps through verbatim', () => {
    const query = { guild_id: '811261515891474442', source: 'vote-command' }
    const back = fromWire({ query }) as { query: unknown }
    expect(back.query).toEqual(query)
  })

  it('leaves primitives and null alone', () => {
    expect(toWire(null)).toBeNull()
    expect(fromWire('some_string_value')).toBe('some_string_value')
    expect(toWire(42)).toBe(42)
  })
})
