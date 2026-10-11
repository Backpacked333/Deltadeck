import { describe, expect, it, vi } from 'vitest'
import {
  rememberAuthReturn,
  replaceRoute,
  restoreAuthReturn,
  takeAuthReturn,
} from './authReturn'

const at = (url: string) => {
  window.history.replaceState(null, '', url)
  return window.location
}

describe('auth return', () => {
  it('restores the remembered route when a provider comes back with a code', () => {
    rememberAuthReturn('#lobby')
    restoreAuthReturn(at('/?code=abc'))
    expect(window.location.hash).toBe('#lobby')
    expect(window.location.search).toBe('?code=abc')
    // One-shot: a later visit with a code does not jump again.
    restoreAuthReturn(at('/?code=def'))
    expect(window.location.hash).toBe('')
  })

  it('brings an invited player back to the table they were opening', () => {
    const table = '#play/33333333-3333-4333-8333-333333333333'
    rememberAuthReturn(table)
    restoreAuthReturn(at('/?code=abc'))
    expect(window.location.hash).toBe(table)
  })

  it('also restores after a provider error so the lobby can show it', () => {
    rememberAuthReturn('#lobby')
    restoreAuthReturn(at('/?error_description=denied'))
    expect(window.location.hash).toBe('#lobby')
  })

  it('does nothing on ordinary visits or with an unsafe target', () => {
    rememberAuthReturn('#lobby')
    restoreAuthReturn(at('/?seed=3'))
    expect(window.location.hash).toBe('')
    rememberAuthReturn('#x"><img>')
    restoreAuthReturn(at('/?code=abc'))
    expect(window.location.hash).toBe('')
  })

  it('never leaves this page, whatever was stored', () => {
    // sessionStorage is same-origin, but another script on the page (or a
    // future bug) could write it: the return must stay a hash on this page.
    for (const hostile of [
      'https://evil.example/#lobby',
      '//evil.example',
      '/\\evil.example',
      'javascript:alert(1)',
      '#lobby\n//evil',
      '#/../../evil',
      '#lobby?next=https://evil.example',
    ]) {
      rememberAuthReturn(hostile)
      const before = `${window.location.origin}/`
      restoreAuthReturn(at('/?code=abc'))
      expect(window.location.href, hostile).toBe(`${before}?code=abc`)
    }
  })
})

describe('takeAuthReturn', () => {
  it('gives the remembered route once', () => {
    rememberAuthReturn('#progress')
    expect(takeAuthReturn()).toBe('#progress')
    expect(takeAuthReturn()).toBeNull()
  })

  it('never sends a player back to an account page or off this page', () => {
    for (const target of ['#signup', '#signin', '#signout', '//evil', 'x']) {
      rememberAuthReturn(target)
      expect(takeAuthReturn(), target).toBeNull()
    }
  })
})

describe('replaceRoute', () => {
  it('drops the sign-in query, replaces the entry and tells the app', () => {
    at('/?code=abc#table')
    const length = window.history.length
    const heard = vi.fn()
    window.addEventListener('hashchange', heard)
    replaceRoute('#table')
    window.removeEventListener('hashchange', heard)
    expect(window.location.search).toBe('')
    expect(window.location.hash).toBe('#table')
    expect(window.history.length).toBe(length)
    expect(heard).toHaveBeenCalledTimes(1)
  })
})
