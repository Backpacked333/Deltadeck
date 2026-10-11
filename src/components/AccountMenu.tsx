// The signed-in player's place in the header: their initial, and a small
// menu with their profile, online play, progress and Sign out. A disclosure
// (a button that shows a list of links), so the keyboard and screen readers
// treat it like the rest of the header. Entry chunk: no account client here;
// Sign out is a route the online chunk handles.
import { useEffect, useRef, useState } from 'react'
import { LogOut } from 'lucide-react'

/** A new account's name until it chooses one: no profile to show yet. */
const PLACEHOLDER = /^player_[0-9a-f]{12}$/

export function AccountMenu({ username }: { username: string | null }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpen(false)
      button.current?.focus()
    }
    const close = () => setOpen(false)
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', key)
    window.addEventListener('hashchange', close)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', key)
      window.removeEventListener('hashchange', close)
    }
  }, [open])

  const name = username ?? 'your account'
  return (
    <div className="account-menu" ref={root}>
      <button
        ref={button}
        className="account-button"
        aria-expanded={open}
        aria-controls="account-menu-list"
        aria-label={`Account: ${name}`}
        title={username ?? 'Account'}
        onClick={() => setOpen(!open)}
      >
        <span aria-hidden="true">{(username?.[0] ?? '?').toUpperCase()}</span>
      </button>
      {open && (
        <div className="account-panel" id="account-menu-list">
          <p className="account-who">
            Signed in as <b>{name}</b>
          </p>
          <ul role="list">
            {username && !PLACEHOLDER.test(username) && (
              <li>
                <a href={`#u/${username}`}>Your profile</a>
              </li>
            )}
            <li>
              <a href="#lobby">Play online</a>
            </li>
            <li>
              <a href="#progress">Your progress</a>
            </li>
            <li>
              <a href="#signout" className="account-signout">
                <LogOut size={15} aria-hidden="true" /> Sign out
              </a>
            </li>
          </ul>
        </div>
      )}
    </div>
  )
}
