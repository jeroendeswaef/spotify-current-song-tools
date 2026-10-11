/**
 * Strips CR/LF from values before they reach a log line.
 *
 * Track titles, artist names and the display's echoed response are all
 * third-party strings we don't control — a newline in one of them would let a
 * single song forge extra log lines.
 */
export function sanitizeForLog(value: unknown): string {
  return String(value ?? '').replace(/[\r\n]/g, '_')
}

/**
 * Renders an error with its underlying cause.
 *
 * `fetch()` reports every connection-level failure as the same opaque
 * `TypeError: fetch failed`; the real reason (ENOTFOUND, ECONNRESET,
 * ETIMEDOUT, …) is only on `err.cause`. Logging the message alone makes
 * unrelated network problems indistinguishable.
 */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return sanitizeForLog(err)

  const cause = err.cause as (Error & { code?: string; errors?: unknown[] }) | undefined
  if (!cause) return sanitizeForLog(err.message)

  const code = cause.code ?? cause.name

  // When Node tries several addresses for a host (Happy Eyeballs: IPv6 then
  // IPv4) and they all fail, the cause is an AggregateError whose own message
  // is EMPTY — every useful detail, including which address family died, is in
  // `.errors`. Without this the log reads just "fetch failed (ETIMEDOUT)".
  const parts: string[] = []
  if (cause.message) parts.push(cause.message)
  for (const sub of cause.errors ?? []) {
    if (sub instanceof Error && sub.message) parts.push(sub.message)
  }

  const detail = parts.length ? `${code}: ${parts.join('; ')}` : code
  return sanitizeForLog(`${err.message} (${detail})`)
}
