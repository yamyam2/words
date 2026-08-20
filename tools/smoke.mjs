// 배포된 주소가 실제로 동작하는지 확인한다.
// 사용: node tools/smoke.mjs [주소]   (기본값: GitHub Pages 주소)
import { spawn } from 'node:child_process'
import { existsSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SITE = process.argv[2] || 'https://yamyam2.github.io/words/'
const PORT = 9335
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find(existsSync)
if (!CHROME) throw new Error('크롬을 찾지 못했습니다')

const PROFILE = join(tmpdir(), 'todays-word-smoke-profile')
const OUT = join(ROOT, 'dist', 'shots')
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const checks = []
const check = (name, pass, detail = '') => {
  checks.push(pass)
  console.log(`  ${pass ? 'OK  ' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`)
}

// 전송 용량 확인 — 모바일에서 처음 여는 속도를 좌우한다
const plain = await fetch(SITE, { headers: { 'accept-encoding': 'identity' } })
const raw = (await plain.arrayBuffer()).byteLength
const gz = await fetch(SITE, { headers: { 'accept-encoding': 'gzip' } })
const encoded = gz.headers.get('content-encoding')
console.log(`\n원본 ${(raw / 1024).toFixed(0)} KB · 전송 인코딩 ${encoded || '없음'}`)
check('gzip 으로 전송된다', encoded === 'gzip' || encoded === 'br', encoded || '압축 없음')

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
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
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', rej, { once: true })
  })
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const msgId = ++id
    pending.set(msgId, { resolve, reject })
    ws.send(JSON.stringify({ id: msgId, method, params, ...(sessionId ? { sessionId } : {}) }))
  })
  return { ws, ready, send }
}

const cdp = connect(await browserSocket())
await cdp.ready
const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
const call = (m, p) => cdp.send(m, p, sessionId)
await call('Page.enable')
await call('Runtime.enable')
await call('Emulation.setDeviceMetricsOverride', {
  width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
  screenOrientation: { angle: 0, type: 'portraitPrimary' },
})
async function evaluate(expression) {
  const res = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || 'JS 오류')
  return res.result.value
}
async function goto(url) {
  await call('Page.navigate', { url })
  for (let i = 0; i < 100; i++) {
    if (await evaluate('document.readyState === "complete" && !!window.TW').catch(() => false)) return
    await sleep(150)
  }
  throw new Error('페이지 로드 실패: ' + url)
}
async function shot(name) {
  const { data } = await call('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, name + '.png'), Buffer.from(data, 'base64'))
}

try {
  console.log(`\n${SITE} 확인`)
  const started = Date.now()
  await goto(SITE)
  console.log(`  (로드 ${((Date.now() - started) / 1000).toFixed(1)}초)`)

  const page = await evaluate(`({
    title: document.title,
    words: typeof Words === 'object' && Words.lengths.join(','),
    shareUrl: TW.shareUrl(),
    home: !document.getElementById('home').hidden,
  })`)
  check('게임이 뜬다', page.home && page.title === '오늘의 단어', page.title)
  check('단어 데이터가 실렸다', page.words === '4,5,6,7', page.words)
  check('공유 가능한 주소로 인식', typeof page.shareUrl === 'string' && page.shareUrl.startsWith('https://'), String(page.shareUrl))
  await shot('live-01-home')

  // 출제 → 잠금 링크가 진짜 주소로 나오는지
  const link = await evaluate(`(() => {
    document.querySelector('[data-go=compose]').click()
    const input = document.getElementById('composeInput')
    input.value = '시민'; input.dispatchEvent(new Event('input', { bubbles: true }))
    document.getElementById('composeMake').click()
    return document.getElementById('composeLink').value
  })()`)
  check('잠금 링크가 진짜 주소로 나온다', link.startsWith(SITE.replace(/\/$/, '')) && link.includes('#p='), link)

  // 그 링크로 실제로 풀리는지
  await goto(link)
  await evaluate(`(async () => {
    for (const j of Array.from(TW.state.answerJamo)) TW.press(j)
    TW.submit()
    await new Promise((r) => setTimeout(r, 2600))
  })()`)
  const played = await evaluate(`({
    answer: TW.state.answer, locked: TW.state.locked, status: TW.state.status,
    sheet: document.getElementById('sheetCard').textContent,
  })`)
  check('링크로 그 문제가 열리고 잠겨 있다', played.answer === '시민' && played.locked === true)
  check('풀면 결과가 뜬다', played.status === 'won' && played.sheet.includes('시민'))
  check('잠금이라 다른 모드 버튼이 없다', !played.sheet.includes('새 문제') && played.sheet.includes('나도 문제 내보기'))
  await shot('live-02-locked')
} catch (err) {
  check('오류 없이 끝남', false, err.message)
} finally {
  cdp.ws.close()
  chrome.kill()
  await sleep(300)
  try { rmSync(PROFILE, { recursive: true, force: true }) } catch (e) { /* 무시 */ }
  const bad = checks.filter((ok) => !ok).length
  console.log(`\n검사 ${checks.length}개 중 통과 ${checks.length - bad}, 실패 ${bad}`)
  process.exit(bad ? 1 : 0)
}
