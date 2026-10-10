/**
 * Tempo-banded playlists: each one holds tracks in a BPM range, so a song with
 * a trusted BPM can be filed into the right one with a keystroke.
 *
 * Bands are lower-inclusive and upper-exclusive — 140 bpm files under
 * classicLindy (140–160), not easyLindy (120–140) — except the top band, which
 * includes its upper bound so 300 still lands in balboa.
 *
 * Playlist ids come from the environment (PLAYLIST_SLOW_LINDY etc.) so they
 * stay out of source. A band without one still owns its BPM range; `p` just
 * reports it as unconfigured.
 */
import './config.ts' // loads .env before the ids are read
import { sanitizeForLog } from './log.ts'
import { getAccessToken } from './tokens.ts'

export type Band = { id: string | null; env: string; name: string; min: number; max: number }

function band(env: string, name: string, min: number, max: number): Band {
  return { id: process.env[env] || null, env, name, min, max }
}

export const BANDS: Band[] = [
  band('PLAYLIST_SLOW_LINDY', 'slowLindy', 100, 120),
  band('PLAYLIST_EASY_LINDY', 'easyLindy', 120, 140),
  band('PLAYLIST_CLASSIC_LINDY', 'classicLindy', 140, 160),
  band('PLAYLIST_CHARLESTON', 'charleston', 160, 185),
  band('PLAYLIST_SHAG', 'shag', 185, 220),
  band('PLAYLIST_BALBOA', 'balboa', 220, 300),
]

/** Bands with a playlist id set — the only ones that can be read or filed into. */
export const CONFIGURED_BANDS = BANDS.filter(
  (b): b is Band & { id: string } => b.id !== null,
)

const TOP = BANDS[BANDS.length - 1]

/** Spotify ids are 22-character base62; validated before reaching any path. */
const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/

/** The band a BPM belongs to, or null if it falls outside every range. */
export function bandForBpm(bpm: number): Band | null {
  for (const band of BANDS) {
    if (bpm >= band.min && bpm < band.max) return band
  }
  // The top band owns its upper bound, so 300 isn't homeless.
  return bpm === TOP.max ? TOP : null
}

/**
 * Known track ids per playlist, so the same song isn't filed twice and the
 * now-playing line can say whether a song is already saved.
 *
 * A set may be incomplete if a read failed — that's safe, because it's only
 * ever consulted for presence. An absence just means "try the add".
 */
const members = new Map<string, Set<string>>()

/** The duplicate check is a nicety; adding still works without it. */
let warnedNoDedupe = false

function warnDedupeUnavailable(reason: string): void {
  if (warnedNoDedupe) return
  warnedNoDedupe = true
  console.warn(`playlist: duplicate check unavailable (${reason}) — adds will not be deduplicated`)
}

async function loadMembers(playlistId: string): Promise<Set<string> | null> {
  const cached = members.get(playlistId)
  if (cached) return cached

  const ids = new Set<string>()
  // `/tracks` is retired and 403s; `/items` is the live endpoint, and it nests
  // the entry under `item` rather than `track`.
  let url =
    `https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}/items` +
    `?limit=100&fields=next,items(item(id))`

  try {
    while (url) {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${await getAccessToken()}` },
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) {
        warnDedupeUnavailable(`spotify ${res.status}`)
        return null
      }
      const page = (await res.json()) as {
        next: string | null
        items: { item: { id: string | null } | null }[]
      }
      for (const entry of page.items ?? []) {
        if (entry.item?.id) ids.add(entry.item.id)
      }
      // `next` is Spotify's own pagination link, same host.
      url = page.next ?? ''
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'read failed'
    warnDedupeUnavailable(sanitizeForLog(message))
    return null
  }

  members.set(playlistId, ids)
  return ids
}

/**
 * Reads every band playlist up front, so the first song already knows whether
 * it's filed. Returns how many distinct tracks are known, or null if nothing
 * could be read.
 */
export async function preloadPlaylists(): Promise<number | null> {
  const loaded = await Promise.all(CONFIGURED_BANDS.map((band) => loadMembers(band.id)))
  if (loaded.every((set) => set === null)) return null

  const distinct = new Set<string>()
  for (const set of loaded) {
    for (const id of set ?? []) distinct.add(id)
  }
  return distinct.size
}

/** The bands a track is already filed under. */
export function savedIn(trackId: string | null): Band[] {
  if (!trackId) return []
  return CONFIGURED_BANDS.filter((band) => members.get(band.id)?.has(trackId))
}

/** Records a track as filed, creating the set if the playlist was never read. */
function remember(playlistId: string, trackId: string): void {
  let set = members.get(playlistId)
  if (!set) {
    set = new Set<string>()
    members.set(playlistId, set)
  }
  set.add(trackId)
}

export type AddOutcome =
  | { status: 'added' }
  | { status: 'already there' }
  | { status: 'failed'; detail: string }

/**
 * Adds a track to a playlist, skipping it if already present. Never throws.
 */
export async function addTrackToPlaylist(
  playlistId: string,
  trackId: string,
): Promise<AddOutcome> {
  if (!SPOTIFY_ID.test(playlistId) || !SPOTIFY_ID.test(trackId)) {
    return { status: 'failed', detail: 'invalid id' }
  }

  const existing = await loadMembers(playlistId)
  if (existing?.has(trackId)) return { status: 'already there' }

  try {
    const res = await fetch(
      `https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}/items`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await getAccessToken()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ uris: [`spotify:track:${trackId}`] }),
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      },
    )

    if (res.status === 403) {
      return {
        status: 'failed',
        detail: 'no permission — re-run `npm run authorize` to grant playlist access',
      }
    }
    if (!res.ok) {
      return { status: 'failed', detail: `spotify ${res.status}` }
    }

    // Remember it even if the playlist was never readable, so a second `p`
    // this session doesn't file it twice.
    remember(playlistId, trackId)
    return { status: 'added' }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'request failed'
    return { status: 'failed', detail: sanitizeForLog(message) }
  }
}
