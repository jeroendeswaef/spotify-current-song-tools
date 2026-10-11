/**
 * Pushes the current song to the ledctrl display.
 *
 *   POST http://ledctrl.local:8080/now-playing
 *   Authorization: Bearer <token>
 *   {"title": "...", "artist": "...", "bpm": 110}   // bpm only when known and verified
 */

import { UPDATE_LED_MATRIX } from './config.ts'
import { describeError, sanitizeForLog } from './log.ts'

const WEBHOOK_URL = process.env.WEBHOOK_URL

// TODO: move to the environment (LEDCTRL_TOKEN) rather than source control.
const TOKEN = process.env.LEDCTRL_TOKEN

export type NowPlayingEvent = {
  event: 'now_playing' | 'paused' | 'stopped' | 'replay'
  id: string | null
  name: string | null
  artists: string[]
  album: string | null
  url: string | null
  imageUrl: string | null
  type: string
  isrc: string | null
  isLocal: boolean
  bpm: number | null
  /** Why `bpm` is null — a fixed internal string, never Deezer's response. */
  bpmReason: string | null
  /** Where `bpm` came from, shown in the log so the two are distinguishable. */
  bpmSource: 'deezer' | 'manual tap' | null
  /** Whether the BPM has been confirmed by ear. Manual taps always are. */
  bpmVerified: boolean
  /** Tempo-band playlists this song is already filed under. */
  savedIn: string[]
  progressMs: number | null
  durationMs: number | null
  at: string
}

/**
 * POSTs {title, artist, bpm?}. The BPM is only sent once verified, so the panel
 * never shows an unconfirmed Deezer guess. Retries on network errors and 5xx; a 4xx is a config
 * problem (bad token, wrong path) and won't fix itself, so it fails fast.
 */
export async function postWebhook(event: NowPlayingEvent): Promise<void> {
  const payload = {
    title: event.name ?? '',
    artist: event.artists.join(', '),
    // Omitted entirely when unknown or unverified, rather than sent as 0 or null.
    ...(event.bpm !== null && event.bpmVerified && { bpm: event.bpm }),
  }
  const suffix =
    event.bpm !== null
      ? ` [${event.bpm} bpm, ${event.bpmSource ?? 'unknown source'}` +
        `${event.bpmVerified ? ', verified' : ', unverified — not sent'}]`
      : ` [no bpm: ${event.bpmReason ?? 'unknown'}]`

  // Only tracks can be filed, so don't nag about podcasts or local files.
  const filed =
    event.type !== 'track'
      ? ''
      : event.savedIn.length
        ? ` (saved: ${event.savedIn.join(', ')})`
        : ' (not saved)'

  const line =
    `${sanitizeForLog(payload.artist)} — ${sanitizeForLog(payload.title)}` + suffix + filed

  if (!UPDATE_LED_MATRIX) {
    console.log(`now playing: ${line}`)
    return
  }

  const body = JSON.stringify(payload)

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          'Content-Type': 'application/json',
        },
        body,
        signal: AbortSignal.timeout(10_000),
      })

      if (res.ok) {
        // ledctrl echoes back what it actually rendered — it truncates long
        // fields, so log that rather than what we sent.
        const shown = (await res.json().catch(() => null)) as
          | { displayed?: { title?: string; artist?: string } }
          | null
        const d = shown?.displayed
        console.log(
          d
            ? `displayed: ${sanitizeForLog(d.artist)} — ${sanitizeForLog(d.title)}${suffix}${filed}`
            : `sent: ${line}`,
        )
        return
      }

      if (res.status < 500) {
        console.error(`ledctrl rejected ${res.status}: ${sanitizeForLog(await res.text())}`)
        return
      }
      console.error(`ledctrl ${res.status}, attempt ${attempt}/3`)
    } catch (err) {
      console.error(`ledctrl error, attempt ${attempt}/3:`, describeError(err))
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 1000))
  }
  console.error('ledctrl giving up on:', line)
}

const HEALTH_MS = 3_000

/** POST <ledctrl>/health, on the same host as WEBHOOK_URL unless overridden. */
const HEALTH_URL =
  process.env.LEDCTRL_HEALTH_URL ?? (WEBHOOK_URL ? new URL('/health', WEBHOOK_URL).href : undefined)

let healthy: boolean | null = null
let healthTimer: ReturnType<typeof setTimeout> | null = null
/** Bumped on every start/stop, so a ping still in flight from before can't reschedule itself. */
let healthRun = 0

/**
 * Heartbeats ledctrl every 3s while updateLedMatrix is on and Spotify is
 * actually playing. Logs only when the state flips (first result, ok →
 * failing, failing → ok) so it doesn't spam. Chained timeouts rather than
 * setInterval, so a slow ledctrl can't pile up overlapping requests.
 */
export function setHealthPing(playing: boolean): void {
  if (!UPDATE_LED_MATRIX || !HEALTH_URL) return
  if (playing === (healthTimer !== null)) return
  const url = HEALTH_URL
  const run = ++healthRun

  if (!playing) {
    clearTimeout(healthTimer ?? undefined)
    healthTimer = null
    // Forget the last result, so resuming logs the health afresh.
    healthy = null
    console.log('ledctrl health: paused (nothing playing)')
    return
  }

  const report = (ok: boolean, detail: string) => {
    if (ok === healthy) return
    healthy = ok
    if (ok) console.log('ledctrl health: ok')
    else console.error(`ledctrl health: failing (${detail})`)
  }

  const ping = async () => {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}` },
        signal: AbortSignal.timeout(HEALTH_MS),
      })
      // Discard the body so the connection can be reused.
      await res.body?.cancel()
      if (run !== healthRun) return
      report(res.ok, `HTTP ${res.status}`)
    } catch (err) {
      if (run !== healthRun) return
      report(false, describeError(err))
    }
    if (run === healthRun) healthTimer = setTimeout(ping, HEALTH_MS)
  }
  // Marks the heartbeat as running straight away; the first ping goes out now.
  healthTimer = setTimeout(ping, 0)
}
