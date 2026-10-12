import { describe, expect, it } from 'vitest'
import {
  CODE_INPUT_MAX,
  formatCode,
  GAME_CODE_ALPHABET,
  GAME_CODE_LENGTH,
  GAME_CODE_RE,
  normaliseCode,
} from './gameCode'

describe('game codes', () => {
  it('has 31 distinct symbols and none that can be mixed up', () => {
    expect(GAME_CODE_ALPHABET).toHaveLength(31)
    expect(new Set(GAME_CODE_ALPHABET).size).toBe(31)
    for (const c of '01ILO') expect(GAME_CODE_ALPHABET).not.toContain(c)
  })

  it('cleans what a person types or pastes', () => {
    expect(normaliseCode('abc-234')).toBe('ABC234')
    expect(normaliseCode(' abc 234 ')).toBe('ABC234')
    expect(GAME_CODE_RE.test('ABC234')).toBe(true)
  })

  it('never remaps a character: a lookalike is simply wrong', () => {
    for (const bad of [
      'ABC230',
      'ABC231',
      'ABCIL2',
      'ABCO23',
      'ABC23',
      'ABC2345',
    ])
      expect(normaliseCode(bad)).toBeNull()
    expect(normaliseCode('A'.repeat(CODE_INPUT_MAX + 1))).toBeNull()
  })

  it('shows a code in two halves', () => {
    expect(formatCode('ABC234')).toBe('ABC-234')
    expect(formatCode('ABCD2345')).toBe('ABCD-2345')
    expect(GAME_CODE_LENGTH).toBe(6)
  })
})
