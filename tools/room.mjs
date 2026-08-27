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
    const body = readFileSync(file)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(body)
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
  })()`)
  await waitFor(a, `document.body.classList.contains('watching') && !document.getElementById('quickChat').hidden && document.getElementById('gameSub').textContent.includes('마감까지')`)
  await a.evaluate(`document.querySelector('[data-chat="화이팅!"]').click()`)
  await waitFor(b, `document.getElementById('toast').textContent.includes('화이팅!')`)
  await a.evaluate(`document.querySelector('#quickChat [data-act=room-force]').click()`)
  await Promise.all([waitFor(a, `document.querySelector('.score-list') !== null`), waitFor(b, `document.querySelector('.score-list') !== null`)])
  ok('완주자 관전 · 고정 응원 · 60초 카운트다운 · 즉시 종료')

  async function createMode(kind, size = 4, rounds = 1) {
    await b.evaluate(`TW.GOES.leave()`)
    await a.evaluate(`TW.GOES.leave()`)
    await Promise.all([waitFor(a, `!document.getElementById('home').hidden`), waitFor(b, `!document.getElementById('home').hidden`)])
    await a.evaluate(`(() => {
      document.querySelector('[data-go=rooms]').click()
      document.getElementById('roomNick').value = 'A'
      document.querySelector('[data-act=room-open-create]').click()
      document.querySelector('[data-rmode="${kind}"]').click()
      document.querySelector('[data-rsize="${size}"]').click()
      ${kind === 'relay' ? `document.querySelector('[data-rounds="${rounds}"]').click()` : ''}
      document.querySelector('[data-act=room-create]').click()
    })()`)
    await waitFor(a, `!document.getElementById('lobby').hidden && document.getElementById('roomCode').textContent.length === 6`)
    const nextCode = await a.evaluate(`document.getElementById('roomCode').textContent`)
    await b.evaluate(`(() => {
      document.querySelector('[data-go=rooms]').click()
      document.getElementById('roomNick').value = 'B'
      document.getElementById('roomJoinCode').value = '${nextCode}'
      document.querySelector('[data-act=room-join]').click()
    })()`)
    await waitFor(a, `document.querySelectorAll('#roomRoster li').length === 2`)
    return nextCode
  }

  await createMode('setter', 4)
  await Promise.all([
    waitFor(a, `Room.current?.kind === 'setter' && Room.current.setterPid === Room.current.me.pid && Net.status === 'live' && !document.querySelector('[data-act=room-start]').disabled`),
    waitFor(b, `Room.current?.kind === 'setter' && Room.current.peers.size >= 2`),
  ])
  await a.evaluate(`document.querySelector('[data-act=room-start]').click()`)
  await waitFor(a, `document.getElementById('roomWord') !== null`)
  const lenient = await a.evaluate(`(() => {
    const input = document.getElementById('roomWord')
    input.value = '퍄퍄'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return { disabled: document.getElementById('roomWordButton').disabled, hint: document.getElementById('roomWordHint').textContent }
  })()`)
  if (lenient.disabled || !lenient.hint.includes('그래도')) throw new Error('출제 대결의 사전 경고/허용 동작이 잘못됐습니다')
  await a.evaluate(`document.querySelector('[data-act=room-word]').click()`)
  await Promise.all([waitFor(a, `TW.state?.mode === 'setter'`), waitFor(b, `TW.state?.mode === 'setter'`)])
  const setterView = await a.evaluate(`({ watching: document.body.classList.contains('watching'), keyboard: document.getElementById('keyboard').hidden, banner: document.getElementById('roomBanner').textContent })`)
  if (!setterView.watching || !setterView.keyboard || !setterView.banner.includes('퍄퍄')) throw new Error('출제자 관전 화면이 잘못됐습니다')
  await b.evaluate(`(async () => {
    for (const jamo of TW.state.answerJamo) TW.press(jamo)
    await TW.submit()
    while (TW.busy) await new Promise((resolve) => setTimeout(resolve, 50))
  })()`)
  await Promise.all([waitFor(a, `document.querySelector('.score-list') !== null`), waitFor(b, `document.querySelector('.score-list') !== null`)])
  ok('출제 대결 → 사전 밖 단어 허용 · 출제자 관전 · 정답 제출')

  await createMode('relay', 4, 3)
  for (let round = 1; round <= 3; round++) {
    await a.evaluate(`document.querySelector('[data-act=${round === 1 ? 'room-start' : 'room-next'}]')?.click()`)
    await Promise.all([waitFor(a, `TW.state?.mode === 'relay' && Room.current.round === ${round} && !Room.current.over`), waitFor(b, `TW.state?.mode === 'relay' && Room.current.round === ${round} && !Room.current.over`)])
    const winner = round === 1 ? b : a
    await winner.evaluate(`(async () => {
      for (const jamo of TW.state.answerJamo) TW.press(jamo)
      await TW.submit()
      while (TW.busy) await new Promise((resolve) => setTimeout(resolve, 50))
    })()`)
    await waitFor(a, `Room.current.results.size >= 1`)
    await a.evaluate(`(() => { document.getElementById('btnMenu').click(); document.querySelector('[data-act=room-force]').click() })()`)
    await Promise.all([waitFor(a, `document.querySelector('.score-list') !== null`), waitFor(b, `document.querySelector('.score-list') !== null`)])
  }
  await a.evaluate(`document.querySelector('[data-act=room-standings]').click()`)
  const standings = await a.evaluate(`document.querySelector('.score-list').textContent`)
  if (!standings.includes('10점') || !standings.includes('5점')) throw new Error('릴레이 누적 점수가 맞지 않습니다: ' + standings)
  ok('릴레이 → 3라운드 연속 진행 · 누적 점수 · 최종 순위')

  const coopCode = await createMode('coop', 4)
  const c = await newPlayer('C')
  players.push(c)
  await c.evaluate(`(() => {
    document.querySelector('[data-go=rooms]').click()
    document.getElementById('roomNick').value = 'C'
    document.getElementById('roomJoinCode').value = '${coopCode}'
    document.querySelector('[data-act=room-join]').click()
  })()`)
  await Promise.all([waitFor(a, `document.querySelectorAll('#roomRoster li').length === 3`), waitFor(b, `Room.current.peers.size >= 3`), waitFor(c, `Room.current.peers.size >= 3`)])
  await a.evaluate(`document.querySelector('[data-act=room-start]').click()`)
  await Promise.all([waitFor(a, `TW.state?.mode === 'coop'`), waitFor(b, `TW.state?.mode === 'coop'`), waitFor(c, `TW.state?.mode === 'coop'`)])
  await a.evaluate(`(async () => {
    const word = Words.answers[TW.state.size].find((candidate) => candidate !== TW.state.answer)
    for (const jamo of Hangul.decompose(word)) TW.press(jamo)
    await TW.submit()
  })()`)
  await Promise.all([waitFor(a, `TW.state?.guesses.length === 1 && Room.current.turnPid !== Room.current.me.pid`), waitFor(b, `TW.state?.guesses.length === 1 && Room.current.turnPid === Room.current.me.pid`), waitFor(c, `TW.state?.guesses.length === 1`)])
  const before = await a.evaluate(`TW.state.current.length`)
  await a.evaluate(`TW.press('ㄱ')`)
  const after = await a.evaluate(`TW.state.current.length`)
  if (before !== after) throw new Error('협동 모드에서 차례가 아닌 입력이 반영됐습니다')
  await b.evaluate(`(async () => {
    const word = Words.answers[TW.state.size].find((candidate) => candidate !== TW.state.answer && Hangul.encode(Hangul.decompose(candidate)) !== Hangul.encode(TW.state.guesses[0]))
    for (const jamo of Hangul.decompose(word)) TW.press(jamo)
    await TW.submit()
  })()`)
  await Promise.all([waitFor(a, `TW.state?.guesses.length === 2`), waitFor(b, `TW.state?.guesses.length === 2 && Room.current.turnPid !== Room.current.me.pid`), waitFor(c, `TW.state?.guesses.length === 2 && Room.current.turnPid === Room.current.me.pid`)])
  await c.evaluate(`(async () => {
    for (const jamo of TW.state.answerJamo) TW.press(jamo)
    await TW.submit()
  })()`)
  await Promise.all([waitFor(a, `document.querySelector('.answer-reveal') !== null`), waitFor(b, `document.querySelector('.answer-reveal') !== null`), waitFor(c, `document.querySelector('.answer-reveal') !== null`)])
  const shared = await Promise.all([a, b, c].map((player) => player.evaluate(`TW.state.guesses.map((guess) => Hangul.encode(guess)).join(',')`)))
  if (new Set(shared).size !== 1 || shared[0].split(',').length !== 3) throw new Error('협동 공유 보드가 세 브라우저에서 갈라졌습니다: ' + JSON.stringify(shared))
  const answerShown = await c.evaluate(`document.querySelector('.answer-reveal').textContent.includes(TW.state.answer)`)
  if (!answerShown) throw new Error('협동 결과에 정답이 표시되지 않았습니다')
  ok('협동 3인 → 방장 확정 보드 · 한 줄씩 순환 · 턴 잠금 · 정답 공개')

  await a.evaluate(`document.querySelector('[data-act=room-again]').click()`)
  await Promise.all([waitFor(a, `TW.state?.mode === 'coop' && TW.state.guesses.length === 0 && !Room.current.over`), waitFor(b, `TW.state?.mode === 'coop' && TW.state.guesses.length === 0 && !Room.current.over`), waitFor(c, `TW.state?.mode === 'coop' && TW.state.guesses.length === 0 && !Room.current.over`)])
  const turns = [a, b, c, a, b]
  for (let row = 0; row < turns.length; row++) {
    await turns[row].evaluate(`(async () => {
      const word = Words.answers[TW.state.size].filter((candidate) => candidate !== TW.state.answer)[${row}]
      for (const jamo of Hangul.decompose(word)) TW.press(jamo)
      await TW.submit()
    })()`)
    await Promise.all([a, b, c].map((player) => waitFor(player, `TW.state?.guesses.length === ${row + 1} && !TW.busy`)))
  }
  await Promise.all([a, b, c].map((player) => waitFor(player, `Room.current.finalChance?.active && !document.getElementById('finalChance').hidden`)))
  await Promise.all([
    a.evaluate(`(() => { const input = document.getElementById('finalWord'); input.value = Words.answers[TW.state.size].filter((word) => word !== TW.state.answer)[8]; input.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('finalSubmit').click() })()`),
    b.evaluate(`(() => { const input = document.getElementById('finalWord'); input.value = Words.answers[TW.state.size].filter((word) => word !== TW.state.answer)[9]; input.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('finalSubmit').click() })()`),
    c.evaluate(`(() => { const input = document.getElementById('finalWord'); input.value = TW.state.answer; input.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('finalSubmit').click() })()`),
  ])
  await Promise.all([a, b, c].map((player) => waitFor(player, `Room.current.coopResult?.winnerPid && document.querySelector('.answer-reveal')?.textContent.includes(TW.state.answer)`)))
  const finalWinner = await a.evaluate(`({ pid: Room.current.coopResult.winnerPid, name: document.querySelector('#sheetCard h2').textContent, rows: TW.state.guesses.length })`)
  const cPid = await c.evaluate(`Room.current.me.pid`)
  if (finalWinner.pid !== cPid || !finalWinner.name.includes('C') || finalWinner.rows !== 5) throw new Error('협동 마지막 기회 승자 처리 실패: ' + JSON.stringify(finalWinner))
  ok('협동 5회 실패 → 전원 동시 마지막 기회 · 최초 정답자 C 승리')
} finally {
  for (const player of players) await cdp.send('Target.disposeBrowserContext', { browserContextId: player.browserContextId }).catch(() => {})
  cdp.ws.close()
  chrome.kill()
  server.close()
  await sleep(300)
  try { rmSync(profile, { recursive: true, force: true }) } catch (e) { /* 무시 */ }
}
