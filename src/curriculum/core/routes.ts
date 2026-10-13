import {
  experienceIds,
  legacyIds,
  pathwayIds,
  unitIds,
  unitSteps,
  type ExperienceId,
  type LegacyModuleId,
  type PathwayId,
  type UnitId,
  type UnitStep,
} from './types'
export type OverviewPage =
  | 'path'
  | 'core'
  | 'map'
  | 'lab'
  | 'notebook'
  | 'reviews'
  | 'pathways'
  | 'foundations'
  | 'atlas'
  | 'connections'
  | 'targeted'
export type LearningRoute =
  | { kind: 'table' }
  | { kind: 'overview'; page: OverviewPage }
  | { kind: 'unit'; id: UnitId; step: UnitStep }
  | { kind: 'pathway'; id: PathwayId }
  | { kind: 'lab'; id: ExperienceId | LegacyModuleId }
  | { kind: 'module'; id: LegacyModuleId; tab: 'learn' | 'lab' | 'check' }
  | { kind: 'not-found'; requested: string }
function member<T extends string>(
  value: string,
  values: readonly T[],
): value is T {
  return values.includes(value as T)
}
export function parseLearningRoute(hash: string): LearningRoute {
  if (hash === '#table') return { kind: 'table' }
  if (!hash.startsWith('#learn')) return { kind: 'overview', page: 'path' }
  let parts: string[]
  try {
    parts = hash.slice(1).split('/').map(decodeURIComponent)
  } catch {
    return { kind: 'not-found', requested: hash }
  }
  const [, page = 'path', id = '', detail = ''] = parts
  if (parts[0] !== 'learn') return { kind: 'not-found', requested: hash }
  if (page === 'map' && parts.length === 2)
    return { kind: 'overview', page: 'atlas' }
  if (page === 'module')
    return {
      kind: 'module',
      id: member(id, legacyIds) ? id : 'odds',
      tab: member(detail, ['learn', 'lab', 'check']) ? detail : 'learn',
    }
  if (
    parts.length <= 2 &&
    member(page || 'path', [
      'path',
      'core',
      'map',
      'lab',
      'notebook',
      'reviews',
      'pathways',
      'foundations',
      'atlas',
      'connections',
      'targeted',
    ])
  )
    return { kind: 'overview', page: (page || 'path') as OverviewPage }
  if (
    page === 'unit' &&
    parts.length <= 4 &&
    member(id, unitIds) &&
    (!detail || member(detail, unitSteps))
  )
    return { kind: 'unit', id, step: (detail || 'brief') as UnitStep }
  if (page === 'pathway' && parts.length === 3 && member(id, pathwayIds))
    return { kind: 'pathway', id }
  if (
    page === 'lab' &&
    parts.length === 3 &&
    (member(id, legacyIds) || member(id, experienceIds))
  )
    return { kind: 'lab', id }
  return { kind: 'not-found', requested: hash }
}
export const routes = {
  table: '#table',
  overview: (page: OverviewPage) => `#learn/${page}`,
  unit: (id: UnitId, step: UnitStep = 'brief') => `#learn/unit/${id}/${step}`,
  module: (id: LegacyModuleId, tab: 'learn' | 'lab' | 'check' = 'learn') =>
    `#learn/module/${id}/${tab}`,
  lab: (id: ExperienceId | LegacyModuleId) => `#learn/lab/${id}`,
  pathway: (id: PathwayId) => `#learn/pathway/${id}`,
}
