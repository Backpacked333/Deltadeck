import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from 'react'
import { useHash } from '../lib/navigation'
import { LiveHandBridge, type LiveHand } from './components/LiveHandBridge'
import './palette.css'
import './styles.css'
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronRight,
  CircleCheck,
  Clock3,
  ExternalLink,
  FlaskConical,
  GitBranch,
  GraduationCap,
  LayoutGrid,
  Menu,
  Network,
  NotebookPen,
  Search,
  ShieldCheck,
  Spade,
  Target,
  X,
} from 'lucide-react'
import {
  modules,
  moduleById,
  totalMinutes,
  type Module,
  type ModuleId,
} from './curriculum'
import { Checkpoint } from './components/Checkpoint'
import { Lab } from './components/Labs'
import { type Progress } from './lib/progress'
import { useLearningSession, type LearningSession } from './core/session'
import { parseLearningRoute } from './core/routes'
import { experienceIds } from './core/types'
import { registry } from './core/registry'
import { evidenceState } from './core/assessment'
import { FoundationWorkspace } from './components/FoundationWorkspace'
import { LearningDataTools } from './components/LearningDataTools'
import {
  attachLearningSession,
  startLearningEvidence,
} from './learning/runtime'

const LearningWorkspace = lazy(() => import('./learning/LearningWorkspace'))

type Page = 'path' | 'map' | 'lab' | 'notebook' | 'module'
const stages = [
  'All modules',
  'Foundations',
  'Decision science',
  'Market mechanics',
] as const
const navItems = [
  { id: 'path', label: 'Core library', icon: LayoutGrid },
  { id: 'map', label: 'Concept atlas', icon: Network },
  { id: 'lab', label: 'Practice lab', icon: FlaskConical },
  { id: 'notebook', label: 'My notebook', icon: NotebookPen },
] as const
const moduleHref = (id: ModuleId, tab = 'learn') => `#learn/module/${id}/${tab}`

function HeroArt() {
  return (
    <div className="hero-art" aria-hidden="true">
      <div className="art-grid" />
      <div className="orbit orbit-one" />
      <div className="orbit orbit-two" />
      <svg className="art-line" viewBox="0 0 400 220">
        <defs>
          <linearGradient id="lineFill" x1="0" y1="0" x2="0" y2="1">
            <stop
              offset="0%"
              style={{ stopColor: 'var(--brand)' }}
              stopOpacity="0.4"
            />
            <stop
              offset="100%"
              style={{ stopColor: 'var(--brand)' }}
              stopOpacity="0"
            />
          </linearGradient>
        </defs>
        <path
          d="M20 190 L65 163 L97 177 L135 124 L170 142 L201 100 L232 118 L276 64 L315 74 L365 20 V220 H20Z"
          fill="url(#lineFill)"
        />
        <path
          d="M20 190 L65 163 L97 177 L135 124 L170 142 L201 100 L232 118 L276 64 L315 74 L365 20"
          fill="none"
          style={{ stroke: 'var(--brand)' }}
          strokeWidth="2"
        />
        <circle cx="365" cy="20" r="5" style={{ fill: 'var(--accent)' }} />
      </svg>
      <div className="art-card card-back">
        <span>
          K<small>♣</small>
        </span>
        <b>♣</b>
      </div>
      <div className="art-card card-front">
        <span>
          A<small>♠</small>
        </span>
        <b>♠</b>
        <span className="card-corner">A</span>
      </div>
      <div className="art-chip chip-one">+EV</div>
      <div className="art-chip chip-two">Δ</div>
      <div className="art-caption">
        <span className="tiny-dot" /> SAME MATH. A NEW PERSPECTIVE.
      </div>
    </div>
  )
}

