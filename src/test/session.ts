// A stored session of the shape supabase-js writes, for tests of pages that
// need a signed-in visitor. Far-future expiry, so nothing tries to refresh.
export const TEST_SESSION_KEY = 'sb-test-auth-token'

export function seedSession({
  userId = '11111111-1111-4111-8111-111111111111',
  username = 'tester',
}: { userId?: string; username?: string | null } = {}) {
  localStorage.setItem(
    TEST_SESSION_KEY,
    JSON.stringify({
      access_token: 'test-access-token',
      refresh_token: 'test-refresh-token',
      expires_at: 4102444800,
      token_type: 'bearer',
      user: { id: userId, email: 'tester@example.com' },
    }),
  )
  if (username) localStorage.setItem('qp.username', username)
}
