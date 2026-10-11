# spotify-now-playing-webhook

Spotify has no webhook API, so this polls `GET /v1/me/player/currently-playing`
and POSTs to your webhook whenever playback changes.

Zero dependencies. TypeScript runs directly on Node ≥ 22.18 via native type
stripping — no build step, no `npm install`.

## Setup

1. Create an app at <https://developer.spotify.com/dashboard>.
2. In its settings, add the redirect URI.
   It must match byte-for-byte. Non-loopback redirect URIs must be `https` —
   that's fine here, since TLS is terminated by the tunnel and only plain HTTP
   reaches us on `127.0.0.1:8084`.
3. Copy the config and fill in the client ID/secret:

   ```sh
   cp env.example .env
   ```

4. Make sure the tunnel is up, so the redirect URI reaches
   `localhost:8084`. Then authorize once (opens a browser, writes
   `.tokens.json`):

   ```sh
   npm run authorize
   ```

   The callback server listens on `127.0.0.1:8084` and only needs to be up for
   the few seconds the redirect takes. Two knobs if it doesn't connect:
   `AUTH_PORT` to move the local port, and `AUTH_HOST=0.0.0.0` if the mapping
   is a LAN port-forward rather than a tunnel client on this machine.

5. Run the poller:

   ```sh
   npm start
   ```

Pass `--no-updateLedMatrix` to print song changes without touching the display
— useful for confirming Spotify auth works on its own.

## What it sends

One POST to `http://ledctrl.local:8080/now-playing` per song change:

```http
POST /now-playing HTTP/1.1
Authorization: Bearer <LEDCTRL_TOKEN>
Content-Type: application/json

{"title": "Singin on Nothin", "artist": "Jonathan Stout and his Campus Five", "bpm": 110}
```

`bpm` is omitted entirely when the tempo can't be determined — never sent as
`0` or `null`.

ledctrl echoes back what it actually rendered, and truncates the artist to 32
chars, so the log line shows the truncated form:

```
displayed: Jonathan Stout and his Campus Fi — Singin on Nothin
```

**When it fires:** only when the *song* changes. Pause and resume of the same
track, a replay of it, and ad breaks send nothing, since the display would not
change. Pausing deliberately leaves the last song on screen rather than
clearing it — stopping playback entirely just resets the dedupe, so the same
song re-sends if you start it again.

While `updateLedMatrix` is on and Spotify is playing, it also sends
`POST /health` (same host as `WEBHOOK_URL`, same bearer token, no body) every
3 seconds as a heartbeat. Pausing or stopping playback stops the heartbeat; it
resumes on the next poll that sees music playing. The log only notes when
health flips between ok and failing, or when the heartbeat pauses.

Override the target with `WEBHOOK_URL`, the heartbeat with `LEDCTRL_HEALTH_URL`,
and the token with `LEDCTRL_TOKEN`.

## BPM

Spotify doesn't expose tempo any more, so BPM comes from Deezer's public API
(no auth needed for reads). The join is by **ISRC**, the recording's global
identifier — an exact match on the same recording rather than fuzzy
title/artist string matching.

That takes two calls, because **the currently-playing endpoint returns a
*simplified* track object with no `external_ids` field at all.** Verified
against the live API: a track that arrives from
`/me/player/currently-playing` with no `external_ids` comes back from
`/v1/tracks/{id}` carrying `{"isrc": "USMC15075936"}`. So:

```
GET https://api.spotify.com/v1/tracks/{id}      -> external_ids.isrc
GET https://api.deezer.com/track/isrc:{isrc}    -> bpm
```

Both are skipped for podcast episodes and local files, which have no ISRC.

Both lookups happen once per song change, not once per poll, and both cache
definitive answers for the process lifetime — the ISRC by track id, the tempo
by ISRC. Transient failures deliberately aren't cached, so one network blip
doesn't leave a song permanently BPM-less. BPM is decoration, so every failure path degrades to "no
bpm" rather than blocking the song: Deezer being down, slow (5s timeout), or
returning something unparseable all just omit the field.

