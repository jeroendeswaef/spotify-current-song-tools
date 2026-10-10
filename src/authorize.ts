/**
 * One-time interactive consent. Opens the Spotify authorize page, catches the
 * redirect on 127.0.0.1, exchanges the code, and writes .tokens.json.
 *
 *   node src/authorize.ts
 */
import http from 'node:http'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { AUTH_HOST, AUTH_PORT, CLIENT_ID, REDIRECT_URI, SCOPES, TOKEN_FILE } from './config.ts'
import { tokenRequest, writeRefreshToken } from './tokens.ts'

const state = crypto.randomBytes(16).toString('hex')
const redirect = new URL(REDIRECT_URI)

const authUrl =
  'https://accounts.spotify.com/authorize?' +
  new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    scope: SCOPES,
    redirect_uri: REDIRECT_URI,
    state,
    // Force the consent screen so re-running always yields a fresh refresh token.
    show_dialog: 'true',
  })

function reply(res: http.ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(`<!doctype html><meta charset="utf-8"><title>Spotify auth</title>
<body style="font:16px system-ui;padding:3rem;max-width:40rem">${message}</body>`)
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', REDIRECT_URI)
  if (url.pathname !== redirect.pathname) return reply(res, 404, 'Not found.')

  const error = url.searchParams.get('error')
  if (error) {
    reply(res, 400, `<h1>Denied</h1><p>Spotify returned <code>${error}</code>.</p>`)
    console.error(`Authorization denied: ${error}`)
    return server.close(() => process.exit(1))
  }

  if (url.searchParams.get('state') !== state) {
    reply(res, 400, '<h1>State mismatch</h1><p>Possible CSRF. Nothing was saved.</p>')
    console.error('State mismatch — aborting.')
    return server.close(() => process.exit(1))
  }

  const code = url.searchParams.get('code')
  if (!code) return reply(res, 400, '<h1>No code in callback.</h1>')

  try {
    const tok = await tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI, // not a redirect — just has to match the first leg
    })
    if (!tok.refresh_token) throw new Error('no refresh_token in response')

    writeRefreshToken(tok.refresh_token)
    reply(res, 200, '<h1>Authorized</h1><p>Token saved. You can close this tab.</p>')
    console.log(`\nRefresh token written to ${TOKEN_FILE}`)
    console.log('Granted scopes:', tok.scope)
    console.log('\nNow run:  npm start')
    server.close(() => process.exit(0))
  } catch (err) {
    reply(res, 500, `<h1>Token exchange failed</h1><pre>${String(err)}</pre>`)
    console.error(err)
    server.close(() => process.exit(1))
  }
})

server.listen(AUTH_PORT, AUTH_HOST, () => {
  console.log(`Listening on http://${AUTH_HOST}:${AUTH_PORT}${redirect.pathname}`)
  console.log(`Expecting Spotify to redirect to ${REDIRECT_URI}\n`)
  console.log('Open this URL to authorize:\n')
  console.log(authUrl + '\n')
  if (process.env.NO_BROWSER) return
  if (process.platform === 'darwin') spawn('open', [authUrl], { stdio: 'ignore' }).unref()
  else if (process.platform === 'linux') spawn('xdg-open', [authUrl], { stdio: 'ignore' }).unref()
})

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${AUTH_PORT} is already in use — stop whatever holds it, or set AUTH_PORT.`)
    process.exit(1)
  }
  throw err
})
