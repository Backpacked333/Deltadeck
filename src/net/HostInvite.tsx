// The host's half of the waiting room (ADR amendment 2026-10-12, "Live
// games"): the game code, to read out or send, and the people who asked to
// join from the open games list, each with Accept and Decline. Everything
// shown is the table's last `invite` frame; the page decides nothing. The
// link and its copy button stay in LiveTable's WaitingRoom, as they were.
import { useEffect, useRef, useState } from 'react'
import { Check, Copy, Share2 } from 'lucide-react'
import { formatCode } from '../shared/gameCode'
import { joinCodeLink } from './api'
import type { InviteState } from './client'
import { REQUEST_WAIT_MS } from './GameList'
import { wasUnlisted } from './gameText'
import { useNow } from './useNow'

/**
 * A reservation (RESERVE_MS in worker/src/lobby.ts): after Accept, the seat
 * waits this long for the one accepted. Counted here from the frame that
 * first named them, since the frame carries no age for it.
 */
export const RESERVE_WAIT_MS = 60_000

export function HostInvite({
  invite,
  answer,
  open,
  matchId,
}: {
  invite: InviteState | null
  answer: (requestId: string, accept: boolean) => boolean
  /** The table socket is open: answers can be sent. */
  open: boolean
  /** The table's id, to know whether the host asked to be listed. */
  matchId?: string
}) {
  // Read once: the host's wish does not change while the page is here.
  const [asked] = useState(() => (matchId ? wasUnlisted(matchId) : false))
  if (!invite) return null
  return (
    <>
      {asked && !invite.listed && (
        <p className="live-muted">
          This game is not listed in open games, so nobody will ask to join.
          Your code and link still work: share them.
        </p>
      )}
      <GameCode code={invite.code} listed={invite.listed} />
      <JoinRequests invite={invite} answer={answer} open={open} />
    </>
  )
}

function GameCode({ code, listed }: { code: string | null; listed: boolean }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    if (!code) return
    try {
      await navigator.clipboard.writeText(formatCode(code))
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }
  // Only where the device has a share sheet (phones, some desktops).
  const canShare = typeof navigator.share === 'function'
  const share = async () => {
    if (!code) return
    try {
      await navigator.share({
        title: 'Play heads-up poker with me',
        text: `Code ${formatCode(code)}`,
        url: joinCodeLink(code),
      })
    } catch {
      // Closing the sheet is an AbortError, and nothing to say about it; a
      // device that cannot share still has the code and the link above.
    }
  }
  if (!code)
    return <p className="live-muted">Code expired, your link still works.</p>
  return (
    <div className="live-code" role="group" aria-labelledby="game-code-label">
      <span id="game-code-label" className="live-muted">
        Game code
      </span>
      {/* Seen as XXX-XXX; heard character by character. */}
      <span className="live-code-text" aria-hidden>
        {formatCode(code)}
      </span>
      <span className="sr-only">{code.split('').join(' ')}</span>
      <div className="live-row live-row-tight">
        <button className="btn btn-outline" onClick={() => void copy()}>
          {copied ? <Check size={16} /> : <Copy size={16} />}
          Copy code
        </button>
        {canShare && (
          <button className="btn btn-outline" onClick={() => void share()}>
            <Share2 size={16} />
            Share
          </button>
        )}
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        {copied ? 'Code copied' : ''}
      </p>
      {copied && <span className="live-muted">Code copied</span>}
      {listed && <p className="live-muted">Listed in open games.</p>}
    </div>
  )
}

