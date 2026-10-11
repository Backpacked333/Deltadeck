import type { EvidenceReference, SourceRecord } from '../core/types'
const checkedAt = '2026-10-07T07:19:00.000Z'
export const probabilitySource: EvidenceReference = {
  sourceId: 'mit-probability',
  claim:
    'A specified probability model and conditioning information define a probability; sample observations support inference, not certainty.',
  locator:
    'MIT 18.05 statistics notes: probability models, samples/statistics, likelihood and inference',
  verification: 'checked',
  checkedAt,
}
export const kellySource: EvidenceReference = {
  sourceId: 'boyd-kelly',
  claim:
    'Kelly maximizes expected log growth under iid modeled returns; drawdown is a separate risk objective. In a two-outcome gamble the stake is (pi P - 1)/(P - 1), when positive.',
  locator: 'Sections 1, 2.1–2.3',
  verification: 'checked',
  checkedAt,
}
export const pricingSource: EvidenceReference = {
  sourceId: 'mit-options',
  claim:
    'A state-by-state replicating portfolio determines the no-arbitrage cost in the supplied two-state market; pricing weight q is distinct from physical probability p.',
  locator: 'Recitation 5 slides 8–10',
  verification: 'checked',
  checkedAt,
}
export const teachingSource: EvidenceReference = {
  sourceId: 'ies-learning',
  claim:
    'Spacing, alternating worked examples and problems, combining graphics with verbal descriptions, and retrieval quizzes are instructional recommendations; they do not validate this application.',
  locator: 'Recommendations 1–5',
  verification: 'checked',
  checkedAt,
}
export const sources: readonly SourceRecord[] = [
  {
    id: 'mit-probability',
    title: 'MIT 18.05 probability and statistics notes',
    url: 'https://ocw.mit.edu/courses/18-05-introduction-to-probability-and-statistics-spring-2022/mit18_05_s22_statistics.pdf',
    references: [probabilitySource],
    originalExamples:
      'All business ledgers, urns, assets and service projects are original finite hypothetical examples. The arithmetic follows the explicitly supplied distributions.',
  },
  {
    id: 'boyd-kelly',
    title: 'Busseti, Ryu and Boyd — Risk-Constrained Kelly Gambling',
    url: 'https://stanford.edu/~boyd/papers/pdf/kelly.pdf',
    references: [kellySource],
    originalExamples:
      'Nominal even-money stakes and log-utility insurance examples are original exercises; no robust or risk-constrained solver is implemented here.',
  },
  {
    id: 'mit-options',
    title: 'MIT Finance Theory I — Options recitation',
    url: 'https://ocw.mit.edu/courses/15-401-finance-theory-i-fall-2008/d0734e7fec7b333f1255a6dc3dff389c_MIT15_401F08_rec05.pdf',
    references: [pricingSource],
    originalExamples:
      'Two-state payoff tables are stipulated hypothetical markets. Insurance and warranty contracts are invented teaching contracts, not legal or market quotations.',
  },
  {
    id: 'ies-learning',
    title: 'IES — Organizing Instruction and Study to Improve Student Learning',
    url: 'https://ies.ed.gov/ncee/wwc/PracticeGuide/1',
    references: [teachingSource],
    originalExamples:
      'Review intervals and scoring rules are product design choices, not an experimentally validated DeltaDeck intervention.',
  },
]
