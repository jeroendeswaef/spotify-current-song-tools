import { readFileSync, writeFileSync } from 'node:fs'
import { basicAuth, TOKEN_FILE } from './config.ts'

export type TokenResponse = {
  access_token: string
  token_type: string
  expires_in: number
  refresh_token?: string
  scope?: string
}

type Stored = { refresh_token: string }

export function readRefreshToken(): string | null {
  if (process.env.SPOTIFY_REFRESH_TOKEN) return process.env.SPOTIFY_REFRESH_TOKEN
  try {
    const stored = JSON.parse(readFileSync(TOKEN_FILE, 'utf8')) as Stored
    return stored.refresh_token ?? null
  } catch {
    return null
  }
}

export function writeRefreshToken(token: string): void {
  writeFileSync(TOKEN_FILE, JSON.stringify({ refresh_token: token }, null, 2) + '\n', {
    mode: 0o600,
  })
}

export async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: basicAuth,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`token request failed: ${res.status} ${text}`)
  return JSON.parse(text) as TokenResponse
}

let accessToken = ''
let expiresAt = 0

/** Returns a valid access token, refreshing ~60s before expiry. */
export async function getAccessToken(): Promise<string> {
  if (accessToken && Date.now() < expiresAt - 60_000) return accessToken

  const refreshToken = readRefreshToken()
  if (!refreshToken) {
    throw new Error('No refresh token. Run `npm run authorize` first.')
  }

  const tok = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken })
  accessToken = tok.access_token
  expiresAt = Date.now() + tok.expires_in * 1000

  // Spotify only sometimes rotates the refresh token. Persist it when it does,
  // otherwise the old one silently stops working later.
  if (tok.refresh_token && tok.refresh_token !== refreshToken) {
    writeRefreshToken(tok.refresh_token)
  }
  return accessToken
}

/** Force the next getAccessToken() to refresh — used after an unexpected 401. */
export function invalidateAccessToken(): void {
  expiresAt = 0
}
