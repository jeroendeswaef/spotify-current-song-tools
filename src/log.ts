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

  const cause = err.cause as (Error & { code?: string }) | undefined
  if (!cause) return sanitizeForLog(err.message)

  const code = cause.code ?? cause.name
  const detail = code && cause.message ? `${code}: ${cause.message}` : (code ?? cause.message)
  return sanitizeForLog(`${err.message} (${detail})`)
}
