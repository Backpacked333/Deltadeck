// Fair play, terms, privacy and the rating method (#fair-play, #terms,
// #privacy, #method). A lazy chunk: nothing here loads with the trainer. The
// copy says what exists today and what does not; it must change when the
// platform does.
import { SUPPORT_EMAIL } from './contact'
import { Method } from './Method'
import { Section } from './Section'
import './info.css'

export type InfoPageId = 'fair-play' | 'terms' | 'privacy' | 'method'

export default function InfoPage({ page }: { page: InfoPageId }) {
  return page === 'terms' ? (
    <Terms />
  ) : page === 'privacy' ? (
    <Privacy />
  ) : page === 'method' ? (
    <Method />
  ) : (
    <FairPlay />
  )
}

function Support() {
  return <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
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
          <code>#play/…</code>) and the hand number from the hand review, and
          send them to <Support />. A person reads every report. There are no
          automatic bans. With rated play, confirmed cheating means a rating
          reset and removal from the ladder, decided by a person, with one
          appeal.
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
        <p>The rules for playing other people on DeltaDeck.</p>
      </header>

      <Section id="t-money" title="Play money only">
        <p>
          Play money only. Chips have no cash value. There are no prizes, no
          deposits, no withdrawals and nothing to buy. DeltaDeck teaches
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
          account deletes them. <a href="#privacy">Privacy</a> lists everything
          we keep.
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

function Privacy() {
  return (
    <article className="page info-page">
      <header className="page-head">
        <h1>Privacy</h1>
        <p>
          What DeltaDeck keeps about you, where it is kept, who can see it, and
          how to have it deleted. No advertising, no tracking by third parties,
          and nothing is sold.
        </p>
      </header>

      <Section id="p-collect" title="What we keep">
        <ul>
          <li>
            <b>Your account:</b> your email address and your username. A
            password is stored only as a hash. If you sign in with Google, the
            account also keeps what Google sends (your name, email address and
            profile picture); DeltaDeck uses only the email address.
          </li>
          <li>
            <b>Your school,</b> if you add one: the school's name and web
            domain. A school email you confirm with a code is kept only until
            the code is used or expires, never with your account.
          </li>
          <li>
            <b>Your profile picture,</b> if you add one: a small square copy
            your browser makes of the photo you choose, stored with Supabase and
            public. Removing it deletes it. If someone reports it, we keep who
            reported it and when.
          </li>
          <li>
            <b>Your practice:</b> hands against Atlas, trainer settings and
            lesson progress, while you are signed in.
          </li>
          <li>
            <b>Online play:</b> every hand you play, with its actions, decision
            times and result, and your rating.
          </li>
          <li>
            <b>Challenge scores</b> from the hand on the home page (saved to
            your account if you claim them), and a daily count of page events
            (such as "challenge finished") under a random id your browser makes
            up. No event carries your name, email or cards.
          </li>
          <li>
            <b>Server logs</b> that name accounts and matches by id, never cards
            or passwords. Cloudflare, which serves the site, sees your IP
            address and counts requests per address to stop abuse; DeltaDeck
            does not keep it with your account.
          </li>
        </ul>
        <p>
          Your browser keeps your sign-in and a copy of your practice in its own
          storage on your device.
        </p>
      </Section>

      <Section id="p-where" title="Where it is kept">
        <ul>
          <li>
            <b>Supabase,</b> in the United States (us-east-1): accounts, profile
            pictures, hands, practice, ratings and claimed scores.
          </li>
          <li>
            <b>Cloudflare:</b> runs the site and the tables, and keeps challenge
            scores, page event counts and logs.
          </li>
          <li>
            <b>Resend:</b> sends the codes we email you.
          </li>
          <li>
            <b>Google,</b> only if you sign in with Google.
          </li>
        </ul>
      </Section>

      <Section id="p-who" title="Who can see it">
        <p>
          Everyone can see your username, your profile picture, your school
          badge, your rating and the online hands you play (your folded cards
          never; see <a href="#terms">Terms</a>). Only you can see your email
          address, your practice and your lesson progress. The people who run
          DeltaDeck can read the database to keep it working and to look into
          fair-play reports.
        </p>
      </Section>

      <Section id="p-delete" title="Deleting your account">
        <p>
          Write to <Support /> from the email address on your account, and we
          delete your account, your practice and your lessons within 30 days.
          Online hands already played stay in the public record, as the Terms
          say. Signing out removes your practice from that browser at any time.
        </p>
      </Section>

      <p className="info-links">
        <a href="#terms">Terms of play</a> · <a href="#fair-play">Fair play</a>
      </p>
    </article>
  )
}
