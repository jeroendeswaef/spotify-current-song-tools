/**
 * Resolves a track's ISRC.
 *
 * The currently-playing endpoint returns a *simplified* track object, which has
 * no `external_ids` at all — so the ISRC needs a second call to the full track
 * endpoint. Confirmed against the live API: the same track that arrives with no
 * `external_ids` from /me/player/currently-playing comes back from
 * /v1/tracks/{id} with {"isrc": "..."}.
 */
import { sanitizeForLog } from './log.ts'
import { getAccessToken } from './tokens.ts'

/** Spotify IDs are 22-character base62, validated before reaching the path. */
const TRACK_ID_PATTERN = /^[A-Za-z0-9]{22}$/

/** Track id -> ISRC (or null for "asked, Spotify has none"). */
const cache = new Map<string, string | null>()
const CACHE_LIMIT = 500

/**
 * Returns the ISRC for a track id, or null. Never throws — a failure here just
 * means no BPM, which must not stop the song reaching the display.
 */
export async function fetchIsrc(trackId: string | null): Promise<string | null> {
  if (!trackId || !TRACK_ID_PATTERN.test(trackId)) return null

  const cached = cache.get(trackId)
  if (cached !== undefined) return cached

  let isrc: string | null = null
  let definitive = true

  try {
    const res = await fetch(`https://api.spotify.com/v1/tracks/${encodeURIComponent(trackId)}`, {
      headers: { Authorization: `Bearer ${await getAccessToken()}`, Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    })

    if (res.ok) {
      const data = (await res.json()) as { external_ids?: { isrc?: string } }
      isrc = data.external_ids?.isrc ?? null
    } else {
      console.warn(`isrc: spotify ${res.status} for track ${trackId}`)
      definitive = false
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'lookup failed'
    console.warn(`isrc: lookup failed for track ${trackId}: ${sanitizeForLog(message)}`)
    definitive = false
  }

  // Transient failures aren't cached, so the next play retries.
  if (definitive) {
    if (cache.size >= CACHE_LIMIT) cache.clear()
    cache.set(trackId, isrc)
  }
  return isrc
}
