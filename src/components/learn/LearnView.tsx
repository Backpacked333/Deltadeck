import { useState } from 'react'
import type { ComponentType } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCircle2,
  Clock3,
  Dices,
  Grid3x3,
  ShieldCheck,
  Target,
  TrendingUp,
} from 'lucide-react'
import type { LessonId } from '../../lib/storage'
import { LESSON_IDS } from '../../lib/storage'
import {
  EVWidget,
  InsuranceWidget,
  OptionWidget,
  OutsWidget,
  RangeWidget,
  VarianceWidget,
} from './Widgets'

type Lesson = {
  title: string
  subtitle: string
  icon: typeof TrendingUp
  level: string
  body: string[]
  widget: ComponentType
  connection: string
  caveat: string
  question: string
  choices: string[]
  answer: number
  explanation: string
}

const LESSONS: Record<LessonId, Lesson> = {
  equity: {
    title: 'Think in expected value',
    subtitle: 'A good bet can still lose. A bad bet can still win.',
    icon: TrendingUp,
    level: 'Foundations',
    body: [
      'Expected value (EV) is the average result of a choice if you could repeat it many times. Weigh each outcome by its probability and add them up.',
      'With a 160-chip pot, a 40-chip call and a 30% chance to win: 0.30 × 160 − 0.70 × 40 = +20 chips. Most single calls lose, yet the call earns 20 chips on average because the wins are large.',
    ],
    widget: EVWidget,
    connection:
      'Investors and insurers weigh outcomes by probability too. EV is the starting point, but it ignores how painful a loss is, how uncertain your estimate is, and whether you survive a losing streak.',
    caveat:
      'This shortcut assumes no more betting. In real poker, later actions can change the price.',
    question: 'The pot is 150. Calling costs 50. What equity breaks even?',
    choices: ['25%', '33%', '50%'],
    answer: 0,
    explanation:
      '50 ÷ (150 + 50) = 25%. At that equity, 25% × 150 − 75% × 50 = 0.',
  },
  'pot-odds': {
    title: 'Count outs, compare the price',
    subtitle: 'Draws are worth exactly what the cards say, no more.',
    icon: Target,
    level: 'Foundations',
    body: [
      'An out is an unseen card that improves you to the likely best hand. Nine hearts complete a heart flush draw.',
      'Turn outs into equity, then compare with the price: the share of the final pot you must put in. If equity beats the price, calling is profitable before any future betting.',
    ],
    widget: OutsWidget,
    connection:
      'Pricing a draw is like pricing any contingent payoff: probability of the good state against the cost to stay exposed to it.',
    caveat:
      'Some outs are tainted: they complete your hand but also improve the opponent. Ranges matter.',
    question:
      'You have 9 outs with one card to come and 46 unseen cards. Roughly what is your chance to hit?',
    choices: ['About 10%', 'About 20%', 'About 35%'],
    answer: 1,
    explanation:
      '9 ÷ 46 ≈ 19.6%. The rule of 2 gives 18%, close enough at the table.',
  },
  variance: {
    title: 'Variance and sample size',
    subtitle: 'Results are noisy. Decisions are what you control.',
    icon: Dices,
    level: 'Mindset',
    body: [
      'A positive-EV decision still loses often. Over a handful of hands, luck dominates the result; over thousands, the average starts to show.',
      'That is why DeltaDeck grades decisions, not results, and why your progress page separates the two lines.',
    ],
    widget: VarianceWidget,
    connection:
      'Fund managers face the same problem: a good process can trail for years and a bad one can look brilliant. Judging a strategy needs a large sample or a model of what should have happened.',
    caveat:
      'Small samples cannot prove skill. Neither can a few bad results prove a mistake.',
    question:
      'A +10 EV call loses five times in a row. What should you conclude?',
    choices: [
      'It was a mistake',
      'Nothing yet: the sample is tiny',
      'The deck is rigged',
    ],
    answer: 1,
    explanation:
      'Five results say almost nothing about a decision. Check the decision itself: price, equity and assumptions.',
  },
  ranges: {
    title: 'Think in ranges',
    subtitle: 'Opponents do not hold one hand. They hold a distribution.',
    icon: Grid3x3,
    level: 'Intermediate',
    body: [
      'Before any action, an opponent could hold any of 1,326 starting combinations. Every bet, call and check is evidence that makes some hands more likely and others less.',
      'DeltaDeck applies Bayes’ rule using Atlas’s published strategy: each possible hand is reweighted by how likely Atlas was to take the action it took. Your equity is then measured against that range.',
    ],
    widget: RangeWidget,
    connection:
      'This is Bayesian updating, the same logic behind credit scoring, medical tests and market prices that react to news.',
    caveat:
      'The update is only as good as the strategy model. Real opponents are less predictable than Atlas.',
    question: 'A tight player makes a big river raise. Which is most likely?',
    choices: [
      'Any random hand',
      'Mostly strong hands, with some bluffs',
      'Always a bluff',
    ],
    answer: 1,
    explanation:
      'Tight players raise big mostly with strength. Occasional bluffs keep the range from being pure strength.',
  },
  options: {
    title: 'See the shape of an option',
    subtitle: 'Limited downside. A different kind of upside.',
    icon: ArrowUpRight,
    level: 'Finance bridge',
    body: [
      'A call option gives the right, not the obligation, to buy at a fixed strike price. With strike 100 and premium 10, an asset ending at 130 is worth 30 to you: 20 net. At 80 you walk away and lose only the 10 premium.',
    ],
    widget: OptionWidget,
    connection:
      'A poker draw has a similar intuition: pay now for the chance of a favorable future. But a call in poker is not an option: there is no traded underlying and later betting can cost more.',
    caveat:
      'Expiration payoff is not the option’s price today. Time, volatility, rates and the pricing model matter.',
    question: 'Strike 100, premium 10. At expiration, where do you break even?',
    choices: ['100', '110', '120'],
    answer: 1,
    explanation:
      'At 110 the option’s 10 intrinsic value exactly covers the 10 premium.',
  },
  insurance: {
    title: 'Put a price on protection',
    subtitle: 'A smaller range of outcomes has a cost.',
    icon: ShieldCheck,
    level: 'Finance bridge',
    body: [
      'Suppose there is a 20% chance of losing 200 chips. Expected loss is 40. A policy paying 200 in the bad state has a fair premium of 40, before any expenses or margin.',
    ],
    widget: InsuranceWidget,
    connection:
      'Fair insurance does not raise expected wealth; it lowers uncertainty. A risk-averse person may prefer a certain 40-chip cost to a one-in-five chance of losing 200.',
    caveat:
      'Real insurance adds deductibles, exclusions, expenses and correlated losses.',
    question: 'A 10% chance of a 100-chip payout has what fair premium?',
    choices: ['1 chip', '10 chips', '100 chips'],
    answer: 1,
    explanation: '0.10 × 100 = 10 chips. A real insurer would charge more.',
  },
}