The wire payload omits `bpm` when it's unknown, but the **log always says why**,
so a missing tempo never looks like a broken integration:

```
now playing: Jonathan Stout and his Campus Five — Singin on Nothin [110 bpm, deezer]
now playing: Artist 2 — Song B [no bpm: tempo unknown]
now playing: Some Podcast — Episode 42 [no bpm: no isrc]
```

Reasons: `no isrc` (podcasts, local files), `invalid isrc`, `not in Deezer`
(unknown ISRC), `tempo unknown` (Deezer has the track but no tempo),
`deezer <status>`, `lookup failed` (timeout, network, unparseable body).

Caveats worth knowing:

- **Not every recording has one.** Deezer answers an unknown ISRC with HTTP 200
  and an `error` object, and uses `bpm: 0` for "I have the track but not its
  tempo". Both become no-bpm.
- **Podcast episodes and local files have no ISRC**, so they never get a BPM
  and never trigger either lookup.
- **Deezer's values are estimates** and can be half- or double-time for
  syncopated material — swing and drum'n'bass are the usual offenders.
- **Deezer's ISRC index isn't exhaustive**, so a track Spotify knows may simply
  be absent.

## Tap tempo

With the poller running in a terminal:

| Key | Does |
| --- | --- |
| `j` | Tap along with the beat to measure |
| `o` | Apply the last measurement as this song's BPM |
| `v` | Verify the BPM already on record for this song |
| `p` | Add the song to the playlist for its tempo band |

```
now playing: Ella Fitzgerald — Solid As A Rock [110 bpm, deezer]
tapped: 148 bpm over 5 taps  [current: 110 bpm, deezer]  Ella Fitzgerald — Solid As A Rock  — press o to apply
override: 148 bpm, manual tap (was 110 bpm, deezer), saved  Ella Fitzgerald — Solid As A Rock
```

Every BPM in the log carries its origin — `deezer` or `manual tap` — so the two
are never confused, plus `verified` once it's been confirmed by ear.

A measurement **starts** once two taps land within 2 seconds of each other, and
**ends** when no tap arrives for 2 seconds. A single stray tap is discarded.
You can measure as many times as you like, per song or otherwise — each run is
independent. Tapping alone changes nothing; only `o` applies it.

The BPM is the average interval across the whole run, not just the last pair,
so uneven human tapping evens out. More taps give a better estimate.

### Overrides

`o` stores the measurement against the current track id, in the BPM store (see
below). An override:

- wins over Deezer, and skips both the ISRC and Deezer lookups entirely
- survives the song changing and coming back, **and process restarts**
- is sent to the display like any other BPM, next time that song comes round
- is **not** pushed immediately — the display keeps the old value until the
  song is played again

`o` declines to do anything surprising: it reports and does nothing when there's
no measurement yet, when nothing is playing, or when the last measurement was
taken against a different song.

### Verifying

Deezer's tempo is an estimate, and it has a habit of landing on half- or
double-time for swing. `v` is how you say "I listened, that figure is right":

```
now playing: Alberta Hunter — Sweet Georgia Brown [131 bpm, deezer]
verify: 131 bpm, deezer, verified  Alberta Hunter — Sweet Georgia Brown
...later...
now playing: Alberta Hunter — Sweet Georgia Brown [131 bpm, deezer, verified]
```

A **manual tap is verified by definition** — you measured it by ear, so `o`
records it as verified without needing `v`.

Verifying also pins the value: a later Deezer lookup will not overwrite a
verified figure, the same protection manual corrections get. A manual
correction still wins over a verified Deezer value, so you can always re-tap.

`v` does nothing when nothing is playing, when the song has no BPM to vouch
for, or when it's already verified — each says which.

## Tempo playlists

`p` files the current song into whichever playlist covers its BPM:

