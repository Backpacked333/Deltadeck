// The crest badge beside a player's name, for a verified school email at
// one of the schools on the landing page's banners (src/landing/schools.ts,
// whose logos live in public/schools/<id>.webp). Any other school shows no
// badge. The logos are the schools' trademarks: the badge names the school
// in its tooltip and nothing more, and claims no affiliation or endorsement.
import { SCHOOLS } from '../landing/schools'

/** school_domains (20261010110000_landing.sql) to a banner school's id. */
const CREST_DOMAINS: Record<string, string> = {
  'princeton.edu': 'princeton',
  'mit.edu': 'mit',
  'harvard.edu': 'harvard',
  'stanford.edu': 'stanford',
  'yale.edu': 'yale',
  'caltech.edu': 'caltech',
  'duke.edu': 'duke',
  'jhu.edu': 'jhu',
  'northwestern.edu': 'northwestern',
  'upenn.edu': 'penn',
  'cornell.edu': 'cornell',
  'uchicago.edu': 'uchicago',
  'brown.edu': 'brown',
  'columbia.edu': 'columbia',
  'dartmouth.edu': 'dartmouth',
  'ucla.edu': 'ucla',
  'berkeley.edu': 'berkeley',
  'rice.edu': 'rice',
  'nd.edu': 'notredame',
  'vanderbilt.edu': 'vanderbilt',
}

export type Crest = { src: string; name: string }

/** The crest for a verified school's domain, or null when we have none. */
export function crestFor(domain: string | null | undefined): Crest | null {
  const id = domain ? CREST_DOMAINS[domain] : undefined
  const school = id ? SCHOOLS.find((s) => s.id === id) : undefined
  return school
    ? { src: `/schools/${school.id}.webp`, name: school.name }
    : null
}

/** Every domain with a crest (tests). */
export const crestDomains = () => Object.keys(CREST_DOMAINS)
