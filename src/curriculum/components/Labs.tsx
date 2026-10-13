import { useId, useMemo, useState, type ReactNode } from 'react'
import { ArrowDown, ArrowRight, FlaskConical, RotateCcw } from 'lucide-react'
import type { LabId } from '../curriculum'
import {
  betValue,
  binaryRisk,
  binomial,
  blackScholesCall,
  callValue,
  hitProbability,
  impliedVolatility,
  showdownEquity,
} from '../lib/math'
import { allInCashout, bankrollRisk } from '../../lib/finance'

const percent = (value: number) => `${(value * 100).toFixed(1)}%`
const number = (value: number) =>
  Number.isFinite(value)
    ? value.toLocaleString('en-US', {
        notation: Math.abs(value) >= 1e9 ? 'scientific' : 'standard',
        maximumFractionDigits: 2,
        minimumFractionDigits: 2,
      })
    : 'Beyond numeric range'
const signed = (value: number) => `${value > 0 ? '+' : ''}${number(value)}`

function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  suffix = '',
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  suffix?: string
  onChange: (value: number) => void
}) {
  const id = useId()
  return (
    <label className="slider-field" htmlFor={id}>
      <span>
        {label}
        <output htmlFor={id} aria-hidden="true">
          {value}
          {suffix}
        </output>
      </span>
      <input
        id={id}
        type="range"
        aria-label={label}
        aria-valuetext={`${value}${suffix}`}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className="range-endpoints" aria-hidden="true">
        <span>
          {min}
          {suffix}
        </span>
        <span>
          {max}
          {suffix}
        </span>
      </span>
    </label>
  )
}

