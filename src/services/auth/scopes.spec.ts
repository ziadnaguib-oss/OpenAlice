import { describe, it, expect } from 'vitest'

import { isTokenScope, scopesSatisfy } from './scopes.js'

describe('token scopes', () => {
  it('validates scope names', () => {
    expect(isTokenScope('read')).toBe(true)
    expect(isTokenScope('gate:approve')).toBe(true)
    expect(isTokenScope('root')).toBe(false)
    expect(isTokenScope(42)).toBe(false)
  })

  it('implication lattice: admin implies everything', () => {
    for (const required of ['read', 'enqueue', 'gate:approve', 'admin'] as const) {
      expect(scopesSatisfy(['admin'], required)).toBe(true)
    }
  })

  it('enqueue and gate:approve imply read but not each other or admin', () => {
    expect(scopesSatisfy(['enqueue'], 'read')).toBe(true)
    expect(scopesSatisfy(['gate:approve'], 'read')).toBe(true)
    expect(scopesSatisfy(['enqueue'], 'gate:approve')).toBe(false)
    expect(scopesSatisfy(['gate:approve'], 'enqueue')).toBe(false)
    expect(scopesSatisfy(['enqueue'], 'admin')).toBe(false)
    expect(scopesSatisfy(['gate:approve'], 'admin')).toBe(false)
  })

  it('read implies only itself; empty set implies nothing', () => {
    expect(scopesSatisfy(['read'], 'read')).toBe(true)
    expect(scopesSatisfy(['read'], 'enqueue')).toBe(false)
    expect(scopesSatisfy([], 'read')).toBe(false)
  })

  it('a set satisfies when any member does', () => {
    expect(scopesSatisfy(['read', 'gate:approve'], 'gate:approve')).toBe(true)
  })
})
