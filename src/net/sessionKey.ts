// Where supabase-js keeps this project's session in localStorage: its default
// key, sb-<project ref>-auth-token, the ref being the first label of the
// project's host. Lets the session check tell "signed out" (the key is gone)
// from "offline" (the key is there but could not be refreshed).
export function storageKeyFor(url: string) {
  return `sb-${new URL(url).hostname.split('.')[0]}-auth-token`
}
