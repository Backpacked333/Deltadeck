// One address for the site (CANONICAL_ORIGIN, https://deltadeck.net): a page
// asked for on any other host, such as the old workers.dev address or www,
// moves there for good, with its path and query. APIs and sockets answer
// wherever they are asked, so a tab still open on the old address keeps
// working until it reloads. A local server, and a preview or version URL
// (<id>-quantpoker.<account>.workers.dev, a build before it is live), stay
// where they are.
const LOCAL_HOST = /^(localhost|127\.0\.0\.1)$/
const PREVIEW_HOST = /^[^.]+-quantpoker\.[^.]+\.workers\.dev$/

/** The 301 to the canonical address for this request, or null to serve it. */
export function canonicalRedirect(request: Request, canonical?: string) {
  if (!canonical) return null
  if (request.method !== 'GET' && request.method !== 'HEAD') return null
  const url = new URL(request.url)
  if (url.origin === canonical) return null
  if (LOCAL_HOST.test(url.hostname) || PREVIEW_HOST.test(url.hostname))
    return null
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/'))
    return null
  return Response.redirect(`${canonical}${url.pathname}${url.search}`, 301)
}
