import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SCHOOLS } from '../landing/schools'
import { crestDomains, crestFor } from './crests'

const at = (path: string) => join(process.cwd(), path)

describe('crestFor', () => {
  it('names the school and its logo for a listed domain', () => {
    expect(crestFor('princeton.edu')).toEqual({
      src: '/schools/princeton.webp',
      name: 'Princeton',
    })
    expect(crestFor('nd.edu')?.name).toBe('Notre Dame')
  })

  it('gives nothing for any other school, or none', () => {
    expect(crestFor('uni.edu')).toBeNull()
    expect(crestFor('harvard.edu.evil.com')).toBeNull()
    expect(crestFor(null)).toBeNull()
    expect(crestFor('')).toBeNull()
  })

  it('covers every banner school, each a school_domains domain with a logo', () => {
    const seed = readFileSync(
      at('supabase/migrations/20261010110000_landing.sql'),
      'utf8',
    )
    const crests = crestDomains().map((d) => crestFor(d)!)
    expect(crests.map((c) => c.name).sort()).toEqual(
      SCHOOLS.map((s) => s.name).sort(),
    )
    for (const domain of crestDomains()) {
      expect(seed).toContain(`('${domain}', '${crestFor(domain)!.name}'`)
      expect(existsSync(at(`public${crestFor(domain)!.src}`))).toBe(true)
    }
  })
})
