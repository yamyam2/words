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
async function newPlayer(name, url = PAGE_URL, viewport = null) {
  const { browserContextId } = await cdp.send('Target.createBrowserContext')
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  const call = (method, params = {}) => cdp.send(method, params, sessionId)
  await call('Page.enable')
  await call('Runtime.enable')
  await call('Network.enable')
  await call('Network.setCacheDisabled', { cacheDisabled: true })
  if (viewport) await call('Emulation.setDeviceMetricsOverride', viewport)
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
  await a.evaluate(`(() => { document.querySelector('[data-go=rooms]').click(); document.getElementById('roomNick').value = 'A' })()`)
  const initialModePick = await a.evaluate(`({ selected: document.querySelectorAll('[data-room-pick][aria-pressed="true"]').length, categories: [...document.querySelectorAll('[data-room-category]')].map((button) => button.textContent.trim()), modeHidden: document.getElementById('roomModeStep').hidden, codeInput: !!document.getElementById('roomJoinCode') })`)
  if (initialModePick.selected !== 0 || initialModePick.categories.join(',') !== '개인전,팀전' || !initialModePick.modeHidden || !initialModePick.codeInput) throw new Error('멀티 모드 초기 선택 상태 실패: ' + JSON.stringify(initialModePick))
  const groupedModes = await a.evaluate(`(() => { document.querySelector('[data-room-category=solo]').click(); const solo = [...document.querySelectorAll('[data-room-pick]')].map((button) => button.textContent.trim()); document.querySelector('[data-room-category=team]').click(); const team = [...document.querySelectorAll('[data-room-pick]')].map((button) => button.textContent.trim()); return { solo, team } })()`)
  if (groupedModes.solo.join(',') !== '같은 단어 대결,출제 대결,연판,서바이벌,토너먼트,원탁 모드' || groupedModes.team.join(',') !== '협동,팀전,팀 출제 대결,스파이전') throw new Error('개인전/팀전 모드 분류 실패: ' + JSON.stringify(groupedModes))
  await a.evaluate(`(() => { document.querySelector('[data-room-category=solo]').click(); document.querySelector('[data-room-pick=versus]').click(); document.querySelector('[data-act=room-open-create]').click(); document.querySelector('[data-act=room-create]').click() })()`)
  await waitFor(a, `!document.getElementById('lobby').hidden && document.getElementById('roomCode').textContent.length === 6`)
  const code = await a.evaluate(`document.getElementById('roomCode').textContent`)

  const mobileViewport = { width: 393, height: 852, deviceScaleFactor: 3, mobile: true }
  const b = await newPlayer('B', `${PAGE_URL}#r=${code}`, mobileViewport)
  players.push(b)
  await waitFor(b, `document.getElementById('roomNick') !== null`)
  await b.call('Emulation.setDeviceMetricsOverride', { ...mobileViewport, height: 500 })
  await sleep(150)
  const inviteEntry = await b.evaluate(`(() => { const card = document.getElementById('sheetCard').getBoundingClientRect(); const title = document.querySelector('#sheetCard h2').getBoundingClientRect(); return { text: document.getElementById('sheetCard').textContent, categories: document.querySelectorAll('[data-room-category]').length, codeInput: !!document.getElementById('roomJoinCode'), join: !!document.querySelector('[data-act=room-join]'), positioned: document.getElementById('sheet').classList.contains('invite-entry-sheet'), cardTop: card.top, titleTop: title.top, titleBottom: title.bottom, viewportHeight: innerHeight } })()`)
  if (inviteEntry.text.includes('같이 하기') || inviteEntry.text.includes('친구들과 실시간') || inviteEntry.categories || inviteEntry.codeInput || !inviteEntry.join || !inviteEntry.text.includes('별명을 입력해 주세요') || !inviteEntry.positioned || inviteEntry.cardTop < 0 || inviteEntry.titleTop < 0 || inviteEntry.titleBottom > inviteEntry.viewportHeight) throw new Error('초대 링크 전용 입장 화면 실패: ' + JSON.stringify(inviteEntry))
  ok('초대 링크 → 모바일 키보드 높이에서도 별명 제목·입력 화면 표시')
  await b.call('Emulation.setDeviceMetricsOverride', mobileViewport)
  await b.evaluate(`(() => {
    document.getElementById('roomNick').value = 'B'
    document.querySelector('[data-act=room-join]').click()
  })()`)
  await waitFor(a, `document.querySelectorAll('#roomRoster li').length === 2`)
  await waitFor(b, `Array.from(Room.current.peers.values()).filter((player) => player.online).length === 2`)
  ok('A 방 생성 → B 참가 → A 명단에 B 표시')
  await Promise.all([a, b].map((player) => waitFor(player, `!document.getElementById('lobbyChat').hidden`)))
  await waitFor(b, `Room.current.chatOpen && document.querySelector('#lobbyChat .chat-panel') !== null`)
  const lobbyRoles = await Promise.all([a, b].map((player) => player.evaluate(`({ host: Room.current.host, inviteHidden: document.getElementById('roomInvite').hidden, invite: !!document.querySelector('#roomInvite .room-invite'), quick: document.querySelectorAll('#lobbyChat [data-chat]').length })`)))
  if (!lobbyRoles[0].host || lobbyRoles[0].inviteHidden || !lobbyRoles[0].invite || lobbyRoles[1].host || !lobbyRoles[1].inviteHidden || lobbyRoles[1].invite || lobbyRoles.some((state) => state.quick !== 0)) throw new Error('대기방 역할별 초대/빠른 메시지 표시 실패: ' + JSON.stringify(lobbyRoles))
  await a.evaluate(`document.querySelector('[data-sheet=changemode]').click()`)
  await waitFor(a, `document.querySelector('[data-change-room-mode=roundtable]') !== null`)
  await a.evaluate(`document.querySelector('[data-change-room-mode=roundtable]').click()`)
  await waitFor(b, `Room.current.kind === 'roundtable' && document.querySelector('.lobby-mode-card')?.textContent.includes('원탁 모드')`)
  const inviteeMode = await b.evaluate(`({ card: document.querySelector('.lobby-mode-card')?.textContent, canChange: !!document.querySelector('[data-sheet=changemode]') })`)
  if (!inviteeMode.card?.includes('5칸') || inviteeMode.canChange) throw new Error('참가자 현재 모드 표시/방장 전용 변경 권한 실패: ' + JSON.stringify(inviteeMode))
  await a.evaluate(`document.querySelector('[data-change-room-mode=versus]').click()`)
  await waitFor(b, `Room.current.kind === 'versus' && document.querySelector('.lobby-mode-card')?.textContent.includes('같은 단어 대결')`)
  await a.evaluate(`document.querySelector('[data-close]').click()`)
  ok('대기방 현재 모드 강조 표시 · 참가자에게 실시간 반영 · 방장만 기존 방 모드 변경')
  await b.evaluate(`(() => { const input = document.getElementById('roomChatInput'); input.value = '대기방 안녕!'; document.querySelector('#lobbyChat #roomChatSend').click() })()`)
  await waitFor(a, `Room.current.messages.some((message) => message.text === '대기방 안녕!')`)
  await b.evaluate(`document.getElementById('roomCode').click()`)
  const lobbyChatClosed = await b.evaluate(`!Room.current.chatOpen && document.querySelector('#lobbyChat .chat-panel') === null`)
  if (!lobbyChatClosed) throw new Error('대기방 채팅 바깥을 눌러도 닫히지 않습니다')
  ok('참가자 초대 링크 숨김 · 대기방 채팅 자동 열기 · 빠른 메시지 제거 · 바깥 터치 닫기')

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
  await a.evaluate(`(() => { document.querySelector('[data-act=room-chat-toggle]').click(); const input = document.getElementById('roomChatInput'); input.value = '조금만 더 힘내!'; document.getElementById('roomChatSend').click() })()`)
  await waitFor(b, `Room.current.messages.some((message) => message.text === '조금만 더 힘내!')`)
  await a.evaluate(`document.getElementById('gameSub').click()`)
  if (!await a.evaluate(`!Room.current.chatOpen && document.querySelector('#quickChat .chat-panel') === null`)) throw new Error('게임 채팅 바깥을 눌러도 닫히지 않습니다')
  await a.evaluate(`document.querySelector('#quickChat [data-act=room-force]').click()`)
  await Promise.all([waitFor(a, `document.querySelector('.score-list') !== null`), waitFor(b, `document.querySelector('.score-list') !== null`)])
  const winnerDisplay = await a.evaluate(`({ crowned: document.querySelector('.score-list li.winner .winner-crown')?.textContent, name: document.querySelector('.score-list li.winner b')?.textContent, celebration: !!document.querySelector('.result-celebration') })`)
  if (winnerDisplay.crowned !== '👑' || !winnerDisplay.name.includes('A') || !winnerDisplay.celebration) throw new Error('결과창 1위 왕관·축하 효과 실패: ' + JSON.stringify(winnerDisplay))
  ok('완주자 관전에서 실제 추측 확인 · 고정 응원 · 자유 채팅 · 즉시 종료')
  ok('멀티 결과창 → 1위 별명 왕관 · 축하 효과')

  async function createMode(kind, size = 4, rounds = 1) {
    await b.evaluate(`TW.GOES.leave()`)
    await a.evaluate(`TW.GOES.leave()`)
    await Promise.all([waitFor(a, `!document.getElementById('home').hidden`), waitFor(b, `!document.getElementById('home').hidden`)])
    await sleep(900)
    await a.evaluate(`(() => {
      document.querySelector('[data-go=rooms]').click()
      document.getElementById('roomNick').value = 'A'
      document.querySelector('[data-room-category="${['versus', 'setter', 'relay', 'captain', 'tournament', 'roundtable'].includes(kind) ? 'solo' : 'team'}"]').click()
      document.querySelector('[data-room-pick="${kind}"]').click()
      document.querySelector('[data-act=room-open-create]').click()
      document.querySelector('[data-rsize="${size}"]').click()
      ${kind === 'relay' ? `document.querySelector('[data-rounds="${rounds}"]').click()` : ''}
      ${kind === 'captain' ? `document.querySelector('[data-eliminate="2"]').click()` : ''}
      ${kind === 'tournament' ? `if (!document.querySelector('[data-wait]')?.parentElement.parentElement.hidden) throw new Error('토너먼트 대기시간 설정이 노출됨')` : ''}
      ${kind === 'roundtable' ? `document.querySelector('[data-roundtable-free="true"]').click()` : ''}
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
  ok('연판 → 3라운드 연속 진행 · 누적 점수 · 최종 순위')

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
  await waitFor(a, `Room.current?.kind === 'team' && Array.from(Room.current.peers.values()).filter((p) => p.online).length === 4`, 20000)
  await Promise.all(four.map((player) => waitFor(player, `Room.current?.kind === 'team'`, 12000)))
  const pids = Object.fromEntries(await Promise.all(four.map(async (player) => [player.name, await player.evaluate(`Room.current.me.pid`)])))
  await a.evaluate(`document.querySelector('[data-act=room-random-teams]').click()`)
  await Promise.all(four.map((player) => waitFor(player, `Room.current.teamsHidden === true`, 12000)))
  const hiddenTeams = await Promise.all(four.map((player) => player.evaluate(`({ host: Room.current.host, assignments: Room.current.teams.size, labels: document.querySelectorAll('#roomRoster .team-label').length, notice: document.getElementById('lobbyActions').textContent.includes('비밀 팀 배정 완료') })`)))
  if (hiddenTeams.some((state) => state.labels !== 0 || !state.notice || !state.host && state.assignments !== 0) || hiddenTeams.find((state) => state.host)?.assignments !== 4) throw new Error('비밀 랜덤 팀 배정이 노출됐습니다: ' + JSON.stringify(hiddenTeams))
  const balance = await a.evaluate(`Object.values(Object.fromEntries(Room.current.teams)).reduce((count, team) => ({ ...count, [team]: (count[team] || 0) + 1 }), {})`)
  if (balance.red !== 2 || balance.blue !== 2) throw new Error('4인 랜덤 팀 균형 실패: ' + JSON.stringify(balance))
  await a.evaluate(`document.querySelector('[data-act=room-manual-teams]').click()`)
  await Promise.all(four.map((player) => waitFor(player, `Room.current.teamsHidden === false`, 12000)))
  ok('랜덤 팀 → 2:2 균형 배정 · 시작 전 전원에게 팀 비공개')
  await a.call('Emulation.setDeviceMetricsOverride', { width: 393, height: 852, deviceScaleFactor: 3, mobile: true })
  await a.evaluate(`(() => {
    document.querySelector('[data-team-pid="${pids.A}"][data-team="red"]').click()
    document.querySelector('[data-team-pid="${pids.B}"][data-team="blue"]').click()
    document.querySelector('[data-team-pid="${pids.C}"][data-team="red"]').click()
    document.querySelector('[data-team-pid="${pids.D}"][data-team="blue"]').click()
    document.querySelector('[data-act=room-start]').click()
  })()`)
  await Promise.all(four.map((player) => waitFor(player, `TW.state?.mode === 'team' && !Room.current.over`, 12000)))
  await Promise.all(four.map((player) => waitFor(player, `Room.current.participants.every((pid) => Room.current.peers.has(pid) && Room.current.peers.get(pid).nick)`, 12000)))
  const teamRosters = await Promise.all(four.map((player) => player.evaluate(`document.getElementById('roomBanner').textContent`)))
  if (!teamRosters[0].includes('우리 팀') || !teamRosters[0].includes('A') || !teamRosters[0].includes('C') || teamRosters[0].includes('B') || teamRosters[0].includes('D') || !teamRosters[1].includes('B') || !teamRosters[1].includes('D') || teamRosters[1].includes('A') || teamRosters[1].includes('C')) throw new Error('게임 중 우리 팀 명단 표시 실패: ' + JSON.stringify(teamRosters))
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
  await a.evaluate(`(() => { document.querySelector('[data-act=room-chat-toggle]').click(); document.querySelector('[data-chat-scope="all"]').click(); const input = document.getElementById('roomChatInput'); input.value = '전체 채팅 테스트'; document.getElementById('roomChatSend').click() })()`)
  await Promise.all(four.map((player) => waitFor(player, `Room.current.messages.some((message) => message.text === '전체 채팅 테스트')`)))
  await sleep(800)
  await a.evaluate(`(() => { document.querySelector('[data-chat-scope="team"]').click(); const input = document.getElementById('roomChatInput'); input.value = '빨강팀만 보여요'; document.getElementById('roomChatSend').click() })()`)
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
  ok('팀전 2:2 → 우리 팀 명단 · 팀별 공유 턴 · 전체/팀 채팅 · 관전 중 상대 색 보드 · 시간 순위')

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
      await Promise.all(four.map((page) => waitFor(page, `Room.current.teamBoards.${team}.length === ${row + 1}${row === 4 ? '' : ' && !TW.busy'}`, 12000)))
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

  const teamSetterCode = await createMode('teamsetter', 4)
  for (const [index, player] of [c, d].entries()) {
    await player.evaluate(`TW.GOES.leave()`)
    await waitFor(player, `!document.getElementById('home').hidden`); await sleep(400)
    await player.evaluate(`(() => { document.querySelector('[data-go=rooms]').click(); document.getElementById('roomNick').value = '${player.name}'; document.getElementById('roomJoinCode').value = '${teamSetterCode}'; document.querySelector('[data-act=room-join]').click() })()`)
    await waitFor(a, `Array.from(Room.current.peers.values()).filter((p) => p.online).length === ${index + 3}`, 20000)
  }
  await Promise.all(four.map((player) => waitFor(player, `Room.current?.kind === 'teamsetter' && Array.from(Room.current.peers.values()).filter((p) => p.online).length === 4`, 12000)))
  const setterPids = Object.fromEntries(await Promise.all(four.map(async (player) => [player.name, await player.evaluate(`Room.current.me.pid`)])))
  await a.evaluate(`(() => {
    document.querySelector('[data-team-pid="${setterPids.A}"][data-team="red"]').click()
    document.querySelector('[data-team-pid="${setterPids.B}"][data-team="blue"]').click()
    document.querySelector('[data-team-pid="${setterPids.C}"][data-team="red"]').click()
    document.querySelector('[data-team-pid="${setterPids.D}"][data-team="blue"]').click()
    document.querySelector('[data-team-setter="${setterPids.A}"]').click()
    document.querySelector('[data-team-setter="${setterPids.B}"]').click()
  })()`)
  await Promise.all(four.map((player) => waitFor(player, `Room.current.teams.get('${setterPids.A}') === 'red' && Room.current.teams.get('${setterPids.B}') === 'blue' && Room.current.teamSetters.red === '${setterPids.A}' && Room.current.teamSetters.blue === '${setterPids.B}'`, 12000)))
  await a.evaluate(`document.querySelector('[data-act=room-start]').click()`)
  await Promise.all([waitFor(a, `document.getElementById('roomWord') !== null`, 12000), waitFor(b, `document.getElementById('roomWord') !== null`, 12000)])
  const words = await a.evaluate(`Words.answers[4].slice(0, 2)`)
  await a.evaluate(`(() => { const input = document.getElementById('roomWord'); input.value = '${words[0]}'; input.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('[data-act=room-word]').click() })()`)
  await b.evaluate(`(() => { const input = document.getElementById('roomWord'); input.value = '${words[1]}'; input.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('[data-act=room-word]').click() })()`)
  await Promise.all(four.map((player) => waitFor(player, `TW.state?.mode === 'teamsetter' && !Room.current.over`, 12000)))
  const teamSetterAnswers = await Promise.all(four.map((player) => player.evaluate(`({ team: Room.current.teams.get(Room.current.me.pid), answer: TW.state.answer, chatScope: Room.current.chatScope })`)))
  if (teamSetterAnswers.some((state) => state.chatScope !== 'team') || new Set(teamSetterAnswers.filter((state) => state.team === 'red').map((state) => state.answer)).size !== 1 || new Set(teamSetterAnswers.filter((state) => state.team === 'blue').map((state) => state.answer)).size !== 1 || teamSetterAnswers.find((state) => state.team === 'red').answer === teamSetterAnswers.find((state) => state.team === 'blue').answer) throw new Error('팀 출제 대결의 서로 다른 정답/팀 채팅 기본값 실패: ' + JSON.stringify(teamSetterAnswers))
  const teamSetterByPid = new Map()
  for (const player of four) teamSetterByPid.set(await player.evaluate(`Room.current.me.pid`), player)
  for (const team of ['red', 'blue']) {
    const turnPid = await a.evaluate(`Room.current.teamTurns.${team}`)
    await teamSetterByPid.get(turnPid).evaluate(`(async () => { for (const jamo of TW.state.answerJamo) TW.press(jamo); await TW.submit() })()`)
  }
  await Promise.all(four.map((player) => waitFor(player, `Room.current.over && document.querySelector('.team-score') !== null`, 12000)))
  const twoWordsShown = await a.evaluate(`document.querySelector('.answer-reveal').textContent.includes('${words[0]}') && document.querySelector('.answer-reveal').textContent.includes('${words[1]}')`)
  if (!twoWordsShown) throw new Error('팀 출제 대결 결과에 두 정답이 모두 보이지 않습니다')
  ok('팀 출제 대결 → 팀별 출제자 · 상대 팀에 서로 다른 단어 · 팀 채팅 기본값 · 두 정답 공개')

  const captainCode = await createMode('captain', 4)
  for (const [index, player] of [c, d].entries()) {
    await player.evaluate(`TW.GOES.leave()`)
    await waitFor(player, `!document.getElementById('home').hidden`); await sleep(400)
    await player.evaluate(`(() => { document.querySelector('[data-go=rooms]').click(); document.getElementById('roomNick').value = '${player.name}'; document.getElementById('roomJoinCode').value = '${captainCode}'; document.querySelector('[data-act=room-join]').click() })()`)
    await waitFor(a, `Array.from(Room.current.peers.values()).filter((p) => p.online).length === ${index + 3}`, 20000)
  }
  await waitFor(a, `Room.current?.kind === 'captain' && Array.from(Room.current.peers.values()).filter((p) => p.online).length === 4`, 20000)
  await Promise.all(four.map((player) => waitFor(player, `Room.current?.kind === 'captain'`, 12000)))
  await a.evaluate(`document.querySelector('[data-act=room-start]').click()`)
  await Promise.all(four.map((player) => waitFor(player, `TW.state?.mode === 'captain' && Room.current.captainAlive.length === 4`, 12000)))
  for (const player of [c, d]) await player.evaluate(`(async () => { for (const jamo of TW.state.answerJamo) TW.press(jamo); await TW.submit() })()`)
  await b.evaluate(`TW.GOES.leave()`)
  await waitFor(a, `Room.current.peers.get('${setterPids.B}')?.online === false`, 12000)
  await a.evaluate(`(async () => {
    const wrong = Words.answers[TW.state.size].find((candidate) => candidate !== TW.state.answer)
    for (let row = 0; row < 5; row++) { for (const jamo of Hangul.decompose(wrong)) TW.press(jamo); await TW.submit(); while (TW.busy) await new Promise((resolve) => setTimeout(resolve, 40)) }
  })()`)
  await Promise.all([a, c, d].map((player) => waitFor(player, `Room.current.over && Room.current.captainAlive.length === 2 && Room.current.captainEliminated.length === 2`, 12000)))
  const firstSurvivors = await a.evaluate(`({ alive: Room.current.captainAlive, eliminated: Room.current.captainEliminated, next: !!document.querySelector('[data-act=room-next]'), host: Room.current.host, stillInRoom: Room.current.me.pid === '${setterPids.A}' })`)
  if (!firstSurvivors.alive.includes(setterPids.C) || !firstSurvivors.alive.includes(setterPids.D) || !firstSurvivors.eliminated.includes(setterPids.A) || !firstSurvivors.eliminated.includes(setterPids.B) || !firstSurvivors.next || !firstSurvivors.host || !firstSurvivors.stillInRoom) throw new Error('서바이벌 이탈·오답 자동 탈락 후 방 유지 실패: ' + JSON.stringify(firstSurvivors))
  await a.evaluate(`document.querySelector('[data-act=room-next]').click()`)
  await Promise.all([a, c, d].map((player) => waitFor(player, `Room.current.round === 2 && !Room.current.over && Room.current.captainAlive.length === 2`, 12000)))
  if (!await a.evaluate(`Room.current.me.role === 'spectator' && document.body.classList.contains('watching')`)) throw new Error('서바이벌 탈락자가 다음 판에서 관전 상태가 아닙니다')
  const hostSpectator = await a.evaluate(`Room.current.host && document.getElementById('roomBanner').textContent.includes('방장으로 남아')`)
  if (!hostSpectator) throw new Error('탈락한 방장이 관전·진행 권한 안내를 받지 못했습니다')
  await c.evaluate(`(async () => { for (const jamo of TW.state.answerJamo) TW.press(jamo); await TW.submit() })()`)
  await d.evaluate(`(async () => {
    const wrong = Words.answers[TW.state.size].find((candidate) => candidate !== TW.state.answer)
    for (let row = 0; row < 5; row++) { for (const jamo of Hangul.decompose(wrong)) TW.press(jamo); await TW.submit(); while (TW.busy) await new Promise((resolve) => setTimeout(resolve, 40)) }
  })()`)
  await Promise.all([a, c, d].map((player) => waitFor(player, `Room.current.over && !!Room.current.captainChampion`, 12000)))
  const champion = await a.evaluate(`({ pid: Room.current.captainChampion, title: document.querySelector('#sheetCard h2').textContent })`)
  if (champion.pid !== setterPids.C || !champion.title.includes('최후의 생존자')) throw new Error('서바이벌 최종 우승 처리 실패: ' + JSON.stringify(champion))
  ok('서바이벌 → 중도 이탈·오답 자동 탈락 · 방장 관전 유지 · 생존 인원으로 다음 판 · 최종 우승')

  const tournamentCode = await createMode('tournament', 4)
  for (const [index, player] of [c, d].entries()) {
    await player.evaluate(`TW.GOES.leave()`)
    await waitFor(player, `!document.getElementById('home').hidden`); await sleep(400)
    await player.evaluate(`(() => { document.querySelector('[data-go=rooms]').click(); document.getElementById('roomNick').value = '${player.name}'; document.getElementById('roomJoinCode').value = '${tournamentCode}'; document.querySelector('[data-act=room-join]').click() })()`)
    await waitFor(a, `Array.from(Room.current.peers.values()).filter((p) => p.online).length === ${index + 3}`, 20000)
  }
  await Promise.all(four.map((player) => waitFor(player, `Room.current?.kind === 'tournament' && Array.from(Room.current.peers.values()).filter((p) => p.online).length === 4`, 12000)))
  await a.evaluate(`document.querySelector('[data-act=room-start]').click()`)
  await Promise.all(four.map((player) => waitFor(player, `TW.state?.mode === 'tournament' && Room.current.tournamentPairs.length === 2`, 12000)))
  const firstPairs = await a.evaluate(`Room.current.tournamentPairs`)
  const opponentCounts = await Promise.all(four.map((player) => player.evaluate(`document.querySelectorAll('#peers .peer').length`)))
  if (opponentCounts.some((count) => count !== 1)) throw new Error('토너먼트 참가자에게 자기 대진 상대만 보이지 않습니다: ' + JSON.stringify(opponentCounts))
  const firstAdvances = firstPairs.map((pair) => pair[0])
  const firstPairWinner = fourByPid.get(firstAdvances[0]); const firstPairLoserPid = firstPairs[0].find((pid) => pid !== firstAdvances[0]); const firstPairLoser = fourByPid.get(firstPairLoserPid)
  const firstPairAnswer = await firstPairWinner.evaluate(`TW.state.answer`)
  await firstPairWinner.evaluate(`(async () => { for (const jamo of TW.state.answerJamo) TW.press(jamo); await TW.submit() })()`)
  await Promise.all([firstPairWinner, firstPairLoser].map((player) => waitFor(player, `Room.current.tournamentMatches.size === 1 && !Room.current.over && Room.current.resultSheet === 'tournamentmatch'`, 12000)))
  const loserResult = await firstPairLoser.evaluate(`({ answer: document.querySelector('.answer-reveal b')?.textContent, title: document.querySelector('#sheetCard h2')?.textContent, watching: document.body.classList.contains('watching') })`)
  if (loserResult.answer !== firstPairAnswer || !loserResult.title.includes('패배') || !loserResult.watching) throw new Error('토너먼트 즉시 종료 후 패자 정답·관전 처리 실패: ' + JSON.stringify(loserResult))
  await firstPairWinner.evaluate(`document.querySelector('[data-act=room-tournament-ready]').click()`)
  await waitFor(firstPairWinner, `Room.current.tournamentReady.has(Room.current.me.pid)`, 12000)
  await fourByPid.get(firstAdvances[1]).evaluate(`(async () => { for (const jamo of TW.state.answerJamo) TW.press(jamo); await TW.submit() })()`)
  await Promise.all(four.map((player) => waitFor(player, `Room.current.over && Room.current.tournamentAlive.length === 2 && document.querySelector('.tournament-bracket')`, 12000)))
  const firstBracket = await a.evaluate(`({ alive: Room.current.tournamentAlive, eliminated: Room.current.tournamentEliminated, advances: document.querySelectorAll('.bracket-player.advance').length, faded: document.querySelectorAll('.bracket-player.eliminated').length, manualNext: !!document.querySelector('[data-act=room-next]'), autoWithinTen: Room.current.tournamentNextAt - Date.now() <= 10000 })`)
  if (firstBracket.alive.slice().sort().join(',') !== firstAdvances.slice().sort().join(',') || firstBracket.eliminated.length !== 2 || firstBracket.advances !== 2 || firstBracket.faded !== 2 || firstBracket.manualNext || !firstBracket.autoWithinTen) throw new Error('토너먼트 대진표·자동 진행 처리 실패: ' + JSON.stringify(firstBracket))
  for (const pid of firstAdvances) await fourByPid.get(pid).evaluate(`(() => { const button = document.querySelector('[data-act=room-tournament-ready]'); if (button && !button.disabled) button.click() })()`)
  await Promise.all(four.map((player) => waitFor(player, `Room.current.round === 2 && !Room.current.over && Room.current.tournamentPairs.length === 1`, 12000)))
  const finalist = await a.evaluate(`Room.current.tournamentPairs[0][0]`)
  await fourByPid.get(finalist).evaluate(`(async () => { for (const jamo of TW.state.answerJamo) TW.press(jamo); await TW.submit() })()`)
  await Promise.all(four.map((player) => waitFor(player, `Room.current.over && !!Room.current.tournamentChampion`, 12000)))
  const tournamentChampion = await a.evaluate(`({ pid: Room.current.tournamentChampion, title: document.querySelector('#sheetCard h2').textContent })`)
  if (tournamentChampion.pid !== finalist || !tournamentChampion.title.includes('토너먼트 우승')) throw new Error('토너먼트 최종 우승 처리 실패: ' + JSON.stringify(tournamentChampion))
  ok('토너먼트 4인 → 먼저 맞히면 대진 즉시 종료 · 패자 정답 공개 · 진출/탈락 애니메이션 · 전원 준비 다음 라운드 · 최종 우승')

  await createMode('roundtable', 4)
  await a.evaluate(`document.querySelector('[data-act=room-start]').click()`)
  await Promise.all([a, b].map((player) => waitFor(player, `Room.current?.kind === 'roundtable' && Room.current.roundtableFreeWords && !document.getElementById('roundTable').hidden && !document.getElementById('keyboard').hidden && Room.current.roundtableSeats.length === 2`, 12000)))
  const roundtableByPid = new Map([[await a.evaluate(`Room.current.me.pid`), a], [await b.evaluate(`Room.current.me.pid`), b]])
  const firstTurnPid = await a.evaluate(`Room.current.turnPid`); const firstTurn = roundtableByPid.get(firstTurnPid)
  const roundtableUi = await firstTurn.evaluate(`(() => {
    const arena = document.querySelector('.roundtable-arena').getBoundingClientRect()
    const board = document.querySelector('.board-wrap').getBoundingClientRect()
    const action = document.getElementById('roundtableAction').getBoundingClientRect()
    const keyboard = document.getElementById('keyboard').getBoundingClientRect()
    return { rows: document.querySelectorAll('#board .row').length, keys: document.querySelectorAll('#keyboard .key').length, action: document.querySelector('.roundtable-submit')?.textContent, ownColor: document.querySelector('.roundtable-submit')?.classList.contains('my-turn'), order: arena.bottom <= board.top + 1 && board.bottom <= action.top + 1 && action.bottom <= keyboard.top + 1 }
  })()`)
  if (roundtableUi.rows !== 1 || roundtableUi.keys < 20 || !roundtableUi.action?.includes('내 차례') || !roundtableUi.ownColor || !roundtableUi.order) throw new Error('원탁 모드 자판/입력칸/상태 버튼 화면 구성 실패: ' + JSON.stringify(roundtableUi))
  await firstTurn.evaluate(`(() => { for (const jamo of ['ㅎ','ㅎ','ㅎ','ㅎ']) TW.press(jamo); document.querySelector('[data-act=room-roundtable-submit]').click() })()`)
  await Promise.all([a, b].map((player) => waitFor(player, `Room.current.roundtableRows.length === 1 && Room.current.turnPid !== '${firstTurnPid}'`, 12000)))
  const challengerPid = firstTurnPid; const challenger = firstTurn
  const challengeUi = await challenger.evaluate(`({ text: document.querySelector('.roundtable-submit')?.textContent, challengeColor: document.querySelector('.roundtable-submit')?.classList.contains('challenge-turn') })`)
  if (!challengeUi.text?.includes('다른 사람 차례') || !challengeUi.challengeColor) throw new Error('다른 사람 차례 정답 도전 표시 실패: ' + JSON.stringify(challengeUi))
  await challenger.evaluate(`(() => { for (const jamo of ['ㄱ','ㄱ','ㄱ','ㄱ']) TW.press(jamo); document.querySelector('[data-act=room-roundtable-submit]').click() })()`)
  await Promise.all([a, b].map((player) => waitFor(player, `Room.current.roundtableLocked.has('${challengerPid}')`, 12000)))
  if (await a.evaluate(`Room.current.roundtableRows.length !== 1`)) throw new Error('원탁 모드 비공개 정답 도전이 색 힌트 기록에 노출됐습니다')
  const secondTurnPid = await a.evaluate(`Room.current.turnPid`); const secondTurn = roundtableByPid.get(secondTurnPid)
  await secondTurn.evaluate(`(() => { const word = Words.answers[TW.state.size].find((candidate) => candidate !== TW.state.answer); for (const jamo of Hangul.decompose(word)) TW.press(jamo); document.querySelector('[data-act=room-roundtable-submit]').click() })()`)
  await Promise.all([a, b].map((player) => waitFor(player, `Room.current.roundtableRows.length === 2 && Room.current.turnPid === '${challengerPid}'`, 12000)))
  await challenger.evaluate(`(() => { const word = Words.answers[TW.state.size].find((candidate) => candidate !== TW.state.answer); for (const jamo of Hangul.decompose(word)) TW.press(jamo); document.querySelector('[data-act=room-roundtable-submit]').click() })()`)
  await Promise.all([a, b].map((player) => waitFor(player, `Room.current.roundtableRows.length === 3 && !Room.current.roundtableLocked.has('${challengerPid}') && Room.current.turnPid !== '${challengerPid}'`, 12000)))
  await challenger.evaluate(`(() => { for (const jamo of TW.state.answerJamo) TW.press(jamo); document.querySelector('[data-act=room-roundtable-submit]').click() })()`)
  await Promise.all([a, b].map((player) => waitFor(player, `Room.current.over && Room.current.roundtableWinner && document.querySelector('.answer-reveal b')`, 12000)))
  const roundtableResult = await a.evaluate(`({ seats: document.querySelectorAll('.roundtable-seat').length, history: Room.current.roundtableRows.length, answer: document.querySelector('.answer-reveal b').textContent, crown: !!document.querySelector('.winner-crown') })`)
  if (roundtableResult.seats !== 2 || roundtableResult.history !== 3 || roundtableResult.answer !== await a.evaluate(`TW.state.answer`) || !roundtableResult.crown) throw new Error('원탁 모드 결과 처리 실패: ' + JSON.stringify(roundtableResult))
  ok('원탁 모드 → 자모 입력칸·자판 · 차례별 초록/노랑 버튼 · 자유 단어 · 비공개 도전 잠금/해제 · 즉시 우승')

  const spyCode = await createMode('spy', 4)
  for (const [index, player] of [c, d].entries()) {
    await player.evaluate(`TW.GOES.leave()`)
    await waitFor(player, `!document.getElementById('home').hidden`); await sleep(400)
    await player.evaluate(`(() => { document.querySelector('[data-go=rooms]').click(); document.getElementById('roomNick').value = '${player.name}'; document.getElementById('roomJoinCode').value = '${spyCode}'; document.querySelector('[data-act=room-join]').click() })()`)
    await waitFor(a, `Array.from(Room.current.peers.values()).filter((p) => p.online).length === ${index + 3}`, 20000)
  }
  await waitFor(a, `Room.current?.kind === 'spy' && Array.from(Room.current.peers.values()).filter((p) => p.online).length === 4`, 20000)
  await Promise.all(four.map((player) => waitFor(player, `Room.current?.kind === 'spy'`, 12000)))
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
  const duplicateChecks = { red: false, blue: false }
  for (let row = 0; row < 5; row++) {
    for (const team of ['red', 'blue']) {
      const turnPid = await a.evaluate(`Room.current.teamTurns.${team}`)
      if (row === 4 && turnPid === spies[team]) throw new Error(`${team} 팀의 마지막 정규 차례가 스파이에게 배정됐습니다`)
      const turnPage = spyPages.get(turnPid)
      if (turnPid === spies[team] && row > 0 && !duplicateChecks[team]) {
        const duplicate = await turnPage.evaluate(`(async () => {
          const before = Room.current.teamBoards.${team}.length
          for (const jamo of Room.current.teamBoards.${team}[0].guess) TW.press(jamo)
          await TW.submit(); await new Promise((resolve) => setTimeout(resolve, 120))
          const state = { before, after: Room.current.teamBoards.${team}.length, notice: document.getElementById('toast').textContent }
          for (let i = 0; i < TW.state.size; i++) TW.press('←')
          return state
        })()`)
        if (duplicate.after !== duplicate.before || !duplicate.notice.includes('이미 입력한 단어')) throw new Error(`${team} 팀 스파이 중복 단어 차단 실패: ` + JSON.stringify(duplicate))
        duplicateChecks[team] = true
      }
      await turnPage.evaluate(`(async () => {
        const used = new Set(Room.current.teamBoards.${team}.map((entry) => Hangul.encode(entry.guess)))
        const word = Words.answers[TW.state.size].find((candidate) => candidate !== TW.state.answer && !used.has(Hangul.encode(Hangul.decompose(candidate))))
        for (const jamo of Hangul.decompose(word)) TW.press(jamo)
        await TW.submit()
      })()`)
      await Promise.all(four.map((player) => waitFor(player, `Room.current.teamBoards.${team}.length === ${row + 1}${row === 4 ? '' : ' && !TW.busy'}`, 12000)))
    }
  }
  if (!duplicateChecks.red || !duplicateChecks.blue) throw new Error('양 팀 스파이의 중복 단어 차단을 모두 확인하지 못했습니다: ' + JSON.stringify(duplicateChecks))
  await Promise.all(four.map((player) => waitFor(player, `Room.current.teamFinals[Room.current.teams.get(Room.current.me.pid)]?.active`, 12000)))
  const spyFinalViews = await Promise.all(four.map((player) => player.evaluate(`({ spy: Room.current.isSpy, hidden: document.getElementById('finalChance').hidden, unlimited: Room.current.teamFinals[Room.current.teams.get(Room.current.me.pid)].unlimited, endsAt: Room.current.teamFinals[Room.current.teams.get(Room.current.me.pid)].endsAt })`)))
  if (spyFinalViews.some((view) => !view.unlimited || view.endsAt !== null || view.spy && !view.hidden || !view.spy && view.hidden)) throw new Error('스파이 제외/무제한 마지막 기회 표시 실패: ' + JSON.stringify(spyFinalViews))
  const citizens = {}
  for (const team of ['red', 'blue']) {
    const pid = await a.evaluate(`Room.current.participants.find((pid) => Room.current.teams.get(pid) === '${team}' && pid !== Room.current.spies.${team})`)
    citizens[team] = spyPages.get(pid)
  }
  await citizens.red.evaluate(`(() => { const input = document.getElementById('finalWord'); input.value = TW.state.answer; input.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('finalSubmit').click() })()`)
  await citizens.blue.evaluate(`(() => { const input = document.getElementById('finalWord'); input.value = Words.answers[TW.state.size].find((word) => word !== TW.state.answer); input.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('finalSubmit').click() })()`)
  await Promise.all(four.map((player) => waitFor(player, `Room.current.over && document.querySelector('.team-score') !== null`, 12000)))
  const blueSpyTitle = await spyPages.get(spies.blue).evaluate(`document.querySelector('#sheetCard h2').textContent`)
  const redSpyTitle = await spyPages.get(spies.red).evaluate(`document.querySelector('#sheetCard h2').textContent`)
  const spyRate = await a.evaluate(`({ winner: Room.current.teamWinner, red: Room.current.teamResult.find((r) => r.team === 'red'), blue: Room.current.teamResult.find((r) => r.team === 'blue') })`)
  if (spyRate.winner !== 'red' || spyRate.red.total !== 1 || spyRate.blue.total !== 1 || !blueSpyTitle.includes('스파이 개인 승리') || !redSpyTitle.includes('스파이 작전 실패')) throw new Error('스파이 개인 승패/일반 팀원 정답률 처리 실패: ' + JSON.stringify({ blueSpyTitle, redSpyTitle, spyRate }))
  ok('스파이전 → 팀 내 중복 단어 차단 · 마지막 정규 차례/마지막 기회 스파이 제외 · 일반 팀원 정답률 · 무제한 진행')
} finally {
  for (const player of players) await cdp.send('Target.disposeBrowserContext', { browserContextId: player.browserContextId }).catch(() => {})
  cdp.ws.close()
  chrome.kill()
  server.close()
  await sleep(300)
  try { rmSync(profile, { recursive: true, force: true }) } catch (e) { /* 무시 */ }
}
