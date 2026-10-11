// After sign-up from the landing page (L-7, L-8, O-4): the challenge score
// is attached to the new account, then two short steps. The username step
// comes first, in AuthGate (a placeholder name always asks for one), so a
// reload resumes wherever the account stands: nothing here is stored.
//
//   2. School: the badge the database set from a confirmed school email.
//   3. First move: a rated match, the challenge again, or the curriculum.
import { useEffect, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  BookOpen,
  Check,
  GraduationCap,
  RotateCcw,
  Spade,
  Swords,
} from 'lucide-react'
import { takeAuthReturn } from '../lib/authReturn'
import { track } from '../lib/track'
import type { Identity } from './api'
import { claimPendingScore } from './claim'
import { SchoolEmail } from './SchoolEmail'
import type { Claimed } from './claim'

type School = { school: string | null; domain: string | null }

async function loadSchool(
  client: SupabaseClient,
  userId: string,
): Promise<School> {
  const { data, error } = await client
    .from('players')
    .select('school, school_domain')
    .eq('user_id', userId)
    .maybeSingle()
  if (error || !data) return { school: null, domain: null }
  return { school: data.school ?? null, domain: data.school_domain ?? null }
}

export function Onboarding({
  identity,
  client,
}: {
  identity: Identity
  client: SupabaseClient | null
}) {
  const [claimed, setClaimed] = useState<Claimed | undefined>(undefined)
  const [school, setSchool] = useState<School | null>(null)
  const [step, setStep] = useState<'school' | 'move'>('school')
  const { getToken, player } = identity

  useEffect(() => {
    track('signup_complete')
    let live = true
    void claimPendingScore(getToken).then((c) => live && setClaimed(c))
    return () => {
      live = false
    }
  }, [getToken])

  useEffect(() => {
    if (!client) {
      setSchool({ school: null, domain: null })
      return
    }
    let live = true
    void loadSchool(client, player.userId).then((s) => live && setSchool(s))
    return () => {
      live = false
    }
  }, [client, player.userId])

  const move = (event: 'rated' | 'practice' | 'learn', hash: string) => {
    track(
      event === 'rated'
        ? 'first_move_rated'
        : event === 'practice'
          ? 'first_move_practice'
          : 'first_move_learn',
    )
    window.location.hash = hash
  }

  return (
    <section className="panel onboard" aria-labelledby="onboard-title">
      <p className="onboard-step" aria-live="polite">
        Step {step === 'school' ? 2 : 3} of 3
      </p>
      <h2 id="onboard-title">
        {step === 'school' ? `Welcome, ${player.username}` : 'Your first move'}
      </h2>

      {claimed && (
        <p className="onboard-score" role="status">
          <Check size={16} />
          {claimed.saved
            ? `Your challenge score of ${claimed.claim.accuracy} is saved to your account.`
            : `Your challenge score of ${claimed.claim.accuracy} is kept on this device; we will save it to your account next time.`}
        </p>
      )}

      {step === 'school' ? (
        <>
          {school === null ? (
            <p className="live-status" role="status">
              Checking your school…
            </p>
          ) : school.school ? (
            <p className="onboard-badge">
              <GraduationCap size={18} /> You're playing for{' '}
              <strong>{school.school}</strong>. Your badge shows on your profile
              and on the ladder.
            </p>
          ) : (
            <SchoolEmail
              getToken={getToken}
              onVerified={(name) => setSchool({ school: name, domain: null })}
            />
          )}
          <button
            className={`btn btn-lg ${school?.school ? 'btn-primary' : 'btn-quiet'}`}
            onClick={() => setStep('move')}
          >
            {school?.school ? 'Continue' : 'Skip for now'}
          </button>
        </>
      ) : (
        <div className="onboard-moves">
          <button
            className="onboard-move"
            onClick={() => move('rated', '#lobby')}
          >
            <Swords size={18} />
            <strong>Play a rated match</strong>
            <span>
              Forty hands against a real player near your level. Needs a
              confirmed email.
            </span>
          </button>
          <button
            className="onboard-move"
            onClick={() => move('practice', takeAuthReturn() ?? '#table')}
          >
            <Spade size={18} />
            <strong>Practice against Atlas</strong>
            <span>
              Shuffled hands, every decision graded, your history saved.
            </span>
          </button>
          <button
            className="onboard-move"
            onClick={() => move('practice', '#start')}
          >
            <RotateCcw size={18} />
            <strong>Beat your score</strong>
            <span>Another challenge hand against Atlas.</span>
          </button>
          <button
            className="onboard-move"
            onClick={() => move('learn', '#learn/path')}
          >
            <BookOpen size={18} />
            <strong>Learn the math</strong>
            <span>
              Expected value, pot odds and ranges, one lesson at a time.
            </span>
          </button>
        </div>
      )}
    </section>
  )
}
