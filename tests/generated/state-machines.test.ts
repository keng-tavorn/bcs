import { describe, expect, it } from 'vitest'
import { MACHINES, transition, type StateMachine } from '@/core/state-machines'

// §6.4 / §15.3: every (state, command) pair of every machine — the pairs in the table go where the table says, every
// other pair is INVALID_STATE_TRANSITION. The pairs are counted here, not hard-coded.

describe('[FR-INT-009/AC1] state machines walk every (state, command) pair', () => {
  for (const m of MACHINES as readonly StateMachine<string, string>[]) {
    it(`${m.name}: ${m.states.length} states × ${m.commands.length} commands`, () => {
      let allowed = 0
      let refused = 0
      for (const state of m.states) {
        for (const command of m.commands) {
          const expected = m.transitions.find((t) => t.command === command && t.from.includes(state))
          const result = transition(m, state, command)
          if (expected) {
            expect(result).toEqual({ ok: true, to: expected.to })
            allowed++
          } else {
            expect(result).toEqual({ ok: false, error: 'INVALID_STATE_TRANSITION', from: state, command })
            refused++
          }
        }
      }
      expect(allowed + refused).toBe(m.states.length * m.commands.length)
      expect(allowed).toBe(m.transitions.reduce((n, t) => n + t.from.length, 0))
    })

    it(`${m.name}: the table only uses its own states and commands, and no pair appears twice`, () => {
      const pairs = new Set<string>()
      for (const t of m.transitions) {
        expect(m.commands).toContain(t.command)
        expect(m.states).toContain(t.to)
        for (const from of t.from) {
          expect(m.states).toContain(from)
          const key = `${from}|${t.command}`
          expect(pairs.has(key)).toBe(false)
          pairs.add(key)
        }
      }
    })
  }
})
