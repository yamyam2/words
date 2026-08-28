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
  return { name, browserContextId, evaluate, call }
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
  const rootModes = await a.evaluate(`[...document.querySelectorAll('#homeRootMenu .btn')].filter((button) => !button.hidden).map((button) => button.textContent.trim())`)
  if (rootModes.join(',') !== '싱글 모드,멀티 모드') throw new Error('첫 화면 2단계 메뉴 실패: ' + JSON.stringify(rootModes))
  await a.evaluate(`(() => {
    document.querySelector('[data-go=rooms]').click()
    document.getElementById('roomNick').value = 'A'
    document.querySelector('[data-room-new=versus]').click()
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
  if (!markFrames.length || markFrames.some((line) => !line.includes('"guess"'))) throw new Error('mark 추측 전송 검증 실패')
  ok('진행 중인 상대 화면에는 3줄이 색상으로만 표시됨')

  await a.evaluate(`(async () => {
    for (const jamo of TW.state.answerJamo) TW.press(jamo)
    await TW.submit()
    while (TW.busy) await new Promise((resolve) => setTimeout(resolve, 50))
  })()`)
  await waitFor(a, `document.body.classList.contains('watching') && !document.getElementById('quickChat').hidden && document.getElementById('gameSub').textContent.includes('마감까지')`)
  await waitFor(a, `document.getElementById('peers').textContent.replace('B', '').match(/[ㄱ-ㅎㅏ-ㅣ가-힣]/)`)
  await a.evaluate(`document.querySelector('[data-chat="화이팅!"]').click()`)
  await waitFor(b, `document.getElementById('toast').textContent.includes('화이팅!')`)
  await sleep(800)
  await a.evaluate(`(() => { document.querySelector('[data-act=room-chat-toggle]').click(); const input = document.getElementById('roomChatInput'); input.value = '조금만 더 힘내!'; document.querySelector('[data-act=room-chat-send]').click() })()`)
  await waitFor(b, `Room.current.messages.some((message) => message.text === '조금만 더 힘내!')`)
  await a.evaluate(`document.querySelector('#quickChat [data-act=room-force]').click()`)
  await Promise.all([waitFor(a, `document.querySelector('.score-list') !== null`), waitFor(b, `document.querySelector('.score-list') !== null`)])
  ok('완주자 관전에서 실제 추측 확인 · 고정 응원 · 자유 채팅 · 즉시 종료')

  async function createMode(kind, size = 4, rounds = 1) {
    await b.evaluate(`TW.GOES.leave()`)
    await a.evaluate(`TW.GOES.leave()`)
    await Promise.all([waitFor(a, `!document.getElementById('home').hidden`), waitFor(b, `!document.getElementById('home').hidden`)])
    await a.evaluate(`(() => {
      document.querySelector('[data-go=rooms]').click()
      document.getElementById('roomNick').value = 'A'
      document.querySelector('[data-room-new="${kind}"]').click()
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

  await createMode('setter', 5)
  await Promise.all([
    waitFor(a, `Room.current?.kind === 'setter' && document.querySelectorAll('[data-setter]').length === 2 && Net.status === 'live' && !document.querySelector('[data-act=room-start]').disabled`),
    waitFor(b, `Room.current?.kind === 'setter' && Net.status === 'live'`),
  ])
  const setterPid = await b.evaluate(`Room.current.me.pid`)
  await a.evaluate(`document.querySelector('[data-setter="${setterPid}"]').click()`)
  await waitFor(a, `Room.current.setterPid === '${setterPid}' && document.querySelector('[data-setter="${setterPid}"]').getAttribute('aria-pressed') === 'true'`)
  await a.evaluate(`document.querySelector('[data-act=room-start]').click()`)
  await waitFor(b, `document.getElementById('roomWord') !== null`)
  const preserved = await b.evaluate(`(() => {
    const input = document.getElementById('roomWord')
    input.value = '오빠'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return { disabled: document.getElementById('roomWordButton').disabled, hint: document.getElementById('roomWordHint').textContent }
  })()`)
  if (preserved.disabled) throw new Error('오빠를 출제할 수 없습니다: ' + JSON.stringify(preserved))
  await b.evaluate(`document.querySelector('[data-act=room-word]').click()`)
  await Promise.all([waitFor(a, `TW.state?.mode === 'setter'`), waitFor(b, `TW.state?.mode === 'setter'`)])
  const setterView = await b.evaluate(`({ watching: document.body.classList.contains('watching'), keyboard: document.getElementById('keyboard').hidden, banner: document.getElementById('roomBanner').textContent, answer: TW.state.answer })`)
  const playerAnswer = await a.evaluate(`TW.state.answer`)
  if (!setterView.watching || !setterView.keyboard || !setterView.banner.includes('오빠') || setterView.answer !== '오빠' || playerAnswer !== '오빠') throw new Error('출제자 선택 또는 오빠 원문 보존 실패: ' + JSON.stringify({ setterView, playerAnswer }))
  const setterGuess = await a.evaluate(`(async () => {
    const word = Words.answers[TW.state.size].find((candidate) => candidate !== TW.state.answer)
    for (const jamo of Hangul.decompose(word)) TW.press(jamo)
    await TW.submit()
    while (TW.busy) await new Promise((resolve) => setTimeout(resolve, 50))
    return word
  })()`)
  await waitFor(b, `document.getElementById('peers').textContent.includes('${setterGuess}')`)
  await a.evaluate(`(async () => {
    for (const jamo of TW.state.answerJamo) TW.press(jamo)
    await TW.submit()
    while (TW.busy) await new Promise((resolve) => setTimeout(resolve, 50))
  })()`)
  await Promise.all([waitFor(a, `document.querySelector('.score-list') !== null`), waitFor(b, `document.querySelector('.score-list') !== null`)])
  ok('출제 대결 → 방장이 출제자 선택 · 오빠 원문 보존 · 출제자가 실제 추측 확인')

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
  await Promise.all([a, b, c].map((player) => waitFor(player, `Room.current.over && document.querySelector('#sheetCard').textContent.includes('1/3')`)))
  await Promise.all([b, c].map((player) => player.evaluate(`document.querySelector('[data-act=room-again]').click()`)))
  await Promise.all([a, b, c].map((player) => waitFor(player, `!Room.current.startedAt && !Room.current.over && !document.getElementById('lobby').hidden`)))
  ok('한 번 더!! → 준비 인원 1/3 공유 · 전원 준비 후 같은 방 로비 복귀')
  await a.evaluate(`document.querySelector('[data-act=room-start]').click()`)
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
  const aPid = await a.evaluate(`Room.current.me.pid`)
  const cPid = await c.evaluate(`Room.current.me.pid`)
  await c.evaluate(`(() => { const input = document.getElementById('finalWord'); input.value = TW.state.answer; input.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('finalSubmit').click() })()`)
  await Promise.all([a, b, c].map((player) => waitFor(player, `Room.current.finalChance?.submitted.has('${cPid}')`)))
  const stayedOpen = await a.evaluate(`Room.current.finalChance?.active && !Room.current.over && document.getElementById('finalChance').hidden === false`)
  if (!stayedOpen) throw new Error('첫 정답 뒤 다른 참가자의 마지막 기회를 기다리지 않았습니다')
  await sleep(150)
  await a.evaluate(`(() => { const input = document.getElementById('finalWord'); input.value = TW.state.answer; input.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('finalSubmit').click() })()`)
  await Promise.all([a, b, c].map((player) => waitFor(player, `Room.current.finalChance?.submitted.has('${aPid}')`)))
  await b.evaluate(`(() => { const input = document.getElementById('finalWord'); input.value = Words.answers[TW.state.size].filter((word) => word !== TW.state.answer)[9]; input.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('finalSubmit').click() })()`)
  await Promise.all([a, b, c].map((player) => waitFor(player, `Room.current.coopResult?.winnerPid && document.querySelector('.answer-reveal')?.textContent.includes(TW.state.answer)`)))
  const finalWinner = await a.evaluate(`({ pid: Room.current.coopResult.winnerPid, ranking: Room.current.coopResult.finalResults.filter((result) => result.status === 'won').sort((x, y) => x.ms - y.ms).map((result) => result.pid), name: document.querySelector('#sheetCard h2').textContent, text: document.querySelector('#sheetCard').textContent, rows: TW.state.guesses.length })`)
  if (finalWinner.pid !== cPid || finalWinner.ranking.join(',') !== [cPid, aPid].join(',') || !finalWinner.name.includes('C') || !finalWinner.text.includes('오답') || !finalWinner.text.includes('정규 5회 실패 후 마지막 기회') || finalWinner.text.includes('5/5') || finalWinner.rows !== 5) throw new Error('협동 마지막 기회 시간 순위 처리 실패: ' + JSON.stringify(finalWinner))
  const wrongPlayerButton = await b.evaluate(`(() => { Room.current.readyVoters = new Set(['${aPid}']); TW.openSheet('scoreboard'); return document.querySelector('[data-act=room-again]')?.textContent || '' })()`)
  if (!wrongPlayerButton.includes('한 번 더')) throw new Error('Presence 명단에서 잠시 빠진 오답자에게 한 번 더 버튼이 보이지 않습니다: ' + wrongPlayerButton)
  ok('협동 5회 실패 → 첫 정답 뒤 전원 대기 · 정답자 제출 시간 순위')

  const extras = []
  for (const name of ['D', 'E', 'F']) {
    const player = await newPlayer(name, `${PAGE_URL}#r=${coopCode}`)
    players.push(player); extras.push(player)
    await waitFor(player, `document.getElementById('roomNick') !== null`)
    await player.evaluate(`(() => { document.getElementById('roomNick').value = '${name}'; document.querySelector('[data-act=room-join]').click() })()`)
  }
  const six = [a, b, c, ...extras]
  await waitFor(a, `Array.from(Room.current.peers.values()).filter((player) => player.online).length === 6`)
  await Promise.all(six.map((player) => waitFor(player, `Room.current.over && document.querySelector('[data-act=room-again]') !== null`, 12000)))
  await Promise.all(six.map((player) => player.evaluate(`document.querySelector('[data-act=room-again]').click()`)))
  await Promise.all(six.map((player) => waitFor(player, `!Room.current.startedAt && !Room.current.over && !document.getElementById('lobby').hidden`, 12000)))
  await a.evaluate(`document.querySelector('[data-act=room-start]').click()`)
  await Promise.all(six.map((player) => waitFor(player, `TW.state?.mode === 'coop' && Room.current.maxTries === 6 && document.querySelectorAll('#board .row').length === 6`, 12000)))
  const pagesByPid = new Map()
  for (const player of six) pagesByPid.set(await player.evaluate(`Room.current.me.pid`), player)
  for (let row = 0; row < 6; row++) {
    const turnPid = await a.evaluate(`Room.current.turnPid`)
    const player = pagesByPid.get(turnPid)
    if (!player) throw new Error('6인 협동 차례 참가자를 찾지 못했습니다: ' + turnPid)
    await player.evaluate(`(async () => {
      const word = Words.answers[TW.state.size].find((candidate) => Hangul.encode(Hangul.decompose(candidate)) !== Hangul.encode(TW.state.answerJamo))
      for (const jamo of Hangul.decompose(word)) TW.press(jamo)
      await TW.submit()
    })()`)
    await Promise.all(six.map((page) => waitFor(page, `TW.state?.guesses.length === ${row + 1} && !TW.busy`, 12000)))
  }
  await Promise.all(six.map((player) => waitFor(player, `Room.current.finalChance?.active && TW.state.guesses.length === 6`, 12000)))
  ok('협동 6인 → 공유 보드 6줄 · 전원 최소 한 번씩 차례 보장')

  await a.evaluate(`(() => { document.getElementById('btnMenu').click(); document.querySelector('[data-act=room-force]').click() })()`)
  await Promise.all(six.map((player) => waitFor(player, `Room.current.over`, 12000)))
  const teamCode = await createMode('team', 4)
  const d = extras[0]
  for (const player of [c, d]) {
    await player.evaluate(`(() => { TW.GOES.leave(); document.querySelector('[data-go=rooms]').click(); document.getElementById('roomNick').value = '${player.name}'; document.getElementById('roomJoinCode').value = '${teamCode}'; document.querySelector('[data-act=room-join]').click() })()`)
  }
  const four = [a, b, c, d]
  await Promise.all(four.map((player) => waitFor(player, `Room.current?.kind === 'team' && Array.from(Room.current.peers.values()).filter((p) => p.online).length === 4`, 12000)))
  const pids = Object.fromEntries(await Promise.all(four.map(async (player) => [player.name, await player.evaluate(`Room.current.me.pid`)])))
  await a.call('Emulation.setDeviceMetricsOverride', { width: 393, height: 852, deviceScaleFactor: 3, mobile: true })
  await a.evaluate(`(() => {
    document.querySelector('[data-team-pid="${pids.A}"][data-team="red"]').click()
    document.querySelector('[data-team-pid="${pids.B}"][data-team="blue"]').click()
    document.querySelector('[data-team-pid="${pids.C}"][data-team="red"]').click()
    document.querySelector('[data-team-pid="${pids.D}"][data-team="blue"]').click()
    document.querySelector('[data-act=room-start]').click()
  })()`)
  await Promise.all(four.map((player) => waitFor(player, `TW.state?.mode === 'team' && !Room.current.over`, 12000)))
  await sleep(500)
  const firstTeamTile = await a.evaluate(`Math.round(document.querySelector('#board .tile').getBoundingClientRect().width)`)
  if (firstTeamTile > 60) throw new Error('iPhone 첫 팀전의 단어 칸이 너무 큽니다: ' + firstTeamTile)
  for (const player of [a, b]) {
    await player.evaluate(`(async () => {
      const word = Words.answers[TW.state.size].find((candidate) => candidate !== TW.state.answer)
      for (const jamo of Hangul.decompose(word)) TW.press(jamo)
      await TW.submit()
    })()`)
  }
  await Promise.all(four.map((player) => waitFor(player, `Room.current.teamBoards.red.length === 1 && Room.current.teamBoards.blue.length === 1 && !TW.busy`, 12000)))
  const activeOpponent = await a.evaluate(`document.querySelector('[data-team-board="blue"] .mini-tile.correct,[data-team-board="blue"] .mini-tile.present,[data-team-board="blue"] .mini-tile.absent') !== null`)
  if (!activeOpponent) throw new Error('팀전 진행 화면에서 상대 팀 색 보드가 보이지 않습니다')
  await a.evaluate(`(() => { document.querySelector('[data-act=room-chat-toggle]').click(); const input = document.getElementById('roomChatInput'); input.value = '전체 채팅 테스트'; document.querySelector('[data-act=room-chat-send]').click() })()`)
  await Promise.all(four.map((player) => waitFor(player, `Room.current.messages.some((message) => message.text === '전체 채팅 테스트')`)))
  await sleep(800)
  await a.evaluate(`(() => { document.querySelector('[data-chat-scope="team"]').click(); const input = document.getElementById('roomChatInput'); input.value = '빨강팀만 보여요'; document.querySelector('[data-act=room-chat-send]').click() })()`)
  await waitFor(c, `Room.current.messages.some((message) => message.text === '빨강팀만 보여요')`)
  await sleep(500)
  if (await d.evaluate(`Room.current.messages.some((message) => message.text === '빨강팀만 보여요')`)) throw new Error('팀 채팅이 상대 팀에 전달됐습니다')
  await c.evaluate(`(async () => { for (const jamo of TW.state.answerJamo) TW.press(jamo); await TW.submit() })()`)
  await Promise.all([a, c].map((player) => waitFor(player, `document.body.classList.contains('watching') && Room.current.teamStatus.red === 'won'`, 12000)))
  const spectatorColors = await a.evaluate(`document.querySelector('[data-team-board="blue"] .mini-tile.correct,[data-team-board="blue"] .mini-tile.present,[data-team-board="blue"] .mini-tile.absent') !== null`)
  if (!spectatorColors) throw new Error('팀전 관전 화면에서 상대 팀 색 보드가 사라졌습니다')
  await d.evaluate(`(async () => { for (const jamo of TW.state.answerJamo) TW.press(jamo); await TW.submit() })()`)
  await Promise.all(four.map((player) => waitFor(player, `Room.current.over && document.querySelector('.team-score') !== null`, 12000)))
  const teamResult = await a.evaluate(`({ winner: Room.current.teamResult[0].team, colors: document.querySelectorAll('.team-score li').length, answerShown: document.querySelector('.answer-reveal').textContent.includes(TW.state.answer) })`)
  if (teamResult.winner !== 'red' || teamResult.colors !== 2 || !teamResult.answerShown) throw new Error('팀전 결과 처리 실패: ' + JSON.stringify(teamResult))
  ok('팀전 2:2 → 팀별 공유 턴 · 전체/팀 채팅 · 관전 중 상대 색 보드 · 시간 순위')

  await Promise.all(four.map((player) => player.evaluate(`document.querySelector('[data-act=room-again]').click()`)))
  await Promise.all(four.map((player) => waitFor(player, `!Room.current.startedAt && !Room.current.over && !document.getElementById('lobby').hidden`, 12000)))
  await a.evaluate(`document.querySelector('[data-act=room-start]').click()`)
  await Promise.all(four.map((player) => waitFor(player, `TW.state?.mode === 'team' && !Room.current.over`, 12000)))
  await sleep(500)
  const rematchTile = await a.evaluate(`Math.round(document.querySelector('#board .tile').getBoundingClientRect().width)`)
  if (rematchTile > 60 || Math.abs(rematchTile - firstTeamTile) > 2) throw new Error(`iPhone 팀전 첫 판/다시 하기 칸 크기가 다릅니다: ${firstTeamTile} / ${rematchTile}`)
  const fourByPid = new Map()
  for (const player of four) fourByPid.set(await player.evaluate(`Room.current.me.pid`), player)
  for (let row = 0; row < 5; row++) {
    for (const team of ['red', 'blue']) {
      const turnPid = await a.evaluate(`Room.current.teamTurns.${team}`)
      const player = fourByPid.get(turnPid)
      if (!player) throw new Error('팀 마지막 기회 전 차례 참가자를 찾지 못했습니다: ' + turnPid)
      await player.evaluate(`(async () => {
        const word = Words.answers[TW.state.size].find((candidate) => candidate !== TW.state.answer)
        for (const jamo of Hangul.decompose(word)) TW.press(jamo)
        await TW.submit()
      })()`)
      await Promise.all(four.map((page) => waitFor(page, `Room.current.teamBoards.${team}.length === ${row + 1} && !TW.busy`, 12000)))
    }
  }
  await Promise.all(four.map((player) => waitFor(player, `Room.current.teamFinals[Room.current.teams.get(Room.current.me.pid)]?.active && !document.getElementById('finalChance').hidden`, 12000)))
  for (const player of [a, c, b]) {
    await player.evaluate(`(() => { const input = document.getElementById('finalWord'); input.value = TW.state.answer; input.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('finalSubmit').click() })()`)
  }
  await d.evaluate(`(() => { const input = document.getElementById('finalWord'); input.value = Words.answers[TW.state.size].find((word) => word !== TW.state.answer); input.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('finalSubmit').click() })()`)
  await Promise.all(four.map((player) => waitFor(player, `Room.current.over && document.querySelector('.team-score') !== null`, 12000)))
  const rateResult = await a.evaluate(`({ winner: Room.current.teamWinner, red: Room.current.teamResult.find((r) => r.team === 'red').accuracy, blue: Room.current.teamResult.find((r) => r.team === 'blue').accuracy, text: document.querySelector('#sheetCard').textContent })`)
  if (rateResult.winner !== 'red' || rateResult.red !== 1 || rateResult.blue !== .5 || !rateResult.text.includes('정답률 100%') || !rateResult.text.includes('정답률 50%') || rateResult.text.includes('5/5')) throw new Error('팀 마지막 기회 정답률 판정 실패: ' + JSON.stringify(rateResult))
  ok(`iPhone 15 첫 판/다시 하기 칸 크기 ${firstTeamTile}px/${rematchTile}px · 팀 마지막 기회 정답률 판정`)

  const spyCode = await createMode('spy', 4)
  for (const player of [c, d]) {
    await player.evaluate(`(() => { TW.GOES.leave(); document.querySelector('[data-go=rooms]').click(); document.getElementById('roomNick').value = '${player.name}'; document.getElementById('roomJoinCode').value = '${spyCode}'; document.querySelector('[data-act=room-join]').click() })()`)
  }
  await Promise.all(four.map((player) => waitFor(player, `Room.current?.kind === 'spy' && Array.from(Room.current.peers.values()).filter((p) => p.online).length === 4`, 12000)))
  const spyPids = Object.fromEntries(await Promise.all(four.map(async (player) => [player.name, await player.evaluate(`Room.current.me.pid`)])))
  await a.evaluate(`(() => {
    document.querySelector('[data-team-pid="${spyPids.A}"][data-team="red"]').click()
    document.querySelector('[data-team-pid="${spyPids.B}"][data-team="blue"]').click()
    document.querySelector('[data-team-pid="${spyPids.C}"][data-team="red"]').click()
    document.querySelector('[data-team-pid="${spyPids.D}"][data-team="blue"]').click()
    document.querySelector('[data-act=room-start]').click()
  })()`)
  await Promise.all(four.map((player) => waitFor(player, `TW.state?.mode === 'spy' && document.querySelector('#sheetCard h2') !== null`, 12000)))
  const spies = await a.evaluate(`Room.current.spies`)
  const spyPages = new Map(await Promise.all(four.map(async (player) => [await player.evaluate(`Room.current.me.pid`), player])))
  for (const team of ['red', 'blue']) {
    const spyPage = spyPages.get(spies[team])
    if (!spyPage || !await spyPage.evaluate(`document.querySelector('#sheetCard h2').textContent.includes('당신은 스파이')`)) throw new Error(`${team} 팀 스파이 비밀 안내 실패`)
  }
  await Promise.all(four.map((player) => player.evaluate(`document.querySelector('[data-close]').click()`)))
  const redTurn = await a.evaluate(`Room.current.teamTurns.red`); const blueTurn = await a.evaluate(`Room.current.teamTurns.blue`)
  await spyPages.get(redTurn).evaluate(`(async () => { for (const jamo of TW.state.answerJamo) TW.press(jamo); await TW.submit() })()`)
  await Promise.all(four.map((player) => waitFor(player, `Room.current.teamStatus.red === 'won'`, 12000)))
  await spyPages.get(blueTurn).evaluate(`(async () => { const word = Words.answers[TW.state.size].find((candidate) => candidate !== TW.state.answer); for (const jamo of Hangul.decompose(word)) TW.press(jamo); await TW.submit() })()`)
  await Promise.all(four.map((player) => waitFor(player, `Room.current.teamBoards.blue.length === 1 && !TW.busy`, 12000)))
  const nextBlue = await a.evaluate(`Room.current.teamTurns.blue`)
  await spyPages.get(nextBlue).evaluate(`(async () => { for (const jamo of TW.state.answerJamo) TW.press(jamo); await TW.submit() })()`)
  await Promise.all(four.map((player) => waitFor(player, `Room.current.over && document.querySelector('.team-score') !== null`, 12000)))
  const blueSpyTitle = await spyPages.get(spies.blue).evaluate(`document.querySelector('#sheetCard h2').textContent`)
  const redSpyTitle = await spyPages.get(spies.red).evaluate(`document.querySelector('#sheetCard h2').textContent`)
  if (!blueSpyTitle.includes('스파이 개인 승리') || !redSpyTitle.includes('스파이 작전 실패')) throw new Error('스파이 개인 승패 처리 실패: ' + JSON.stringify({ blueSpyTitle, redSpyTitle }))
  ok('스파이전 → 팀별 비밀 스파이 한 명 · 잠입 팀 패배 시 개인 승리')
} finally {
  for (const player of players) await cdp.send('Target.disposeBrowserContext', { browserContextId: player.browserContextId }).catch(() => {})
  cdp.ws.close()
  chrome.kill()
  server.close()
  await sleep(300)
  try { rmSync(profile, { recursive: true, force: true }) } catch (e) { /* 무시 */ }
}
