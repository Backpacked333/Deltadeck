import type { HandCompletionV1 } from '../shared/protocol'
import type { TableState } from './client'
import { Cards } from './ReviewLive'
import { useEffect, useState } from 'react'

const labels = {
  stand: 'Stand',
  rebuy: 'Rebuy',
  sit_out: 'Sit out',
  sit_in: 'Sit in',
}

export function CommandStatus({
  state,
  retry,
  check,
}: {
  state: TableState
  retry: () => boolean
  check: () => boolean
}) {
  const command = state.command
  const pending = state.ownControl?.pendingIntent
  const text = command
    ? `${labels[command.envelope.kind]}: ${
        command.phase === 'sending'
          ? 'request sent — awaiting acceptance.'
          : command.phase === 'unknown'
            ? 'outcome unknown. Checking the table; do not assume it happened.'
            : command.phase === 'accepted-pending-effect'
              ? 'accepted — takes effect after this hand.'
              : command.phase === 'completed'
                ? 'completed.'
                : command.phase === 'stale'
                  ? 'not retried: the hand or seat changed. Check the current table before requesting again.'
                  : `rejected (${command.reason?.replaceAll('_', ' ')}). No effect confirmed.`
      }`
    : pending
      ? `${labels[pending.kind]}: accepted — takes effect after this hand.`
      : null
  return (
    <div className="live-trust" role="status" aria-live="polite">
      {state.resyncing && (
        <span>Resyncing — waiting for the current table. </span>
      )}
      {state.pending && state.resyncing && (
        <span>Move outcome unknown — confirming the current decision. </span>
      )}
      {text && <span>{text}</span>}
      {command?.phase === 'unknown' && command.retryable && (
        <button className="btn btn-outline" onClick={retry}>
          Retry same request
        </button>
      )}
      {command?.phase === 'unknown' && !command.retryable && (
        <button
          className="btn btn-outline"
          disabled={state.status !== 'open' || state.resyncing}
          onClick={check}
        >
          Check outcome
        </button>
      )}
    </div>
  )
}

export function LastHand({
  completion,
}: {
  completion: HandCompletionV1 | null
}) {
  if (!completion) return null
  return (
    <details className="live-last-hand">
      <summary>
        Last hand · {completion.hand.handNo} ·{' '}
        {completion.final.showdown ? 'Showdown' : 'Won without showdown'}
      </summary>
      <div className="live-row">
        <Cards ids={completion.final.board} />
        <ul>
          {completion.final.participants.map((p) => {
            const net = completion.final.netBySeat[p.seat] ?? 0
            return (
              <li key={`${p.seat}:${p.seatGeneration}`}>
                {p.username}: {net > 0 ? '+' : ''}
                {net} chips
              </li>
            )
          })}
        </ul>
      </div>
    </details>
  )
}

export function StartStatus({
  state,
  cancel,
}: {
  state: TableState
  cancel: () => boolean
}) {
  const [now, setNow] = useState(() => performance.now())
  const deadline = state.start?.deadlineAt
  const serverNow = state.presentation?.serverNow
  const receivedAt = state.frameTiming?.at
  useEffect(() => {
    if (!deadline) return
    const timer = window.setInterval(() => setNow(performance.now()), 250)
    return () => window.clearInterval(timer)
  }, [deadline])
  const remaining =
    deadline !== undefined &&
    serverNow !== undefined &&
    receivedAt !== undefined
      ? Math.max(0, deadline - serverNow - Math.max(0, now - receivedAt))
      : null
  const phase = state.cancellation?.phase
  if (phase === 'cancelled')
    return (
      <p role="status">
        Start cancelled by the table. <a href="#lobby">Back to the lobby</a>
      </p>
    )
  if (phase === 'game_started')
    return <p role="status">The deal won the race — the game has started.</p>
  if (state.view || !state.start)
    return phase === 'unknown' ? (
      <p role="status">
        Cancellation outcome unknown. Reconnecting to confirm.
      </p>
    ) : null
  return (
    <div className="live-trust" role="status">
      <span>
        {phase === 'sending'
          ? 'Cancel sent — awaiting confirmation.'
          : phase === 'unknown'
            ? 'Cancellation outcome unknown. Check or retry the same request.'
            : phase === 'stale'
              ? 'This start is no longer current.'
              : state.start.waitingForHost
                ? 'Waiting for host — your seat is reserved.'
                : 'Reservation confirmed — waiting for the first deal.'}
      </span>
      {remaining !== null && (
        <span>
          {remaining > 0
            ? `Host deadline: ${Math.ceil(remaining / 1000)}s`
            : 'Host deadline reached — awaiting the table’s decision.'}
        </span>
      )}
      <button
        className="btn btn-outline"
        disabled={
          state.status !== 'open' ||
          state.resyncing ||
          phase === 'sending' ||
          phase === 'stale'
        }
        onClick={cancel}
      >
        {phase === 'unknown' ? 'Retry cancellation' : 'Cancel before deal'}
      </button>
    </div>
  )
}
