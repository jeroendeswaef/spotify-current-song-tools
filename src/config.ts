import dns from 'node:dns'
import { readFileSync } from 'node:fs'
import net from 'node:net'
import { join } from 'node:path'

export const ROOT = join(import.meta.dirname, '..')
export const TOKEN_FILE = join(ROOT, '.tokens.json')

/**
 * Minimal .env loader. Node 24 has `--env-file`, but loading it ourselves keeps
 * the run command to a plain `node src/poll.ts`.
 */
function loadDotEnv(): void {
  let raw: string
  try {
    raw = readFileSync(join(ROOT, '.env'), 'utf8')
  } catch {
    return // no .env is fine — env vars may come from the shell or systemd
  }
  for (const line of raw.split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!match) continue
    const [, key, rest] = match
    if (process.env[key] !== undefined) continue // real env wins

    const value = rest.trim().replace(/^(['"])(.*)\1$/s, '$2')
    // A commented-out-style `KEY=` means "leave it unset". Assigning '' here
    // would defeat every `process.env.X ?? default` downstream — an empty
    // string is not nullish, so the default would never apply.
    if (value === '') continue
    process.env[key] = value
  }
}

loadDotEnv()

export function required(name: string): string {
  const value = process.env[name]
  if (!value) {
    console.error(`Missing ${name}. Copy .env.example to .env and fill it in.`)
    process.exit(1)
  }
  return value
}

export const CLIENT_ID = required('SPOTIFY_CLIENT_ID')
export const CLIENT_SECRET = required('SPOTIFY_CLIENT_SECRET')

/**
 * Must match a redirect URI registered in the Spotify dashboard byte-for-byte.
 * Non-loopback URIs must be https — TLS is terminated by the tunnel in front of
 * us, so this is a public URL even though we serve plain HTTP locally.
 */
export const REDIRECT_URI =
  process.env.SPOTIFY_REDIRECT_URI

/**
 * Where the callback server actually listens. Deliberately independent of
 * REDIRECT_URI: the public URL is https on :443, the local socket is http on
 * :8084. Set AUTH_HOST=0.0.0.0 if the mapping is a LAN port-forward rather than
 * a tunnel client running on this machine.
 */
export const AUTH_PORT = Number(process.env.AUTH_PORT || 8084)
export const AUTH_HOST = process.env.AUTH_HOST || '127.0.0.1'

/**
 * Reads a boolean option from either `--name` / `--name=false` / `--no-name` on
 * the command line, or an env var, in that order of precedence.
 */
function boolOption(flag: string, envVar: string, fallback: boolean): boolean {
  const off = new Set(['0', 'false', 'no', 'off'])

  for (const arg of process.argv.slice(2)) {
    if (arg === `--no-${flag}`) return false
    if (arg === `--${flag}`) return true
    if (arg.startsWith(`--${flag}=`)) return !off.has(arg.slice(flag.length + 3).toLowerCase())
  }

  const env = process.env[envVar]
  if (env !== undefined && env !== '') return !off.has(env.toLowerCase())

  return fallback
}

/**
 * Whether to push song changes to the LED matrix. Off means the poller still
 * runs and logs every change, it just doesn't touch the display.
 *
 *   node src/poll.ts --no-updateLedMatrix
 *   UPDATE_LED_MATRIX=false npm start
 */
export const UPDATE_LED_MATRIX = boolOption('updateLedMatrix', 'UPDATE_LED_MATRIX', true)

/**
 * Forces outbound connections onto IPv4.
 *
 * api.spotify.com publishes both A and AAAA records, and Node's Happy Eyeballs
 * races them. On mobile networks the IPv6 path is often advertised but
 * black-holed, which surfaces as an AggregateError with code ETIMEDOUT. Setting
 * this skips the IPv6 attempt entirely.
 *
 *   node src/poll.ts --ipv4
 *   FORCE_IPV4=1 npm start
 */
export const FORCE_IPV4 = boolOption('ipv4', 'FORCE_IPV4', false)

if (FORCE_IPV4) {
  dns.setDefaultResultOrder('ipv4first')
  net.setDefaultAutoSelectFamily(false)
}

/**
 * The playlist scopes are only needed for the `p` key (filing a song into its
 * tempo band). Changing this list invalidates an existing refresh token for the
 * new capability — re-run `npm run authorize` after editing.
 *
 * `playlist-read-private` is required even for *public* playlists you own:
 * playlist metadata reads without it, but reading the item list 403s. That read
 * is what stops the same song being filed twice.
 */
export const SCOPES = [
  'user-read-currently-playing',
  'playlist-read-private',
  'playlist-modify-public',
  'playlist-modify-private',
].join(' ')

export const basicAuth = 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')
