/**
 * BPM lookup via Deezer's public API — no auth needed for reads.
 *
 * Matching is by ISRC (the recording's global identifier, which Spotify returns
 * in `external_ids`), so this is an exact join on the same recording rather
 * than fuzzy title/artist string matching.
 *
 *   GET https://api.deezer.com/track/isrc:USUM71703861
 */
import { sanitizeForLog } from './log.ts'

/**
 * ISRC is a fixed 12-character code: 2-letter country, 3-char registrant,
 * 2-digit year, 5-digit designation. Validated before it goes anywhere near the
 * request path, so a malformed value can't escape the `/track/isrc:` segment.
 */
const ISRC_PATTERN = /^[A-Za-z]{2}[A-Za-z0-9]{3}\d{7}$/

/**
 * A missing BPM always carries a reason, so "no tempo" is never confused with
 * "the lookup is broken" when reading the log.
 *
 * Every reason is a fixed internal string — nothing from Deezer's response body
 * is carried into it.
 */
export type BpmResult = { bpm: number; reason: null } | { bpm: null; reason: string }

const found = (bpm: number): BpmResult => ({ bpm, reason: null })
const missing = (reason: string): BpmResult => ({ bpm: null, reason })

const cache = new Map<string, BpmResult>()
const CACHE_LIMIT = 500

/**
 * Returns the track's BPM, or null plus a reason. Never throws: BPM is
 * decoration, so a Deezer outage must not stop the song reaching the display.
 */
export async function lookupBpm(isrc: string | null): Promise<BpmResult> {
  // Podcast episodes, local files, and some regional releases have no ISRC.
  if (!isrc) return missing('no isrc')

  const key = isrc.toUpperCase()
  if (!ISRC_PATTERN.test(key)) {
    console.warn(`bpm: ignoring malformed isrc ${sanitizeForLog(isrc)}`)
    return missing('invalid isrc')
  }

  const cached = cache.get(key)
  if (cached) return cached

  let result: BpmResult
  // Transient failures must not be cached, or one network blip would poison
  // this ISRC for the lifetime of the process.
  let definitive = true

  try {
    const res = await fetch(`https://api.deezer.com/track/isrc:${encodeURIComponent(key)}`, {
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    })

    if (res.ok) {
      // Deezer answers "no such track" with HTTP 200 and an `error` object.
      const data = (await res.json()) as { bpm?: number; error?: { type?: string } }
      if (data.error) {
        result = missing('not in Deezer')
      } else if (typeof data.bpm === 'number' && data.bpm > 0) {
        result = found(Math.round(data.bpm))
      } else {
        // Deezer uses 0 for "have the track, don't know its tempo".
        result = missing('tempo unknown')
      }
    } else {
      console.warn(`bpm: deezer ${res.status} for ${key}`)
      result = missing(`deezer ${res.status}`)
      definitive = false
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'lookup failed'
    console.warn(`bpm: lookup failed for ${key}: ${sanitizeForLog(message)}`)
    result = missing('lookup failed')
    definitive = false
  }

  if (definitive) {
    if (cache.size >= CACHE_LIMIT) cache.clear()
    cache.set(key, result)
  }
  return result
}
