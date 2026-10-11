/**
 * Polls Spotify's currently-playing endpoint and fires a webhook on every
 * track change, pause/resume, stop, and replay.
 *
 *   node src/poll.ts
 */
import { lookupBpm } from './bpm.ts'
import { UPDATE_LED_MATRIX } from './config.ts'
import { fetchIsrc } from './isrc.ts'
import { describeError, sanitizeForLog } from './log.ts'
import { addTrackToPlaylist, BANDS, bandForBpm, preloadPlaylists, savedIn } from './playlists.ts'
import {
  countStored,
  DB_PATH,
  loadBpm,
  markVerified,
  saveDeezerBpm,
  saveManualBpm,
} from './store.ts'
import { startTapTempo, type TapResult } from './taptempo.ts'
import { getAccessToken, invalidateAccessToken } from './tokens.ts'
import { postWebhook, setHealthPing, type NowPlayingEvent } from './webhook.ts'

const ENDPOINT =
  'https://api.spotify.com/v1/me/player/currently-playing?additional_types=track,episode'

const POLL_MS = Number(process.env.POLL_INTERVAL_MS || 5000)
const IDLE_MS = Number(process.env.IDLE_INTERVAL_MS || 15000)

/** Ceiling for the retry backoff, so a long outage still rechecks regularly. */
const MAX_BACKOFF_MS = 30_000

type State = { id: string | null; isPlaying: boolean; progressMs: number }
let last: State | null = null

/**
 * Last track id actually pushed to the display. The display shows a song, so it
 * only needs updating when the song changes — not on a replay of the same
 * track. Resuming after a pause re-sends it (see tick()), since the heartbeat
 * stops while paused. Pausing deliberately leaves the last song on screen
 * rather than clearing it.
 */
let lastSentId: string | null = null

/** The song currently on the display, for pairing with a tap measurement. */
let currentEvent: NowPlayingEvent | null = null

/**
 * The most recent tap measurement, tagged with the song it was taken against so
 * pressing `o` after the track changes can't apply a stale figure.
 */
let lastTap: { bpm: number; trackId: string | null } | null = null


async function display(event: NowPlayingEvent, id: string | null): Promise<void> {
  if (id === lastSentId) return
  lastSentId = id

  const stored = loadBpm(event.id)
  if (stored) {
    // Anything already on record — a past Deezer answer or a manual
    // correction — stands in for both lookups.
    event.bpm = stored.bpm
    event.bpmSource = stored.source
    event.bpmVerified = stored.verified
    event.bpmReason = null
  } else {
    // The currently-playing payload is a simplified track object with no
    // external_ids, so the ISRC needs a second call. Local files and podcast
    // episodes have no ISRC to fetch.
    if (!event.isrc && event.type === 'track' && !event.isLocal) {
      event.isrc = await fetchIsrc(event.id)
    }

    // Both lookups happen once per song change, not once per poll.
    const { bpm, reason } = await lookupBpm(event.isrc)
    event.bpm = bpm
    event.bpmReason = reason
    event.bpmSource = bpm === null ? null : 'deezer'

    // Only successful lookups are recorded. A miss isn't cached to disk, so
    // Deezer gets another chance as their catalogue fills in.
    if (bpm !== null && event.id) {
      saveDeezerBpm({
        trackId: event.id,
        isrc: event.isrc,
        title: event.name,
        artist: event.artists.join(', '),
        bpm,
      })
    }
  }

  event.savedIn = savedIn(event.id).map((band) => band.name)
  currentEvent = event
  await postWebhook(event)
}

/** The song label used in tap/override log lines. */
function currentSongLabel(): string {
  return currentEvent?.name
    ? `${sanitizeForLog(currentEvent.artists.join(', '))} — ${sanitizeForLog(currentEvent.name)}`
    : '(nothing playing)'
}

/** Reports a tap measurement beside the song's current figure. */
function reportTap({ bpm, taps }: TapResult): void {
  lastTap = { bpm, trackId: currentEvent?.id ?? null }

  const existing =
    currentEvent?.bpm != null
      ? `${currentEvent.bpm} bpm, ${currentEvent.bpmSource}`
      : `no bpm: ${currentEvent?.bpmReason ?? 'unknown'}`

  console.log(
    `tapped: ${bpm} bpm over ${taps} taps  [current: ${existing}]  ${currentSongLabel()}` +
      `  — press o to apply`,
  )
}