function JoinRequests({
  invite,
  answer,
  open,
}: {
  invite: InviteState
  answer: (requestId: string, accept: boolean) => boolean
  open: boolean
}) {
  const { requests, reservedFor, answering } = invite
  // The ages only grow: a request older than the table keeps it is gone
  // there, and no frame says so.
  const waiting = requests.length > 0 || reservedFor !== null
  const now = useNow(waiting ? 1000 : 60_000)
  const live = requests.filter(
    (r) => r.ageMs + (now - invite.at) < REQUEST_WAIT_MS,
  )
  useRequestAlert(live.map((r) => r.id))

  // Which button was pressed, for the word on it ("Accepting…").
  const [pressed, setPressed] = useState<{
    id: string
    accept: boolean
  } | null>(null)
  useEffect(() => {
    if (!answering) setPressed(null)
  }, [answering])
  const title = useRef<HTMLHeadingElement>(null)
  const press = (id: string, accept: boolean) => {
    if (!answer(id, accept)) return
    setPressed({ id, accept })
    // The pressed button is about to be disabled and its row to go: focus
    // moves to the section, where the next row or the outcome is read on.
    title.current?.focus()
  }
  // Heard once, from a region that was there before the words: the label
  // of a button is its name, and does not change with "Accepting…".
  const pending = pressed
    ? `${pressed.accept ? 'Accepting' : 'Declining'} ${
        requests.find((r) => r.id === pressed.id)?.username ?? ''
      }…`
    : ''

  // A reservation that ran out: the seat is open again, and the host is told
  // who did not come.
  const holding =
    reservedFor !== null &&
    invite.reservedAt !== null &&
    now - invite.reservedAt < RESERVE_WAIT_MS
  const [missed, setMissed] = useState<string | null>(null)
  const before = useRef<string | null>(null)
  useEffect(() => {
    if (reservedFor !== null) setMissed(holding ? null : reservedFor)
    // Held a moment ago, not now, and still here: they did not come.
    else if (before.current !== null) setMissed(before.current)
    before.current = reservedFor
  }, [reservedFor, holding])

  const outcome = holding
    ? `${reservedFor} is joining…`
    : missed
      ? `${missed} didn't arrive. Your game is open again.`
      : ''

  return (
    <section className="live-requests" aria-labelledby="requests-title">
      <h3 id="requests-title" ref={title} tabIndex={-1}>
        Join requests
      </h3>
      <p className="sr-only" role="status">
        {pending}
      </p>
      {/* One region for the outcome, there before the words are. */}
      <p role="status" className={outcome ? undefined : 'sr-only'}>
        {outcome}
      </p>
      {holding ? null : (
        <>
          <ul aria-live="polite" className="live-request-list">
            {live.map((r) => (
              <li key={r.id}>
                <span
                  className="live-req-text"
                  title={`${r.username} wants to join`}
                >
                  {`${r.username} wants to join`}
                </span>
                <span className="live-req-age" aria-hidden>
                  <i
                    style={{
                      animationDelay: `-${r.ageMs + (now - invite.at)}ms`,
                    }}
                  />
                </span>
                <span className="live-req-buttons">
                  <button
                    className="btn btn-primary"
                    aria-label={`Accept ${r.username}`}
                    disabled={!open || answering !== null}
                    onClick={() => press(r.id, true)}
                  >
                    {pressed?.id === r.id && pressed.accept
                      ? 'Accepting…'
                      : 'Accept'}
                  </button>
                  <button
                    className="btn btn-outline"
                    aria-label={`Decline ${r.username}`}
                    disabled={!open || answering !== null}
                    onClick={() => press(r.id, false)}
                  >
                    {pressed?.id === r.id && !pressed.accept
                      ? 'Declining…'
                      : 'Decline'}
                  </button>
                </span>
              </li>
            ))}
          </ul>
          {live.length === 0 && (
            <p className="live-muted">
              No requests yet. Anyone with your code or link joins instantly.
            </p>
          )}
        </>
      )}
    </section>
  )
}

/**
 * A request that arrives while this tab is out of sight: the tab title
 * carries the count, and a phone buzzes. Both end when the tab is seen.
 */
function useRequestAlert(ids: string[]) {
  const seen = useRef(new Set<string>())
  const base = useRef<string | null>(null)
  const restore = () => {
    if (base.current !== null) document.title = base.current
    base.current = null
  }
  const key = ids.join(',')
  useEffect(() => {
    const fresh = ids.filter((id) => !seen.current.has(id))
    for (const id of ids) seen.current.add(id)
    if (!fresh.length || document.visibilityState === 'visible') return
    base.current ??= document.title
    document.title = `(${ids.length}) ${base.current}`
    if (typeof navigator.vibrate === 'function') navigator.vibrate(30)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is `ids`
  }, [key])
  useEffect(() => {
    const seenAgain = () => {
      if (document.visibilityState === 'visible') restore()
    }
    document.addEventListener('visibilitychange', seenAgain)
    return () => {
      document.removeEventListener('visibilitychange', seenAgain)
      restore()
    }
  }, [])
}