function ModuleCard({
  module,
  completed,
  next,
}: {
  module: Module
  completed: boolean
  next: boolean
}) {
  return (
    <a
      className={`module-card ${next ? 'recommended' : ''} ${completed ? 'complete-card' : ''}`}
      href={moduleHref(module.id)}
    >
      <div className="module-card-top">
        <span className={`module-number ${completed ? 'done' : ''}`}>
          {completed ? <Check size={19} /> : module.number}
        </span>
        <span className="card-time">
          <Clock3 size={12} /> {module.minutes} min
        </span>
      </div>
      <div className="module-poker">{module.poker}</div>
      <h3>{module.title}</h3>
      <p>{module.subtitle}</p>
      <div className="connection">
        <GitBranch size={14} />
        <span>{module.finance}</span>
      </div>
      <div className="module-card-bottom">
        <span>
          {completed
            ? 'Completed · revisit'
            : next
              ? 'Start here'
              : module.stage}
        </span>
        <ArrowUpRight size={18} />
      </div>
    </a>
  )
}

function LearningPath({ completed }: { completed: ModuleId[] }) {
  const [filter, setFilter] = useState<(typeof stages)[number]>('All modules')
  const next = modules.find((module) => !completed.includes(module.id))
  const visible = modules.filter(
    (module) => filter === 'All modules' || module.stage === filter,
  )
  return (
    <>
      <section className="page-heading">
        <div>
          <div className="eyebrow">THE DELTADECK CURRICULUM</div>
          <h1 tabIndex={-1}>A better way to think about risk.</h1>
          <p>Start at the poker table. Build intuition for the markets.</p>
          <a href="#learn/connections">Core connection diagram</a>
        </div>
        <span className="outline-badge">
          <GraduationCap size={15} /> Learn by doing
        </span>
      </section>
      <section className="hero">
        <div className="hero-copy">
          <div className="hero-kicker">
            <span /> FROM THE FELT TO THE MARKET
          </div>
          <h2>
            Different games.
            <br />
            Same <em>edge.</em>
          </h2>
          <p>
            Turn poker instincts into quantitative intuition. Explore the
            mathematics behind every call, every hedge, and every calculated
            risk.
          </p>
          <a
            className="button hero-button"
            href={moduleHref(next?.id ?? 'odds')}
          >
            {completed.length === modules.length
              ? 'Revisit the curriculum'
              : completed.length
                ? 'Continue learning'
                : 'Start your learning path'}
            <ArrowRight size={17} />
          </a>
          <div className="hero-meta">
            <span>{modules.length} connected modules</span>
            <i /> <span>At your own pace</span>
          </div>
        </div>
        <HeroArt />
      </section>
      <div className="curriculum-metrics">
        <div>
          <span className="stat-icon">
            <BookOpen size={18} />
          </span>
          <strong>
            {modules.length}
            <span>Core modules</span>
          </strong>
        </div>
        <div>
          <span className="stat-icon">
            <FlaskConical size={18} />
          </span>
          <strong>
            {modules.length}
            <span>Interactive labs</span>
          </strong>
        </div>
        <div>
          <span className="stat-icon">
            <Clock3 size={18} />
          </span>
          <strong>
            ~{Math.round(totalMinutes / 60)} hrs<span>Of focused learning</span>
          </strong>
        </div>
        <div>
          <span className="stat-icon">
            <Target size={18} />
          </span>
          <strong>
            {completed.length} / {modules.length}
            <span>Modules completed</span>
          </strong>
        </div>
      </div>
      <section className="path-section">
        <div className="section-heading">
          <div>
            <div className="eyebrow">YOUR LEARNING PATH</div>
            <h2>Build your edge, one concept at a time.</h2>
          </div>
          <a href="#learn/map" className="text-button">
            See the connections <ArrowUpRight size={15} />
          </a>
        </div>
        <div
          className="filter-tabs"
          role="group"
          aria-label="Filter modules by stage"
        >
          {stages.map((stage) => (
            <button
              key={stage}
              aria-pressed={filter === stage}
              onClick={() => setFilter(stage)}
            >
              {stage}
              {stage === 'All modules' ? <span>{modules.length}</span> : null}
            </button>
          ))}
        </div>
        <div className="module-grid">
          {visible.map((module) => (
            <ModuleCard
              key={module.id}
              module={module}
              completed={completed.includes(module.id)}
              next={module.id === next?.id}
            />
          ))}
        </div>
      </section>
      <section className="bridge-banner">
        <span className="bridge-icon">
          <ShieldCheck size={27} />
        </span>
        <div>
          <h3>Good intuition knows its limits.</h3>
          <p>
            Poker isn’t a stock market. Every lesson explains the connection—and
            exactly where the analogy stops.
          </p>
        </div>
        <a className="text-button" href="#learn/map">
          Explore the map <ArrowRight size={16} />
        </a>
      </section>
    </>
  )
}

