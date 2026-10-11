// The schools on the landing page's banners: the top 20 US national
// universities (U.S. News & World Report, Best National Universities 2025,
// ties included). Every one is a school DeltaDeck already gives a badge for
// (school_domains in supabase/migrations/20261010110000_landing.sql), so the
// banner's claim is true; SchoolBanners.test.tsx checks that.
//
// Logos are the schools' own marks, from their Wikimedia Commons and English
// Wikipedia files, rendered to 256 px WebP in public/schools/<id>.webp. They
// are trademarks of the schools; the banner says DeltaDeck is not affiliated
// with or endorsed by them.

export type School = {
  id: string
  /** As school_domains names it. */
  name: string
  /** The banner's cloth, its trim, and the name's ink (AA on the cloth). */
  cloth: string
  trim: string
  ink: string
}

const CREAM = '#f6f1e6'

export const SCHOOLS: School[] = [
  {
    id: 'princeton',
    name: 'Princeton',
    cloth: '#16130f',
    trim: '#e77500',
    ink: CREAM,
  },
  { id: 'mit', name: 'MIT', cloth: '#a31f34', trim: '#8a8b8c', ink: CREAM },
  {
    id: 'harvard',
    name: 'Harvard',
    cloth: '#a51c30',
    trim: '#1e1e1e',
    ink: CREAM,
  },
  {
    id: 'stanford',
    name: 'Stanford',
    cloth: '#8c1515',
    trim: '#2e2d29',
    ink: CREAM,
  },
  { id: 'yale', name: 'Yale', cloth: '#00356b', trim: '#63aaff', ink: CREAM },
  {
    id: 'caltech',
    name: 'Caltech',
    cloth: '#ff6c0c',
    trim: '#1b120a',
    ink: '#1b120a',
  },
  { id: 'duke', name: 'Duke', cloth: '#012169', trim: '#00539b', ink: CREAM },
  {
    id: 'jhu',
    name: 'Johns Hopkins',
    cloth: '#002d72',
    trim: '#68ace5',
    ink: CREAM,
  },
  {
    id: 'northwestern',
    name: 'Northwestern',
    cloth: '#4e2a84',
    trim: '#b6acd1',
    ink: CREAM,
  },
  { id: 'penn', name: 'Penn', cloth: '#011f5b', trim: '#990000', ink: CREAM },
  {
    id: 'cornell',
    name: 'Cornell',
    cloth: '#b31b1b',
    trim: '#222222',
    ink: CREAM,
  },
  {
    id: 'uchicago',
    name: 'UChicago',
    cloth: '#800000',
    trim: '#767676',
    ink: CREAM,
  },
  { id: 'brown', name: 'Brown', cloth: '#4e3629', trim: '#ed1c24', ink: CREAM },
  {
    id: 'columbia',
    name: 'Columbia',
    cloth: '#1d4f91',
    trim: '#b9d9eb',
    ink: CREAM,
  },
  {
    id: 'dartmouth',
    name: 'Dartmouth',
    cloth: '#00693e',
    trim: '#12312b',
    ink: CREAM,
  },
  {
    id: 'ucla',
    name: 'UCLA',
    cloth: '#2774ae',
    trim: '#ffd100',
    ink: '#ffffff',
  },
  {
    id: 'berkeley',
    name: 'UC Berkeley',
    cloth: '#002676',
    trim: '#fdb515',
    ink: CREAM,
  },
  { id: 'rice', name: 'Rice', cloth: '#00205b', trim: '#7c7e7f', ink: CREAM },
  {
    id: 'notredame',
    name: 'Notre Dame',
    cloth: '#0c2340',
    trim: '#c99700',
    ink: CREAM,
  },
  {
    id: 'vanderbilt',
    name: 'Vanderbilt',
    cloth: '#1c1c1c',
    trim: '#cfae70',
    ink: CREAM,
  },
]
