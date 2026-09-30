import { describe, expect, it } from 'vitest'
import { cn } from './utils'

// A real pure module from `src`, imported with no browser present and no
// `chrome` global defined. This is the proof the harness works before anything
// depends on it.
describe('cn', () => {
  it('joins class names', () => {
    expect(cn('px-2', 'text-sm')).toBe('px-2 text-sm')
  })

  it('drops falsy values instead of emitting them', () => {
    expect(cn('px-2', false, undefined, null, '')).toBe('px-2')
  })

  it('lets a later utility win over an earlier conflicting one', () => {
    // tailwind-merge is what makes this more than string concatenation.
    expect(cn('p-2', 'p-4')).toBe('p-4')
  })

  it('returns an empty string for no input', () => {
    expect(cn()).toBe('')
  })
})
