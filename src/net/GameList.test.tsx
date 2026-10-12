import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CODE_FAILED,
  GAMES_EVERY_MS,
  GameList,
  REQUEST_WAIT_MS,
  TOO_MANY,
} from './GameList'
import { codeFieldText, openFor, readLink } from './gameText'
import { useLobby } from './useLobby'
import {
  FakeSocket,
  gameId,
  gameRow,
  gamesFrame,
  joinStatusFrame,
  MATCH,
} from './testing'

const parsed = (s: FakeSocket) => s.sent.map((m) => JSON.parse(m))
const asks = (s: FakeSocket) => parsed(s).filter((m) => m.t === 'games').length

// Stable: useLobby opens a new connection whenever it changes.
const getToken = async () => 'jwt'

function Harness() {
  const { state, connection } = useLobby(getToken)
  return <GameList state={state} connection={connection} />
}

/** The page with its lobby socket open. */
async function page() {
  render(<Harness />)
  await act(async () => {})
  const socket = FakeSocket.last()
  act(() => socket.open())
  return socket
}
const setVisible = (visibilityState: 'visible' | 'hidden') => {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibilityState,
  })
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => {
  FakeSocket.all = []
  vi.stubGlobal('WebSocket', FakeSocket)
  window.location.hash = '#lobby'
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(document, 'visibilityState')
})

describe('GameList: asking', () => {
  it('asks as the socket opens, every 5 s while the tab is seen, and as it comes back', async () => {
    vi.useFakeTimers()
    render(<Harness />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    const socket = FakeSocket.last()
    act(() => socket.open())
    expect(asks(socket)).toBe(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(GAMES_EVERY_MS - 1)
    })
    expect(asks(socket)).toBe(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(asks(socket)).toBe(2)

    // Hidden: the ticks pass and ask nothing; seen again, it asks at once.
    act(() => setVisible('hidden'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(GAMES_EVERY_MS * 3)
    })
    expect(asks(socket)).toBe(2)
    act(() => setVisible('visible'))
    expect(asks(socket)).toBe(3)
  })

  it('asks again after a reconnect, and never once the page has gone', async () => {
    vi.useFakeTimers()
    const view = render(<Harness />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    const first = FakeSocket.last()
    act(() => first.open())
    act(() => first.drop(1006))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    const second = FakeSocket.last()
    act(() => second.open())
    expect(asks(second)).toBe(1)
    view.unmount()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(GAMES_EVERY_MS * 3)
    })
    expect(asks(second)).toBe(1)
  })
})

