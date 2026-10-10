/**
 * Tap tempo: hold the terminal focused and tap `j` along with the beat.
 *
 * A measurement starts once two taps land within TAP_WINDOW_MS of each other,
 * and ends when no tap arrives for TAP_WINDOW_MS. A lone stray tap is
 * discarded. You can measure as many times as you like, per song or otherwise.
 *
 * The result is reported alongside Deezer's figure — it never replaces it, and
 * it is not sent to the display.
 */

export const TAP_WINDOW_MS = 2000

export type TapResult = { bpm: number; taps: number }

/**
 * The timing logic, with no terminal involvement, so it can be driven directly
 * from tests with synthetic timestamps.
 */
export function createTapTempo(onMeasure: (result: TapResult) => void) {
  let taps: number[] = []
  let timer: ReturnType<typeof setTimeout> | null = null

  function finalize(): void {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    const collected = taps
    taps = []

    // One tap on its own was never a measurement.
    if (collected.length < 2) return

    const span = collected[collected.length - 1] - collected[0]
    if (span <= 0) return

    // Average interval across the whole run, rather than just the last pair.
    onMeasure({
      bpm: Math.round((60_000 * (collected.length - 1)) / span),
      taps: collected.length,
    })
  }

  return {
    tap(at: number): void {
      // If the timer was delayed, close the stale run before starting a new one.
      if (taps.length > 0 && at - taps[taps.length - 1] > TAP_WINDOW_MS) finalize()

      taps.push(at)
      if (timer) clearTimeout(timer)
      timer = setTimeout(finalize, TAP_WINDOW_MS)
    },
    finalize,
    stop(): void {
      if (timer) clearTimeout(timer)
      timer = null
      taps = []
    },
  }
}

/**
 * Puts the terminal in raw mode and routes `j` into the tap tracker, `o` into
 * the override callback and `v` into the verify callback. No-ops when stdin
 * isn't a TTY (piped input, launchd, systemd), where there are no keystrokes
 * to read.
 */
export function startTapTempo(
  onMeasure: (result: TapResult) => void,
  onOverride: () => void,
  onVerify: () => void,
  onAddToPlaylist: () => void,
): boolean {
  if (!process.stdin.isTTY) return false

  const tracker = createTapTempo(onMeasure)

  process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.setEncoding('utf8')

  process.stdin.on('data', (chunk: string) => {
    for (const ch of chunk) {
      // Raw mode swallows the usual SIGINT, so Ctrl+C is handled here.
      if (ch === '\u0003') {
        process.stdin.setRawMode(false)
        console.log('')
        process.exit(0)
      }
      if (ch === 'j' || ch === 'J') tracker.tap(Date.now())
      if (ch === 'o' || ch === 'O') onOverride()
      if (ch === 'v' || ch === 'V') onVerify()
      if (ch === 'p' || ch === 'P') onAddToPlaylist()
    }
  })

  return true
}