| Playlist | BPM | Id from |
| --- | --- | --- |
| slowLindy | 100–120 | `PLAYLIST_SLOW_LINDY` |
| easyLindy | 120–140 | `PLAYLIST_EASY_LINDY` |
| classicLindy | 140–160 | `PLAYLIST_CLASSIC_LINDY` |
| charleston | 160–185 | `PLAYLIST_CHARLESTON` |
| shag | 185–220 | `PLAYLIST_SHAG` |
| balboa | 220–300 | `PLAYLIST_BALBOA` |

The playlist ids live in `.env`, not source — use the 22-character id from the
playlist's share link (`open.spotify.com/playlist/<id>`). A band with no id
still owns its BPM range; `p` on a song in it says which variable to set.

```
playlist: added easyLindy (120–140) at 131 bpm  Alberta Hunter — Sweet Georgia Brown
```

**Only verified BPMs can be filed.** An unverified figure is refused with a
pointer to `v`, since filing a track by a half-time Deezer guess would put it in
the wrong band.

Bands are **lower-inclusive, upper-exclusive** — 140 bpm is classicLindy, not
easyLindy — except balboa, which includes 300 so the top of the range isn't
homeless. A BPM below 100 or above 300 is reported and filed nowhere.

### Knowing what's already filed

All six playlists are read once at startup, so every song line says whether
it's already saved:

```
tempo playlists: 143 tracks across 6 bands
now playing: Alberta Hunter — Sweet Georgia Brown [131 bpm, deezer] (saved: easyLindy)
now playing: Peggy Lee — Why Don't You Do Right [149 bpm, deezer] (not saved)
```

A successful `p` updates that view immediately, so the song reads as saved from
then on and a second `p` is a no-op rather than a duplicate. The view is
in-memory only — it's rebuilt from Spotify on every start, so nothing to keep
in sync.

Podcasts and local files omit the marker entirely, since they can't be filed.

If the playlists can't be read, startup says so and `p` still works — you just
lose duplicate detection for songs filed in earlier sessions. Anything added in
*this* session is still remembered.

Editing `BANDS` in `src/playlists.ts` changes the BPM ranges.

### Permission

`p` needs three scopes beyond the basic playback read:

| Scope | For |
| --- | --- |
| `playlist-modify-public` | adding to a public playlist |
| `playlist-modify-private` | adding to a private one |
| `playlist-read-private` | reading contents, to skip duplicates |

**`playlist-read-private` is required even for public playlists you own** —
without it `GET /v1/me/playlists` fails with `Insufficient client scope`.

### `/tracks` is retired — use `/items`

`POST|GET /v1/playlists/{id}/tracks` returns **403 Forbidden**, for every
playlist including Spotify's own, no matter which scopes are granted. The live
endpoint is `/v1/playlists/{id}/items`, and it differs in one easily-missed way:

```jsonc
// /items  — the entry is nested under `item`
{ "items": [ { "item": { "id": "14gp5BfAMSA4Z2693x54QR" } } ] }
// asking for items(track(id)) returns [{}] — silently empty, not an error
```

Read with `fields=next,items(item(id))`. Using the old `track(...)` spelling
yields empty objects rather than a failure, so a duplicate check built on it
would quietly match nothing and file every song twice.

The `tracks` field is also absent from the playlist object now, so
`playlist.tracks.total` is `undefined`.

Changing the scope list doesn't upgrade an existing refresh token, so re-run
`npm run authorize` after any change here. Without the read scope, adding still
works — you just get one warning that duplicates can't be detected.

## The BPM store

BPMs persist in a SQLite file, `bpm.db` in the project directory — via Node's
built-in `node:sqlite`, so there's still nothing to install. Override the path
with `BPM_DB`.

Both Deezer answers and manual measurements are stored, keyed by Spotify track
id, with the title, artist, ISRC and a timestamp alongside for when you want to
read the table yourself:

```sh
sqlite3 bpm.db 'SELECT artist, title, bpm, source, verified FROM track_bpm ORDER BY updated_at DESC'
```

Precedence, enforced in SQL rather than in application logic:

- a stored value short-circuits both lookups — a known song costs no network
- **a Deezer answer never overwrites a manual correction, nor a verified value**
- a manual measurement always wins, and can itself be re-measured
- Deezer may refresh its own earlier value, but only while it's unverified

