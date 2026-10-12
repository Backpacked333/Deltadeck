import {
  lazy,
  Suspense,
  useState,
  type ComponentType,
  type LazyExoticComponent,
} from 'react'
import { evidenceState } from '../core/assessment'
import { atlas, registry } from '../core/registry'
import { routes, type LearningRoute } from '../core/routes'
import type { LearningSession } from '../core/session'
import {
  unitSteps,
  type AttemptSnapshot,
  type Prediction,
  type ExperienceEntryProps,
  type FoundationUnit,
  type Question,
  type UnitStep,
} from '../core/types'
import { pathways } from '../content/pathways'
import { connectionLabels } from '../content/foundations'
import { CasePlayer } from './CasePlayer'
import { PredictionForm } from './PredictionForm'
import { modules } from '../curriculum'
import { freshFamilyCase } from '../core/freshness'

function Retrieval({
  question: q,
  unit: u,
  session,
}: {
  question: Question
  unit: FoundationUnit
  session: LearningSession
}) {
  const caseId = `retrieval:${u.id}`
  const [attempt, setAttempt] = useState<AttemptSnapshot>(
    () =>
      [...session.store.attempts]
        .reverse()
        .find((a) => a.caseId === caseId) ?? {
        id: crypto.randomUUID(),
        caseId,
        unitId: u.id,
        contentVersion: u.contentVersion,
        rubricVersion: u.rubricVersion,
        modelVersion: 'retrieval-v1',
        mode: 'practice',
        createdAt: session.clock().toISOString(),
        inputs: {},
        answers: {},
        assistance: { hintIds: [], solutionViewed: false },
        phase: 'draft',
      },
  )
  const answer = attempt.answers[q.id] ?? ''
  const revealed = attempt.assistance.solutionViewed
  function save(next: AttemptSnapshot) {
    session.recordAttempt(next)
    setAttempt(next)
  }
  return (
    <section>
      <h3>Retrieve before studying</h3>
      <p>{q.prompt}</p>
      {q.kind === 'choice' ? (
        <label>
          Retrieval response
          <select
            disabled={revealed}
            value={String(answer)}
            onChange={(e) =>
              save({ ...attempt, answers: { [q.id]: e.target.value } })
            }
          >
            <option value="">Choose an answer</option>
            {q.options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <button
        disabled={revealed}
        className="button secondary"
        onClick={() =>
          save({
            ...attempt,
            assistance: { ...attempt.assistance, solutionViewed: true },
            phase: 'reflected',
          })
        }
      >
        Check retrieval (practice only)
      </button>
      <button
        className="text-button"
        disabled={revealed}
        onClick={() =>
          save({
            ...attempt,
            answers: { [q.id]: 'skipped' },
            assistance: { ...attempt.assistance, solutionViewed: true },
            phase: 'reflected',
          })
        }
      >
        Skip retrieval (recorded; not success)
      </button>
      {revealed ? (
        <p role="status">
          {answer === 'skipped'
            ? 'Retrieval skipped. '
            : answer === q.expected
              ? 'Supported. '
              : 'Revisit the setup. '}
          {q.rationale} Retrieval is not demonstration evidence.
        </p>
      ) : null}
    </section>
  )
}
function GuidedPrediction({
  unit: u,
  session,
  experiment = false,
}: {
  unit: FoundationUnit
  session: LearningSession
  experiment?: boolean
}) {
  const key = `lesson-${experiment ? 'experiment' : 'prediction'}:${u.id}`
  const draft = session.store.drafts[key]?.attempt
  function save(prediction: Prediction, committed: boolean) {
    const next: AttemptSnapshot = {
      ...(draft ?? {
        id: crypto.randomUUID(),
        unitId: u.id,
        caseId: key,
        contentVersion: u.contentVersion,
        rubricVersion: u.rubricVersion,
        modelVersion: 'guided-v1',
        mode: 'explore',
        createdAt: session.clock().toISOString(),
        inputs: {
          legacyId: u.lesson!.experiment.legacyId ?? null,
          experienceId: u.lesson!.experiment.experienceId ?? null,
        },
        answers: {},
        assistance: { hintIds: [], solutionViewed: false },
        phase: 'draft',
      }),
      prediction,
      ...(committed
        ? {
            committedAt: session.clock().toISOString(),
            phase: 'prediction_committed',
          }
        : {}),
    }
    session.recordAttempt(next)
    session.update((store) => ({
      ...store,
      drafts: { ...store.drafts, [key]: { attempt: next, protocol: {} } },
    }))
  }
  return draft?.committedAt ? (
    <p>
      Committed prediction: {draft.prediction?.actionId};{' '}
      {draft.prediction?.direction}; estimate{' '}
      {draft.prediction?.numericEstimate ?? 'not supplied'}; confidence{' '}
      {draft.prediction?.confidencePercent ?? 'not sure'}.{' '}
      {draft.prediction?.rationale} This guided snapshot is exploration, not
      demonstration.
    </p>
  ) : (
    <PredictionForm
      initial={draft?.prediction}
      actions={['Test the stated model', 'Withhold judgment']}
      question={
        experiment
          ? u.lesson!.experiment.question
          : u.lesson!.predictionQuestion
      }
      onDraft={(p) => save(p, false)}
      onCommit={(p) => save(p, true)}
    />
  )
}
function CaseSelector({
  ids,
  session,
}: {
  ids: readonly string[]
  session: LearningSession
}) {
  const fresh = freshFamilyCase(ids, registry.cases, session.store)
  const [selected, setSelected] = useState(fresh ?? ids[0])
  if (!selected)
    return <p>Case bank pending integration; no evidence can be earned here.</p>
  return (
    <>
      <label>
        Case variant
        <select value={selected} onChange={(e) => setSelected(e.target.value)}>
          {ids.map((id) => (
            <option key={id} value={id}>
              {registry.cases.get(id)?.title}
            </option>
          ))}
        </select>
      </label>
      {!fresh ? (
        <p>
          No fresh variants remain in this bank. Revisit for assisted practice,
          not new unaided evidence.
        </p>
      ) : null}
      <CasePlayer
        key={selected}
        caseRecord={registry.cases.get(selected)!}
        session={session}
      />
    </>
  )
}
function UnitLesson({
  unit: u,
  step,
  session,
}: {
  unit: FoundationUnit
  step: UnitStep
  session: LearningSession
}) {
  const l = u.lesson
  return (
    <>
      <header className="page-heading">
        <div>
          <div className="eyebrow">
            FOUNDATION {u.id.toUpperCase()} · {u.availability}
          </div>
          <h1 tabIndex={-1}>{u.title}</h1>
          <p>{u.question}</p>
        </div>
      </header>
      <p>
        Evidence:{' '}
        {evidenceState(
          session.store,
          u.id,
          u.contentVersion,
          u.rubricVersion,
          session.clock,
        )}
        . Prior/core completion is separate.
      </p>
      <p>
        Recommended prerequisites:{' '}
        {u.prerequisites.length
          ? u.prerequisites.map((id) => (
              <a key={id} href={routes.unit(id)}>
                {id.toUpperCase()}{' '}
              </a>
            ))
          : 'none'}
        ; recommendations are not locks.
      </p>
      {!l || u.availability !== 'available' ? (
        <section>
          <h2>Partial — required cases are not integrated</h2>
          <p>This is a unit shell, not a shipped lesson or assessment.</p>
          <ul>
            {u.fragmentSlots.map((s) => (
              <li key={s.id}>
                {s.id}: {s.purpose} Owner {s.owner}; {s.minTransfer} transfer
                and{s.minReview} review variants.
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <>
          <nav className="qp-step-nav" aria-label="Seven lesson steps">
            {unitSteps.map((s) => (
              <a
                key={s}
                aria-current={s === step ? 'step' : undefined}
                href={routes.unit(u.id, s)}
              >
                {s}
              </a>
            ))}
          </nav>
          <section className="qp-lesson-step">
            <h2>{step}</h2>
            {step === 'brief' ? (
              <>
                {l.brief.map((p) => (
                  <p key={p}>{p}</p>
                ))}
                {(() => {
                  const c = registry.cases.get(u.workedCaseIds[0])
                  return c ? (
                    <section>
                      <h3>Decision brief</h3>
                      <p>
                        Role: {c.role}. Objective: {c.objective}
                      </p>
                      <ul>
                        {c.information.map((info) => (
                          <li key={info}>{info}</li>
                        ))}
                      </ul>
                      <p>
                        Allowed actions: {c.actions.join('; ')}.{' '}
                        {c.assumptions.join(' ')}
                      </p>
                      <p>
                        Cash flows are incremental net profits unless explicitly
                        labeled as gross receipts or terminal wealth. Prior/sunk
                        costs are excluded from the current action ledger.
                      </p>
                    </section>
                  ) : null
                })()}
                <Retrieval
                  key={u.id}
                  question={l.retrieval}
                  unit={u}
                  session={session}
                />
              </>
            ) : null}
            {step === 'predict' ? (
              <>
                <p>{l.predictionQuestion}</p>
                <GuidedPrediction unit={u} session={session} />
                <p>
                  Prediction is recorded per case before structured questions
                  appear. Work through practice first or proceed to a fresh
                  transfer.
                </p>
                <a className="button" href={routes.unit(u.id, 'practice')}>
                  Make a practice prediction
                </a>
              </>
            ) : null}
            {step === 'worked' ? (
              <>
                {l.worked.map((p) => (
                  <p key={p}>{p}</p>
                ))}
                {u.workedCaseIds.map((id) => {
                  const c = registry.cases.get(id)!
                  return (
                    <article className="qp-case" key={id}>
                      <h3>{c.title}</h3>
                      <p>{connectionLabels[c.connection]}</p>
                      <p>{c.objective}</p>
                      <ul>
                        {c.information.map((p) => (
                          <li key={p}>{p}</li>
                        ))}
                      </ul>
                      <ol>
                        {c.workedSolution.map((p) => (
                          <li key={p}>{p}</li>
                        ))}
                      </ol>
                      <p>{c.assumptions.join(' ')}</p>
                      <p>Decision-changing assumption: {c.decisionReversal}</p>
                    </article>
                  )
                })}
              </>
            ) : null}
            {step === 'practice' ? (
              <>
                {l.practice.map((p) => (
                  <p key={p}>{p}</p>
                ))}
                <p>
                  Use the partial scaffold to work from supplied inputs toward
                  the requested quantity. Opening a scaffold or hint marks
                  assistance; a fresh transfer is needed for unaided evidence.
                </p>
                <CaseSelector ids={u.practiceCaseIds} session={session} />
              </>
            ) : null}
            {step === 'experiment' ? (
              <>
                <h3>{l.experiment.question}</h3>
                {l.experiment.instructions.map((p) => (
                  <p key={p}>{p}</p>
                ))}
                <GuidedPrediction
                  key={`${u.id}:experiment`}
                  unit={u}
                  session={session}
                  experiment
                />
                {l.experiment.legacyId ? (
                  <a
                    className="button"
                    href={routes.module(l.experiment.legacyId, 'lab')}
                  >
                    Open the existing synthetic lab
                  </a>
                ) : l.experiment.experienceId ? (
                  <a
                    className="button"
                    href={routes.lab(l.experiment.experienceId)}
                  >
                    Open the specialist experiment
                  </a>
                ) : (
                  <p>Required specialist experiment pending.</p>
                )}
                <label>
                  Experiment reflection (ungraded,2,000-character limit)
                  <textarea
                    maxLength={2000}
                    value={session.store.unitNotes[u.id] ?? ''}
                    onChange={(e) =>
                      session.update((store) => ({
                        ...store,
                        unitNotes: {
                          ...store.unitNotes,
                          [u.id]: e.target.value,
                        },
                      }))
                    }
                  />
                </label>
                <p>
                  Use the model’s displayed inputs; these controls do not
                  execute a legal action in the paused live hand. This guided
                  experiment never grants correctness or mastery from realized
                  winnings.
                </p>
              </>
            ) : null}
            {step === 'transfer' || step === 'review' ? (
              <>
                {l[step].map((p) => (
                  <p key={p}>{p}</p>
                ))}
                {step === 'review' ? (
                  <p>
                    Device-clock reminder:{' '}
                    {session.store.reviewSchedule[u.id]?.dueAt ??
                      'Demonstrate a fresh transfer first; early cases are practice.'}
                  </p>
                ) : null}
                <CaseSelector
                  key={`${u.id}:${step}`}
                  ids={
                    step === 'transfer' ? u.transferCaseIds : u.reviewCaseIds
                  }
                  session={session}
                />
              </>
            ) : null}
          </section>
          <p>
            <strong>Limitation:</strong> {l.limitation}
          </p>
          <p>
            <strong>Decision reversal:</strong> {l.decisionReversal}
          </p>
        </>
      )}
      <details>
        <summary>Sources and provenance</summary>
        {u.sources.map((r, i) => (
          <p key={i}>
            {registry.sources.has(r.sourceId) ? (
              <a
                href={registry.sources.get(r.sourceId)!.url}
                target="_blank"
                rel="noreferrer"
              >
                {registry.sources.get(r.sourceId)!.title}
              </a>
            ) : (
              r.sourceId
            )}
            : {r.claim} ({r.locator}; {r.verification}). Business examples are
            original hypothetical contracts, not actual market or legal claims.
          </p>
        ))}
      </details>
    </>
  )
}
const lazyExperiences = new Map<
  string,
  LazyExoticComponent<ComponentType<ExperienceEntryProps>>
>()
function RegisteredExperience({
  id,
  session,
}: {
  id: string
  session: LearningSession
}) {
  const registration = registry.experiences.get(id as never)
  if (!registration?.passedGate)
    return (
      <>
        <h1 tabIndex={-1}>Laboratory pending integration</h1>
        <p>{id} is planned, not a runnable or completed laboratory.</p>
      </>
    )
  if (!lazyExperiences.has(id)) lazyExperiences.set(id, lazy(registration.load))
  const View = lazyExperiences.get(id)!
  return (
    <Suspense fallback={<p role="status">Loading laboratory…</p>}>
      <View session={session} />
    </Suspense>
  )
}
const labQuestions = {
  calibration:
    'Which forecast is well calibrated, and does that make its decision valuable?',
  selection:
    'Who made it into the observed sample, and whose outcomes are missing?',
  information:
    'Should I pay for a signal before choosing an irreversible project?',
  contracts: 'What does the contract promise to pay in each state?',
  solvency: 'Can pooled claims exhaust the seller’s available capital?',
  backtest: 'Did choosing among many strategies create an apparent edge?',
}
function NextAction({ session }: { session: LearningSession }) {
  const units = [...registry.units.values()]
  const state = (u: FoundationUnit) =>
    evidenceState(
      session.store,
      u.id,
      u.contentVersion,
      u.rubricVersion,
      session.clock,
    )
  const due = units.find((u) => state(u) === 'review-due')
  const next =
    due ?? units.find((u) => !['demonstrated', 'retained'].includes(state(u)))
  return (
    <p>
      Recommended next action:{' '}
      {next ? (
        <a href={routes.unit(next.id, due ? 'review' : 'brief')}>
          {due ? 'Review' : 'Study'} {next.id.toUpperCase()} {next.title}
        </a>
      ) : (
        <a href={routes.overview('reviews')}>
          Check retention reminders or freely practice a changed case
        </a>
      )}
      . Recommendations never lock access; realized profit is not learning
      evidence.
    </p>
  )
}
function LabCatalog() {
  const [search, setSearch] = useState('')
  const query = search.trim().toLowerCase()
  const rows = registry.experienceInventory
    .map((e) => {
      const cases = [...registry.cases.values()].filter((c) =>
        c.id.includes(e.id),
      )
      const concepts = atlas.concepts
        .filter((c) => c.r1_experience_links.includes(e.id))
        .map((c) => c.id)
      const roles = [...new Set(cases.map((c) => c.role))]
      const units = [...new Set(cases.map((c) => c.unitId))]
      return {
        ...e,
        question: labQuestions[e.id],
        concepts,
        roles,
        units,
        search: [
          e.title,
          labQuestions[e.id],
          ...roles,
          ...concepts,
          ...concepts.map(
            (id) => atlas.concepts.find((c) => c.id === id)?.title ?? '',
          ),
        ]
          .join(' ')
          .toLowerCase(),
      }
    })
    .filter((e) => e.search.includes(query))
  const core = modules.filter((m) =>
    `${m.title} ${m.subtitle} ${m.tags.join(' ')} decision maker poker player ${atlas.concepts
      .filter((c) => c.legacy_resources.includes(m.id))
      .map((c) => `${c.id} ${c.title}`)
      .join(' ')}`
      .toLowerCase()
      .includes(query),
  )
  return (
    <>
      <h1 tabIndex={-1}>Laboratories</h1>
      <p>
        Exploration is not assessment. Commit predictions inside specialist
        labs; demonstrate learning on a fresh foundation transfer. Sliders do
        not change your paused hand.
      </p>
      <label>
        Search labs by question, role or concept
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </label>
      <p>
        {rows.length} specialist and {core.length} core matches.
      </p>
      <ul>
        {rows.map((e) => (
          <li key={e.id}>
            <h2>
              <a href={routes.lab(e.id)}>{e.title}</a>
            </h2>
            <p>
              {e.question} — {e.availability}
            </p>
            <p>
              Concepts: {e.concepts.join(', ')}. Roles: {e.roles.join('; ')}.
            </p>
            <p>
              Recommended for {e.units.join(', ').toUpperCase()} transfers;
              prerequisites are recommendations, not access locks.
            </p>
          </li>
        ))}
      </ul>
      <h2>Eight original core experiments</h2>
      <p>
        Core completion badges are independent prior-learning records, not R1
        demonstration.
      </p>
      <ul>
        {core.map((m) => (
          <li key={m.id}>
            <a href={routes.lab(m.id)}>{m.title}</a> — {m.subtitle} Role:
            decision maker; concepts: {m.tags.join(', ')}.
          </li>
        ))}
      </ul>
      <a href="#learn/core">Core library</a> ·{' '}
      <a href="#learn/connections">Core connection diagram</a>
    </>
  )
}

export function FoundationWorkspace({
  route,
  session,
}: {
  route: LearningRoute
  session: LearningSession
}) {
  const [query, setQuery] = useState('')
  const [domain, setDomain] = useState('all')
  const [pathway, setPathway] = useState('all')
  const [level, setLevel] = useState<'introductory' | 'research'>(
    'introductory',
  )
  const [availability, setAvailability] = useState('all')
  if (route.kind === 'overview' && route.page === 'lab') return <LabCatalog />
  if (route.kind === 'unit')
    return (
      <UnitLesson
        key={route.id}
        unit={registry.units.get(route.id)!}
        step={route.step}
        session={session}
      />
    )
  if (route.kind === 'lab')
    return <RegisteredExperience id={route.id} session={session} />
  if (route.kind === 'not-found')
    return (
      <>
        <h1 tabIndex={-1}>Learning route not found</h1>
        <p>
          The URL is malformed or unknown. Your work remains in this session.
        </p>
        <a href={routes.overview('core')}>Open the core library</a>
      </>
    )
  if (
    route.kind === 'pathway' ||
    (route.kind === 'overview' && route.page === 'pathways')
  )
    return (
      <>
        <h1 tabIndex={-1}>Four quantitative pathways</h1>
        {pathways
          .filter((p) => route.kind !== 'pathway' || p.id === route.id)
          .map((p) => (
            <section className="qp-case" key={p.id}>
              <h2>
                <a href={routes.pathway(p.id)}>{p.title}</a>
              </h2>
              <p>
                Role: {p.role}. Prerequisite bridges: {p.bridges.join('; ')}.
              </p>
              <h3>Available introductory resources</h3>
              <ul>
                {[...registry.units.values()]
                  .filter((u) =>
                    u.conceptIds.some((id) => p.conceptIds.includes(id)),
                  )
                  .map((u) => (
                    <li key={u.id}>
                      {u.availability === 'available' ? (
                        <a href={routes.unit(u.id)}>{u.title}</a>
                      ) : (
                        u.title
                      )}{' '}
                      — {u.availability}
                    </li>
                  ))}
              </ul>
              <h3>Runnable introductory laboratories</h3>
              <ul>
                {registry.experienceInventory
                  .filter((e) =>
                    atlas.concepts.some(
                      (c) =>
                        c.pathways.includes(p.id) &&
                        c.r1_experience_links.includes(e.id),
                    ),
                  )
                  .map((e) => (
                    <li key={e.id}>
                      <a href={routes.lab(e.id)}>{e.title}</a> —{' '}
                      {e.availability}; recommended because its assessed
                      mechanisms support this track.
                    </li>
                  ))}
              </ul>
              <p>
                Selected introductory coverage only; research-level families and
                deeper laboratories remain planned. Sources and limitations are
                displayed in each resource.
              </p>
              <h3>Future capstone — planned, not playable</h3>
              <p>{p.capstone}</p>
              <p>
                {p.conceptIds.length} concept families in this track; this
                inventory is not a delivered lesson count.
              </p>
            </section>
          ))}
      </>
    )
  if (route.kind === 'overview' && route.page === 'reviews')
    return (
      <>
        <h1 tabIndex={-1}>Delayed review</h1>
        <p>
          Reminders use this device’s clock. They are not tamper-proof
          certification.
        </p>
        {[...registry.units.values()].map((u) => (
          <p key={u.id}>
            <a href={routes.unit(u.id, 'review')}>{u.title}</a>:{' '}
            {evidenceState(
              session.store,
              u.id,
              u.contentVersion,
              u.rubricVersion,
              session.clock,
            )}
            ; due{' '}
            {session.store.reviewSchedule[u.id]?.dueAt ??
              'after an eligible transfer'}
          </p>
        ))}
      </>
    )
  if (route.kind === 'overview' && route.page === 'atlas')
    return (
      <>
        <h1 tabIndex={-1}>96-family concept atlas</h1>
        <p>
          Kit inventory, not 96 shipped lessons. Available means assessed
          selected introductory coverage, not the whole research family.
          Research depth remains planned.
        </p>
        <label>
          Search all concept families
          <input value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <label>
          Domain
          <select value={domain} onChange={(e) => setDomain(e.target.value)}>
            <option value="all">All domains</option>
            {atlas.domains.map((d) => (
              <option key={d.id} value={d.id}>
                {d.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          Pathway
          <select value={pathway} onChange={(e) => setPathway(e.target.value)}>
            <option value="all">All pathways</option>
            {pathways.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          Mathematical level
          <select
            value={level}
            onChange={(e) => setLevel(e.target.value as typeof level)}
          >
            <option value="introductory">
              Selected introductory mechanisms
            </option>
            <option value="research">Advanced / research family</option>
          </select>
        </label>
        <label>
          Availability
          <select
            value={availability}
            onChange={(e) => setAvailability(e.target.value)}
          >
            <option value="all">All statuses</option>
            {['available', 'partial', 'planned'].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        {atlas.concepts
          .filter(
            (c) =>
              `${c.id} ${c.title} ${c.research_description}`
                .toLowerCase()
                .includes(query.toLowerCase()) &&
              (domain === 'all' || c.domain === domain) &&
              (pathway === 'all' || c.pathways.includes(pathway)) &&
              (availability === 'all' ||
                registry.conceptAvailability(c.id, level) === availability),
          )
          .map((c) => (
            <article className="qp-case" key={c.id}>
              <h2>
                {c.id} {c.title}
              </h2>
              <p>{c.research_description}</p>
              <p>
                Learning question: How does {c.title.toLowerCase()} change a
                defensible decision under uncertainty?
              </p>
              <p>
                {registry.conceptAvailability(c.id, level)} at {level} level —{' '}
                {c.coverage_note}
              </p>
              <p>
                Suggested prerequisites:{' '}
                {c.suggested_prerequisites.join(', ') || 'none'}; connections:{' '}
                {c.connection_kinds.join(', ')}.
              </p>
              <p>
                {c.legacy_resources.map((id) => (
                  <a key={id} href={routes.module(id as never)}>
                    {id} core practice{' '}
                  </a>
                ))}
                {c.r1_unit_links.map((id) =>
                  registry.units.get(id as never)?.availability ===
                  'available' ? (
                    <a key={id} href={routes.unit(id as never)}>
                      {id} foundation{' '}
                    </a>
                  ) : (
                    <span key={id}>{id} partial </span>
                  ),
                )}
              </p>
              <p>
                {c.r1_experience_links.map((id) =>
                  registry.experiences.get(id as never)?.passedGate ? (
                    <a key={id} href={routes.lab(id as never)}>
                      {id} introductory lab{' '}
                    </a>
                  ) : (
                    <span key={id}>{id}: planned </span>
                  ),
                )}
              </p>
              <p>
                {c.r1_unit_links.map((id) => {
                  const u = registry.units.get(id as never)!
                  return (
                    <span key={id}>
                      {id}:{' '}
                      {evidenceState(
                        session.store,
                        u.id,
                        u.contentVersion,
                        u.rubricVersion,
                        session.clock,
                      )}
                      . Recommended to practice the selected mechanism; not a
                      locked prerequisite.{' '}
                    </span>
                  )
                })}
              </p>
            </article>
          ))}
      </>
    )
  return (
    <>
      <h1 tabIndex={-1}>Foundations for defensible decisions</h1>
      <p>
        Ten complete introductory units and six specialist laboratories. Core
        completion, exploration and realized profit are not foundation
        demonstration.
      </p>
      <NextAction session={session} />
      <a href={routes.overview('reviews')}>Check review reminders</a>
      {[...registry.units.values()].map((u) => (
        <article className="qp-case" key={u.id}>
          <h2>
            {u.availability === 'available' ? (
              <a href={routes.unit(u.id)}>
                {u.id.toUpperCase()} {u.title}
              </a>
            ) : (
              `${u.id.toUpperCase()} ${u.title}`
            )}
          </h2>
          <p>
            {u.question} — {u.availability};{' '}
            {evidenceState(
              session.store,
              u.id,
              u.contentVersion,
              u.rubricVersion,
              session.clock,
            )}
            .
          </p>
        </article>
      ))}
      <h2>Six specialist laboratories</h2>
      <ul>
        {registry.experienceInventory.map((e) => (
          <li key={e.id}>
            {e.availability === 'available' ? (
              <a href={routes.lab(e.id)}>{e.title}</a>
            ) : (
              e.title
            )}{' '}
            — {e.availability}
          </li>
        ))}
      </ul>
    </>
  )
}
