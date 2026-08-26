// 실제 Supabase Realtime 의 join → presence → broadcast 왕복을 빠르게 확인한다.
// 사용: .env.local 에 URL/키를 넣고 `node tools/spike-realtime.mjs`
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const file = join(root, '.env.local')
const local = Object.fromEntries(
  (existsSync(file) ? readFileSync(file, 'utf8') : '')
    .split(/\r?\n/).filter((line) => /^\s*\w+\s*=/.test(line))
    .map((line) => [line.slice(0, line.indexOf('=')).trim(), line.slice(line.indexOf('=') + 1).trim()]),
)
const env = { ...local, ...process.env }
if (!env.TW_SUPABASE_URL || !env.TW_SUPABASE_KEY) {
  console.log('SKIP: .env.local 에 TW_SUPABASE_URL/TW_SUPABASE_KEY가 없습니다')
  process.exit(0)
}

const url = new URL(env.TW_SUPABASE_URL)
url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
url.pathname = '/realtime/v1/websocket'
url.search = ''
url.searchParams.set('apikey', env.TW_SUPABASE_KEY)
url.searchParams.set('vsn', '1.0.0')

const code = 'SPIKE2'
const topic = `realtime:tw:${code}`
const pid = `spike-${Date.now()}`
let ref = 0
const next = () => String(++ref)
const ws = new WebSocket(url)
const timeout = setTimeout(() => { console.error('FAIL: 10초 안에 왕복하지 못했습니다'); ws.close(); process.exitCode = 1 }, 10000)

ws.addEventListener('open', () => {
  const joinRef = next()
  ws.send(JSON.stringify({ topic, event: 'phx_join', ref: joinRef, join_ref: joinRef, payload: {
    config: { broadcast: { self: true, ack: false }, presence: { key: pid, enabled: true }, postgres_changes: [], private: false },
    ...(String(env.TW_SUPABASE_KEY).split('.').length === 3 ? { access_token: env.TW_SUPABASE_KEY } : {}),
  } }))
})
ws.addEventListener('message', ({ data }) => {
  const frame = JSON.parse(String(data))
  if (frame.event === 'phx_reply' && frame.payload?.status === 'ok') {
    ws.send(JSON.stringify({ topic, event: 'presence', ref: next(), payload: {
      type: 'presence', event: 'track', payload: { pid, nick: 'spike', joinedAt: Date.now() },
    } }))
    ws.send(JSON.stringify({ topic, event: 'broadcast', ref: next(), payload: {
      type: 'broadcast', event: 'spike', payload: { ok: true },
    } }))
  }
  if (frame.event === 'broadcast' && frame.payload?.event === 'spike') {
    clearTimeout(timeout)
    console.log('OK: phx_join → presence → broadcast 왕복 성공')
    ws.close()
  }
})
ws.addEventListener('error', () => { clearTimeout(timeout); console.error('FAIL: WebSocket 연결 오류'); process.exitCode = 1 })
