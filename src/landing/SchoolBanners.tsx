// "Represent your school": the twenty schools as campus banners (a brass rod,
// cloth in the school's colours with a swallowtail hem, the school's mark on
// a cream plate) drifting across the page in two rows, one each way. Each row
// is drawn twice for a seamless loop; the copy is hidden from screen readers.
// Rows pause on hover and focus, and stand still with reduced motion.
import type { CSSProperties } from 'react'
import { ArrowRight } from 'lucide-react'
import { useReveal } from './motion'
import { SCHOOLS } from './schools'
import type { School } from './schools'

const ROWS = [SCHOOLS.slice(0, 10), SCHOOLS.slice(10)]

function Banner({ school }: { school: School }) {
  const colours = {
    '--cloth': school.cloth,
    '--trim': school.trim,
    '--ink': school.ink,
  } as CSSProperties
  return (
    <li className="school-banner" style={colours}>
      <div className="school-cloth">
        <span className="school-plate">
          <img
            src={`/schools/${school.id}.webp`}
            alt=""
            loading="lazy"
            decoding="async"
          />
        </span>
        <span className="school-name">{school.name}</span>
      </div>
    </li>
  )
}

export function SchoolBanners({
  signedIn,
  onJoin,
}: {
  signedIn: boolean
  onJoin: () => void
}) {
  const head = useReveal<HTMLDivElement>()
  return (
    <section className="landing-schools" aria-labelledby="schools-title">
      <div className="landing-schools-head reveal" ref={head}>
        <p className="landing-kicker">School badges</p>
        <h2 id="schools-title">Represent your school</h2>
        <p>
          Sign up with your school email and your school's badge sits next to
          your name on the ladder and your profile. Badges for students at more
          than 50 schools, including these.
        </p>
        {!signedIn && (
          <button className="btn btn-accent btn-lg" onClick={onJoin}>
            Claim your school's badge <ArrowRight size={16} />
          </button>
        )}
      </div>
      <div className="schools-rows">
        {ROWS.map((row, r) => (
          <div className={`schools-row ${r ? 'is-reverse' : ''}`} key={r}>
            <ul className="schools-track" aria-label={`Schools, ${r + 1} of 2`}>
              {row.map((school) => (
                <Banner school={school} key={school.id} />
              ))}
            </ul>
            <ul className="schools-track" aria-hidden>
              {row.map((school) => (
                <Banner school={school} key={school.id} />
              ))}
            </ul>
          </div>
        ))}
      </div>
      <p className="schools-fine">
        School names and logos are trademarks of their institutions, shown to
        say which schools' emails earn a badge. DeltaDeck is not affiliated
        with, sponsored or endorsed by any of them.
      </p>
    </section>
  )
}