describe('GameList: the rows', () => {
  it('says it is looking, then lists the games with name and age and a request button', async () => {
    const socket = await page()
    expect(screen.getByText('Looking for open games…')).toBeVisible()
    act(() =>
      socket.emitLobby(
        gamesFrame([
          gameRow(1, 'carol', 3 * 60_000 + 5_000),
          gameRow(2, 'dave', 20_000),
        ]),
      ),
    )
    const table = screen.getByRole('table', { name: 'Open games' })
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows).toHaveLength(2)
    expect(within(rows[0]).getByText('carol')).toBeVisible()
    expect(within(rows[0]).getByText('open 3 min')).toBeVisible()
    expect(within(rows[1]).getByText('open under a minute')).toBeVisible()
    expect(
      within(rows[0]).getByRole('button', { name: 'Request to join carol' }),
    ).toHaveTextContent('Request to join')
  })

  it('has the names to read in full when cut short', async () => {
    const socket = await page()
    act(() => socket.emitLobby(gamesFrame([gameRow(1, 'a_long_player_name')])))
    expect(screen.getByText('a_long_player_name')).toHaveAttribute(
      'title',
      'a_long_player_name',
    )
  })

  it('shows no table id, code or list handle anywhere in the page', async () => {
    const socket = await page()
    act(() =>
      socket.emitLobby(
        gamesFrame([
          // Extra keys from a misbehaving frame must not get as far as the DOM.
          {
            ...gameRow(7, 'carol'),
            matchId: MATCH,
            code: 'ABC234',
          } as never,
        ]),
      ),
    )
    // The row has a key beyond the three: dropped, not shown.
    expect(screen.queryByText('carol')).toBeNull()
    act(() => socket.emitLobby(gamesFrame([gameRow(7, 'carol')])))
    const html = document.body.innerHTML
    expect(html).toContain('carol')
    expect(html).not.toContain(gameId(7))
    expect(html).not.toContain(MATCH)
    expect(html).not.toContain('ABC234')
  })

  it('invites a host when there are none', async () => {
    const socket = await page()
    act(() => socket.emitLobby(gamesFrame([])))
    expect(
      screen.getByText(
        'No open games right now. Create one with Play a friend.',
      ),
    ).toBeVisible()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('drops rows that stop being refreshed (two asks unanswered)', async () => {
    vi.useFakeTimers()
    render(<Harness />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    const socket = FakeSocket.last()
    act(() => socket.open())
    act(() => socket.emitLobby(gamesFrame([gameRow(1)])))
    expect(screen.getByText('carol')).toBeVisible()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(GAMES_EVERY_MS * 2 - 1)
    })
    expect(screen.getByText('carol')).toBeVisible()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(screen.queryByText('carol')).toBeNull()
    // A fresh frame brings them back.
    act(() => socket.emitLobby(gamesFrame([gameRow(1)])))
    expect(screen.getByText('carol')).toBeVisible()
  })

  it('ages are to the minute, with hours', () => {
    expect(openFor(0)).toBe('open under a minute')
    expect(openFor(59_999)).toBe('open under a minute')
    expect(openFor(60_000)).toBe('open 1 min')
    expect(openFor(59 * 60_000)).toBe('open 59 min')
    expect(openFor(60 * 60_000)).toBe('open 1 h')
    expect(openFor(135 * 60_000)).toBe('open 2 h 15 min')
  })
})