/** `o`: make the last tap measurement this song's BPM, for this run only. */
function applyOverride(): void {
  if (!currentEvent?.id) {
    console.log('override: nothing playing')
    return
  }
  if (!lastTap) {
    console.log('override: no measurement yet — tap `j` along with the beat first')
    return
  }
  if (lastTap.trackId !== currentEvent.id) {
    // The measurement belongs to a song that has since changed.
    console.log('override: last measurement was for a different song — tap again')
    return
  }

  const was =
    currentEvent.bpm != null ? `${currentEvent.bpm} bpm, ${currentEvent.bpmSource}` : 'no bpm'

  const saved = saveManualBpm({
    trackId: currentEvent.id,
    isrc: currentEvent.isrc,
    title: currentEvent.name,
    artist: currentEvent.artists.join(', '),
    bpm: lastTap.bpm,
  })

  currentEvent.bpm = lastTap.bpm
  currentEvent.bpmSource = 'manual tap'
  currentEvent.bpmVerified = true // tapped by ear, so verified by definition
  currentEvent.bpmReason = null

  console.log(
    `override: ${lastTap.bpm} bpm, manual tap (was ${was}), ` +
      `${saved ? 'saved' : 'this session only — store unavailable'}  ${currentSongLabel()}`,
  )
  // Re-push so the panel picks up the now-verified BPM without waiting for the next song.
  void postWebhook(currentEvent)
}

/** `v`: vouch for the BPM currently on record for this song. */
function applyVerify(): void {
  if (!currentEvent?.id) {
    console.log('verify: nothing playing')
    return
  }
  if (currentEvent.bpm == null) {
    console.log(`verify: no bpm to verify (${currentEvent.bpmReason ?? 'unknown'})`)
    return
  }
  if (currentEvent.bpmVerified) {
    console.log(`verify: already verified — ${currentEvent.bpm} bpm  ${currentSongLabel()}`)
    return
  }

  if (!markVerified(currentEvent.id)) {
    console.log('verify: not saved — no stored row, or store unavailable')
    return
  }

  currentEvent.bpmVerified = true
  console.log(
    `verify: ${currentEvent.bpm} bpm, ${currentEvent.bpmSource}, verified  ${currentSongLabel()}`,
  )
  void postWebhook(currentEvent)
}

/** `p`: file the current song into the playlist for its tempo band. */
async function applyAddToPlaylist(): Promise<void> {
  if (!currentEvent?.id) {
    console.log('playlist: nothing playing')
    return
  }
  if (currentEvent.bpm == null) {
    console.log(`playlist: no bpm (${currentEvent.bpmReason ?? 'unknown'}) — nothing to file by`)
    return
  }
  // The whole point of the bands is that the tempo is trustworthy.
  if (!currentEvent.bpmVerified) {
    console.log(
      `playlist: ${currentEvent.bpm} bpm is unverified — press v first (or o after tapping)`,
    )
    return
  }

  const band = bandForBpm(currentEvent.bpm)
  if (!band) {
    console.log(`playlist: ${currentEvent.bpm} bpm falls outside every band (100–300)`)
    return
  }

  const where = `${band.name} (${band.min}–${band.max})`
  if (!band.id) {
    console.log(`playlist: no playlist configured for ${where} — set ${band.env} in .env`)
    return
  }

  const outcome = await addTrackToPlaylist(band.id, currentEvent.id)
  if (outcome.status === 'failed') {
    console.log(`playlist: could not add to ${where} — ${outcome.detail}  ${currentSongLabel()}`)
    return
  }

  // Keep the in-memory view current, so the song reads as saved from here on.
  currentEvent.savedIn = savedIn(currentEvent.id).map((b) => b.name)

  console.log(
    `playlist: ${outcome.status} ${where} at ${currentEvent.bpm} bpm  ${currentSongLabel()}`,
  )
}

/** Spotify's shape, narrowed to what we read. */
type Playing = {
  timestamp: number
  progress_ms: number | null
  is_playing: boolean
  currently_playing_type: string
  item: {
    id: string
    name: string
    duration_ms: number
    external_urls: { spotify: string }
    // Absent from this endpoint's simplified track object — see src/isrc.ts.
    external_ids?: { isrc?: string }
    is_local?: boolean
    artists?: { name: string }[]
    show?: { name: string }
    album?: { name: string; images?: { url: string }[] }
    images?: { url: string }[]
  } | null
}

function toEvent(body: Playing, event: NowPlayingEvent['event']): NowPlayingEvent {
  const item = body.item
  return {
    event,
    id: item?.id ?? null,
    name: item?.name ?? null,
    // Tracks have `artists`; podcast episodes have `show` instead.
    artists: item?.artists?.map((a) => a.name) ?? (item?.show ? [item.show.name] : []),
    album: item?.album?.name ?? null,
    url: item?.external_urls.spotify ?? null,
    imageUrl: item?.album?.images?.[0]?.url ?? item?.images?.[0]?.url ?? null,
    type: body.currently_playing_type,
    isrc: item?.external_ids?.isrc ?? null,
    isLocal: item?.is_local ?? false,
    // All filled in by display() once the song is known to be new.
    bpm: null,
    bpmReason: null,
    bpmSource: null,
    bpmVerified: false,
    savedIn: [],
    progressMs: body.progress_ms,
    durationMs: item?.duration_ms ?? null,
    at: new Date(body.timestamp).toISOString(),
  }
}

