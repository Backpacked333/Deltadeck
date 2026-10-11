import type { EvidenceReference, SourceRecord } from '../../core/types'

export const scoringReference: EvidenceReference = {
  sourceId: 'gneiting-raftery-scoring',
  claim:
    'Proper scoring rules evaluate probabilistic forecasts; calibration is consistency between forecasts and observations, distinct from sharpness. A score does not by itself specify an action’s cash-flow objective.',
  locator:
    'Gneiting & Raftery (2007), §1, definition of proper/strictly proper scoring and discussion of calibration/sharpness, pp. 359–360. The binary Brier and action-value calculations here are independently derived finite examples.',
  verification: 'checked',
  checkedAt: '2026-10-07',
}
export const betaReference: EvidenceReference = {
  sourceId: 'mit-beta-conjugacy',
  claim:
    'A Beta(a,b) prior and a binomial count x in n trials give Beta(a+x,b+n−x); repeated updates depend on the assumed likelihood.',
  locator:
    'Orloff & Bloom, MIT 18.05 (Spring 2022), Class 15, §§4, 5.1–5.2, conjugate priors and Binomial/Bernoulli update tables.',
  verification: 'checked',
  checkedAt: '2026-10-07',
}
export const bayesReference: EvidenceReference = {
  sourceId: 'mit-probability',
  claim:
    'Bayes’ theorem combines prior and conditional likelihoods and divides by the evidence probability; a likelihood is not the posterior.',
  locator:
    'Orloff & Bloom, MIT 18.05 (Spring 2022), Class 10, §3 Review of Bayes’ theorem, pp. 3–4.',
  verification: 'checked',
  checkedAt: '2026-10-07',
}
export const sourceRecords: readonly SourceRecord[] = [
  {
    id: 'gneiting-raftery-scoring',
    title:
      'Strictly Proper Scoring Rules, Prediction, and Estimation — Gneiting & Raftery (2007)',
    url: 'https://sites.stat.washington.edu/raftery/Research/PDF/Gneiting2007jasa.pdf',
    references: [scoringReference],
    originalExamples:
      'The two-group population, loss convention (Y−q)², cash-flow decisions, business names and every numerical scenario are original hypothetical exercises, not industry data or an empirical validation of DeltaDeck.',
  },
  {
    id: 'mit-beta-conjugacy',
    title: 'MIT 18.05 Class 15 — Conjugate priors: Beta and normal',
    url: 'https://ocw.mit.edu/courses/18-05-introduction-to-probability-and-statistics-spring-2022/mit18_05_s22_class15-prep.pdf',
    references: [betaReference],
    originalExamples:
      'Beta(2,8) with four successes and one failure is the specification’s hypothetical fixture. Posterior means are conditional on the declared prior and likelihood, not established real-world success rates.',
  },
]
export const caseSources = [
  bayesReference,
  betaReference,
  scoringReference,
] as const