function ConceptMap({ completed }: { completed: ModuleId[] }) {
  const [query, setQuery] = useState('')
  const [focus, setFocus] = useState('All connections')
  const filters = [
    'All connections',
    'Probability',
    'Pricing',
    'Risk & hedging',
  ]
  const focusIds: Record<string, ModuleId[]> = {
    Probability: ['odds', 'outs', 'equity'],
    Pricing: ['odds', 'pricing', 'replication'],
    'Risk & hedging': ['fold', 'variance', 'replication', 'risk'],
  }
  const visible = modules.filter(
    (module) =>
      (focus === 'All connections' || focusIds[focus].includes(module.id)) &&
      `${module.title} ${module.poker} ${module.finance} ${module.tags.join(' ')}`
        .toLowerCase()
        .includes(query.toLowerCase().trim()),
  )
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">ONE IDEA, TWO PERSPECTIVES</div>
          <h1 tabIndex={-1}>Follow the connections.</h1>
          <p>A map of the shared mathematics—and the important differences.</p>
        </div>
        <Network size={32} className="heading-icon" />
      </div>
      <div className="map-toolbar">
        <label className="search-field">
          <Search size={18} />
          <input
            aria-label="Search concepts"
            placeholder="Search equity, volatility, delta…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div
          className="filter-tabs"
          role="group"
          aria-label="Filter concept connections"
        >
          {filters.map((item) => (
            <button
              key={item}
              aria-pressed={focus === item}
              onClick={() => setFocus(item)}
            >
              {item}
            </button>
          ))}
        </div>
      </div>
      <div className="map-column-labels">
        <span>AT THE POKER TABLE</span>
        <span>IN THE FINANCIAL MARKETS</span>
      </div>
      <div className="concept-map">
        {visible.map((module) => (
          <article className="map-row" key={module.id}>
            <div className="map-connection">
              <div>
                <span className="map-number">{module.number}</span>
                <h2>{module.poker}</h2>
                {completed.includes(module.id) ? (
                  <CircleCheck size={16} className="green" />
                ) : null}
              </div>
              <div className="map-arrow">
                <span />
                <ArrowRight size={20} />
                <span />
              </div>
              <h3>{module.finance}</h3>
              <a
                href={moduleHref(module.id)}
                aria-label={`Explore ${module.poker}`}
              >
                <ArrowUpRight size={20} />
              </a>
            </div>
            <p>{module.bridge}</p>
            <details>
              <summary>Where the analogy stops</summary>
              <p>{module.boundary}</p>
            </details>
            <div className="prerequisite-links">
              <span>Builds on</span>
              {module.prerequisites.length ? (
                module.prerequisites.map((id) => (
                  <a href={moduleHref(id)} key={id}>
                    {moduleById[id].poker}
                    <ArrowUpRight size={12} />
                  </a>
                ))
              ) : (
                <span>No prerequisites</span>
              )}
            </div>
          </article>
        ))}
      </div>
      {visible.length === 0 ? (
        <div className="empty-state">
          <Search size={30} />
          <h2>No connections found</h2>
          <p>Try a broader concept or clear your filters.</p>
          <button
            className="button secondary"
            onClick={() => {
              setQuery('')
              setFocus('All connections')
            }}
          >
            Clear filters
          </button>
        </div>
      ) : null}
      <p className="page-disclaimer">
        Connections are teaching bridges, not equivalences. Open any module for
        assumptions, examples, and a hands-on lab.
      </p>
    </>
  )
}