describe('GameList: a request to join', () => {
  const rows = (socket: FakeSocket) =>
    act(() =>
      socket.emitLobby(gamesFrame([gameRow(1, 'carol'), gameRow(2, 'dave')])),
    )

  it('is sent with the list handle, shows waiting for the host, and holds the other rows', async () => {
    const socket = await page()
    rows(socket)
    await userEvent.click(
      screen.getByRole('button', { name: 'Request to join carol' }),
    )
    expect(parsed(socket).at(-1)).toEqual({
      t: 'join_request',
      gameId: gameId(1),
    })
    expect(screen.getByText('Waiting for host…')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'Request to join dave' }),
    ).toBeDisabled()
    act(() => socket.emitLobby(joinStatusFrame('pending', REQUEST_WAIT_MS)))
    expect(screen.getByText('Waiting for host…')).toBeVisible()
  })

  it('keeps keyboard focus: Cancel takes it from Request, Request takes it back', async () => {
    const socket = await page()
    rows(socket)
    const request = screen.getByRole('button', {
      name: 'Request to join carol',
    })
    request.focus()
    await userEvent.keyboard('{Enter}')
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
    await userEvent.keyboard('{Enter}')
    expect(
      screen.getByRole('button', { name: 'Request to join carol' }),
    ).toHaveFocus()
  })

  it('leaves focus alone when the person has moved on', async () => {
    const socket = await page()
    rows(socket)
    await userEvent.click(
      screen.getByRole('button', { name: 'Request to join carol' }),
    )
    const field = screen.getByLabelText('Game code')
    field.focus()
    act(() => socket.emitLobby(joinStatusFrame('declined')))
    expect(field).toHaveFocus()
  })

  it('announces from a region that was there before the words', async () => {
    const socket = await page()
    rows(socket)
    const region = () =>
      within(
        screen
          .getByRole('button', { name: 'Request to join carol' })
          .closest('td')!,
      ).getByRole('status')
    const before = region()
    expect(before).toBeEmptyDOMElement()
    await userEvent.click(
      screen.getByRole('button', { name: 'Request to join carol' }),
    )
    expect(before).toHaveTextContent('Waiting for host…')
    act(() => socket.emitLobby(joinStatusFrame('declined')))
    expect(before).toHaveTextContent('Not this time')
    expect(before.isConnected).toBe(true)
  })

  it('can be cancelled, and the rows come back', async () => {
    const socket = await page()
    rows(socket)
    await userEvent.click(
      screen.getByRole('button', { name: 'Request to join carol' }),
    )
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(parsed(socket).at(-1)).toEqual({ t: 'cancel_request' })
    expect(
      screen.getByRole('button', { name: 'Request to join dave' }),
    ).toBeEnabled()
    expect(screen.queryByText('Waiting for host…')).toBeNull()
  })

  it("counts down the host's 60 s, then says there was no answer and frees the rows", async () => {
    vi.useFakeTimers()
    render(<Harness />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    const socket = FakeSocket.last()
    act(() => socket.open())
    rows(socket)
    fireEvent.click(
      screen.getByRole('button', { name: 'Request to join carol' }),
    )
    act(() => socket.emitLobby(joinStatusFrame('pending', REQUEST_WAIT_MS)))
    expect(screen.getByText('1:00')).toBeInTheDocument()
    // The list is refreshed as it would be, every 5 s, so the rows stay.
    const tick = async (ms: number) => {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms)
      })
      rows(socket)
    }
    for (let i = 0; i < 2; i++) await tick(5_000)
    expect(screen.getByText('0:50')).toBeInTheDocument()
    for (let i = 0; i < 8; i++) await tick(5_000)
    expect(screen.getByText('0:10')).toBeInTheDocument()
    await tick(10_000)
    expect(screen.getByText('No answer, try another game')).toBeVisible()
    expect(screen.queryByText('Waiting for host…')).toBeNull()
    expect(
      screen.getByRole('button', { name: 'Request to join dave' }),
    ).toBeEnabled()
  })

  it.each([
    ['declined', 'Not this time'],
    ['unavailable', 'That game is no longer available'],
  ] as const)('ends %s, in its own row', async (state, words) => {
    const socket = await page()
    rows(socket)
    await userEvent.click(
      screen.getByRole('button', { name: 'Request to join carol' }),
    )
    act(() => socket.emitLobby(joinStatusFrame(state)))
    const row = screen.getByText('carol').closest('tr')!
    expect(within(row).getByText(words)).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'Request to join dave' }),
    ).toBeEnabled()
  })

  it('says so under the list when the game left it before the answer', async () => {
    const socket = await page()
    rows(socket)
    await userEvent.click(
      screen.getByRole('button', { name: 'Request to join carol' }),
    )
    act(() => socket.emitLobby(gamesFrame([gameRow(2, 'dave')])))
    act(() => socket.emitLobby(joinStatusFrame('unavailable')))
    expect(screen.getByText('That game is no longer available')).toBeVisible()
  })

  it('says to wait when the lobby has had too many requests', async () => {
    const socket = await page()
    rows(socket)
    await userEvent.click(
      screen.getByRole('button', { name: 'Request to join carol' }),
    )
    act(() =>
      socket.emitLobby({
        t: 'error',
        code: 'rate_limited',
        message: 'Slow down',
      } as never),
    )
    expect(screen.getByRole('alert')).toHaveTextContent(TOO_MANY)
  })
})

