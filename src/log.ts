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