function Lesson({
  module,
  tab,
  progress,
  onComplete,
  onNote,
}: {
  module: Module
  tab: string
  progress: Progress
  onComplete: () => void
  onNote: (note: string) => void
}) {
  const next = modules[modules.findIndex((item) => item.id === module.id) + 1]
  const unmet = module.prerequisites.filter(
    (id) => !progress.completed.includes(id),
  )
  return (
    <>
      <a className="back-link" href="#learn/path">
        <ArrowLeft size={15} /> Back to learning path
      </a>
      <div className="lesson-heading">
        <div className="eyebrow">
          MODULE {module.number} <span> / </span> {module.stage.toUpperCase()}
        </div>
        <h1 tabIndex={-1}>{module.title}</h1>
        <p>{module.subtitle}</p>
        <div className="lesson-meta">
          <span>
            <Clock3 size={14} /> {module.minutes} min
          </span>
          <span>
            {module.poker}
            <ArrowRight size={14} />
            {module.finance}
          </span>
          {progress.completed.includes(module.id) ? (
            <span className="green">
              <CircleCheck size={14} /> Completed
            </span>
          ) : null}
        </div>
      </div>
      <nav className="lesson-tabs" aria-label="Module sections">
        {[
          { id: 'learn', label: 'The connection', icon: BookOpen },
          { id: 'lab', label: 'Interactive lab', icon: FlaskConical },
          { id: 'check', label: 'Checkpoint', icon: CircleCheck },
        ].map(({ id, label, icon: Icon }) => (
          <a
            key={id}
            href={moduleHref(module.id, id)}
            aria-current={tab === id ? 'page' : undefined}
          >
            <Icon size={16} />
            {label}
          </a>
        ))}
      </nav>
      {tab === 'lab' ? (
        <Lab id={module.id} />
      ) : tab === 'check' ? (
        <Checkpoint
          key={module.id}
          module={module}
          completed={progress.completed.includes(module.id)}
          onComplete={onComplete}
          onNext={() => {
            window.location.hash = next ? moduleHref(next.id) : '#learn/path'
          }}
        />
      ) : (
        <div className="lesson-layout">
          <div className="lesson-content">
            {unmet.length ? (
              <div className="prerequisite-note">
                <GitBranch size={18} />
                <div>
                  Recommended first:{' '}
                  {unmet.map((id, i) => (
                    <span key={id}>
                      {i ? ', ' : ''}
                      <a href={moduleHref(id)}>{moduleById[id].poker}</a>
                    </span>
                  ))}
                  . You can still explore freely.
                </div>
              </div>
            ) : null}
            <section className="connection-panel">
              <div className="eyebrow">THE CONNECTION</div>
              <div className="connection-title">
                <span>{module.poker}</span>
                <ArrowRight size={20} />
                <span>{module.finance}</span>
              </div>
              <p>{module.bridge}</p>
            </section>
            <div className="lesson-concepts">
              {module.concepts.map((concept, i) => (
                <section key={concept.title}>
                  <span className="concept-step">0{i + 1}</span>
                  <div>
                    <h2>{concept.title}</h2>
                    <p>{concept.body}</p>
                  </div>
                </section>
              ))}
            </div>
            <section className="worked-example">
              <div className="eyebrow">A WORKED EXAMPLE</div>
              <h2>{module.scenario.title}</h2>
              <p>{module.scenario.body}</p>
              <div className="example-calculation">
                {module.scenario.calculation}
              </div>
              <p>{module.scenario.takeaway}</p>
            </section>
            <section className="boundary-box">
              <ShieldCheck size={21} />
              <div>
                <h3>Where the analogy stops</h3>
                <p>{module.boundary}</p>
              </div>
            </section>
            <div className="lesson-bottom">
              <a
                className="source-link"
                href={module.source.url}
                target="_blank"
                rel="noreferrer"
              >
                Further reading: {module.source.label}
                <ExternalLink size={13} />
              </a>
              <a href={moduleHref(module.id, 'lab')} className="button primary">
                Try it in the lab
                <ArrowRight size={16} />
              </a>
            </div>
          </div>
          <aside className="lesson-aside">
            <section className="objective-card">
              <Target size={21} />
              <h3>What you’ll take away</h3>
              <ul>
                {module.objectives.map((objective) => (
                  <li key={objective}>
                    <Check size={14} />
                    {objective}
                  </li>
                ))}
              </ul>
            </section>
            <section className="formula-card">
              <div className="eyebrow">KEEP THIS HANDY</div>
              <p>{module.formula}</p>
              <small>{module.formulaKey}</small>
            </section>
            <section className="note-card">
              <label htmlFor={`note-${module.id}`}>
                <NotebookPen size={16} /> Your field notes
              </label>
              <textarea
                id={`note-${module.id}`}
                placeholder="What clicked? What surprised you?"
                maxLength={10000}
                value={progress.notes[module.id] ?? ''}
                onChange={(event) => onNote(event.target.value)}
              />
              <small>Private to this browser · saved as you type</small>
            </section>
          </aside>
        </div>
      )}
      {tab === 'lab' ? (
        <div className="after-lab">
          <span>Got a feel for the numbers?</span>
          <a href={moduleHref(module.id, 'check')} className="button primary">
            Check your understanding
            <ArrowRight size={16} />
          </a>
        </div>
      ) : null}
    </>
  )
}