describe('GameList: the code field style', () => {
  it('outranks the generic row input, so its font and width apply', () => {
    const css = readFileSync(resolve(__dirname, 'live.css'), 'utf8')
    expect(css).toMatch(/\n\.live-row \.live-code-input \{/)
    expect(css).not.toMatch(/\n\.live-code-input \{/)
    expect(css).toMatch(/max-width: 14ch/)
  })
})

describe('GameList: join with a code', () => {
  const field = () => screen.getByRole('textbox', { name: 'Game code' })

  it('is a field made for a code: capitals, no corrections, eight characters at most', async () => {
    await page()
    expect(field()).toHaveAttribute('autocapitalize', 'characters')
    expect(field()).toHaveAttribute('autocomplete', 'off')
    expect(field()).toHaveAttribute('autocorrect', 'off')
    expect(field()).toHaveAttribute('spellcheck', 'false')
    expect(field()).toHaveAttribute('maxlength', '8')
  })

  it('upper-cases, drops spaces and hyphens, and sets the hyphen itself', async () => {
    await page()
    await userEvent.type(field(), 'abc 2')
    expect(field()).toHaveValue('ABC-2')
    await userEvent.type(field(), '3-4x')
    expect(field()).toHaveValue('ABC-234')
    expect(codeFieldText('  ab-c2 34 5  ')).toBe('ABC-234')
    expect(codeFieldText('ab')).toBe('AB')
  })

  it('sends the cleaned code, and goes where the lobby sends', async () => {
    const socket = await page()
    await userEvent.type(field(), 'abc234{Enter}')
    expect(parsed(socket).at(-1)).toEqual({ t: 'join_code', code: 'ABC234' })
    act(() =>
      socket.emitLobby({ t: 'matched', matchId: MATCH, resumed: false }),
    )
    // (Lobby navigates on a match; the list only asks.)
  })

  it('says one thing for a miss, and another for too many tries', async () => {
    const socket = await page()
    await userEvent.type(field(), 'abc234')
    await userEvent.click(screen.getByRole('button', { name: 'Join game' }))
    act(() => socket.emitLobby(joinStatusFrame('unavailable')))
    expect(screen.getByRole('alert')).toHaveTextContent(CODE_FAILED)
    await userEvent.click(screen.getByRole('button', { name: 'Join game' }))
    act(() =>
      socket.emitLobby({
        t: 'error',
        code: 'rate_limited',
        message: 'Slow down',
      } as never),
    )
    expect(screen.getByRole('alert')).toHaveTextContent(TOO_MANY)
  })

  it('answers a code that can not be one as it answers a miss, without asking', async () => {
    const socket = await page()
    const before = socket.sent.length
    await userEvent.type(field(), 'abc0il')
    await userEvent.click(screen.getByRole('button', { name: 'Join game' }))
    expect(screen.getByRole('alert')).toHaveTextContent(CODE_FAILED)
    expect(socket.sent.length).toBe(before + 0)
  })

  it('has nothing to send until something is typed, or while the lobby is out of reach', async () => {
    render(<Harness />)
    await act(async () => {})
    expect(screen.getByRole('button', { name: 'Join game' })).toBeDisabled()
    act(() => FakeSocket.last().open())
    await userEvent.type(field(), 'a')
    expect(screen.getByRole('button', { name: 'Join game' })).toBeEnabled()
  })

  describe('a pasted link', () => {
    const UUID = '33333333-3333-4333-8333-333333333333'
    const paste = async (text: string) => {
      await userEvent.click(field())
      await userEvent.paste(text)
    }

    it('to a table goes to that table', async () => {
      await page()
      await paste(`https://qp.test/#play/${UUID}`)
      expect(window.location.hash).toBe(`#play/${UUID}`)
      expect(field()).toHaveValue('')
    })

    it('with a code joins by the code', async () => {
      const socket = await page()
      await paste('https://qp.test/#join/abc234')
      expect(parsed(socket).at(-1)).toEqual({ t: 'join_code', code: 'ABC234' })
    })

    it('that is neither is read as a code being typed', async () => {
      await page()
      await paste('abc 234')
      expect(field()).toHaveValue('ABC-234')
    })

    it('is read the same typed into the field and submitted', () => {
      expect(readLink(`#play/${UUID.toUpperCase()}`)).toEqual({ play: UUID })
      expect(readLink('x #join/ABC-234')).toEqual({ code: 'ABC234' })
      expect(readLink('#join/ABC0IL')).toBeNull()
      expect(readLink('#join/ABC23')).toBeNull()
      expect(readLink('#play/not-a-uuid')).toBeNull()
      expect(readLink('ABC234')).toBeNull()
    })
  })
})
