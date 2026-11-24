/** Local tracking refs are advisory: a preflight never requires a push or fetch. */
export function checkTrackingState(run, { pass, warn }) {
  const head = run('git', ['rev-parse', 'HEAD'])
  const origin = run('git', ['rev-parse', '--verify', 'origin/main'])
  if (!origin.ok) {
    warn('origin/main is not available', 'local preflight can continue; remote state was not checked')
  } else if (head.ok && head.out !== origin.out) {
    const ahead = run('git', ['rev-list', '--count', 'origin/main..HEAD'])
    const behind = run('git', ['rev-list', '--count', 'HEAD..origin/main'])
    warn(
      'HEAD differs from local origin/main (ahead ' + (ahead.out || '?') + ', behind ' + (behind.out || '?') + ')',
      'local preflight checks HEAD; pushing is a separate release decision and is not required',
    )
  } else if (head.ok) {
    pass('HEAD matches local origin/main')
  }
}
