/**
 * Persistent BPM store — a SQLite file in the project directory.
 *
 * Holds both Deezer lookups and manual tap measurements, so a restart doesn't
 * lose your corrections or re-ask Deezer for everything. Uses Node's built-in
 * `node:sqlite`, so there's still nothing to install.
 *
 * Every operation degrades to a no-op if the database can't be opened or
 * written — a bad disk must not stop songs reaching the display.
 */
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { ROOT } from './config.ts'
import { sanitizeForLog } from './log.ts'

export const DB_PATH = process.env.BPM_DB ?? join(ROOT, 'bpm.db')

export type BpmSource = 'deezer' | 'manual tap'
export type StoredBpm = { bpm: number; source: BpmSource; verified: boolean }

type Row = { bpm: number; source: string; verified: number }

let db: DatabaseSync | null = null
let opened = false

function open(): DatabaseSync | null {
  if (opened) return db
  opened = true
  try {
    db = new DatabaseSync(DB_PATH)
    db.exec(`
      CREATE TABLE IF NOT EXISTS track_bpm (
        track_id   TEXT PRIMARY KEY,
        isrc       TEXT,
        title      TEXT,
        artist     TEXT,
        bpm        INTEGER NOT NULL,
        source     TEXT NOT NULL,
        verified   INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      )
    `)

    // Databases created before `verified` existed need the column adding, and
    // their manual rows backfilling — a manual measurement is verified by
    // definition.
    const columns = db.prepare('PRAGMA table_info(track_bpm)').all() as { name: string }[]
    if (!columns.some((c) => c.name === 'verified')) {
      db.exec('ALTER TABLE track_bpm ADD COLUMN verified INTEGER NOT NULL DEFAULT 0')
      db.exec(`UPDATE track_bpm SET verified = 1 WHERE source = 'manual tap'`)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'open failed'
    console.warn(`store: disabled, could not open ${DB_PATH}: ${sanitizeForLog(message)}`)
    db = null
  }
  return db
}

/** Returns the stored BPM for a track, or null if there isn't one. */
export function loadBpm(trackId: string | null): StoredBpm | null {
  if (!trackId) return null
  const handle = open()
  if (!handle) return null

  try {
    const row = handle
      .prepare('SELECT bpm, source, verified FROM track_bpm WHERE track_id = ?')
      .get(trackId) as Row | undefined
    if (!row) return null
    return {
      bpm: row.bpm,
      source: row.source === 'manual tap' ? 'manual tap' : 'deezer',
      verified: row.verified === 1,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'read failed'
    console.warn(`store: read failed: ${sanitizeForLog(message)}`)
    return null
  }
}

export type SaveInput = {
  trackId: string
  isrc: string | null
  title: string | null
  artist: string | null
  bpm: number
}

/** Returns whether the value actually reached disk. */
function save(input: SaveInput, source: BpmSource): boolean {
  const handle = open()
  if (!handle) return false

  // A manual measurement is verified by definition; a Deezer answer is not
  // until someone presses `v`.
  const verified = source === 'manual tap' ? 1 : 0

  // A Deezer value must never clobber a manual correction, nor a Deezer figure
  // that has already been verified by ear.
  const guard =
    source === 'manual tap'
      ? ''
      : `WHERE track_bpm.source <> 'manual tap' AND track_bpm.verified = 0`

  try {
    handle
      .prepare(
        `INSERT INTO track_bpm (track_id, isrc, title, artist, bpm, source, verified, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(track_id) DO UPDATE SET
           isrc       = excluded.isrc,
           title      = excluded.title,
           artist     = excluded.artist,
           bpm        = excluded.bpm,
           source     = excluded.source,
           verified   = excluded.verified,
           updated_at = excluded.updated_at
         ${guard}`,
      )
      .run(
        input.trackId,
        input.isrc,
        input.title,
        input.artist,
        input.bpm,
        source,
        verified,
        new Date().toISOString(),
      )
    return true
  } catch (err) {
    const message = err instanceof Error ? err.message : 'write failed'
    console.warn(`store: write failed: ${sanitizeForLog(message)}`)
    return false
  }
}

export const saveDeezerBpm = (input: SaveInput): boolean => save(input, 'deezer')
export const saveManualBpm = (input: SaveInput): boolean => save(input, 'manual tap')

/**
 * Marks a stored BPM as verified by ear. Returns false when the store is
 * unavailable or there's no row for the track — there's nothing to vouch for
 * until a BPM has actually been recorded.
 */
export function markVerified(trackId: string): boolean {
  const handle = open()
  if (!handle) return false

  try {
    const result = handle
      .prepare('UPDATE track_bpm SET verified = 1, updated_at = ? WHERE track_id = ?')
      .run(new Date().toISOString(), trackId)
    return result.changes > 0
  } catch (err) {
    const message = err instanceof Error ? err.message : 'write failed'
    console.warn(`store: verify failed: ${sanitizeForLog(message)}`)
    return false
  }
}

/** Row count, for the startup line. Returns null when the store is disabled. */
export function countStored(): number | null {
  const handle = open()
  if (!handle) return null
  try {
    const row = handle.prepare('SELECT COUNT(*) AS n FROM track_bpm').get() as
      | { n: number }
      | undefined
    return row?.n ?? 0
  } catch {
    return null
  }
}