export function LearnView({
  selected,
  completed,
  onSelect,
  onComplete,
  onPlay,
}: {
  selected: LessonId | null
  completed: LessonId[]
  onSelect: (id: LessonId | null) => void
  onComplete: (id: LessonId) => void
  onPlay: () => void
}) {
  const [choice, setChoice] = useState<number | null>(null)
  const [shown, setShown] = useState(selected)
  if (shown !== selected) {
    setShown(selected)
    setChoice(null)
  }
  if (!selected)
    return (
      <div className="page learn-page">
        <header className="page-head">
          <h1>A little knowledge. A better decision.</h1>
          <p>
            Six short, hands-on lessons. {completed.length} of{' '}
            {LESSON_IDS.length} complete.{' '}
            <a className="link-btn" href="#learn/path">
              Full curriculum <ArrowRight size={13} />
            </a>
          </p>
        </header>
        <div className="lesson-grid">
          {LESSON_IDS.map((id) => {
            const lesson = LESSONS[id]
            const Icon = lesson.icon
            const done = completed.includes(id)
            return (
              <button
                key={id}
                className="lesson-card"
                onClick={() => onSelect(id)}
              >
                <span className={`lesson-icon icon-${id}`}>
                  <Icon size={22} />
                </span>
                <span className="label">
                  {done ? 'Completed' : `${lesson.level} · 3 min`}
                </span>
                <h3>{lesson.title}</h3>
                <p>{lesson.subtitle}</p>
                <span className="lesson-go">
                  {done ? <CheckCircle2 size={18} /> : <ArrowRight size={18} />}
                </span>
              </button>
            )
          })}
        </div>
      </div>
    )
  const lesson = LESSONS[selected]
  const Widget = lesson.widget
  const index = LESSON_IDS.indexOf(selected)
  const next = LESSON_IDS[index + 1]
  return (
    <article className="page lesson-page">
      <button className="link-btn back" onClick={() => onSelect(null)}>
        <ArrowLeft size={14} /> All lessons
      </button>
      <div className="lesson-meta">
        <Clock3 size={14} /> 3-minute lesson · {lesson.level}
      </div>
      <h1>{lesson.title}</h1>
      <p className="lesson-sub">{lesson.subtitle}</p>
      {lesson.body.map((p, i) => (
        <p key={i}>{p}</p>
      ))}
      <Widget />
      <h3>Beyond the poker table</h3>
      <p>{lesson.connection}</p>
      <div className="caveat">{lesson.caveat}</div>
      <div className="quiz">
        <span className="label">Check your intuition</span>
        <h3>{lesson.question}</h3>
        <div className="quiz-choices">
          {lesson.choices.map((answer, i) => (
            <button
              key={answer}
              className={
                choice === i
                  ? i === lesson.answer
                    ? 'correct'
                    : 'incorrect'
                  : ''
              }
              onClick={() => {
                setChoice(i)
                if (i === lesson.answer) onComplete(selected)
              }}
            >
              {answer}
              {choice === i && i === lesson.answer && <Check size={16} />}
            </button>
          ))}
        </div>
        {choice !== null && (
          <p className="quiz-feedback" role="status">
            {choice === lesson.answer
              ? `Exactly. ${lesson.explanation}`
              : 'Not quite. Weigh the cost against the possible payoff and try again.'}
          </p>
        )}
      </div>
      <div className="lesson-nav">
        <button className="btn btn-quiet" onClick={onPlay}>
          Practice at the table
        </button>
        {next && (
          <button className="btn btn-primary" onClick={() => onSelect(next)}>
            Next: {LESSONS[next].title} <ArrowRight size={15} />
          </button>
        )}
      </div>
    </article>
  )
}