function Practice({ selectedId }: { selectedId: ModuleId }) {
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">LESS THEORY. MORE WHAT-IF.</div>
          <h1 tabIndex={-1}>Your decision playground.</h1>
          <p>Change an assumption. See the consequences. Build intuition.</p>
        </div>
        <FlaskConical size={32} className="heading-icon" />
      </div>
      <label className="lab-picker">
        Choose your experiment
        <select
          value={selectedId}
          onChange={(event) => {
            window.location.hash = `#learn/lab/${event.target.value}`
          }}
        >
          {modules.map((module) => (
            <option value={module.id} key={module.id}>
              {module.number} · {module.poker} → {module.finance}
            </option>
          ))}
        </select>
      </label>
      <Lab key={selectedId} id={selectedId} />
      <div className="after-lab">
        <span>Want the reasoning behind the model?</span>
        <a className="text-button" href={moduleHref(selectedId)}>
          Read the lesson <ArrowUpRight size={15} />
        </a>
      </div>
    </>
  )
}

function Notebook({
  progress,
  onNote,
  onReset,
}: {
  progress: Progress
  onNote: (id: ModuleId, note: string) => void
  onReset: () => void
}) {
  const [confirmReset, setConfirmReset] = useState(false)
  const [exportError, setExportError] = useState(false)
  function exportNotes() {
    try {
      const content =
        '# DeltaDeck field notes\n\n' +
        modules
          .map(
            (module) =>
              `## ${module.number}. ${module.title}\n${progress.completed.includes(module.id) ? 'Completed' : 'Not completed'}\n\n${progress.notes[module.id] || '(No notes yet)'}\n`,
          )
          .join('\n')
      const url = URL.createObjectURL(
        new Blob([content], { type: 'text/markdown' }),
      )
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = 'deltadeck-notes.md'
      anchor.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      setExportError(false)
    } catch {
      setExportError(true)
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">MAKE THE CONNECTIONS YOUR OWN</div>
          <h1 tabIndex={-1}>Your field notes.</h1>
          <p>Capture the ideas you’ll want to come back to.</p>
        </div>
        <button className="button secondary" onClick={exportNotes}>
          <ArrowDown size={15} /> Export notes
        </button>
      </div>
      {exportError ? (
        <p role="alert">
          Export is unavailable in this browser. Your notes remain here; you can
          select and copy them.
        </p>
      ) : null}
      <div className="notebook-grid">
        {modules.map((module) => (
          <section className="notebook-card" key={module.id}>
            <div>
              <span className="eyebrow">MODULE {module.number}</span>
              {progress.completed.includes(module.id) ? (
                <CircleCheck size={16} className="green" />
              ) : null}
            </div>
            <a href={moduleHref(module.id)}>
              {module.title}
              <ArrowUpRight size={15} />
            </a>
            <label className="sr-only" htmlFor={`notebook-${module.id}`}>
              Notes for {module.title}
            </label>
            <textarea
              id={`notebook-${module.id}`}
              value={progress.notes[module.id] ?? ''}
              maxLength={10000}
              onChange={(event) => onNote(module.id, event.target.value)}
              placeholder="An insight, a question, a connection…"
            />
            <small>
              {(progress.notes[module.id] ?? '').length.toLocaleString()} /
              10,000 characters
            </small>
          </section>
        ))}
      </div>
      <section className="local-data-panel">
        <div>
          <ShieldCheck size={20} />
          <h3>Your learning is saved.</h3>
        </div>
        <p>
          Progress and notes are kept in this browser and, while you are signed
          in, on your account, so they follow you to your other devices. Only
          you can read them. Export your notes whenever you like.
        </p>
        {confirmReset ? (
          <div className="reset-confirm" role="alert">
            <p>
              Delete all notes, completed core checkpoints, foundation attempts,
              active drafts and review evidence from this browser? Table history
              and original mini-lessons are not removed. This cannot be undone.
            </p>
            <button
              className="button danger"
              onClick={() => {
                onReset()
                setConfirmReset(false)
              }}
            >
              Delete my local learning data
            </button>
            <button
              className="button secondary"
              onClick={() => setConfirmReset(false)}
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            className="text-button danger-text"
            onClick={() => setConfirmReset(true)}
          >
            Reset local learning data
          </button>
        )}
      </section>
    </>
  )
}

export default function Curriculum({
  liveHand,
  session,
}: {
  liveHand?: LiveHand
  session?: RefObject<LearningSession | null>
}) {
  const hash = useHash()
  const learning = useLearningSession(session)
  useEffect(() => {
    startLearningEvidence()
    return attachLearningSession(learning)
  }, [learning])
  const route = parseLearningRoute(hash)
  const foundationPage =
    route.kind === 'unit' ||
    route.kind === 'pathway' ||
    route.kind === 'not-found' ||
    (route.kind === 'lab' && experienceIds.includes(route.id as never)) ||
    (route.kind === 'overview' &&
      ['path', 'foundations', 'atlas', 'pathways', 'reviews', 'lab'].includes(
        route.page,
      ))
  const [pagePart = 'path', idPart = 'odds', tabPart = 'learn'] = hash
    .replace(/^#learn\/?/, '')
    .split('/')
    .filter(Boolean)
  const page: Page =
    pagePart === 'connections'
      ? 'map'
      : ['path', 'map', 'lab', 'notebook', 'module'].includes(pagePart)
        ? (pagePart as Page)
        : 'path'
  const id =
    route.kind === 'module'
      ? route.id
      : route.kind === 'lab' && modules.some((m) => m.id === route.id)
        ? (route.id as ModuleId)
        : modules.some((module) => module.id === idPart)
          ? (idPart as ModuleId)
          : 'odds'
  const tab =
    route.kind === 'module'
      ? route.tab
      : ['learn', 'lab', 'check'].includes(tabPart)
        ? tabPart
        : 'learn'
  const progress: Progress = { version: 1, ...learning.store.legacy }
  const [mobileOpen, setMobileOpen] = useState(false)
  const mainRef = useRef<HTMLElement>(null)
  const activeNav =
    route.kind === 'lab' || (route.kind === 'overview' && route.page === 'lab')
      ? 'lab'
      : route.kind === 'overview' && route.page === 'atlas'
        ? 'map'
        : foundationPage
          ? null
          : page === 'module'
            ? 'path'
            : page
  const percentage = Math.round(
    (progress.completed.length / modules.length) * 100,
  )
  const selected = moduleById[id]
  useEffect(() => {
    document.title = `${page === 'module' ? selected.title : (navItems.find((item) => item.id === page)?.label ?? 'Learn')} · DeltaDeck`
    const focusHeading = () => {
      const h = [...(mainRef.current?.querySelectorAll('h1') ?? [])].find(
        (heading) => {
          for (
            let node: HTMLElement | null = heading;
            node;
            node = node.parentElement
          )
            if (
              node.hidden ||
              node.getAttribute('aria-hidden') === 'true' ||
              node.style.display === 'none'
            )
              return false
          return true
        },
      )
      if (!h) return false
      h.tabIndex = -1
      h.focus({ preventScroll: true })
      document.title = `${h.textContent} · DeltaDeck`
      return true
    }
    const observer = new MutationObserver(() => {
      if (focusHeading()) observer.disconnect()
    })
    if (!focusHeading() && mainRef.current)
      observer.observe(mainRef.current, { childList: true, subtree: true })
    window.scrollTo({ top: 0, behavior: 'instant' })
    return () => observer.disconnect()
  }, [hash, page, selected.title])
  useEffect(() => {
    const changed = (event: StorageEvent) =>
      learning.observeStorage(event.key, event.newValue)
    window.addEventListener('storage', changed)
    return () => {
      window.removeEventListener('storage', changed)
      learning.cancelRuns()
    }
  }, [learning])
  function save(updated: Progress) {
    learning.update((store) => ({
      ...store,
      legacy: { completed: updated.completed, notes: updated.notes },
    }))
  }
  function saveNote(noteId: ModuleId, note: string) {
    save({ ...progress, notes: { ...progress.notes, [noteId]: note } })
  }
  return (
    <div className="curriculum-workspace">
      <div className="app-shell">
        <a
          href="#main-content"
          className="skip-link"
          onClick={(event) => {
            event.preventDefault()
            mainRef.current?.focus()
          }}
        >
          Skip to content
        </a>
        {mobileOpen ? (
          <button
            className="sidebar-backdrop"
            aria-label="Close navigation"
            onClick={() => setMobileOpen(false)}
          />
        ) : null}
        <aside className={`sidebar ${mobileOpen ? 'open' : ''}`}>
          <a
            className="brand"
            href="#learn/path"
            onClick={() => setMobileOpen(false)}
          >
            <span className="brand-icon">
              <Spade size={21} fill="currentColor" />
            </span>
            <span>
              delta<span>deck</span>
              <small>THE MATHEMATICS OF AN EDGE</small>
            </span>
          </a>
          <button
            className="close-menu"
            aria-label="Close navigation"
            onClick={() => setMobileOpen(false)}
          >
            <X size={20} />
          </button>
          <div className="sidebar-label">YOUR WORKSPACE</div>
          <a className="back-link return-to-table" href="#table">
            <ArrowLeft size={15} /> Return to table
          </a>
          <nav aria-label="Curriculum navigation">
            <a
              href="#learn/foundations"
              aria-current={
                route.kind === 'unit' ||
                (route.kind === 'overview' &&
                  ['path', 'foundations'].includes(route.page))
                  ? 'page'
                  : undefined
              }
              onClick={() => setMobileOpen(false)}
            >
              Foundation units
            </a>
            <a
              href="#learn/pathways"
              aria-current={
                route.kind === 'pathway' ||
                (route.kind === 'overview' && route.page === 'pathways')
                  ? 'page'
                  : undefined
              }
              onClick={() => setMobileOpen(false)}
            >
              Four pathways
            </a>
            <a href="#learn/atlas" onClick={() => setMobileOpen(false)}>
              96-family atlas
            </a>
            <a
              href="#learn/reviews"
              aria-current={
                route.kind === 'overview' && route.page === 'reviews'
                  ? 'page'
                  : undefined
              }
              onClick={() => setMobileOpen(false)}
            >
              Delayed reviews
            </a>
            {navItems.map(({ id: navId, label, icon: Icon }) => (
              <a
                href={`#learn/${navId === 'path' ? 'core' : navId}`}
                key={navId}
                aria-current={activeNav === navId ? 'page' : undefined}
                onClick={() => setMobileOpen(false)}
              >
                <Icon size={18} />
                <span>{label}</span>
                {navId === 'path' ? (
                  <span className="nav-count">{modules.length}</span>
                ) : null}
              </a>
            ))}
            <a href="#learn/quick" onClick={() => setMobileOpen(false)}>
              <BookOpen size={18} />
              <span>Quick lessons</span>
              <span className="nav-count">6</span>
            </a>
          </nav>
          <div className="sidebar-progress">
            <div>
              <span>Prior/core practice</span>
              <p>Core library completed: {progress.completed.length}/8</p>
              <p>
                Foundation demonstrated:{' '}
                {
                  [...registry.units.values()].filter((u) =>
                    ['demonstrated', 'retained', 'review-due'].includes(
                      evidenceState(
                        learning.store,
                        u.id,
                        u.contentVersion,
                        u.rubricVersion,
                        learning.clock,
                      ),
                    ),
                  ).length
                }
                /10
              </p>
              <strong>{percentage}%</strong>
            </div>
            <progress
              value={progress.completed.length}
              max={modules.length}
              aria-label="Curriculum completion"
            />
            <small>
              {progress.completed.length} of {modules.length} modules completed
            </small>
          </div>
          <div className="sidebar-bottom">
            <div className="sidebar-quote">
              <span>♠</span>
              <p>
                Don’t play the outcome.
                <br />
                <strong>Understand the odds.</strong>
              </p>
            </div>
            <div className="learner">
              <div className="learner-avatar">
                <GraduationCap size={20} />
              </div>
              <div>
                Independent learner<small>Local learning workspace</small>
              </div>
              <span className="online-dot" />
            </div>
          </div>
        </aside>
        <div className="main-shell">
          <header className="topbar">
            <div>
              <button
                className="menu-button"
                aria-label="Open navigation"
                aria-expanded={mobileOpen}
                onClick={() => setMobileOpen(true)}
              >
                <Menu size={21} />
              </button>
              <span>Workspace</span>
              <ChevronRight size={13} />
              <strong>
                {navItems.find((item) => item.id === activeNav)?.label}
              </strong>
              {page === 'module' ? (
                <>
                  <ChevronRight size={13} />
                  <span className="breadcrumb-module">
                    Module {selected.number}
                  </span>
                </>
              ) : null}
            </div>
            <span className="topbar-note">
              <span className="tiny-dot" /> A little more calculated.
            </span>
          </header>
          <main ref={mainRef} id="main-content" tabIndex={-1}>
            {liveHand ? <LiveHandBridge hand={liveHand} /> : null}
            {learning.notice ? (
              <div className="storage-warning" role="alert">
                {learning.notice}
              </div>
            ) : null}
            {learning.recovery || learning.conflict || page === 'notebook' ? (
              <LearningDataTools session={learning} />
            ) : null}
            <p>
              <a href="#learn/targeted">
                Self-study evidence and targeted-practice pilot
              </a>
            </p>
            {hash === '#learn/targeted' ? (
              <Suspense fallback={<p>Loading evidence workspace…</p>}>
                <LearningWorkspace session={learning} />
              </Suspense>
            ) : foundationPage ? (
              <FoundationWorkspace route={route} session={learning} />
            ) : page === 'path' ? (
              <LearningPath completed={progress.completed} />
            ) : page === 'map' ? (
              <ConceptMap completed={progress.completed} />
            ) : page === 'lab' ? (
              <Practice selectedId={id} />
            ) : page === 'notebook' ? (
              <Notebook
                progress={progress}
                onNote={saveNote}
                onReset={() => learning.reset()}
              />
            ) : (
              <Lesson
                key={id}
                module={selected}
                tab={tab}
                progress={progress}
                onComplete={() => {
                  if (!progress.completed.includes(id))
                    save({
                      ...progress,
                      completed: [...progress.completed, id],
                    })
                }}
                onNote={(note) => saveNote(id, note)}
              />
            )}
            <footer>
              <span>
                <Spade size={13} /> DeltaDeck{' '}
                <span className="footer-divider">/</span> Better decisions start
                with better questions.
              </span>
              <span>Educational models. Not financial advice.</span>
            </footer>
          </main>
        </div>
      </div>
    </div>
  )
}
