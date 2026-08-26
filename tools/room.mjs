// 실제 Supabase를 사용하는 다중 브라우저 E2E. 설정이 없으면 명확히 건너뛴다.
// 사용: node tools/room.mjs
import { createServer } from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const envFile = join(ROOT, '.env.local')
const env = Object.fromEntries(
  (existsSync(envFile) ? readFileSync(envFile, 'utf8') : '')
    .split(/\r?\n/).filter((line) => /^\s*\w+\s*=/.test(line))
    .map((line) => [line.slice(0, line.indexOf('=')).trim(), line.slice(line.indexOf('=') + 1).trim()]),
)
if (!(env.TW_SUPABASE_URL || process.env.TW_SUPABASE_URL) || !(env.TW_SUPABASE_KEY || process.env.TW_SUPABASE_KEY)) {
  console.log('SKIP: .env.local 에 Supabase 설정이 없어 멀티플레이 E2E를 건너뜁니다')
  process.exit(0)
}

const build = spawnSync(process.execPath, [join(ROOT, 'tools', 'build.mjs')], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env } })
if (build.status) process.exit(build.status || 1)

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find(existsSync)
if (!CHROME) throw new Error('크롬을 찾지 못했습니다')

const DEBUG_PORT = 9343
const SITE_PORT = 9344
const PAGE_URL = `http://127.0.0.1:${SITE_PORT}/index.html`
const profile = mkdtempSync(join(tmpdir(), 'todays-word-room-'))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const server = createServer((req, res) => {
  const path = (req.url || '/').split(/[?#]/)[0]
  const file = join(ROOT, 'dist', path === '/' ? 'index.html' : path.slice(1))
  try {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(readFileSync(file))
  } catch (e) { res.writeHead(404); res.end('not found') }
})
await new Promise((resolve) => server.listen(SITE_PORT, '127.0.0.1', resolve))
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' })

function connect(url) {
  const ws = new WebSocket(url)
  const pending = new Map()
  let id = 0
  ws.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data)
    if (!message.id || !pending.has(message.id)) return
    const task = pending.get(message.id)
    pending.delete(message.id)
    message.error ? task.reject(new Error(JSON.stringify(message.error))) : task.resolve(message.result)
  })
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const messageId = ++id
    pending.set(messageId, { resolve, reject })
    ws.send(JSON.stringify({ id: messageId, method, params, ...(sessionId ? { sessionId } : {}) }))
  })
  return { ws, ready, send }
}
async function browserSocket() {
  for (let i = 0; i < 60; i++) {
    try {
      const info = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json()
      if (info.webSocketDebuggerUrl) return info.webSocketDebuggerUrl
    } catch (e) { /* 시작 중 */ }
    await sleep(250)
  }
  throw new Error('크롬 디버깅 포트에 연결하지 못했습니다')
}

const cdp = connect(await browserSocket())
await cdp.ready
async function newPlayer(name, url = PAGE_URL) {
  const { browserContextId } = await cdp.send('Target.createBrowserContext')
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  const call = (method, params = {}) => cdp.send(method, params, sessionId)
  await call('Page.enable')
  await call('Runtime.enable')
  await call('Network.enable')
  await call('Network.setCacheDisabled', { cacheDisabled: true })
  await call('Page.addScriptToEvaluateOnNewDocument', { source: `
    globalThis.__sent = [];
    const originalSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) { globalThis.__sent.push(String(data)); return originalSend.call(this, data) };
  ` })
  const evaluate = async (expression) => {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || '브라우저 평가 오류')
    return result.result.value
  }
  await call('Page.navigate', { url })
  for (let i = 0; i < 80; i++) {
    if (await evaluate('document.readyState === "complete" && !!globalThis.Room').catch(() => false)) break
    await sleep(100)
  }
  return { name, browserContextId, evaluate }
}
async function waitFor(player, expression, timeout = 8000) {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    if (await player.evaluate(expression).catch(() => false)) return
    await sleep(200)
  }
  throw new Error(`${player.name}: 조건을 기다리다 시간 초과 — ${expression}`)
}
function ok(message) { console.log('OK  ' + message) }

let players = []
try {
  const a = await newPlayer('A')
  players.push(a)
  await a.evaluate(`(() => {
    document.querySelector('[data-go=rooms]').click()
    document.getElementById('roomNick').value = 'A'
    document.querySelector('[data-act=room-open-create]').click()
    document.querySelector('[data-act=room-create]').click()
  })()`)
  await waitFor(a, `!document.getElementById('lobby').hidden && document.getElementById('roomCode').textContent.length === 6`)
  const code = await a.evaluate(`document.getElementById('roomCode').textContent`)

  const b = await newPlayer('B', `${PAGE_URL}#r=${code}`)
  players.push(b)
  await waitFor(b, `document.getElementById('roomNick') !== null`)
  await b.evaluate(`(() => {
    document.getElementById('roomNick').value = 'B'
    document.querySelector('[data-act=room-join]').click()
  })()`)
  await waitFor(a, `document.querySelectorAll('#roomRoster li').length === 2`)
  ok('A 방 생성 → B 참가 → A 명단에 B 표시')

  await a.evaluate(`document.querySelector('[data-act=room-start]').click()`)
  await Promise.all([waitFor(a, `TW.state?.mode === 'versus'`), waitFor(b, `TW.state?.mode === 'versus'`)])
  ok('방장 시작 → 두 브라우저에 같은 단어 대결 시작')

  await b.evaluate(`(async () => {
    const answer = TW.state.answer
    const words = Words.answers[TW.state.size].filter((word) => word !== answer).slice(0, 3)
    for (const word of words) {
      for (const jamo of Hangul.decompose(word)) TW.press(jamo)
      await TW.submit()
      while (TW.busy) await new Promise((resolve) => setTimeout(resolve, 50))
    }
  })()`)
  await waitFor(a, `document.querySelectorAll('#peers .mini-tile.correct,#peers .mini-tile.present,#peers .mini-tile.absent').length >= TW.state.size * 3`)
  const privacy = await a.evaluate(`({ text: document.getElementById('peers').textContent, html: document.getElementById('peers').innerHTML })`)
  if (/[ㄱ-ㅎㅏ-ㅣ가-힣]/.test(privacy.text.replace('B', ''))) throw new Error('상대 미니보드에 글자가 보입니다')
  const markFrames = await b.evaluate(`__sent.filter((line) => line.includes('"event":"mark"'))`)
  if (!markFrames.length || markFrames.some((line) => line.includes('"guess"'))) throw new Error('mark 페이로드 프라이버시 검증 실패')
  ok('상대 3줄이 색상으로만 표시되고 guess 필드가 전송되지 않음')

  await a.evaluate(`(async () => {
    for (const jamo of TW.state.answerJamo) TW.press(jamo)
    await TW.submit()
    while (TW.busy) await new Promise((resolve) => setTimeout(resolve, 50))
    document.getElementById('btnMenu').click()
    document.querySelector('[data-act=room-force]').click()
  })()`)
  await Promise.all([waitFor(a, `document.querySelector('.score-list') !== null`), waitFor(b, `document.querySelector('.score-list') !== null`)])
  ok('방장 강제 종료 → 두 브라우저에 순위표 표시')
} finally {
  for (const player of players) await cdp.send('Target.disposeBrowserContext', { browserContextId: player.browserContextId }).catch(() => {})
  cdp.ws.close()
  chrome.kill()
  server.close()
  await sleep(300)
  try { rmSync(profile, { recursive: true, force: true }) } catch (e) { /* 무시 */ }
}