/** Runs one poll. Returns how long to wait before the next one. */
async function tick(): Promise<number> {
  const res = await fetch(ENDPOINT, {
    headers: { Authorization: `Bearer ${await getAccessToken()}` },
    signal: AbortSignal.timeout(10_000),
  })

  // Nothing playing, or the user is in a private session — indistinguishable.
  if (res.status === 204) {
    // Playback stopped. Leave whatever is on the display alone, but forget the
    // id so the same song re-sends if it starts again.
    last = null
    lastSentId = null
    setHealthPing(false)
    return IDLE_MS
  }

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('retry-after') ?? 5)
    console.warn(`rate limited, backing off ${retryAfter + 1}s`)
    return (retryAfter + 1) * 1000
  }

  if (res.status === 401) {
    invalidateAccessToken() // token died early; refresh and retry promptly
    return 1000
  }

  if (!res.ok) {
    console.error(`spotify ${res.status}: ${sanitizeForLog(await res.text())}`)
    return IDLE_MS
  }

  const body = (await res.json()) as Playing

  // Ads and unknown payloads come back with a null item.
  if (!body.item) return POLL_MS

  const progress = body.progress_ms ?? 0
  const next: State = { id: body.item.id, isPlaying: body.is_playing, progressMs: progress }

  let event: NowPlayingEvent['event'] | null = null
  if (!last || last.id !== next.id) {
    event = next.isPlaying ? 'now_playing' : 'paused'
  } else if (last.isPlaying !== next.isPlaying) {
    event = next.isPlaying ? 'now_playing' : 'paused'
  } else if (next.isPlaying && progress + 2000 < last.progressMs) {
    // Same track, playing, and the position jumped backwards — a restart or a
    // seek. This is the only signal for a loop/replay, since the ID is unchanged.
    event = 'replay'
  }

  const resumed = last?.id === next.id && !last.isPlaying && next.isPlaying
  last = next
  setHealthPing(next.isPlaying)
  if (resumed && currentEvent?.id === next.id) {
    // The heartbeat is off while paused, so put the song back on the display.
    // Re-sends the event as it stands, keeping any override or verify from this run.
    await postWebhook(currentEvent)
  } else if (event === 'now_playing') {
    await display(toEvent(body, event), next.id)
  }
  return POLL_MS
}

async function main(): Promise<void> {
  const target = process.env.WEBHOOK_URL
  console.log(
    `polling every ${POLL_MS}ms → ` +
      (UPDATE_LED_MATRIX ? target : 'log only (updateLedMatrix off)'),
  )

  const stored = countStored()
  if (stored !== null) console.log(`bpm store: ${stored} tracks in ${DB_PATH}`)

  // Read the tempo playlists up front, so the very first song already knows
  // whether it's filed.
  const filed = await preloadPlaylists()
  console.log(
    filed === null
      ? 'tempo playlists: could not be read'
      : `tempo playlists: ${filed} tracks across ${BANDS.length} bands`,
  )

  const onAdd = () => {
    // The key handler is synchronous; failures are reported inside.
    void applyAddToPlaylist()
  }

  if (startTapTempo(reportTap, applyOverride, applyVerify, onAdd)) {
    console.log(
      '`j` tap bpm · `o` apply · `v` verify · `p` add to tempo playlist — ctrl-c to quit',
    )
  }
  // Flaky links (cellular especially) fail in bursts. Back off so a dead
  // network isn't hammered, but start short so a brief blip costs one poll
  // rather than a whole song, and stay quiet while the error is unchanged.
  let failures = 0
  let lastFailure: string | null = null

  for (;;) {
    let delay = IDLE_MS
    try {
      delay = await tick()
      if (failures > 0) {
        console.log(`polling recovered after ${failures} failed ${failures === 1 ? 'try' : 'tries'}`)
        failures = 0
        lastFailure = null
      }
    } catch (err) {
      failures++
      const described = describeError(err)
      if (described !== lastFailure) {
        console.error(`poll failed: ${described}`)
        lastFailure = described
      } else if (failures === 2) {
        console.error('poll failed: same error repeating — staying quiet until it changes')
      }
      delay = Math.min(POLL_MS * 2 ** (failures - 1), MAX_BACKOFF_MS)
    }
    await new Promise((r) => setTimeout(r, delay))
  }
}

main()