function Metric({
  label,
  value,
  hint,
  accent = false,
}: {
  label: string
  value: string
  hint?: string
  accent?: boolean
}) {
  return (
    <div className={`metric ${accent ? 'accent' : ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      {hint ? <small>{hint}</small> : null}
    </div>
  )
}

function LabFrame({
  title,
  description,
  controls,
  children,
  assumption,
}: {
  title: string
  description: string
  controls: ReactNode
  children: ReactNode
  assumption: string
}) {
  return (
    <section className="lab-frame">
      <div className="lab-intro">
        <div className="eyebrow">
          <FlaskConical size={14} /> INTERACTIVE LAB
        </div>
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
      <div className="lab-layout">
        <div className="lab-controls">{controls}</div>
        <div className="lab-results" aria-live="polite" aria-atomic="true">
          {children}
        </div>
      </div>
      <p className="assumption">
        <strong>Model assumptions</strong> {assumption}
      </p>
    </section>
  )
}

function OddsLab() {
  const [pot, setPot] = useState(100)
  const [cost, setCost] = useState(25)
  const [equity, setEquity] = useState(30)
  const result = callValue(pot, cost, equity / 100)
  return (
    <LabFrame
      title="Would you make the call?"
      description="Change the price and your edge. Watch the decision change with them."
      assumption="One opponent; no future betting, rake, or ties. Pot includes the opponent’s bet, but not your call. EV is relative to folding."
      controls={
        <>
          <Slider
            label="Pot before your call"
            value={pot}
            min={20}
            max={500}
            step={10}
            suffix=" chips"
            onChange={setPot}
          />
          <Slider
            label="Cost to call"
            value={cost}
            min={0}
            max={200}
            step={5}
            suffix=" chips"
            onChange={setCost}
          />
          <Slider
            label="Your equity"
            value={equity}
            min={0}
            max={100}
            suffix="%"
            onChange={setEquity}
          />
        </>
      }
    >
      <div className="poker-table">
        <span className="table-label">FINAL POT</span>
        <strong>
          {result.finalPot}
          <small>chips</small>
        </strong>
        <div className="playing-cards">
          <span>
            A<small>♠</small>
          </span>
          <span>
            K<small>♠</small>
          </span>
        </div>
      </div>
      <div className="metric-grid">
        <Metric label="Break-even equity" value={percent(result.threshold)} />
        <Metric
          label="Expected profit"
          value={`${signed(result.ev)}`}
          hint="chips per decision"
          accent
        />
      </div>
      <p className={`decision ${result.ev < 0 ? 'negative' : ''}`}>
        {result.ev > 0
          ? 'Positive-EV call'
          : result.ev < 0
            ? 'Folding has higher EV'
            : 'Exactly break-even'}{' '}
        <ArrowRight size={16} />
      </p>
    </LabFrame>
  )
}

function OutsLab() {
  const [outs, setOuts] = useState(9)
  const [draws, setDraws] = useState(2)
  const unseen = draws === 2 ? 47 : 46
  const exact = hitProbability(outs, unseen, draws)
  const estimate = (outs * (draws === 2 ? 4 : 2)) / 100
  return (
    <LabFrame
      title="Find your future cards"
      description="Compare the exact deck calculation with the rule of two and four."
      assumption="Fixed clean outs; uniform unseen cards; no replacement. Two cards means flop-to-river; one card means turn-to-river. A hit is not necessarily a win."
      controls={
        <>
          <Slider
            label="Clean outs"
            value={outs}
            min={0}
            max={20}
            onChange={setOuts}
          />
          <fieldset className="segmented-field">
            <legend>Cards to come</legend>
            <div className="segmented">
              {[1, 2].map((n) => (
                <button
                  key={n}
                  aria-pressed={draws === n}
                  onClick={() => setDraws(n)}
                >
                  {n === 1 ? 'Turn → river' : 'Flop → river'}
                </button>
              ))}
            </div>
          </fieldset>
          <p className="control-note">
            {unseen} unseen cards · {outs} outs · {unseen - outs} misses
          </p>
        </>
      }
    >
      <div
        className="deck-grid"
        aria-label={`${outs} outs out of ${unseen} unseen cards`}
      >
        {Array.from({ length: unseen }, (_, i) => (
          <span key={i} className={i < outs ? 'is-out' : ''} aria-hidden="true">
            {i < outs ? '♥' : '·'}
          </span>
        ))}
      </div>
      <div className="metric-grid">
        <Metric label="Exact hit probability" value={percent(exact)} accent />
        <Metric
          label={`Rule of ${draws === 2 ? 'four' : 'two'}`}
          value={percent(estimate)}
          hint={`${number((estimate - exact) * 100)} percentage points difference`}
        />
      </div>
    </LabFrame>
  )
}

function EquityLab() {
  const [win, setWin] = useState(40)
  const [tie, setTie] = useState(10)
  const loss = 100 - win - tie
  const equity = showdownEquity(win / 100, tie / 100)
  return (
    <LabFrame
      title="Winning isn’t the whole picture"
      description="Add split pots to see your expected share of the final pot."
      assumption="Heads-up showdown with equal splits and no side pots or rake. Probabilities are user inputs, not computed hand equities. Future betting and equity realization are excluded."
      controls={
        <>
          <Slider
            label="Win probability"
            value={win}
            min={0}
            max={100}
            suffix="%"
            onChange={(value) => {
              setWin(value)
              setTie(Math.min(tie, 100 - value))
            }}
          />
          <Slider
            label="Tie probability"
            value={tie}
            min={0}
            max={100 - win}
            suffix="%"
            onChange={setTie}
          />
          <p className="control-note">
            Loss probability is the remainder: {loss}%. Increasing wins caps
            ties so the total stays at 100%.
          </p>
        </>
      }
    >
      <div
        className="distribution"
        role="img"
        aria-label={`Win ${win}%, tie ${tie}%, lose ${loss}%`}
      >
        <span style={{ width: `${win}%` }} />
        <span style={{ width: `${tie}%` }} />
        <span style={{ width: `${loss}%` }} />
      </div>
      <div className="chart-legend">
        <span>● Win {win}%</span>
        <span>● Tie {tie}%</span>
        <span>● Lose {loss}%</span>
      </div>
      <div className="metric-grid">
        <Metric label="Showdown equity" value={percent(equity)} accent />
        <Metric
          label="Share of a 200-chip pot"
          value={number(equity * 200)}
          hint="expected gross chips, not profit"
        />
      </div>
      <div className="result-note">
        Poker equity ≠ option delta ≠ risk-neutral probability.
      </div>
    </LabFrame>
  )
}

function PricingLab({ replication = false }: { replication?: boolean }) {
  const [spot, setSpot] = useState(100)
  const [strike, setStrike] = useState(100)
  const [move, setMove] = useState(20)
  const [rate, setRate] = useState(5)
  const [physical, setPhysical] = useState(50)
  const result = binomial(
    spot,
    strike,
    1 + move / 100,
    1 - move / 100,
    rate / 100,
  )
  const expected =
    (physical / 100) * result.callUp + (1 - physical / 100) * result.callDown
  return (
    <LabFrame
      title={
        replication
          ? 'One payoff. Two ways to build it.'
          : 'A forecast is not a price'
      }
      description={
        replication
          ? 'Replicate the call with stock and cash, then verify put-call parity.'
          : 'Move your physical forecast. Notice what does—and does not—change.'
      }
      assumption="One-period European options; no dividends, transaction costs, or trading restrictions; borrowing and shorting allowed. Rate is a simple return over the whole period. Controls keep d < 1 + r < u."
      controls={
        <>
          <Slider
            label="Stock price now"
            value={spot}
            min={50}
            max={150}
            step={5}
            onChange={setSpot}
          />
          <Slider
            label="Strike price"
            value={strike}
            min={50}
            max={150}
            step={5}
            onChange={setStrike}
          />
          <Slider
            label="Up / down move"
            value={move}
            min={10}
            max={50}
            suffix="%"
            onChange={setMove}
          />
          <Slider
            label="Period risk-free rate"
            value={rate}
            min={0}
            max={9}
            suffix="%"
            onChange={setRate}
          />
          {!replication ? (
            <Slider
              label="Physical up probability"
              value={physical}
              min={0}
              max={100}
              suffix="%"
              onChange={setPhysical}
            />
          ) : null}
        </>
      }
    >
      <div className="state-tree">
        <div className="tree-root">
          <small>STOCK NOW</small>
          <strong>{number(spot)}</strong>
        </div>
        <div className="tree-branches">
          <div>
            <small>UP · q = {percent(result.q)}</small>
            <strong>{number(result.stockUp)}</strong>
            <span>Call pays {number(result.callUp)}</span>
          </div>
          <div>
            <small>DOWN · 1 − q = {percent(1 - result.q)}</small>
            <strong>{number(result.stockDown)}</strong>
            <span>Call pays {number(result.callDown)}</span>
          </div>
        </div>
      </div>
      {replication ? (
        <>
          <div className="metric-grid">
            <Metric
              label="Replicating delta"
              value={number(result.delta)}
              hint="shares per call"
              accent
            />
            <Metric
              label="Cash position now"
              value={signed(result.cash)}
              hint={
                result.cash < 0 ? 'negative = borrowing' : 'positive = lending'
              }
            />
          </div>
          <div className="parity-proof">
            <div>
              <span>Call − put</span>
              <strong>
                {number(result.call)} − {number(result.put)} ={' '}
                {number(result.call - result.put)}
              </strong>
            </div>
            <div>
              <span>Stock − PV(strike)</span>
              <strong>
                {number(spot)} − {number(strike / (1 + rate / 100))} ={' '}
                {number(result.parity)}
              </strong>
            </div>
            <p>
              Same payoff. Same price. <span>Parity holds.</span>
            </p>
          </div>
          <div className="replication-proof">
            <span>Hedge at expiry: Δ × stock + cash × (1 + r)</span>
            <strong>
              Up:{' '}
              {number(
                result.delta * result.stockUp + result.cash * (1 + rate / 100),
              )}{' '}
              · Down:{' '}
              {number(
                result.delta * result.stockDown +
                  result.cash * (1 + rate / 100),
              )}
            </strong>
            <small>Matches the call in both states.</small>
          </div>
        </>
      ) : (
        <>
          <div className="metric-grid">
            <Metric
              label="No-arbitrage call price"
              value={number(result.call)}
              hint="discounted risk-neutral payoff"
              accent
            />
            <Metric
              label="Physical expected payoff"
              value={number(expected)}
              hint="undiscounted forecast, not a price"
            />
          </div>
          <div className="result-note">
            Changing your physical forecast changes expected payoff, not the
            replicating price.
          </div>
        </>
      )}
    </LabFrame>
  )
}

function FoldLab() {
  const [pot, setPot] = useState(100)
  const [bet, setBet] = useState(50)
  const [fold, setFold] = useState(40)
  const [equity, setEquity] = useState(25)
  const result = betValue(pot, bet, fold / 100, equity / 100)
  return (
    <LabFrame
      title="Give your bet two ways to win"
      description="Explore how folds and showdown equity contribute to a bet’s value."
      assumption="One opponent matches the bet if calling; no raises, later betting, rake, or ties. Equity is conditional on being called. Comparing with checking requires a separate model."
      controls={
        <>
          <Slider
            label="Pot before the bet"
            value={pot}
            min={20}
            max={500}
            step={10}
            suffix=" chips"
            onChange={setPot}
          />
          <Slider
            label="Your bet"
            value={bet}
            min={0}
            max={200}
            step={5}
            suffix=" chips"
            onChange={setBet}
          />
          <Slider
            label="Opponent folds"
            value={fold}
            min={0}
            max={100}
            suffix="%"
            onChange={setFold}
          />
          <Slider
            label="Equity when called"
            value={equity}
            min={0}
            max={100}
            suffix="%"
            onChange={setEquity}
          />
        </>
      }
    >
      <div className="branch-card">
        <span>
          Opponent folds <b>{fold}%</b>
        </span>
        <strong>+{pot} chips</strong>
        <small>Win the existing pot</small>
      </div>
      <ArrowDown className="branch-arrow" size={18} />
      <div className="branch-card alternative">
        <span>
          Opponent calls <b>{100 - fold}%</b>
        </span>
        <strong>{signed(result.calledEV)} chips EV</strong>
        <small>Conditional showdown branch</small>
      </div>
      <div className="metric-grid">
        <Metric
          label="Combined bet EV"
          value={signed(result.ev)}
          hint="chips relative to not investing"
          accent
        />
        <Metric
          label="Pure-bluff break-even"
          value={percent(result.bluffThreshold)}
          hint="fold frequency needed if equity = 0"
        />
      </div>
    </LabFrame>
  )
}

function VolatilityCurve({ volatility }: { volatility: number }) {
  const points = Array.from({ length: 37 }, (_, i) => {
    const vol = 0.1 + i * 0.025
    return `${36 + i * 9},${155 - blackScholesCall(100, 100, 1, 0.05, vol) * 3}`
  }).join(' ')
  const x = 36 + ((volatility - 10) / 90) * 324
  const y = 155 - blackScholesCall(100, 100, 1, 0.05, volatility / 100) * 3
  return (
    <svg
      viewBox="0 0 400 195"
      className="vol-chart"
      role="img"
      aria-label="Black–Scholes call premium rises as annualized volatility increases from 10% to 100%, holding other inputs fixed"
    >
      <path d="M36 20V155H370" fill="none" stroke="#cbd8d2" />
      <path d="M36 65H370M36 110H370" stroke="#e4eae5" strokeDasharray="3 5" />
      <polyline points={points} stroke="#1c7663" strokeWidth="3" fill="none" />
      <circle
        cx={x}
        cy={y}
        r="6"
        fill="#e9a477"
        stroke="white"
        strokeWidth="3"
      />
      <text x="10" y="19">
        Price
      </text>
      <text x="28" y="177">
        10%
      </text>
      <text x="340" y="177">
        100%
      </text>
      <text x="135" y="190">
        Annualized volatility
      </text>
    </svg>
  )
}

function VarianceLab() {
  const [win, setWin] = useState(55)
  const [hands, setHands] = useState(100)
  const [volatility, setVolatility] = useState(25)
  const result = binaryRisk(win / 100, 100, 100, hands)
  const premium = blackScholesCall(100, 100, 1, 0.05, volatility / 100)
  const implied = impliedVolatility(premium, 100, 100, 1, 0.05)
  return (
    <LabFrame
      title="Price the uncertainty, not just the average"
      description="Compare poker payoff dispersion with model-implied option volatility."
      assumption="Poker: independent identical outcomes of +100 or −100 chips. Options: Black–Scholes European call, spot = strike = 100, one year, no dividends, continuously compounded annual rate 5%. Premiums are synthetic, not live market data."
      controls={
        <>
          <Slider
            label="Poker win probability"
            value={win}
            min={0}
            max={100}
            suffix="%"
            onChange={setWin}
          />
          <Slider
            label="Independent hands"
            value={hands}
            min={10}
            max={1000}
            step={10}
            onChange={setHands}
          />
          <div className="control-divider">Separate options model</div>
          <Slider
            label="Synthetic market volatility"
            value={volatility}
            min={10}
            max={100}
            suffix="%"
            onChange={setVolatility}
          />
          <p className="control-note">
            We generate a premium, then solve backward for its implied
            volatility. There is no conversion from chips to return volatility.
          </p>
        </>
      }
    >
      <div className="metric-grid">
        <Metric
          label="Total expected poker profit"
          value={signed(result.totalMean)}
          hint={`${hands} hands · chips`}
        />
        <Metric
          label="Total poker standard deviation"
          value={number(result.totalSD)}
          hint={`per hand SD: ${number(result.sd)} chips`}
        />
      </div>
      <VolatilityCurve volatility={volatility} />
      <div className="metric-grid">
        <Metric label="Synthetic call premium" value={number(premium)} />
        <Metric
          label="Recovered implied volatility"
          value={percent(implied)}
          accent
        />
      </div>
    </LabFrame>
  )
}

function RiskLab() {
  const [equity, setEquity] = useState(55)
  const [amountAtRisk, setAmountAtRisk] = useState(100)
  const [profitOnWin, setProfitOnWin] = useState(100)
  const [fee, setFee] = useState(1)
  const [bankroll, setBankroll] = useState(1000)
  const [kellyScale, setKellyScale] = useState(50)
  const [horizon, setHorizon] = useState(100)
  const [ruinFloor, setRuinFloor] = useState(25)
  const settlement = allInCashout(
    equity / 100,
    amountAtRisk,
    profitOnWin,
    fee / 100,
  )
  const bankrollModel = useMemo(
    () =>
      bankrollRisk({
        bankroll,
        equity: equity / 100,
        amountAtRisk,
        profitOnWin,
        kellyScale: kellyScale / 100,
        horizon,
        ruinFloor: ruinFloor / 100,
      }),
    [
      amountAtRisk,
      bankroll,
      equity,
      horizon,
      kellyScale,
      profitOnWin,
      ruinFloor,
    ],
  )
  return (
    <LabFrame
      title="The all-in risk desk"
      description="Compare settlement choices, size a repeated edge, and inspect a finite-horizon drawdown distribution."
      assumption="One binary win/loss payoff with known physical equity; no ties, rake, taxes, liquidity constraints, or later decisions. Two runouts are equal-sized and independent. Kelly bets repeat the same odds and edge, resize after every result, and define ruin as ever touching the selected fraction of starting bankroll within the horizon. Cashout has no counterparty failure; this is not a CDS price."
      controls={
        <>
          <Slider
            label="Showdown equity"
            value={equity}
            min={1}
            max={99}
            suffix="%"
            onChange={setEquity}
          />
          <Slider
            label="Chips at risk"
            value={amountAtRisk}
            min={10}
            max={500}
            step={10}
            onChange={setAmountAtRisk}
          />
          <Slider
            label="Profit on a win"
            value={profitOnWin}
            min={10}
            max={1000}
            step={10}
            onChange={setProfitOnWin}
          />
          <Slider
            label="Cashout fee"
            value={fee}
            min={0}
            max={5}
            step={0.25}
            suffix="%"
            onChange={setFee}
          />
          <div className="control-divider">Repeated-bankroll model</div>
          <Slider
            label="Starting bankroll"
            value={bankroll}
            min={500}
            max={10000}
            step={100}
            onChange={setBankroll}
          />
          <Slider
            label="Fraction of full Kelly"
            value={kellyScale}
            min={0}
            max={100}
            step={5}
            suffix="%"
            onChange={setKellyScale}
          />
          <Slider
            label="Repeated bets"
            value={horizon}
            min={10}
            max={300}
            step={10}
            onChange={setHorizon}
          />
          <Slider
            label="Ruin drawdown floor"
            value={ruinFloor}
            min={10}
            max={80}
            step={5}
            suffix="%"
            onChange={setRuinFloor}
          />
        </>
      }
    >
      <div className="metric-grid">
        <Metric
          label="Play it once · EV"
          value={signed(settlement.showdownEV)}
          hint={`SD ${number(settlement.runOnceDeviation)}`}
        />
        <Metric
          label="Run it twice · EV"
          value={signed(settlement.showdownEV)}
          hint={`SD ${number(settlement.runTwiceDeviation)} · independent boards`}
        />
        <Metric
          label="Take cashout · EV"
          value={signed(settlement.cashoutEV)}
          hint={`guaranteed net · fee ${number(settlement.fee)}`}
          accent
        />
        <Metric
          label="Cashout payment"
          value={number(settlement.cashoutPayout)}
          hint={`fair gross ${number(settlement.fairPayout)}`}
        />
      </div>
      <div className="lab-callout">
        <strong>Insurance / CDS lens</strong>
        <p>
          Cashing out sells the whole pot claim, including its upside. Loss-only
          insurance instead pays on a losing runout while you retain the hand:
          covering {amountAtRisk} chips has a fair one-period premium of{' '}
          {number((1 - equity / 100) * amountAtRisk)} chips. That contingent
          payment is the closer CDS analogy. A real CDS also needs a reference
          entity, recovery, default timing, spreads, discounting, collateral,
          and counterparty credit—not modeled here.
        </p>
      </div>
      <div className="metric-grid">
        <Metric
          label="Full Kelly fraction"
          value={percent(bankrollModel.fullKelly)}
          hint={`scaled stake ${number(bankrollModel.stake)} chips`}
        />
        <Metric
          label={`${horizon}-bet ruin probability`}
          value={percent(bankrollModel.ruinProbability)}
          hint={`ever at or below ${ruinFloor}% of start`}
          accent
        />
        <Metric
          label="5th-percentile bankroll"
          value={number(bankrollModel.fifthPercentile)}
          hint="downside swing"
        />
        <Metric
          label="Median bankroll"
          value={number(bankrollModel.median)}
          hint="50th percentile"
        />
        <Metric
          label="95th-percentile bankroll"
          value={number(bankrollModel.ninetyFifthPercentile)}
          hint="upside swing"
        />
        <Metric
          label="Expected final bankroll"
          value={number(bankrollModel.expectedBankroll)}
          hint={`final SD ${number(bankrollModel.finalDeviation)}`}
        />
      </div>
      <p className="control-note">
        The current all-in risks {percent(amountAtRisk / bankroll)} of the
        starting bankroll; scaled Kelly allocates{' '}
        {percent(bankrollModel.fraction)}. Kelly maximizes model log growth, not
        survival probability, and uncertain equity can make its recommendation
        dangerously precise.
      </p>
    </LabFrame>
  )
}

export function Lab({ id }: { id: LabId }) {
  const [revision, setRevision] = useState(0)
  const labs: Record<LabId, ReactNode> = {
    odds: <OddsLab />,
    outs: <OutsLab />,
    equity: <EquityLab />,
    pricing: <PricingLab />,
    fold: <FoldLab />,
    variance: <VarianceLab />,
    replication: <PricingLab replication />,
    risk: <RiskLab />,
  }
  return (
    <div className="lab-wrapper">
      <button
        className="reset-lab text-button"
        onClick={() => setRevision((value) => value + 1)}
      >
        <RotateCcw size={13} /> Reset inputs
      </button>
      <div key={`${id}-${revision}`}>{labs[id]}</div>
    </div>
  )
}
