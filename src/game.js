// 오늘의 단어 — 게임 로직
// 보드는 자모 단위로만 다룬다. 조합된 글자는 정답을 공개할 때만 보여준다.
;(function () {
  'use strict'

  const H = globalThis.Hangul
  const W = globalThis.Words

  const MAX_TRIES = 5
  const SIZES = W.lengths                       // [4, 5, 6, 7]
  const BACK = '←'      // 지우기
  const ENTER = '↑'     // 제출
  const KEY_ROWS = [
    ['ㅂ', 'ㅈ', 'ㄷ', 'ㄱ', 'ㅅ', 'ㅛ', 'ㅕ', 'ㅑ', BACK],
    ['ㅁ', 'ㄴ', 'ㅇ', 'ㄹ', 'ㅎ', 'ㅗ', 'ㅓ', 'ㅏ', 'ㅣ'],
    ['ㅋ', 'ㅌ', 'ㅊ', 'ㅍ', 'ㅠ', 'ㅜ', 'ㅡ', ENTER],
  ]
  // 데스크톱 두벌식 자판. ㅐ·ㅔ 등은 게임 자모가 아니므로 두 칸으로 펼쳐서 넣는다.
  const QWERTY = {
    q: 'ㅂ', w: 'ㅈ', e: 'ㄷ', r: 'ㄱ', t: 'ㅅ', y: 'ㅛ', u: 'ㅕ', i: 'ㅑ', o: 'ㅐ', p: 'ㅔ',
    a: 'ㅁ', s: 'ㄴ', d: 'ㅇ', f: 'ㄹ', g: 'ㅎ', h: 'ㅗ', j: 'ㅓ', k: 'ㅏ', l: 'ㅣ',
    z: 'ㅋ', x: 'ㅌ', c: 'ㅊ', v: 'ㅍ', b: 'ㅠ', n: 'ㅜ', m: 'ㅡ',
  }
  const MARK_EMOJI = { correct: '\u{1F7E9}', present: '\u{1F7E8}', absent: '⬜' }
  const MODE_LABEL = {
    daily: '오늘의 문제', free: '무한 연습', custom: '친구가 낸 문제',
    versus: '같은 단어 대결', setter: '출제 대결', relay: '릴레이', coop: '협동',
  }

  const $ = (sel) => document.querySelector(sel)
  const el = { home: $('#home'), game: $('#game'), board: $('#board'), keyboard: $('#keyboard'),
    toast: $('#toast'), sheet: $('#sheet'), sheetCard: $('#sheetCard'), resultbar: $('#resultbar'),
    title: $('#gameTitle'), sub: $('#gameSub'), sizePicker: $('#sizePicker'),
    back: $('#btnBack'), menu: $('#btnMenu') }

  // ── 저장소 (샌드박스 iframe 에서 localStorage 가 막힐 수 있어 메모리로 폴백) ──
  const mem = {}
  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); if (v != null) return JSON.parse(v) } catch (e) { /* 무시 */ }
      return key in mem ? mem[key] : fallback
    },
    set(key, value) {
      mem[key] = value
      try { localStorage.setItem(key, JSON.stringify(value)) } catch (e) { /* 무시 */ }
    },
  }

  // ── 날짜 · 난수 ──────────────────────────────────────────────────────
  function kstToday() {
    const now = new Date()
    const kst = new Date(now.getTime() + (now.getTimezoneOffset() + 540) * 60000)
    const p = (n) => String(n).padStart(2, '0')
    return `${kst.getFullYear()}-${p(kst.getMonth() + 1)}-${p(kst.getDate())}`
  }
  function mulberry32(seed) {
    let a = seed >>> 0
    return function () {
      a = (a + 0x6d2b79f5) >>> 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }
  // 같은 날짜·칸수면 누구에게나 같은 문제가 나온다
  function dailyAnswer(date, size) {
    const rnd = mulberry32(Number(date.replace(/-/g, '')) * 131 + size * 7919)
    rnd(); rnd(); rnd()
    return W.answers[size][Math.floor(rnd() * W.answers[size].length)]
  }
  function freeAnswer(size) {
    const pool = W.answers[size]
    const recent = store.get('tw.recent.v1', {})
    const used = new Set(recent[size] || [])
    const fresh = pool.filter((w) => !used.has(w))
    const list = fresh.length ? fresh : pool
    const word = list[Math.floor(Math.random() * list.length)]
    const keep = Math.min(80, Math.floor(pool.length / 2))
    recent[size] = [...(recent[size] || []), word].slice(-keep)
    store.set('tw.recent.v1', recent)
    return word
  }

  // ── 커스텀 문제 링크 (#w=base64url) ─────────────────────────────────
  const b64url = {
    encode(text) {
      const bytes = new TextEncoder().encode(text)
      let bin = ''
      for (const b of bytes) bin += String.fromCharCode(b)
      return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    },
    decode(text) {
      const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
      return new TextDecoder().decode(bytes)
    },
  }
  // 남에게 보내도 열리는 주소일 때만 링크를 만든다.
  // 아티팩트 안에서는 location 이 일회용 내부 프레임 주소(...frame.claudeusercontent.com/_f/...)라
  // 그대로 보내면 상대에게 'page not found' 가 뜬다. 그럴 땐 링크 대신 문제 코드를 준다.
  function shareUrl() {
    if (!/^https?:$/.test(location.protocol)) return null       // file:// 등
    if (window.self !== window.top) return null                 // iframe 안 (아티팩트 등)
    if (/\.frame\.claudeusercontent\.com$/.test(location.hostname)) return null
    if (location.pathname.startsWith('/_f/')) return null
    if (/__frame_[tv]=/.test(location.search)) return null
    return location.origin + location.pathname + location.search
  }

  // 링크든 코드든 붙여넣은 문자열에서 문제를 꺼낸다.
  // #p= 는 잠금 링크(그 문제 하나만 풀 수 있음), #w= 와 맨코드는 일반.
  function readPuzzle(text) {
    const raw = String(text || '').trim()
    const locked = /[#&?]p=([A-Za-z0-9_-]+)/.exec(raw)
    const match = locked || /[#&?]w=([A-Za-z0-9_-]+)/.exec(raw) || /^([A-Za-z0-9_-]+)$/.exec(raw)
    if (!match) return null
    let word
    try { word = b64url.decode(match[1]) } catch (e) { return null }
    const jamo = H.decompose(word || '')
    if (!jamo) return null
    const size = Array.from(jamo).length
    return SIZES.includes(size) ? { word, size, locked: Boolean(locked) } : null
  }

  // ── 상태 ─────────────────────────────────────────────────────────────
  let state = null
  let busy = false
  let judge = (guess) => H.score(guess, state.answerJamo)
  let pending = []
  let pickedSize = store.get('tw.settings.v1', { size: 5 }).size

  const isValid = (jamo) => W.validSet(jamo.length).has(H.encode(jamo))

  // locked = 잠금 링크로 들어온 경우. 그 문제 하나만 풀 수 있고 나머지 화면은 감춘다.
  function startGame(mode, size, word, locked, maxTries) {
    const answer = word || (mode === 'daily' ? dailyAnswer(kstToday(), size) : freeAnswer(size))
    state = {
      mode, size, answer, locked: Boolean(locked),
      maxTries: Math.max(MAX_TRIES, Math.floor(Number(maxTries) || MAX_TRIES)),
      answerJamo: Array.from(H.decompose(answer)),
      guesses: [], current: [], status: 'playing',
      date: kstToday(), room: globalThis.Room?.current?.code || null,
    }
    if (mode === 'daily') restoreDaily()
    showGame()
  }

  // ── 오늘의 문제 진행 상황 저장/복원 ─────────────────────────────────
  const dailySlot = () => `${state.date}:${state.size}`
  function restoreDaily() {
    const saved = store.get('tw.daily.v1', {})[dailySlot()]
    if (!saved || saved.answer !== state.answer) return
    state.guesses = saved.guesses.map((g) => Array.from(g))
    state.status = saved.status
  }
  function saveDaily() {
    if (state.mode !== 'daily') return
    const all = store.get('tw.daily.v1', {})
    all[dailySlot()] = { answer: state.answer, guesses: state.guesses.map((g) => g.join('')), status: state.status }
    // 오래된 기록은 정리
    const keys = Object.keys(all).sort()
    for (const k of keys.slice(0, Math.max(0, keys.length - 24))) delete all[k]
    store.set('tw.daily.v1', all)
  }

  // ── 통계 ─────────────────────────────────────────────────────────────
  function loadStats() {
    const s = store.get('tw.stats.v1', {})
    for (const n of SIZES) {
      s[n] = s[n] || { played: 0, won: 0, dist: [0, 0, 0, 0, 0], streak: 0, max: 0, last: null }
    }
    return s
  }
  function recordResult() {
    if (state.mode !== 'daily' && state.mode !== 'free') return
    const stats = loadStats()
    const s = stats[state.size]
    s.played++
    if (state.status === 'won') { s.won++; s.dist[state.guesses.length - 1]++ }
    if (state.mode === 'daily') {
      if (state.status === 'won') {
        const yesterday = new Date(new Date(state.date + 'T00:00:00').getTime() - 86400000)
        const p = (n) => String(n).padStart(2, '0')
        const prev = `${yesterday.getFullYear()}-${p(yesterday.getMonth() + 1)}-${p(yesterday.getDate())}`
        s.streak = s.last === prev ? s.streak + 1 : 1
        s.max = Math.max(s.max, s.streak)
      } else s.streak = 0
      s.last = state.date
    }
    store.set('tw.stats.v1', stats)
  }

  // ── 화면 전환 ────────────────────────────────────────────────────────
  function showHome() {
    state = null
    if (location.hash) history.replaceState(null, '', location.pathname + location.search)
    el.game.hidden = true
    const lobby = $('#lobby')
    if (lobby) lobby.hidden = true
    el.home.hidden = false
    paintSizePicker()
  }
  function showGame() {
    closeSheet()          // 해시로 들어오면 열려 있던 시트가 그대로 남는다
    el.home.hidden = true
    const lobby = $('#lobby')
    if (lobby) lobby.hidden = true
    el.game.hidden = false
    el.resultbar.hidden = true
    // hidden 으로 감추면 그리드 칸이 무너져 제목이 눌린다. 자리는 남기고 안 보이게만 한다.
    el.back.classList.toggle('invisible', state.locked)
    el.menu.dataset.sheet = state.locked ? 'rules' : 'stats'
    el.menu.textContent = state.locked ? '?' : '☰'
    el.menu.setAttribute('aria-label', state.locked ? '규칙' : '기록')
    el.title.textContent = MODE_LABEL[state.mode]
    el.sub.textContent = state.mode === 'daily'
      ? `${state.date} · ${state.size}칸`
      : `${state.size}칸 · ${state.maxTries}번 안에`
    buildBoard()
    buildKeyboard()
    fitBoard()
    paint()
    if (state.status !== 'playing') finish(true)
  }
  function paintSizePicker() {
    for (const chip of el.sizePicker.children) {
      chip.setAttribute('aria-pressed', String(Number(chip.dataset.size) === pickedSize))
    }
  }
  const resolveSize = () => (pickedSize === 0 ? SIZES[Math.floor(Math.random() * SIZES.length)] : pickedSize)

  // ── 보드 · 키보드 ────────────────────────────────────────────────────
  function buildBoard() {
    el.board.style.setProperty('--cols', state.size)
    el.board.innerHTML = ''
    for (let r = 0; r < state.maxTries; r++) {
      const row = document.createElement('div')
      row.className = 'row'
      for (let c = 0; c < state.size; c++) row.appendChild(document.createElement('div')).className = 'tile'
      el.board.appendChild(row)
    }
  }
  // 타일은 정사각형이라 보드 폭이 곧 보드 높이를 정한다. 남은 가로·세로 공간 중
  // 빠듯한 쪽에 맞춰 타일 한 변을 정하고, 그만큼만 보드에 준다.
  const TILE_MAX = 68
  const TILE_MIN = 24
  const GAP = 6
  function fitBoard() {
    if (!state || el.game.hidden) return
    const wrap = el.board.parentElement
    const style = getComputedStyle(wrap)
    const availWidth = wrap.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
    const availHeight = wrap.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
    // 아직 레이아웃이 잡히기 전이면 건드리지 않는다. 여기서 음수 폭을 넣으면
    // 브라우저가 그 값을 버리고 직전 판의 폭이 그대로 남아 보드가 어긋난다.
    if (!(availWidth > 0 && availHeight > 0)) return
    const tile = Math.max(TILE_MIN, Math.min(
      TILE_MAX,
      (availWidth - GAP * (state.size - 1)) / state.size,
      (availHeight - GAP * (state.maxTries - 1)) / state.maxTries,
    ))
    el.board.style.width = Math.floor(tile * state.size + GAP * (state.size - 1)) + 'px'
  }
  // 남은 공간이 바뀌면 언제든 다시 맞춘다 — 모바일 주소창이 접히거나, 결과 바가 뜨거나,
  // 화면을 돌리거나, 화면 전환 직후 레이아웃이 늦게 잡히는 경우까지 한 번에 덮는다.
  if (typeof ResizeObserver === 'function') new ResizeObserver(fitBoard).observe(el.board.parentElement)
  else addEventListener('resize', fitBoard)

  function buildKeyboard() {
    el.keyboard.innerHTML = ''
    for (const keys of KEY_ROWS) {
      const row = document.createElement('div')
      row.className = 'krow'
      for (const k of keys) {
        const b = document.createElement('button')
        b.className = 'key' + (k === BACK ? ' fn' : k === ENTER ? ' fn submit' : '')
        b.textContent = k
        b.dataset.key = k
        if (k === BACK) b.setAttribute('aria-label', '지우기')
        if (k === ENTER) b.setAttribute('aria-label', '제출')
        row.appendChild(b)
      }
      el.keyboard.appendChild(row)
    }
  }

  // 제출된 줄과 입력 중인 줄을 그린다. reveal 로 지정한 줄은 색을 칠하지 않는다(애니메이션이 칠함).
  function paint(reveal) {
    state.guesses.forEach((guess, r) => {
      const marks = H.score(guess, state.answerJamo)
      const tiles = el.board.children[r].children
      for (let c = 0; c < state.size; c++) {
        tiles[c].textContent = guess[c]
        tiles[c].className = 'tile' + (r === reveal ? ' filled' : ' ' + marks[c])
      }
    })
    const r = state.guesses.length
    if (r < state.maxTries) {
      const tiles = el.board.children[r].children
      for (let c = 0; c < state.size; c++) {
        tiles[c].textContent = state.current[c] || ''
        tiles[c].className = 'tile' + (state.current[c] ? ' filled' : '')
      }
    }
    if (reveal === undefined) paintKeyboard()
  }
  function paintKeyboard() {
    const rank = { absent: 1, present: 2, correct: 3 }
    const best = {}
    for (const guess of state.guesses) {
      const marks = H.score(guess, state.answerJamo)
      guess.forEach((j, i) => {
        if (!best[j] || rank[marks[i]] > rank[best[j]]) best[j] = marks[i]
      })
    }
    for (const b of el.keyboard.querySelectorAll('.key')) {
      const key = b.dataset.key
      const mark = best[key]
      b.className = 'key' + (key === BACK ? ' fn' : key === ENTER ? ' fn submit' : '') + (mark ? ' ' + mark : '')
    }
  }

  // ── 입력 ─────────────────────────────────────────────────────────────
  function press(key) {
    if (!state || busy || state.status !== 'playing') return
    if (state.room && globalThis.Room && !globalThis.Room.canPlay()) {
      globalThis.Room.blockedInput?.()
      return
    }
    if (key === BACK) { state.current.pop(); paint(); return }
    if (key === ENTER) { submit(); return }
    if (state.current.length >= state.size) return
    // ㅐ·ㄲ 같은 자모를 눌렀다면 두 칸으로 펼쳐 넣는다
    const parts = Array.from(H.expand(key))
    if (!parts.length) return
    for (const p of parts) {
      if (state.current.length >= state.size) break
      state.current.push(p)
    }
    paint()
    const tiles = el.board.children[state.guesses.length].children
    const last = tiles[state.current.length - 1]
    if (last) { last.classList.remove('pop'); void last.offsetWidth; last.classList.add('pop') }
  }

  async function submit() {
    const guess = state.current
    if (guess.length < state.size) return reject('자모를 다 채워주세요')
    // 친구가 직접 낸 문제는 내장 사전에 없을 수도 있다. 정답 그 자체만은 제출할 수 있게 한다.
    const isAnswer = guess.join('') === state.answerJamo.join('')
    if (!isValid(guess) && !isAnswer) return reject('사전에 없는 단어예요')
    // 협동은 방장이 한 줄을 확정한 뒤 모든 화면에 똑같이 적용한다.
    // 여기서 로컬 보드를 먼저 바꾸면 참가자마다 행/턴이 갈라질 수 있다.
    if (state.room && globalThis.Room?.submitCoop?.(guess.slice())) return

    // 비동기 채점기로 교체해도 같은 입력이 두 번 제출되지 않게 채점 전에 잠근다.
    busy = true
    const activeState = state
    let marks
    try { marks = await judge(guess.slice()) } catch (e) {
      busy = false
      toast('채점하지 못했어요. 다시 시도해 주세요')
      return
    }
    if (state !== activeState) { busy = false; return }

    state.guesses.push(guess.slice())
    state.current = []
    const rowIndex = state.guesses.length - 1
    paint(rowIndex)

    const won = marks.every((m) => m === 'correct')
    if (won) state.status = 'won'
    else if (state.guesses.length >= state.maxTries) state.status = 'lost'
    if (state.room) globalThis.Room?.localMark(rowIndex, marks)

    const tiles = el.board.children[rowIndex].children
    marks.forEach((mark, i) => {
      setTimeout(() => {
        tiles[i].classList.add('flip')
        setTimeout(() => { tiles[i].classList.add(mark); tiles[i].classList.remove('filled') }, 220)
      }, i * 180)
    })
    setTimeout(() => {
      busy = false
      paintKeyboard()
      saveDaily()
      if (state.status !== 'playing') {
        recordResult()
        if (state.room) globalThis.Room?.localDone(state.status, state.guesses.length)
        finish()
      }
      flushRemote()
    }, marks.length * 180 + 420)
  }
  function setJudge(next) { judge = typeof next === 'function' ? next : (guess) => H.score(guess, state.answerJamo) }
  function applyRemote(fn) { if (busy) pending.push(fn); else fn() }
  function flushRemote() {
    const q = pending
    pending = []
    for (const fn of q) { try { fn() } catch (e) { /* 원격 이벤트 하나가 뒤 큐를 막지 않게 한다 */ } }
  }
  // 협동 모드에서 다른 참가자가 제출한 한 줄을 같은 보드에 재생한다.
  function applyRoomTurn(guess, marks, status, done) {
    if (!state?.room || state.status !== 'playing' || busy) return false
    if (!Array.isArray(guess) || guess.length !== state.size || !Array.isArray(marks) || marks.length !== state.size) return false
    if (state.guesses.length >= state.maxTries) return false
    busy = true
    const rowIndex = state.guesses.length
    state.guesses.push(guess.slice())
    state.current = []
    state.status = ['won', 'lost'].includes(status) ? status : 'playing'
    paint(rowIndex)
    const tiles = el.board.children[rowIndex].children
    marks.forEach((mark, i) => {
      setTimeout(() => {
        tiles[i].classList.add('flip')
        setTimeout(() => { tiles[i].classList.add(mark); tiles[i].classList.remove('filled') }, 220)
      }, i * 180)
    })
    setTimeout(() => {
      busy = false
      paintKeyboard()
      if (typeof done === 'function') done()
      flushRemote()
    }, marks.length * 180 + 420)
    return true
  }
  function reject(message) {
    toast(message)
    const row = el.board.children[state.guesses.length]
    row.classList.remove('shake'); void row.offsetWidth; row.classList.add('shake')
  }

  function finish(restored) {
    if (state.room) { el.resultbar.hidden = true; return }
    el.resultbar.hidden = false
    if (state.status === 'won' && !restored) {
      const tiles = el.board.children[state.guesses.length - 1].children
      Array.from(tiles).forEach((t, i) => setTimeout(() => t.classList.add('bounce'), i * 90))
      setTimeout(() => openSheet('result'), 900)
    } else if (!restored) {
      toast('정답은 ' + state.answer, 2400)
      setTimeout(() => openSheet('result'), 1500)
    }
  }

  let toastTimer
  function toast(message, ms = 1400) {
    el.toast.textContent = message
    el.toast.hidden = false
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => { el.toast.hidden = true }, ms)
  }

  // ── 공유 문구 ────────────────────────────────────────────────────────
  function shareGrid() {
    return state.guesses
      .map((g) => H.score(g, state.answerJamo).map((m) => MARK_EMOJI[m]).join(''))
      .join('\n')
  }
  function shareText() {
    const score = state.status === 'won' ? `${state.guesses.length}/${state.maxTries}` : `X/${state.maxTries}`
    const head = state.mode === 'daily'
      ? `오늘의 단어 ${state.size}칸 · ${state.date} · ${score}`
      : `${MODE_LABEL[state.mode]} ${state.size}칸 · ${score}`
    const base = shareUrl()
    const link = base && state.mode === 'custom' ? base + location.hash : base
    return [head, shareGrid(), link].filter(Boolean).join('\n')
  }
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true } catch (e) { /* 폴백 */ }
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      ta.remove()
      return ok
    } catch (e) { return false }
  }
  async function copyAndTell(text, okMessage) {
    if (await copyText(text)) toast(okMessage)
    else openSheet('copy', text)          // 클립보드가 막힌 환경 폴백
  }

  // ── 시트 ─────────────────────────────────────────────────────────────
  // 낱자모 ㅣ 는 세로줄처럼 보여서, 자모열은 작은 타일로 보여 준다
  const jamoChips = (jamo) => `<span class="chips">${Array.from(jamo).map((j) => `<b>${j}</b>`).join('')}</span>`
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

  function openSheet(kind, payload) {
    const html = SHEETS[kind](payload)
    el.sheetCard.innerHTML = `<button class="sheet-close" data-close aria-label="닫기">&times;</button>${html}`
    el.sheet.hidden = false
    el.sheetCard.scrollTop = 0
    const field = el.sheetCard.querySelector('[autofocus]')
    if (field) setTimeout(() => field.focus(), 60)
  }
  const closeSheet = () => { el.sheet.hidden = true }

  const SHEETS = {
    rules: () => `
      <h2>규칙</h2>
      <p>숨겨진 단어를 <b>다섯 번</b> 안에 맞히세요. 자음과 모음이 <b>한 칸씩</b> 들어갑니다.</p>
      <div class="hr"></div>
      <p><b>복합모음과 쌍자음은 두 칸을 씁니다.</b></p>
      <ul>
        <li>ㅐ = ㅏ + ㅣ &nbsp;·&nbsp; ㅔ = ㅓ + ㅣ &nbsp;·&nbsp; ㅘ = ㅗ + ㅏ &nbsp;·&nbsp; ㅢ = ㅡ + ㅣ</li>
        <li>ㄲ = ㄱ + ㄱ &nbsp;·&nbsp; ㅆ = ㅅ + ㅅ</li>
        <li>겹받침 ㄳ = ㄱ + ㅅ &nbsp;·&nbsp; ㄼ = ㄹ + ㅂ</li>
      </ul>
      <p class="muted">시민 ${jamoChips('ㅅㅣㅁㅣㄴ')} 5칸</p>
      <p class="muted">전세 ${jamoChips('ㅈㅓㄴㅅㅓㅣ')} 6칸 &nbsp;— ㅔ 가 ㅓ + ㅣ 로 나뉩니다</p>
      <div class="hr"></div>
      <p><b>색으로 알려줍니다.</b></p>
      <div class="example">
        <div class="tile correct">ㅅ</div><div class="tile">ㅜ</div><div class="tile">ㅁ</div>
      </div>
      <p>ㅅ 은 <b>그 자리에</b> 있습니다.</p>
      <div class="example">
        <div class="tile">ㄱ</div><div class="tile present">ㅁ</div><div class="tile">ㅏ</div>
      </div>
      <p>ㅁ 은 단어에 있지만 <b>자리가 다릅니다</b>.</p>
      <div class="example">
        <div class="tile">ㅈ</div><div class="tile">ㅓ</div><div class="tile absent">ㅍ</div>
      </div>
      <p>ㅍ 은 <b>아예 없습니다</b>.</p>
      <p class="muted" style="margin-top:10px">같은 자모가 여러 번 쓰였다면 정답에 들어 있는 개수만큼만 색이 칠해집니다.</p>
      <div class="hr"></div>
      <p class="muted">컴퓨터에서는 두벌식 자판(<span class="kbd">r</span>=ㄱ, <span class="kbd">k</span>=ㅏ …)으로 칠 수 있고
      <span class="kbd">Enter</span> 제출, <span class="kbd">Backspace</span> 로 지웁니다.</p>`,

    stats: () => {
      const stats = loadStats()
      const total = SIZES.reduce((a, n) => ({
        played: a.played + stats[n].played,
        won: a.won + stats[n].won,
        dist: a.dist.map((v, i) => v + stats[n].dist[i]),
      }), { played: 0, won: 0, dist: [0, 0, 0, 0, 0] })
      const streak = state ? stats[state.size].streak : Math.max(...SIZES.map((n) => stats[n].streak))
      const max = Math.max(...SIZES.map((n) => stats[n].max))
      const rate = total.played ? Math.round((total.won / total.played) * 100) : 0
      const peak = Math.max(1, ...total.dist)
      const lastTry = state && state.status === 'won' ? state.guesses.length : 0
      const rows = total.dist.map((v, i) => `
        <div class="dist-row"><i>${i + 1}</i>
          <div class="dist-bar${i + 1 === lastTry ? ' hit' : ''}" style="width:${Math.max(8, (v / peak) * 100)}%">${v}</div>
        </div>`).join('')
      const bySize = SIZES.map((n) => `${n}칸 ${stats[n].won}/${stats[n].played}`).join(' · ')
      return `
        <h2>기록</h2>
        <div class="stat-grid">
          <div><b>${total.played}</b><span>플레이</span></div>
          <div><b>${rate}</b><span>승률 %</span></div>
          <div><b>${streak}</b><span>연승</span></div>
          <div><b>${max}</b><span>최고 연승</span></div>
        </div>
        <p class="muted" style="text-align:center">${bySize}</p>
        <div class="hr"></div>
        <p><b>맞힌 횟수 분포</b></p>
        <div class="dist">${rows}</div>
        <p class="muted" style="margin-top:14px">연승은 <b>오늘의 문제</b>를 이어서 맞힐 때만 올라갑니다. 친구가 낸 문제는 기록에 넣지 않아요.</p>`
    },

    result: () => {
      const won = state.status === 'won'
      const head = won ? `${state.guesses.length}번 만에 맞혔어요` : '아쉬워요'
      const reveal = `
        <h2>${head}</h2>
        <div class="answer-reveal">
          <b>${esc(state.answer)}</b>
          <span>${jamoChips(state.answerJamo.join(''))}</span>
        </div>
        <div class="share-grid">${shareGrid().split('\n').join('<br>')}</div>`
      // 잠금 링크로 들어왔으면 이 문제 하나로 끝. 전체 게임으로 가는 길만 작게 남긴다.
      if (state.locked) {
        return `${reveal}
        <div class="sheet-actions">
          <button class="btn accent" data-act="share">결과 복사하기</button>
        </div>
        <p style="text-align:center;margin-top:18px">
          <button class="textlink" data-go="home">나도 문제 내보기</button>
        </p>`
      }
      const again = state.mode === 'daily'
        ? `<button class="btn" data-go="free">무한 연습으로 계속하기</button>`
        : `<button class="btn" data-go="again">새 문제 풀기</button>`
      return `${reveal}
        <div class="sheet-actions">
          <button class="btn accent" data-act="share">결과 복사하기</button>
          ${again}
          <button class="btn ghost" data-sheet="compose">직접 출제하기</button>
          <button class="btn ghost" data-sheet="stats">기록 보기</button>
        </div>`
    },

    compose: () => {
      const linkable = shareUrl() !== null
      return `
      <h2>직접 출제하기</h2>
      <p class="muted">${linkable
        ? '단어를 정하면 링크가 만들어집니다. 카톡으로 보내면 친구가 바로 풀 수 있어요.'
        : '단어를 정하면 <b>문제 코드</b>가 만들어집니다. 지금 주소는 남에게 보내면 열리지 않는 임시 주소라, 링크 대신 코드를 씁니다.'}</p>
      <div style="margin:16px 0 0">
        <input class="field" id="composeInput" autofocus placeholder="예: 시민" maxlength="4"
               autocomplete="off" autocapitalize="off" spellcheck="false">
        <div class="hint" id="composeHint"></div>
      </div>
      ${linkable ? `
      <label class="check">
        <input type="checkbox" id="composeLock" checked>
        <span>이 링크로는 <b>이 문제 하나만</b> 풀 수 있게<br>
          <span class="muted">끄면 친구가 다른 모드도 자유롭게 쓸 수 있어요</span></span>
      </label>` : ''}
      <div class="sheet-actions">
        <button class="btn primary" id="composeMake" data-act="make-link" disabled>${linkable ? '링크 만들기' : '문제 코드 만들기'}</button>
      </div>
      <div id="composeOut" hidden style="margin-top:16px">
        <textarea class="linkbox" id="composeLink" readonly></textarea>
        <p class="muted" id="composeNote" style="margin-top:8px"></p>
        <div class="sheet-actions">
          <button class="btn accent" data-act="copy-link" id="composeCopy">복사하기</button>
          <button class="btn ghost" data-act="try-link">내가 먼저 풀어보기</button>
        </div>
      </div>
      <div class="hr"></div>
      <h2 style="font-size:16px">친구가 준 문제 풀기</h2>
      <p class="muted">받은 링크나 문제 코드를 그대로 붙여넣으면 됩니다.</p>
      <div style="margin-top:12px">
        <input class="field" id="joinInput" placeholder="링크 또는 코드 붙여넣기"
               autocomplete="off" autocapitalize="off" spellcheck="false">
        <div class="hint" id="joinHint"></div>
      </div>
      <div class="sheet-actions">
        <button class="btn" data-act="join">풀어보기</button>
      </div>`
    },

    copy: (text) => `
      <h2>복사가 막혀 있어요</h2>
      <p class="muted">아래 내용을 길게 눌러 직접 복사해 주세요.</p>
      <textarea class="linkbox" style="height:150px" readonly>${esc(text)}</textarea>`,
  }

  // ── 출제 화면 동작 ───────────────────────────────────────────────────
  let composedWord = null
  function onComposeInput() {
    const input = $('#composeInput')
    const hint = $('#composeHint')
    const make = $('#composeMake')
    const out = $('#composeOut')
    out.hidden = true
    composedWord = null
    make.disabled = true

    const word = input.value.trim()
    if (!word) { hint.textContent = ''; hint.className = 'hint'; return }
    const jamo = H.decompose(word)
    const bad = (msg) => { hint.textContent = msg; hint.className = 'hint bad' }
    if (!jamo) return bad('한글 단어만 낼 수 있어요')
    const n = Array.from(jamo).length
    if (!SIZES.includes(n)) return bad(`자모가 ${n}칸이에요. ${SIZES[0]}~${SIZES[SIZES.length - 1]}칸만 낼 수 있어요`)
    if (!isValid(Array.from(jamo))) return bad('사전에 없는 단어라 친구가 제출할 수 없어요')

    composedWord = word
    hint.textContent = `${n}칸 · ${Array.from(jamo).join(' ')}`
    hint.className = 'hint ok'
    make.disabled = false
  }
  function joinPuzzle() {
    const puzzle = readPuzzle($('#joinInput').value)
    const hint = $('#joinHint')
    if (!puzzle) {
      hint.textContent = '문제를 읽지 못했어요. 링크 전체를 붙여넣어 주세요'
      hint.className = 'hint bad'
      return
    }
    closeSheet()
    startGame('custom', puzzle.size, puzzle.word)
  }
  function makeLink() {
    if (!composedWord) return
    const code = b64url.encode(composedWord)
    const base = shareUrl()
    const lock = $('#composeLock')
    const locked = Boolean(lock && lock.checked)
    $('#composeLink').value = base ? `${base}#${locked ? 'p' : 'w'}=${code}` : code
    $('#composeNote').textContent = !base
      ? '게임 주소와 이 코드를 함께 보내세요. 친구는 아래 “친구가 준 문제 풀기” 칸에 코드를 넣으면 됩니다.'
      : locked
        ? '이 링크로 들어가면 이 문제만 나옵니다. 다른 모드는 보이지 않아요.'
        : '이 링크를 카톡으로 보내면 친구가 바로 풀 수 있어요.'
    $('#composeCopy').textContent = base ? '링크 복사하기' : '문제 코드 복사하기'
    $('#composeOut').hidden = false
    $('#composeOut').scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }

  // 다른 기능 파일이 화면 이동과 액션을 자기 키로 등록할 수 있는 작은 확장점.
  const GOES = {
    home: showHome,
    again: () => startGame(state.mode === 'custom' ? 'free' : state.mode, resolveSize()),
    daily: () => startGame('daily', resolveSize()),
    free: () => startGame('free', resolveSize()),
    compose: () => openSheet('compose'),
  }
  const ACTIONS = {
    'make-link': makeLink,
    join: joinPuzzle,
    share: () => copyAndTell(shareText(), '결과를 복사했어요'),
    'copy-link': () => copyAndTell($('#composeLink').value, shareUrl() ? '링크를 복사했어요' : '문제 코드를 복사했어요'),
    'try-link': () => { closeSheet(); startGame('custom', Array.from(H.decompose(composedWord)).length, composedWord) },
  }

  // ── 이벤트 ───────────────────────────────────────────────────────────
  document.addEventListener('click', (ev) => {
    const target = ev.target.closest('[data-key],[data-go],[data-sheet],[data-act],[data-close],[data-size]')
    if (!target) {
      if (ev.target === el.sheet) closeSheet()
      return
    }
    if (target.dataset.key !== undefined) return press(target.dataset.key)
    if (target.dataset.close !== undefined) return closeSheet()

    if (target.dataset.size !== undefined) {
      pickedSize = Number(target.dataset.size)
      store.set('tw.settings.v1', { size: pickedSize })
      return paintSizePicker()
    }
    if (target.dataset.go) {
      closeSheet()
      const fn = GOES[target.dataset.go]
      if (fn) return fn(target, ev)
    }
    if (target.dataset.sheet) return openSheet(target.dataset.sheet)

    if (target.dataset.act) {
      const fn = ACTIONS[target.dataset.act]
      if (fn) return fn(target, ev)
    }
  })

  document.addEventListener('input', (ev) => { if (ev.target.id === 'composeInput') onComposeInput() })
  // 잠금 체크를 바꾸면 이미 만들어 둔 링크도 따라 바뀌어야 한다
  document.addEventListener('change', (ev) => {
    if (ev.target.id === 'composeLock' && composedWord && !$('#composeOut').hidden) makeLink()
  })
  document.addEventListener('keydown', (ev) => {
    if (ev.target.tagName === 'INPUT' || ev.target.tagName === 'TEXTAREA') {
      if (ev.key === 'Enter' && ev.target.id === 'composeInput' && composedWord) makeLink()
      if (ev.key === 'Enter' && ev.target.id === 'joinInput') joinPuzzle()
      return
    }
    if (!el.sheet.hidden) { if (ev.key === 'Escape') closeSheet(); return }
    if (el.game.hidden) return
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return
    if (ev.key === 'Enter') { ev.preventDefault(); return press(ENTER) }
    if (ev.key === 'Backspace') { ev.preventDefault(); return press(BACK) }
    const ch = ev.key.length === 1 ? ev.key : ''
    if (!ch) return
    if (H.ALPHABET.includes(ch)) return press(ch)
    const mapped = QWERTY[ch.toLowerCase()]
    if (mapped) { ev.preventDefault(); press(mapped) }
    else if (H.expand(ch)) press(ch)               // 한글 IME 로 친 ㅐ·ㄲ 등
  })
  // ── 시작 ─────────────────────────────────────────────────────────────
  function bootFromHash() {
    const roomMatch = /[#&]r=([23456789ABCDEFGHJKMNPQRSTVWXYZ]{6})/i.exec(location.hash)
    if (roomMatch) {
      globalThis.TWRoomHash = roomMatch[1].toUpperCase()
      return false
    }
    if (!/[#&]([wpr])=/.test(location.hash)) return false
    const puzzle = readPuzzle(location.hash)
    if (!puzzle) return false
    startGame('custom', puzzle.size, puzzle.word, puzzle.locked)
    return true
  }
  paintSizePicker()
  if (!bootFromHash()) showHome()
  window.addEventListener('hashchange', () => { if (!bootFromHash()) showHome() })

  // 브라우저 콘솔·자동 테스트용 훅
  globalThis.TW = {
    press, submit, startGame,
    get state() { return state },
    get busy() { return busy },
    shareText, shareUrl, freeAnswer, resolveSize,
    SHEETS, GOES, ACTIONS, openSheet, closeSheet, toast, store, isValid, b64url,
    MAX_TRIES, SIZES, setJudge, applyRemote, applyRoomTurn,
    repaint: () => { if (state) paint() },
    restoreRoomGame: (guesses, status = 'playing') => {
      if (!state || !state.room) return
      state.guesses = (guesses || []).map((guess) => Array.from(guess).slice(0, state.size))
      state.current = []
      state.status = ['playing', 'won', 'lost'].includes(status) ? status : 'playing'
      paint()
    },
    endRoomGame: () => {
      if (!state || !state.room || state.status !== 'playing') return
      state.status = 'lost'
      state.current = []
      paint()
      el.resultbar.hidden = true
    },
    copyAndTell,
  }
})()
