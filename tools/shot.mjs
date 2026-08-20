// 개발용 헤드리스 브라우저 검증 (배포본과는 무관).
// dist/index.html 을 모바일 크기로 띄워 실제로 게임을 플레이하고, 화면 상태를 검사한 뒤
// dist/shots/*.png 로 스크린샷을 남긴다.
// 사용: node tools/shot.mjs [--out <폴더>]
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const OUT = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : join(ROOT, 'dist', 'shots')
const PORT = 9333
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find(existsSync)
if (!CHROME) throw new Error('크롬을 찾지 못했습니다')

const PROFILE = join(tmpdir(), 'todays-word-shot-profile')
mkdirSync(OUT, { recursive: true })

// 실제 배포처럼 http 로 서빙한다. file:// 은 공유 링크와 localStorage 동작이 달라
// 링크 기능을 제대로 검증할 수 없다.
const SITE_PORT = 9334
const PAGE_URL = `http://127.0.0.1:${SITE_PORT}/index.html`
const server = createServer((req, res) => {
  const name = (req.url || '/').split('?')[0].split('#')[0]
  const rel = name === '/' ? 'index.html' : name.slice(1)
  let body
  try { body = readFileSync(join(ROOT, 'dist', rel)) } catch (err) { body = null }
  if (!body) {
    res.writeHead(404)
    res.end('not found')
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
})
await new Promise((resolve) => server.listen(SITE_PORT, '127.0.0.1', resolve))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', '--allow-file-access-from-files',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, 'about:blank',
], { stdio: 'ignore' })

async function browserSocket() {
  for (let i = 0; i < 60; i++) {
    try {
      const info = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()
      if (info.webSocketDebuggerUrl) return info.webSocketDebuggerUrl
    } catch (e) { /* 아직 뜨는 중 */ }
    await sleep(250)
  }
  throw new Error('크롬 디버깅 포트에 연결하지 못했습니다')
}

// ── 아주 얇은 CDP 클라이언트 ────────────────────────────────────────────
function connect(url) {
  const ws = new WebSocket(url)
  const pending = new Map()
  let id = 0
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (!msg.id || !pending.has(msg.id)) return
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
  })
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const msgId = ++id
    pending.set(msgId, { resolve, reject })
    ws.send(JSON.stringify({ id: msgId, method, params, ...(sessionId ? { sessionId } : {}) }))
  })
  return { ws, ready, send }
}

// ── 검사 결과 모으기 ────────────────────────────────────────────────────
const checks = []
function check(name, pass, detail = '') {
  checks.push({ name, pass })
  console.log(`  ${pass ? 'OK  ' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`)
}
// 객체는 키 순서를 무시하고 비교한다
const norm = (v) => (v && typeof v === 'object' && !Array.isArray(v))
  ? JSON.stringify(Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))))
  : JSON.stringify(v)
const eq = (name, actual, expected) => {
  const pass = norm(actual) === norm(expected)
  check(name, pass, pass ? '' : `기대 ${norm(expected)} / 실제 ${norm(actual)}`)
}

const cdp = connect(await browserSocket())
await cdp.ready
const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
const call = (method, params) => cdp.send(method, params, sessionId)

await call('Page.enable')
await call('Runtime.enable')
// file:// 리소스도 크롬이 캐시한다 — 고친 CSS 가 반영되지 않아 헛다리를 짚게 된다
await call('Network.enable')
await call('Network.setCacheDisabled', { cacheDisabled: true })
await call('Emulation.setDeviceMetricsOverride', {
  width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
  screenOrientation: { angle: 0, type: 'portraitPrimary' },
})

