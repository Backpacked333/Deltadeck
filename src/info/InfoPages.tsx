// Fair play, terms and the rating method (#fair-play, #terms, #method). A
// lazy chunk: nothing here loads with the trainer. The copy says what
// exists today and what does not; it must change when the platform does.
import { REPORT_CONTACT } from './contact'
import { Method } from './Method'
import { Section } from './Section'
import './info.css'

export type InfoPageId = 'fair-play' | 'terms' | 'method'

export default function InfoPage({ page }: { page: InfoPageId }) {
  return page === 'terms' ? (
    <Terms />
  ) : page === 'method' ? (
    <Method />
  ) : (
    <FairPlay />
  )
}

function Report() {
  return REPORT_CONTACT ? (
    <>
      send them to <a href={`mailto:${REPORT_CONTACT}`}>{REPORT_CONTACT}</a>
    </>
  ) : (
    <>keep them for the report form that comes with rated play</>
  )
}

function FairPlay() {
  return (
    <article className="page info-page">
      <header className="page-head">
        <h1>Fair play</h1>
        <p>
          What online play guarantees today, what it does not check yet, and how
          to report a problem. Casual heads-up, play money.
        </p>
      </header>

      <Section id="fp-today" title="What we guarantee today">
        <ul>
          <li>
            <b>The server owns the cards.</b> Every deck is shuffled on the
            server with a cryptographic random generator. Your browser receives
            your own two cards, the board, and cards shown at showdown, never
            your opponent's hidden cards or the deck.
          </li>
          <li>
            <b>The lab is never on at the live table.</b> No equity, ranges or
            expected values are computed or sent while a hand is played. The
            review comes after the hand.
          </li>
          <li>
            <b>Every deck is committed before the first card.</b> Your browser
            receives a fingerprint of all 52 cards in dealing order before the
            deal. After the hand the server opens the board, the shown hands and
            your own two cards, folded or not, and your browser checks each
            against that fingerprint ("Deck verified" in the hand review). That
            proves no card was changed after the deal. It does not prove the
            shuffle was fair: a biased shuffle could be committed honestly. The
            server also replays every recorded hand from its full deck to check
            the chips and the result.
          </li>
          <li>
            <b>Abandoning is counted.</b> Not opening a paired table within 30
            seconds, or missing three decisions in a row, ends the match and is
            recorded against that account. With rated play, abandoning will
            count against ladder eligibility.
          </li>
          <li>
            <b>One table at a time per account,</b> and quick match pairs the
            same two accounts at most twice a day.
          </li>
        </ul>
      </Section>

      <Section id="fp-not-yet" title="Not detected yet">
        <ul>
          <li>
            <b>Collusion:</b> two players working together against others.
          </li>
          <li>
            <b>Real-time assistance:</b> a solver, a bot or another person
            helping during a hand.
          </li>
          <li>
            <b>More than one account</b> per person.
          </li>
        </ul>
        <p>
          Every action, its timing and every hand are recorded, so these checks
          can be applied to past play when they are built. We would rather say
          so than claim to catch what we do not.
        </p>
      </Section>

      <Section id="fp-report" title="How to report">
        <p>
          Note the match link (the table's address, ending in{' '}
          <code>#play/…</code>) and the hand number from the hand review, and{' '}
          <Report />. A person reads every report. There are no automatic bans.
          With rated play, confirmed cheating means a rating reset and removal
          from the ladder, decided by a person, with one appeal.
        </p>
      </Section>

      <p className="info-links">
        <a href="#terms">Terms of play</a> · <a href="#lobby">Play online</a>
      </p>
    </article>
  )
}

function Terms() {
  return (
    <article className="page info-page">
      <header className="page-head">
        <h1>Terms of play</h1>
        <p>The rules for playing other people on QuantPoker.</p>
      </header>

      <Section id="t-money" title="Play money only">
        <p>
          Play money only. Chips have no cash value. There are no prizes, no
          deposits, no withdrawals and nothing to buy. QuantPoker teaches
          decisions under uncertainty; nothing here is financial or investment
          advice.
        </p>
      </Section>

      <Section id="t-age" title="Who can play">
        <p>
          You must be 18 or older. One account per person. Your username is
          public; your email address is not.
        </p>
      </Section>

      <Section id="t-history" title="Hand histories are public and permanent">
        <p>
          Every hand you play online is recorded and published: the actions with
          their decision times (how long each took), the board, cards shown at
          showdown, the result and both usernames. These records are public and
          permanent. Your folded cards are never published; only you can see
          them.
        </p>
      </Section>

      <Section id="t-practice" title="Your practice data">
        <p>
          While you are signed in, your practice hands against Atlas, your
          trainer settings and your lesson progress are saved to your account,
          so they follow you between devices. They are private: only you can
          read them. Signing out removes them from that browser; deleting your
          account deletes them.
        </p>
      </Section>

      <Section id="t-fair" title="Fair play">
        <p>
          Play your own hands: no help from software or people during a hand, no
          collusion, no second account. Accounts that break these rules can be
          removed. <a href="#fair-play">Fair play</a> says what is checked today
          and how to report a problem.
        </p>
      </Section>

      <Section id="t-service" title="The service">
        <p>
          Accounts and hand records are stored with Supabase in the United
          States (us-east-1); the game runs on Cloudflare. The service is
          provided as it is and may change or stop. If the server ever finds a
          hand that breaks the rules of poker, it stops the match rather than
          pay out a wrong result.
        </p>
      </Section>
    </article>
  )
}