The `verified` column is `1` for anything confirmed by ear — every manual tap,
plus any Deezer figure you've pressed `v` on. A database created before this
column existed is migrated automatically on next start, with existing manual
rows backfilled as verified.

Only successful lookups are written. A Deezer miss is deliberately *not*
recorded, so a track gets another chance as their catalogue fills in.

If the database can't be opened or written, the poller logs one warning and
carries on with everything else working — measurements then apply for the
current session only, and the override line says so rather than claiming to
have saved.

Keyboard input needs a TTY, so this silently does nothing when stdout is piped
or the poller runs under launchd/systemd — everything else works as normal.
The terminal is put in raw mode while running, which is why Ctrl+C is handled
explicitly; it restores the terminal before exiting.

## The `updateLedMatrix` option

On by default. Turn it off and the poller still runs and logs every song
change, it just doesn't touch the display:

```sh
node src/poll.ts --no-updateLedMatrix
npm start -- --updateLedMatrix=false
UPDATE_LED_MATRIX=false npm start
```

Accepted spellings: `--updateLedMatrix`, `--updateLedMatrix=<value>`,
`--no-updateLedMatrix`, or `UPDATE_LED_MATRIX=<value>`. Values `0`, `false`,
`no`, and `off` mean off; anything else means on. A command-line flag beats the
environment variable.

## Layout

| File               | Role                                                      |
| ------------------ | --------------------------------------------------------- |
| `src/authorize.ts` | One-time OAuth consent → `.tokens.json`                   |
| `src/tokens.ts`    | Refresh-token storage, access-token minting + caching      |
| `src/poll.ts`      | The poll loop, change detection, backoff                   |
| `src/store.ts`     | SQLite BPM store (`bpm.db`), Deezer + manual values          |
| `src/playlists.ts` | Tempo bands and playlist filing                              |
| `src/isrc.ts`      | Resolves a track's ISRC via `/v1/tracks/{id}`, with cache    |
| `src/bpm.ts`       | Deezer BPM lookup by ISRC, with cache                       |
| `src/webhook.ts`   | ledctrl POST, retries                                      |
| `src/taptempo.ts`  | `j` tap tempo and `o` override keys (raw-mode keyboard)     |
| `src/log.ts`       | CRLF sanitization for logged third-party strings            |
| `src/config.ts`    | `.env` loading and constants                               |

## Things that will bite you

- **Dev Mode.** A new Spotify app only works for you plus up to 25 users you add
  by email in the dashboard. Anyone else gets a 403 at the consent screen.
- **Rate limits** are a rolling ~30s window with no published number, applied
  per-app across all users. 5s is comfortable for one user; `Retry-After` is
  honoured automatically. If you fan out to many users, widen the interval.
- **204 is normal** — idle playback *or* a private session, with no way to tell
  them apart. The poller emits `stopped` and slows to `IDLE_INTERVAL_MS`.
- **Short tracks get missed.** At 5s intervals, a track skipped after 3s never
  appears. If gapless history matters more than latency, reconcile against
  `/v1/me/player/recently-played` — authoritative, but only logs plays > 30s.
- **Ads** return `item: null`; those polls are skipped.
- **Replays** reuse the same track ID, so they're detected by `progress_ms`
  jumping backwards. A backwards *seek* within a track looks identical and will
  also fire `replay`.
- **The refresh token** doesn't expire on a timer, but Spotify sometimes rotates
  it on refresh — `tokens.ts` persists the new one when that happens. It dies
  for good if you revoke app access or change `SCOPES`; re-run `npm run authorize`.

## Running it for real

`.tokens.json` is written `0600` and gitignored, as is `.env`. For a long-lived
deploy, inject `SPOTIFY_REFRESH_TOKEN` from a secret store instead — it takes
precedence over the file.

As a user agent on macOS, or a systemd unit with
`Restart=always` on Linux — the loop never exits on its own, and survives
network errors and token expiry.