async function evaluate(expression) {
  const res = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || String(expression).slice(0, 80))
  return res.result.value
}
async function goto(url) {
  await call('Page.navigate', { url })
  for (let i = 0; i < 80; i++) {
    if (await evaluate('document.readyState === "complete" && !!window.TW').catch(() => false)) return
    await sleep(100)
  }
  throw new Error('페이지 로드 실패: ' + url)
}
async function shot(name) {
  const { data } = await call('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, name + '.png'), Buffer.from(data, 'base64'))
}

// 애니메이션을 최소화하고 한 줄씩 실제 입력 경로로 제출한다.
const DRIVE = `
window.__fast = () => {
  if (document.getElementById('__fast')) return
  const css = document.createElement('style'); css.id = '__fast'
  css.textContent = '*{animation-duration:1ms !important}'
  document.head.appendChild(css)
}
window.__play = async (rows) => {
  __fast()
  for (const row of rows) {
    for (const j of Array.from(row)) TW.press(j)
    TW.submit()
    await new Promise(r => setTimeout(r, TW.state.size * 190 + 620))
  }
  return TW.state.status
}
window.__rows = (n) => [...document.querySelectorAll('#board .row')].slice(0, n)
  .map(r => [...r.children].map(t => t.classList.contains('correct') ? 'G'
    : t.classList.contains('present') ? 'Y' : t.classList.contains('absent') ? 'X' : '.').join(''))
window.__keys = () => Object.fromEntries([...document.querySelectorAll('.key')]
  .map(k => [k.dataset.key, k.classList.contains('correct') ? 'G' : k.classList.contains('present') ? 'Y'
    : k.classList.contains('absent') ? 'X' : '.']).filter(([, v]) => v !== '.'))
`

let failed = false
try {
  console.log('\n[1] 시작 화면')
  await goto(PAGE_URL)
  await evaluate(DRIVE)
  const layout = await evaluate(`({ vw: innerWidth, doc: document.documentElement.scrollWidth,
    sizes: Math.round(document.querySelector('.sizes').getBoundingClientRect().width),
    sizeRows: new Set([...document.querySelectorAll('.chip')].map(c => Math.round(c.getBoundingClientRect().top))).size })`)
  eq('가로 오버플로 없음', layout.doc, layout.vw)
  eq('칸수 칩이 한 줄에 들어감', layout.sizeRows, 1)
  await shot('01-home')

  console.log('\n[2] 시민(5칸) — 스크린샷 _02 재현')
  await evaluate(`TW.startGame('custom', 5, '시민')`)
  await evaluate(`__play(['ㅎㅛㄱㅏㅁ','ㅇㅓㅈㅓㄴ','ㅂㅜㄷㅗㄹ'])`)   // 효감 / 어전 / 부돌
  eq('세 줄 색상', await evaluate('__rows(3)'), ['XXXXY', 'XXXXG', 'XXXXX'])
  eq('키보드 누적 색', await evaluate('__keys()'), { ㅂ: 'X', ㄷ: 'X', ㅛ: 'X', ㅁ: 'Y', ㄴ: 'G', ㅇ: 'X', ㅎ: 'X', ㅗ: 'X', ㅓ: 'X', ㄱ: 'X', ㅈ: 'X', ㄹ: 'X', ㅏ: 'X', ㅜ: 'X' })
  await shot('02-board')

  console.log('\n[3] 사전에 없는 단어는 거절')
  const rejected = await evaluate(`(async () => {
    for (const j of Array.from('ㅎㅎㅎㅎㅎ')) TW.press(j)
    TW.submit(); await new Promise(r => setTimeout(r, 80))
    const toast = document.getElementById('toast')
    return { guesses: TW.state.guesses.length, toast: toast.hidden ? null : toast.textContent }
  })()`)
  eq('거절 후 제출 줄 수 그대로', rejected.guesses, 3)
  eq('거절 안내 문구', rejected.toast, '사전에 없는 단어예요')
  await shot('03-reject')

  console.log('\n[4] 정답 제출 → 승리 · 결과 시트')
  await evaluate(`(() => { for (let i=0;i<9;i++) TW.press('←') })()`)
  await evaluate(`__play(['ㅅㅣㅁㅣㄴ'])`)
  await sleep(1400)
  eq('상태', await evaluate('TW.state.status'), 'won')
  eq('네 줄 색상', await evaluate('__rows(4)'), ['XXXXY', 'XXXXG', 'XXXXX', 'GGGGG'])
  const share = await evaluate('TW.shareText()')
  check('공유 문구에 이모지 그리드 포함', share.includes('\u{1F7E9}'.repeat(5)) && share.includes('\u{1F7E8}'), '')
  check('결과 시트 열림', await evaluate(`!document.getElementById('sheet').hidden`))
  check('정답 단어 공개', await evaluate(`(document.querySelector('.answer-reveal b')||{}).textContent === '시민'`))
  await shot('04-result')
  console.log('    공유 문구:\n' + share.split('\n').map((l) => '      ' + l).join('\n'))

  console.log('\n[5] 전세(6칸) — 스크린샷 _03 재현')
  await evaluate(`document.querySelector('[data-close]').click(); TW.startGame('custom', 6, '전세')`)
  await evaluate(`__play(['ㅂㅗㅇㄷㅜㄴ','ㅁㅏㅣㅈㅏㄱ','ㅈㅣㄴㅅㅣㄹ'])`)   // 봉둔 / 매작 / 진실
  eq('세 줄 색상 (중복 ㅣ 처리 포함)', await evaluate('__rows(3)'), ['XXXXXY', 'XXYYXX', 'GYGGXX'])
  await shot('05-six')

  console.log('\n[6] 규칙 · 기록 시트')
  await evaluate(`document.querySelector('[data-sheet=stats]').click()`)
  check('기록 시트 렌더', await evaluate(`document.querySelector('.stat-grid') !== null`))
  await shot('06-stats')
  await evaluate(`document.querySelector('[data-close]').click(); document.querySelector('[data-go=home]').click(); document.querySelector('[data-sheet=rules]').click()`)
  check('규칙 시트 렌더', await evaluate(`document.querySelector('#sheetCard').textContent.includes('두 칸')`))
  await shot('07-rules')

  console.log('\n[7] 직접 출제 → 링크 → 그 링크로 접속')
  await evaluate(`document.querySelector('[data-close]').click(); document.querySelector('[data-go=compose]').click()`)
  const compose = await evaluate(`(() => {
    const input = document.getElementById('composeInput')
    input.value = '정치'; input.dispatchEvent(new Event('input', { bubbles: true }))
    const hint = document.getElementById('composeHint').textContent
    document.getElementById('composeMake').click()
    return { hint, link: document.getElementById('composeLink').value }
  })()`)
  eq('출제 입력 안내', compose.hint, '5칸 · ㅈ ㅓ ㅇ ㅊ ㅣ')
  check('링크 생성', /#w=[A-Za-z0-9_-]+$/.test(compose.link), compose.link.slice(-30))
  await shot('08-compose')

  const badWord = await evaluate(`(() => {
    const input = document.getElementById('composeInput')
    input.value = '튤퍕'; input.dispatchEvent(new Event('input', { bubbles: true }))   // 6칸이지만 사전에 없음
    return { hint: document.getElementById('composeHint').textContent, disabled: document.getElementById('composeMake').disabled }
  })()`)
  check('사전에 없는 단어는 출제 불가', badWord.disabled && badWord.hint.includes('사전에 없는'), badWord.hint)

  // 아티팩트처럼 주소를 못 바꾸는 환경을 위해, 링크를 붙여넣어도 풀 수 있어야 한다
  await evaluate(`(() => {
    const input = document.getElementById('joinInput')
    input.value = ${JSON.stringify(compose.link)}
    document.querySelector('[data-act=join]').click()
  })()`)
  eq('링크 붙여넣기로 시작', await evaluate(`[TW.state.mode, TW.state.answer, TW.state.size]`), ['custom', '정치', 5])

  await goto(compose.link)
  await evaluate(DRIVE)
  eq('링크로 접속하면 그 단어로 시작', await evaluate(`[TW.state.mode, TW.state.answer, TW.state.size]`), ['custom', '정치', 5])
  await shot('09-from-link')

  // 아티팩트는 게임을 iframe 안에서 띄운다. 그때 location 은 일회용 내부 주소라
  // 그대로 링크로 내보내면 받는 사람에게 'page not found' 가 뜬다. 코드로 떨어져야 한다.
  console.log('')
  console.log('[7-1] iframe 안(아티팩트 상황)에서는 링크 대신 문제 코드')
  const framed = await evaluate(`(async () => {
    const frame = document.createElement('iframe')
    frame.src = ${JSON.stringify(PAGE_URL)}
    frame.style.cssText = 'position:fixed;left:-9999px;width:390px;height:844px'
    document.body.appendChild(frame)
    await new Promise((r) => { frame.onload = r })
    const win = frame.contentWindow, doc = frame.contentDocument
    doc.querySelector('[data-go=compose]').click()
    const input = doc.getElementById('composeInput')
    input.value = '정치'
    input.dispatchEvent(new win.Event('input', { bubbles: true }))
    doc.getElementById('composeMake').click()
    const out = {
      shareUrl: win.TW.shareUrl(),
      value: doc.getElementById('composeLink').value,
      button: doc.getElementById('composeCopy').textContent,
      note: doc.getElementById('composeNote').textContent,
    }
    frame.remove()
    return out
  })()`)
  eq('iframe 안에서는 공유 주소 없음', framed.shareUrl, null)
  check('링크가 아니라 코드를 준다', /^[A-Za-z0-9_-]+$/.test(framed.value) && !framed.value.includes('://'), framed.value)
  eq('코드가 그 단어로 되돌아온다', Buffer.from(framed.value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'), '정치')
  check('버튼과 안내가 코드용으로 바뀐다', framed.button.includes('코드') && framed.note.includes('코드'), framed.button)

  console.log('')
  console.log('[7-2] 제출 키')
  const submitKey = await evaluate(`(() => {
    TW.startGame('free', 5)
    const keys = [...document.querySelectorAll('.key')]
    const submit = keys.find((k) => k.classList.contains('submit'))
    const back = keys.find((k) => k.dataset.key === '←')
    const jamo = keys.find((k) => k.dataset.key === 'ㅅ')
    const bg = (el) => el ? getComputedStyle(el).backgroundColor : null
    return { label: submit && submit.dataset.key, aria: submit && submit.getAttribute('aria-label'),
             submitBg: bg(submit), backBg: bg(back), jamoBg: bg(jamo) }
  })()`)
  eq('제출 키가 위쪽 화살표', submitKey.label, '↑')
  eq('제출 키에 이름표', submitKey.aria, '제출')
  check('제출 키 색이 자모 키와 다르다', submitKey.submitBg !== submitKey.jamoBg, `${submitKey.submitBg} vs ${submitKey.jamoBg}`)
  check('제출 키 색이 지우기 키와도 다르다', submitKey.submitBg !== submitKey.backBg, `${submitKey.submitBg} vs ${submitKey.backBg}`)

  console.log('\n[8] 오늘의 문제 — 진행 상황 저장/복원')
  await goto(PAGE_URL)
  await evaluate(DRIVE)
  const daily = await evaluate(`(async () => {
    TW.startGame('daily', 5)
    const answer = TW.state.answer
    await __play(['ㅅㅣㅁㅣㄴ'])
    return { answer, guesses: TW.state.guesses.length }
  })()`)
  await goto(PAGE_URL)
  await evaluate(DRIVE)
  const restored = await evaluate(`(() => { TW.startGame('daily', 5); return { answer: TW.state.answer, guesses: TW.state.guesses.length } })()`)
  eq('같은 날짜면 같은 문제', restored.answer, daily.answer)
  check('진행 상황 복원', restored.guesses === daily.guesses,
    `저장 ${daily.guesses}줄 / 복원 ${restored.guesses}줄 (file:// 에서 localStorage 가 막히면 0)`)
  console.log(`    오늘의 5칸 문제: ${daily.answer}`)

  console.log('\n[9] localStorage 가 막힌 환경 (샌드박스 iframe)')
  await goto(PAGE_URL)
  await evaluate(DRIVE)
  const blocked = await evaluate(`(async () => {
    const boom = () => { throw new DOMException('blocked', 'SecurityError') }
    localStorage.getItem = boom; localStorage.setItem = boom
    const errors = []
    addEventListener('error', (e) => errors.push(String(e.message)))
    TW.startGame('free', 5)
    await __play([[...TW.state.answerJamo].join('')])
    await new Promise(r => setTimeout(r, 1200))
    document.querySelector('[data-sheet=stats]').click()
    return { status: TW.state.status, errors, stats: document.querySelector('.stat-grid') !== null }
  })()`)
  eq('저장소가 막혀도 승리까지 진행', blocked.status, 'won')
  eq('저장소 오류가 새어 나오지 않음', blocked.errors, [])
  check('기록 화면도 정상 표시', blocked.stats)

  console.log('\n[10] 7칸 레이아웃')
  await evaluate(`TW.startGame('custom', 7, '관심'); __fast()`)
  await evaluate(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`)
  const seven = await evaluate(`({ doc: document.documentElement.scrollWidth, vw: innerWidth, client: document.documentElement.clientWidth,
    tile: Math.round(document.querySelector('.tile').getBoundingClientRect().width) })`)
  eq('7칸에서도 가로 오버플로 없음', seven.doc, seven.vw)
  check('타일 크기 적정', seven.tile >= 34, `타일 ${seven.tile}px`)
  await goto(PAGE_URL)          // 앞 단계 상태와 섞이지 않게 새로 연다
  await evaluate(DRIVE)
  // 실제 사용처럼 한 프레임 쉬고 잰다
  const widths = await evaluate(`(async () => {
    const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
    const out = {}
    for (const n of [4, 5, 6, 7]) {
      TW.startGame('free', n)
      await frame()
      out[n] = Math.round(document.querySelector('#board .tile').getBoundingClientRect().width)
    }
    return out
  })()`)
  console.log('    칸 수별 타일 폭: ' + JSON.stringify(widths))
  check('타일이 상한(68px)을 넘지 않는다', Object.values(widths).every((w) => w <= 68), JSON.stringify(widths))
  check('칸 수가 늘수록 타일이 작아진다', widths[4] >= widths[5] && widths[5] > widths[6] && widths[6] > widths[7])
  check('어느 칸 수에서도 타일이 34px 이상', Object.values(widths).every((w) => w >= 34))

  eq('세로 스크롤바가 자리를 먹지 않음', seven.client, seven.vw)

  console.log('\n[11] 낮은 화면 (360x600)')
  await call('Emulation.setDeviceMetricsOverride', {
    width: 360, height: 600, deviceScaleFactor: 2, mobile: true,
    screenOrientation: { angle: 0, type: 'portraitPrimary' },
  })
  await evaluate(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`)
  const small = await evaluate(`(async () => {
    TW.startGame('free', 6)
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
    const board = document.querySelector('#board').getBoundingClientRect()
    const kb = document.querySelector('.keyboard').getBoundingClientRect()
    return { boardBottom: Math.round(board.bottom), kbTop: Math.round(kb.top), kbBottom: Math.round(kb.bottom),
             vh: innerHeight, docH: document.documentElement.scrollHeight,
             tile: Math.round(document.querySelector('#board .tile').getBoundingClientRect().width) }
  })()`)
  console.log('    ' + JSON.stringify(small))
  check('보드가 키보드를 침범하지 않음', small.boardBottom <= small.kbTop, `보드 끝 ${small.boardBottom} / 키보드 시작 ${small.kbTop}`)
  check('키보드가 화면 안에 들어옴', small.kbBottom <= small.vh + 1, `키보드 끝 ${small.kbBottom} / 화면 ${small.vh}`)
  check('세로 스크롤이 생기지 않음', small.docH <= small.vh + 1, `문서 ${small.docH} / 화면 ${small.vh}`)
  await shot('11-short')
  await shot('10-seven')
} catch (err) {
  failed = true
  console.error('\n하네스 오류:', err.message)
} finally {
  cdp.ws.close()
  chrome.kill()
  server.close()
  await sleep(300)
  try { rmSync(PROFILE, { recursive: true, force: true }) } catch (e) { /* 무시 */ }

  const bad = checks.filter((c) => !c.pass)
  console.log(`\n검사 ${checks.length}개 중 통과 ${checks.length - bad.length}, 실패 ${bad.length}`)
  console.log('스크린샷 ->', OUT)
  process.exit(failed || bad.length ? 1 : 0)
}
