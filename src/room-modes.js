// 네 가지 멀티플레이 모드의 방 UI와 상태 기계. 네트워크 세부사항은 Net 에만 맡긴다.
;(function () {
  'use strict'
  const Net = globalThis.Net
  const TW = globalThis.TW
  const H = globalThis.Hangul
  const $ = (s) => document.querySelector(s)
  const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  const TO_WIRE = { absent: '0', present: '1', correct: '2' }
  const FROM_WIRE = ['absent', 'present', 'correct']
  const MODES = { versus: '같은 단어 대결', setter: '출제 대결', relay: '릴레이', coop: '협동' }
  const QUICK_MESSAGES = ['ㅋㅋㅋ', '화이팅!', '오 거의 다 왔다!', '천천히 해도 돼']
  let room = null
  let draft = { kind: 'versus', size: 5, roundsTotal: 1, waitSeconds: 60 }
  let timer = null
  let nextTimer = null
  let skipTimer = null
  let waitTimer = null
  let lastBlocked = 0

  function makePid() {
    const bytes = new Uint8Array(12)
    if (globalThis.crypto?.getRandomValues) crypto.getRandomValues(bytes)
    else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
    return Array.from(bytes, (n) => n.toString(36).padStart(2, '0')).join('')
  }
  function savedPlayer() {
    const saved = TW.store.get('tw.player.v1', {})
    return { pid: saved.pid || makePid(), nick: saved.nick || '' }
  }
  function normalizeCode(value) {
    const m = String(value || '').toUpperCase().match(/(?:[#&?]r=)?([23456789ABCDEFGHJKMNPQRSTVWXYZ]{6})(?:\b|$)/)
    return m ? m[1] : null
  }
  function inviteText() { return TW.shareUrl() ? `${TW.shareUrl()}#r=${room.code}` : room.code }
  function orderedPlayers() {
    return room ? Array.from(room.peers.values()).sort((a, b) => a.joinedAt - b.joinedAt || a.pid.localeCompare(b.pid)) : []
  }
  function onlinePlayers() { return orderedPlayers().filter((p) => p.online) }
  function displayNames(list = orderedPlayers()) {
    const counts = new Map()
    return new Map(list.map((p) => {
      const n = (counts.get(p.nick) || 0) + 1
      counts.set(p.nick, n)
      return [p.pid, n === 1 ? p.nick : `${p.nick}${n}`]
    }))
  }
  function playerName(pid) { return displayNames().get(pid) || '참가자' }
  function totalsObject() { return Object.fromEntries(room?.totals || []) }
  function persistRoom() {
    if (!room) return TW.store.set('tw.room.v1', null)
    const state = TW.state
    TW.store.set('tw.room.v1', {
      code: room.code, nick: room.me.nick, kind: room.kind, size: room.size,
      round: room.round, roundsTotal: room.roundsTotal, active: Boolean(room.startedAt && !room.over),
      guesses: state?.room === room.code ? state.guesses.map((g) => H.encode(g)) : [],
      status: state?.room === room.code ? state.status : 'playing',
      setterPid: room.setterPid, turnPid: room.turnPid, totals: totalsObject(), waitSeconds: room.waitSeconds,
    })
  }

  TW.SHEETS.rooms = () => {
    const player = savedPlayer()
    const preset = globalThis.TWRoomHash || ''
    return `<h2>같이 하기</h2>
      <p class="muted">친구들과 실시간으로 대결하거나 한 보드를 함께 풀 수 있어요.</p>
      <div style="margin-top:16px"><input class="field" id="roomNick" ${preset ? 'autofocus' : ''} placeholder="닉네임" maxlength="16" value="${esc(player.nick)}" autocomplete="nickname" autocapitalize="off" spellcheck="false"><div class="hint" id="roomHint"></div></div>
      <div class="sheet-actions"><button class="btn primary" data-act="room-open-create">새 방 만들기</button></div>
      <div class="hr"></div><p><b>방 코드로 들어가기</b></p>
      <div style="margin-top:10px"><input class="field" id="roomJoinCode" placeholder="6자리 코드" maxlength="80" value="${esc(preset)}" autocomplete="off" autocapitalize="characters" spellcheck="false"></div>
      <div class="sheet-actions"><button class="btn" data-act="room-join">들어가기</button></div>`
  }
  TW.SHEETS.create = () => `<h2>방 만들기</h2><p><b>모드</b></p>
    <div class="room-options">${Object.entries(MODES).map(([k, label]) => `<button class="chip" data-rmode="${k}" aria-pressed="${draft.kind === k}">${label}</button>`).join('')}</div>
    <p><b>칸 수</b></p><div class="room-options">${[4, 5, 6, 7, 0].map((n) => `<button class="chip" data-rsize="${n}" aria-pressed="${draft.size === n}">${n || '랜덤'}${n ? '칸' : ''}</button>`).join('')}</div>
    <div ${draft.kind === 'relay' ? '' : 'hidden'}><p><b>라운드</b></p><div class="room-options">${[1, 3, 5].map((n) => `<button class="chip" data-rounds="${n}" aria-pressed="${draft.roundsTotal === n}">${n}라운드</button>`).join('')}</div></div>
    <div ${draft.kind === 'coop' ? 'hidden' : ''}><p><b>첫 완주 후 대기</b></p><div class="room-options">${[30, 60, 90, 0].map((n) => `<button class="chip" data-wait="${n}" aria-pressed="${draft.waitSeconds === n}">${n ? `${n}초` : '제한 없음'}</button>`).join('')}</div></div>
    <p class="muted">${draft.kind === 'setter' ? '방장이 로비에서 출제자를 고릅니다.' : draft.kind === 'relay' ? '라운드 점수를 더해 최종 승자를 정합니다.' : draft.kind === 'coop' ? '한 보드를 공유하며 차례대로 한 줄씩 냅니다.' : '모두 같은 단어를 동시에 풉니다.'}</p>
    <div class="sheet-actions"><button class="btn primary" data-act="room-create">방 만들기</button></div>`
  TW.SHEETS.roommenu = () => {
    if (!room) return '<h2>방을 찾지 못했어요</h2>'
    const sec = room.startedAt ? Math.floor((Date.now() - room.startedAt) / 1000) : 0
    return `<h2>방 메뉴</h2><p class="muted">${MODES[room.kind]} · 방 코드 <b>${esc(room.code)}</b> · ${Math.floor(sec / 60)}분 ${sec % 60}초</p><div class="sheet-actions">
      <button class="btn ghost" data-act="room-copy">초대 ${TW.shareUrl() ? '링크' : '코드'} 복사</button>
      ${room.host && room.startedAt && !room.over ? '<button class="btn accent" data-act="room-force">모두 강제 종료</button>' : ''}
      <button class="btn ghost" data-go="leave">방 나가기</button></div>`
  }
  TW.SHEETS.pickword = () => `<h2>문제 내기</h2><p class="muted">한글 단어를 입력하세요. 자음과 모음으로 펼쳤을 때 <b>${room?.pick?.size || room?.size || 5}칸</b>이어야 합니다.</p>
    <div style="margin-top:16px"><input class="field" id="roomWord" autofocus placeholder="예: 시민" maxlength="8" autocomplete="off" spellcheck="false"><div class="hint" id="roomWordHint">단어를 입력해 주세요</div></div>
    <div class="sheet-actions"><button class="btn primary" id="roomWordButton" data-act="room-word" disabled>이 단어 내기</button></div>`

  TW.GOES.rooms = () => TW.openSheet('rooms')
  TW.GOES.leave = leaveRoom
  TW.ACTIONS['room-open-create'] = () => {
    const nick = readNick()
    if (!nick) return
    TW.store.set('tw.player.v1', { ...savedPlayer(), nick })
    TW.openSheet('create')
  }
  TW.ACTIONS['room-create'] = () => enterRoom(Net.roomCode(), savedPlayer().nick, draft)
  TW.ACTIONS['room-join'] = () => {
    const nick = readNick()
    const code = normalizeCode($('#roomJoinCode')?.value)
    if (!nick) return
    if (!code) return setRoomHint('6자리 방 코드를 확인해 주세요')
    enterRoom(code, nick, { kind: 'versus', size: 5, roundsTotal: 1 })
  }
  Object.assign(TW.ACTIONS, {
    'room-start': startRound, 'room-next': nextRound, 'room-again': playAgain,
    'room-standings': () => TW.openSheet('standings'), 'room-force': forceRound,
    'room-copy': () => TW.copyAndTell(inviteText(), TW.shareUrl() ? '초대 링크를 복사했어요' : '방 코드를 복사했어요'),
    'room-copy-result': copyResult, 'room-word': submitSetterWord,
  })
  function readNick() {
    const input = $('#roomNick')
    const nick = String(input?.value || savedPlayer().nick).trim().replace(/\s+/g, ' ').slice(0, 16)
    if (!nick) { setRoomHint('닉네임을 입력해 주세요'); input?.focus(); return null }
    return nick
  }
  function setRoomHint(message) {
    const hint = $('#roomHint')
    if (hint) { hint.textContent = message; hint.className = 'hint bad' }
  }
  function showLobby() {
    TW.closeSheet(); $('#home').hidden = true; $('#game').hidden = true; $('#lobby').hidden = false
    $('#roomCode').textContent = room.code
    const base = TW.shareUrl()
    $('#roomInvite').innerHTML = `<div class="room-invite">${base ? `<textarea class="linkbox" readonly>${esc(inviteText())}</textarea>` : '<p class="muted" style="text-align:left;flex:1">게임 주소와 이 코드를 함께 보내세요.</p>'}<button class="btn ghost" data-act="room-copy">${base ? '링크 복사' : '코드 복사'}</button></div>`
    renderLobby()
  }
  function renderLobby() {
    if (!room || $('#lobby').hidden) return
    const list = orderedPlayers().filter((p) => p.online)
    const names = displayNames()
    const choose = room.host && room.kind === 'setter' && !room.startedAt
    $('#roomCount').textContent = `${list.length}명`
    $('#roomRoster').innerHTML = list.map((p) => `<li ${choose ? `data-setter="${esc(p.pid)}" aria-pressed="${p.pid === room.setterPid}"` : ''}><b>${esc(names.get(p.pid))}${p.pid === room.me.pid ? ' (나)' : ''}</b><span>${room.kind === 'setter' && p.pid === room.setterPid ? '출제자' : p.pid === room.hostPid ? '방장' : '참가자'}</span></li>`).join('')
    const wait = room.kind !== 'coop' ? ` · 완주 후 ${room.waitSeconds ? `${room.waitSeconds}초` : '제한 없음'}` : ''
    const detail = `${MODES[room.kind]} · ${room.size ? `${room.size}칸` : '랜덤 칸'}${room.kind === 'relay' ? ` · ${room.roundsTotal}라운드` : ''}${wait}`
    $('#lobbyActions').innerHTML = room.host
      ? `<p class="muted">${detail}${choose ? '<br>이름을 눌러 출제자를 바꿀 수 있어요.' : ''}</p><button class="btn primary" data-act="room-start" ${Net.status === 'live' ? '' : 'disabled'}>시작하기</button><button class="btn ghost" data-go="leave">나가기</button>`
      : `<p class="muted">${detail}<br>방장이 시작하기를 기다리는 중…</p><button class="btn ghost" data-go="leave">나가기</button>`
    $('#lobbyStatus').textContent = ({ off: '오프라인', connecting: '연결하는 중…', live: '연결됨', retry: '다시 연결하는 중…', down: '연결을 기다리는 중…' })[Net.status] || Net.status
  }
  function enterRoom(code, nick, options, resume) {
    const old = savedPlayer()
    const me = { pid: old.pid, nick, joinedAt: Date.now(), role: 'player' }
    TW.store.set('tw.player.v1', { pid: me.pid, nick })
    draft = { ...draft, ...options }
    room = {
      code, kind: draft.kind, round: Number(resume?.round) || 1,
      roundsTotal: draft.kind === 'relay' ? Number(draft.roundsTotal) || 3 : 1, size: draft.size,
      waitSeconds: [0, 30, 60, 90].includes(Number(draft.waitSeconds)) ? Number(draft.waitSeconds) : 60,
      me, host: false, hostPid: null, peers: new Map([[me.pid, { ...me, rows: [], status: 'waiting', online: true }]]),
      activePids: new Set(), participants: [], results: new Map(), totals: new Map(Object.entries(resume?.totals || {})),
      startedAt: null, answer: null, over: false, final: false, scoreResults: [],
      setterPid: resume?.setterPid || me.pid, turnPid: resume?.turnPid || null, pick: null, resume: resume || null,
      waitEndsAt: null, coopPending: false,
    }
    globalThis.TWRoomHash = null
    persistRoom(); showLobby()
    Net.connect(code, me).catch(() => { if (room?.code === code) TW.toast('방을 깨우는 중이에요. 자동으로 다시 연결할게요', 2600) })
  }
  function leaveRoom() {
    clearInterval(timer); clearTimeout(nextTimer); clearTimeout(skipTimer); clearTimeout(waitTimer)
    timer = nextTimer = skipTimer = waitTimer = null
    Net.leave(); room = null; TW.store.set('tw.room.v1', null)
    document.body.classList.remove('watching')
    $('#keyboard').hidden = false; $('.board-wrap').hidden = false; $('#peers').hidden = true; $('#roomBanner').hidden = true; $('#quickChat').hidden = true
    $('#btnBack').dataset.go = 'home'; $('#btnMenu').dataset.sheet = 'stats'; $('#btnMenu').textContent = '☰'; $('#btnMenu').setAttribute('aria-label', '기록')
    TW.GOES.home()
  }

  function lobbyPayload() { return { kind: room.kind, size: room.size, roundsTotal: room.roundsTotal, setterPid: room.setterPid, waitSeconds: room.waitSeconds } }
  function broadcastLobby() {
    if (room?.host && !room.startedAt && Net.status === 'live') Net.send('lobby', lobbyPayload())
  }
  function onLobby(payload) {
    if (!room || room.startedAt || room.host || !Object.hasOwn(MODES, payload.kind)) return
    const size = Number(payload.size); const rounds = Number(payload.roundsTotal)
    if (![0, ...TW.SIZES].includes(size)) return
    room.kind = payload.kind; room.size = size
    room.roundsTotal = payload.kind === 'relay' && [1, 3, 5].includes(rounds) ? rounds : 1
    room.waitSeconds = [0, 30, 60, 90].includes(Number(payload.waitSeconds)) ? Number(payload.waitSeconds) : 60
    room.setterPid = String(payload.setterPid || room.hostPid || '')
    renderLobby(); persistRoom()
  }
  function onRoster(roster) {
    if (!room) return
    const online = new Set()
    for (const person of roster) {
      online.add(person.pid)
      const prev = room.peers.get(person.pid) || { rows: [], status: room.startedAt ? 'spectator' : 'waiting' }
      room.peers.set(person.pid, { ...prev, ...person, online: true })
    }
    for (const p of room.peers.values()) p.online = online.has(p.pid)
    room.hostPid = Net.electHost(roster); room.host = room.hostPid === room.me.pid
    if (!room.setterPid || !room.peers.get(room.setterPid)?.online) room.setterPid = room.hostPid
    renderLobby(); renderPeers(); renderBanner()
    if (!room.startedAt) broadcastLobby()
    if (room.kind === 'coop' && room.startedAt && !room.over) scheduleTurnSkip()
    if (room.host && room.waitEndsAt && !room.over) {
      clearTimeout(waitTimer)
      waitTimer = setTimeout(forceRound, Math.max(0, room.waitEndsAt - Date.now()))
    }
  }
  function onStatus(status) {
    renderLobby()
    if (!room) return
    if (status === 'retry') TW.toast('연결이 끊겨 다시 연결하고 있어요', 2200)
    if (status === 'live') { Net.send('sync?', { pid: room.me.pid }); broadcastLobby() }
  }
  function resolvedRoomSize() { return room.size === 0 ? TW.SIZES[Math.floor(Math.random() * TW.SIZES.length)] : room.size }
  function roundParticipants(setterPid) { return onlinePlayers().filter((p) => p.pid !== setterPid).map((p) => p.pid) }
  function startRound() {
    if (!room?.host || Net.status !== 'live') return
    clearTimeout(nextTimer)
    const size = resolvedRoomSize()
    if (room.kind === 'setter') {
      const setterPid = room.peers.get(room.setterPid)?.online ? room.setterPid : room.hostPid
      room.setterPid = setterPid; room.pick = { round: room.round, setterPid, size }
      Net.send('pick', room.pick); onPick(room.pick); return
    }
    sendStart(TW.freeAnswer(size), null, size)
  }
  function sendStart(answer, setterPid, size) {
    if (!room?.host) return
    const participants = roundParticipants(setterPid)
    if (!participants.length) return TW.toast('플레이할 참가자가 없어요')
    const payload = {
      round: room.round, roundsTotal: room.roundsTotal, kind: room.kind, size,
      answer: H.encode(H.decompose(answer)), setter: setterPid, participants,
      turnPid: room.kind === 'coop' ? participants[0] : null, waitSeconds: room.waitSeconds, ts: Date.now(),
    }
    Net.send('start', payload); beginRound(payload, false)
  }
  function onPick(payload) {
    if (!room || room.startedAt || room.kind !== 'setter') return
    const size = Number(payload.size)
    if (Number(payload.round) !== room.round || !TW.SIZES.includes(size)) return
    room.pick = { round: room.round, setterPid: String(payload.setterPid), size }; room.setterPid = room.pick.setterPid
    if (room.me.pid === room.setterPid) TW.openSheet('pickword')
    else TW.toast(`${playerName(room.setterPid)}님이 문제를 고르는 중이에요`, 2200)
  }
  function readSetterWord() {
    const raw = String($('#roomWord')?.value || '').trim()
    const decomposed = H.decompose(raw); const jamo = decomposed ? Array.from(decomposed) : []; const size = room?.pick?.size || 0
    return { raw, jamo, size, validLength: Boolean(raw && decomposed && jamo.length === size) }
  }
  function paintSetterWord() {
    const hint = $('#roomWordHint'); const button = $('#roomWordButton')
    if (!hint || !button) return
    const word = readSetterWord(); button.disabled = !word.validLength
    if (!word.raw) { hint.textContent = '단어를 입력해 주세요'; hint.className = 'hint'; return }
    if (!word.validLength) { hint.textContent = `한글을 자모 ${word.size}칸에 맞춰 입력해 주세요`; hint.className = 'hint bad'; return }
    if (!TW.isValid(word.jamo)) { hint.textContent = '사전에 없는 단어예요. 그래도 낼 수 있어요'; hint.className = 'hint bad'; return }
    hint.textContent = `자모 ${word.size}칸 · 낼 수 있어요`; hint.className = 'hint ok'
  }
  function submitSetterWord() {
    if (!room?.pick || room.me.pid !== room.pick.setterPid) return
    const word = readSetterWord()
    if (!word.validLength) return paintSetterWord()
    const payload = { pid: room.me.pid, round: room.pick.round, answer: H.encode(word.jamo), size: word.size }
    TW.closeSheet()
    if (room.host) onWord(payload); else Net.send('word', payload)
  }
  function onWord(payload) {
    if (!room?.host || !room.pick || room.kind !== 'setter') return
    if (String(payload.pid) !== room.pick.setterPid || Number(payload.round) !== room.pick.round) return
    const answer = decodeAnswer(payload.answer)
    if (!answer || Array.from(H.decompose(answer) || '').length !== room.pick.size) return
    const pick = room.pick; room.pick = null; sendStart(answer, pick.setterPid, pick.size)
  }
  function decodeAnswer(value) {
    try { return H.compose(H.decode(String(value || ''))) } catch (e) { return null }
  }
  function validParticipants(payload) {
    const raw = Array.isArray(payload.participants) ? payload.participants.map(String) : []
    // 방장이 정한 순서를 그대로 쓴다. Presence 도착 순서로 다시 거르면 기기마다 턴 순서가 달라진다.
    return Array.from(new Set(raw.filter((pid) => pid && pid.length <= 64)))
  }
  function beginRound(payload, spectator) {
    if (!room || Number(payload.round) < room.round) return
    const answer = decodeAnswer(payload.answer); const size = Number(payload.size)
    if (!answer || !TW.SIZES.includes(size) || !Object.hasOwn(MODES, payload.kind)) return
    room.round = Number(payload.round) || 1; room.roundsTotal = Math.max(1, Number(payload.roundsTotal) || room.roundsTotal || 1)
    room.kind = payload.kind; room.size = size; room.answer = answer
    room.waitSeconds = [0, 30, 60, 90].includes(Number(payload.waitSeconds)) ? Number(payload.waitSeconds) : room.waitSeconds
    room.setterPid = payload.setter ? String(payload.setter) : null
    room.participants = validParticipants(payload); room.activePids = new Set(room.participants)
    room.turnPid = room.kind === 'coop' ? String(payload.turnPid || room.participants[0] || '') : null
    room.startedAt = Date.now(); room.over = false; room.final = false; room.results = new Map(); room.scoreResults = []
    room.waitEndsAt = null; room.coopPending = false; clearTimeout(waitTimer)
    for (const p of room.peers.values()) {
      p.rows = []; p.status = room.activePids.has(p.pid) ? 'playing' : p.pid === room.setterPid ? 'setter' : 'spectator'; p.tries = null; p.ms = null
    }
    const isSetter = room.me.pid === room.setterPid; const isActive = room.activePids.has(room.me.pid)
    room.me.role = isSetter ? 'setter' : spectator || !isActive ? 'spectator' : 'player'
    TW.startGame(room.kind, room.size, answer)
    $('#btnBack').dataset.go = 'leave'; $('#btnMenu').dataset.sheet = 'roommenu'; $('#btnMenu').textContent = '☰'; $('#btnMenu').setAttribute('aria-label', '방 메뉴')
    const watching = room.me.role !== 'player'
    document.body.classList.toggle('watching', watching); $('#keyboard').hidden = watching; $('.board-wrap').hidden = watching
    $('#peers').hidden = room.kind === 'coop'
    renderPeers(); renderBanner(); renderQuickChat(); startTimer(); persistRoom()
  }
  function startTimer() {
    clearInterval(timer)
    const tick = () => {
      if (!room?.startedAt || room.over) return
      const sec = Math.floor((Date.now() - room.startedAt) / 1000)
      const round = room.kind === 'relay' ? `${room.round}/${room.roundsTotal}R · ` : ''
      const left = room.waitEndsAt ? Math.max(0, Math.ceil((room.waitEndsAt - Date.now()) / 1000)) : null
      $('#gameSub').textContent = left === null
        ? `${round}${room.size}칸 · ${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`
        : `${round}마감까지 ${left}초`
    }
    tick(); timer = setInterval(tick, 1000)
  }
  function renderBanner() {
    const banner = $('#roomBanner')
    if (!banner || !room?.startedAt) { if (banner) banner.hidden = true; return }
    let text = ''
    if (room.over) text = `정답: ${room.answer}`
    else if (room.kind === 'coop' && room.coopPending) text = '제출을 확인하는 중…'
    else if (room.kind === 'coop') text = room.turnPid === room.me.pid ? '내 차례예요' : `지금은 ${playerName(room.turnPid)}님 차례`
    else if (room.me.role === 'finished') text = room.waitEndsAt ? '완료! 남은 참가자를 응원해 주세요' : '완료! 다른 참가자의 보드를 보고 있어요'
    else if (room.me.role === 'setter') text = `내가 낸 정답: ${room.answer}`
    else if (room.me.role === 'spectator') text = '이번 라운드는 관전 중이에요'
    banner.textContent = text; banner.hidden = !text
  }
  function canPlay() { return Boolean(room && room.me.role === 'player' && !room.over && (room.kind !== 'coop' || room.turnPid === room.me.pid && !room.coopPending)) }
  function blockedInput() {
    if (!room || Date.now() - lastBlocked < 1200) return
    lastBlocked = Date.now()
    TW.toast(room.me.role !== 'player' ? '이번 라운드는 관전 중이에요' : room.coopPending ? '제출을 확인하는 중이에요' : `${playerName(room.turnPid)}님 차례예요`)
  }
  function renderQuickChat() {
    const bar = $('#quickChat')
    if (!bar || !room?.startedAt || room.over) { if (bar) bar.hidden = true; return }
    const eligible = ['finished', 'setter', 'spectator'].includes(room.me.role)
    if (!eligible) { bar.hidden = true; return }
    const force = room.host && room.kind !== 'coop' ? '<button class="btn accent" data-act="room-force">지금 결과 보기</button>' : ''
    bar.innerHTML = QUICK_MESSAGES.map((text) => `<button class="chip" data-chat="${esc(text)}">${esc(text)}</button>`).join('') + force
    bar.hidden = false
  }
  function showWaitingView() {
    if (!room || room.kind === 'coop' || room.over) return
    room.me.role = 'finished'
    document.body.classList.add('watching')
    $('#keyboard').hidden = true; $('.board-wrap').hidden = true; $('#peers').hidden = false
    renderPeers(); renderBanner(); renderQuickChat()
  }
  function sendChat(text) {
    if (!room || !QUICK_MESSAGES.includes(text) || !['finished', 'setter', 'spectator'].includes(room.me.role) || room.over) return
    Net.send('chat', { pid: room.me.pid, text, round: room.round })
    TW.toast(`나: ${text}`, 1600)
  }
  function onChat(payload) {
    if (!room || room.over || Number(payload.round) !== room.round || !QUICK_MESSAGES.includes(payload.text)) return
    const sender = room.peers.get(String(payload.pid))
    if (!sender) return
    TW.toast(`${playerName(sender.pid)}: ${payload.text}`, 2200)
  }
  function beginWait(payload) {
    if (!room || room.over || room.kind === 'coop' || Number(payload.round) !== room.round) return
    const seconds = Math.max(1, Math.min(90, Number(payload.seconds) || 0))
    room.waitEndsAt = Date.now() + seconds * 1000
    clearTimeout(waitTimer)
    if (room.host) waitTimer = setTimeout(forceRound, seconds * 1000)
    renderBanner(); renderQuickChat()
  }
  function maybeStartWait() {
    if (!room?.host || room.kind === 'coop' || room.over || room.waitEndsAt || !room.waitSeconds) return
    if (!room.results.size || room.results.size >= room.activePids.size) return
    const payload = { round: room.round, seconds: room.waitSeconds }
    Net.send('wait', payload); beginWait(payload)
  }

  function encodeMarks(marks) { return marks.map((m) => TO_WIRE[m]).join('') }
  function decodeMarks(value) {
    const wire = String(value || '')
    if (!/^[012]+$/.test(wire) || wire.length !== room.size) return null
    return Array.from(wire, (n) => FROM_WIRE[Number(n)] || 'absent')
  }
  function nextParticipant(pid, onlineOnly) {
    const list = room.participants.filter((id) => room.activePids.has(id) && (!onlineOnly || room.peers.get(id)?.online))
    if (!list.length) return null
    const i = list.indexOf(pid)
    return list[(i + 1 + list.length) % list.length]
  }
  function localMark(row, marks) {
    if (!room) return
    if (room.kind === 'coop') return
    const p = room.peers.get(room.me.pid)
    if (p) { if (!p.rows) p.rows = []; p.rows[row] = marks.slice() }
    Net.send('mark', { pid: room.me.pid, row, marks: encodeMarks(marks) }); renderPeers(); persistRoom()
  }
  function localDone(status, tries) {
    if (!room || room.me.role !== 'player') return
    if (room.kind === 'coop') { if (room.host) finishCoop(status, tries); return }
    const result = { pid: room.me.pid, status, tries, ms: Date.now() - room.startedAt }
    room.results.set(result.pid, result); Object.assign(room.peers.get(result.pid), result)
    Net.send('done', result); renderPeers(); persistRoom(); showWaitingView(); maybeStartWait(); maybeFinish()
  }
  function onMark(payload) {
    if (!room || room.kind === 'coop' || !room.startedAt || payload.pid === room.me.pid) return
    const p = room.peers.get(String(payload.pid)); const marks = decodeMarks(payload.marks); const row = Number(payload.row)
    if (!p || !marks || !(row >= 0 && row < TW.MAX_TRIES)) return
    if (!p.rows) p.rows = []; p.rows[row] = marks; renderPeers()
  }
  function onDone(payload) {
    if (!room || room.kind === 'coop' || !room.startedAt || payload.pid === room.me.pid) return
    const p = room.peers.get(String(payload.pid))
    if (!p || !room.activePids.has(p.pid)) return
    const result = { pid: p.pid, status: payload.status === 'won' ? 'won' : 'lost', tries: Math.max(1, Math.min(TW.MAX_TRIES, Number(payload.tries) || TW.MAX_TRIES)), ms: Math.max(0, Number(payload.ms) || 0) }
    room.results.set(result.pid, result); Object.assign(p, result); renderPeers(); maybeStartWait(); maybeFinish()
  }
  function submitCoop(guess) {
    if (!room || room.kind !== 'coop') return false
    if (!canPlay()) { blockedInput(); return true }
    room.coopPending = true; renderBanner()
    const row = TW.state.guesses.length
    const payload = { phase: 'submit', pid: room.me.pid, row, guess: H.encode(guess), round: room.round }
    if (room.host) processCoopSubmit(payload)
    else Net.send('turn', payload)
    setTimeout(() => {
      if (!room?.coopPending || room.kind !== 'coop' || room.round !== payload.round || TW.state?.guesses.length !== row) return
      room.coopPending = false; renderBanner(); TW.toast('제출이 전달되지 않았어요. 다시 눌러 주세요')
      Net.send('sync?', { pid: room.me.pid })
    }, 6000)
    return true
  }
  function processCoopSubmit(payload) {
    if (!room?.host || room.kind !== 'coop' || room.over || payload.phase !== 'submit') return
    const pid = String(payload.pid); const row = Number(payload.row)
    if (Number(payload.round) !== room.round || pid !== room.turnPid || row !== TW.state?.guesses.length) return
    let guess
    try { guess = Array.from(H.decode(String(payload.guess || ''))) } catch (e) { return }
    if (guess.length !== room.size) return
    const marks = H.score(guess, TW.state.answerJamo)
    const won = marks.every((mark) => mark === 'correct')
    const status = won ? 'won' : row + 1 >= TW.MAX_TRIES ? 'lost' : 'playing'
    const commit = {
      phase: 'commit', pid, row, guess: H.encode(guess), marks: encodeMarks(marks), status,
      nextPid: status === 'playing' ? nextParticipant(pid, false) : null, round: room.round,
    }
    Net.send('turn', commit)
    applyCoopCommit(commit)
  }
  function applyCoopCommit(payload) {
    if (!room || room.kind !== 'coop' || room.over || payload.phase !== 'commit') return
    const pid = String(payload.pid); const row = Number(payload.row)
    if (Number(payload.round) !== room.round || pid !== room.turnPid || row !== TW.state?.guesses.length) return
    let guess
    try { guess = Array.from(H.decode(String(payload.guess || ''))) } catch (e) { return }
    const marks = decodeMarks(payload.marks)
    if (guess.length !== room.size || !marks) return
    const expected = H.score(guess, TW.state.answerJamo)
    if (expected.some((mark, i) => mark !== marks[i])) return
    const status = ['won', 'lost'].includes(payload.status) ? payload.status : 'playing'
    const nextPid = status === 'playing' ? String(payload.nextPid || '') : null
    if (pid === room.me.pid) room.coopPending = false
    TW.applyRemote(() => TW.applyRoomTurn(guess, marks, status, () => {
      room.turnPid = nextPid; renderBanner(); persistRoom()
      if (status !== 'playing' && room.host) finishCoop(status, row + 1)
      else scheduleTurnSkip()
    }))
  }
  function onTurn(payload) {
    if (!room || room.kind !== 'coop' || !room.startedAt || room.over) return
    if (payload.phase === 'submit') return TW.applyRemote(() => processCoopSubmit(payload))
    if (payload.phase === 'commit') return applyCoopCommit(payload)
    if (payload.skip || payload.phase === 'skip') {
      if (String(payload.pid) !== room.turnPid) return
      room.turnPid = String(payload.nextPid || ''); room.coopPending = false; renderBanner(); scheduleTurnSkip(); return
    }
  }
  function scheduleTurnSkip() {
    clearTimeout(skipTimer); skipTimer = null
    if (!room?.host || room.kind !== 'coop' || room.over || !room.turnPid || room.peers.get(room.turnPid)?.online) return
    const skipped = room.turnPid
    skipTimer = setTimeout(() => {
      if (!room?.host || room.over || room.turnPid !== skipped || room.peers.get(skipped)?.online) return
      const nextPid = nextParticipant(skipped, true)
      if (!nextPid) return
      Net.send('turn', { phase: 'skip', pid: skipped, nextPid, round: room.round }); room.turnPid = nextPid; room.coopPending = false; renderBanner(); persistRoom()
    }, 15000)
  }
  function maybeFinish() {
    if (!room?.host || room.over || !room.activePids.size) return
    if (Array.from(room.activePids).every((pid) => room.results.has(pid))) finishRound()
  }
  function forceRound() {
    if (!room?.host || room.over) return
    if (room.kind === 'coop') return finishCoop('lost', TW.state?.guesses.length || 0)
    const ms = Date.now() - room.startedAt
    for (const pid of room.activePids) if (!room.results.has(pid)) room.results.set(pid, { pid, status: 'lost', tries: TW.MAX_TRIES, ms })
    finishRound()
  }
  function finishRound() {
    if (!room || room.over) return
    room.over = true; clearTimeout(waitTimer); room.waitEndsAt = null
    const scores = Array.from(room.results.values())
    if (room.kind === 'relay') {
      const points = Net.awardPoints(scores)
      for (const [pid, point] of Object.entries(points)) room.totals.set(pid, (Number(room.totals.get(pid)) || 0) + point)
    }
    const payload = { round: room.round, scores, totals: totalsObject(), final: room.kind !== 'relay' || room.round >= room.roundsTotal }
    Net.send('over', payload); TW.applyRemote(() => showScoreboard(scores, payload.final))
  }
  function finishCoop(status, tries) {
    if (!room?.host || room.over) return
    room.over = true
    const payload = { round: room.round, coop: true, status: status === 'won' ? 'won' : 'lost', tries: Math.max(0, Number(tries) || 0), answer: H.encode(H.decompose(room.answer)) }
    Net.send('over', payload); TW.applyRemote(() => showCoopResult(payload))
  }
  function onOver(payload) {
    if (!room || Number(payload.round) !== room.round) return
    if (room.kind === 'coop' || payload.coop) return TW.applyRemote(() => showCoopResult(payload))
    if (!Array.isArray(payload.scores)) return
    room.totals = new Map(Object.entries(payload.totals || {}))
    TW.applyRemote(() => showScoreboard(payload.scores, Boolean(payload.final)))
  }
  function sortedResults(results) {
    return results.slice().sort((a, b) => a.status === 'won' && b.status !== 'won' ? -1 : a.status !== 'won' && b.status === 'won' ? 1 : (a.ms || Infinity) - (b.ms || Infinity) || (a.tries || 99) - (b.tries || 99))
  }
  function showScoreboard(results, final) {
    if (!room) return
    clearInterval(timer); clearTimeout(nextTimer); clearTimeout(waitTimer)
    room.over = true; room.final = Boolean(final); room.scoreResults = sortedResults(results)
    room.waitEndsAt = null; $('#quickChat').hidden = true
    TW.endRoomGame(); renderBanner(); persistRoom(); TW.openSheet('scoreboard')
    if (room.kind === 'relay' && !room.final && room.host) nextTimer = setTimeout(nextRound, 10000)
  }
  function showCoopResult(payload) {
    if (!room) return
    clearInterval(timer); clearTimeout(skipTimer); clearTimeout(waitTimer)
    room.over = true; room.coopResult = { status: payload.status === 'won' ? 'won' : 'lost', tries: Math.max(0, Number(payload.tries) || 0) }
    room.turnPid = null; room.coopPending = false; $('#quickChat').hidden = true
    TW.endRoomGame(); renderBanner(); persistRoom(); TW.openSheet('scoreboard')
  }

  TW.SHEETS.scoreboard = () => {
    if (!room) return '<h2>결과를 찾지 못했어요</h2>'
    if (room.kind === 'coop') {
      const won = room.coopResult?.status === 'won'
      return `<h2>${won ? '함께 맞혔어요!' : '이번에는 아쉬워요'}</h2><div class="answer-reveal"><b>${esc(room.answer || '')}</b><span>${won ? `${room.coopResult.tries}/${TW.MAX_TRIES}번 만에 성공` : `정답 · ${room.size}칸`}</span></div><div class="sheet-actions">${room.host ? '<button class="btn primary" data-act="room-again">한 판 더</button>' : '<p class="muted">방장이 다음 판을 시작하기를 기다리는 중…</p>'}<button class="btn ghost" data-go="leave">나가기</button></div>`
    }
    const names = displayNames(); const relay = room.kind === 'relay'
    return `<h2>${relay ? `${room.round}/${room.roundsTotal} 라운드 결과` : '대결 결과'}</h2>
      <div class="answer-reveal"><b>${esc(room.answer || '')}</b><span>${room.size}칸</span></div>
      <ol class="score-list">${room.scoreResults.map((r, i) => `<li><strong>${i + 1}</strong><b>${esc(names.get(r.pid) || '나간 참가자')}</b><span>${r.status === 'won' ? `${(r.ms / 1000).toFixed(1)}초 · ${r.tries}/${TW.MAX_TRIES}` : `X/${TW.MAX_TRIES}`}</span></li>`).join('')}</ol>
      <div class="sheet-actions">${relay && room.final ? '<button class="btn primary" data-act="room-standings">최종 순위 보기</button>' : relay && room.host ? '<button class="btn primary" data-act="room-next">다음 라운드</button>' : relay ? '<p class="muted">방장이 다음 라운드를 시작하기를 기다리는 중…</p>' : ''}<button class="btn accent" data-act="room-copy-result">결과 복사하기</button><button class="btn ghost" data-go="leave">나가기</button></div>`
  }
  TW.SHEETS.standings = () => {
    if (!room) return '<h2>순위를 찾지 못했어요</h2>'
    const names = displayNames()
    const list = Array.from(room.totals, ([pid, points]) => ({ pid, points: Number(points) || 0 })).sort((a, b) => b.points - a.points || (names.get(a.pid) || '').localeCompare(names.get(b.pid) || ''))
    return `<h2>최종 순위</h2><ol class="score-list">${list.map((e, i) => `<li><strong>${i + 1}</strong><b>${esc(names.get(e.pid) || '나간 참가자')}</b><span>${e.points}점</span></li>`).join('')}</ol><div class="sheet-actions">${room.host ? '<button class="btn primary" data-act="room-again">한 판 더</button>' : '<p class="muted">방장이 다음 게임을 시작하기를 기다리는 중…</p>'}<button class="btn ghost" data-go="leave">나가기</button></div>`
  }
  function nextRound() {
    if (!room?.host || room.kind !== 'relay' || room.round >= room.roundsTotal) return
    clearTimeout(nextTimer); room.round++; room.startedAt = null; room.over = false; TW.closeSheet(); startRound()
  }
  function playAgain() {
    if (!room?.host) return
    clearTimeout(nextTimer); room.round = 1; room.totals = new Map(); room.startedAt = null; room.over = false; room.final = false
    TW.closeSheet(); startRound()
  }
  function copyResult() {
    if (!room) return
    if (room.kind === 'coop') {
      const score = room.coopResult?.status === 'won' ? `${room.coopResult.tries}/${TW.MAX_TRIES}` : `X/${TW.MAX_TRIES}`
      return TW.copyAndTell([`오늘의 단어 협동 · ${room.size}칸 · ${score}`, `정답 ${room.answer}`, inviteText()].join('\n'), '협동 결과를 복사했어요')
    }
    const rows = room.scoreResults.map((r, i) => `${i + 1}. ${room.peers.get(r.pid)?.nick || '나간 참가자'} · ${r.status === 'won' ? `${(r.ms / 1000).toFixed(1)}초 · ${r.tries}/${TW.MAX_TRIES}` : `X/${TW.MAX_TRIES}`}`)
    TW.copyAndTell([`오늘의 단어 ${MODES[room.kind]} · ${room.size}칸`, `정답 ${room.answer}`, ...rows, inviteText()].join('\n'), '대결 결과를 복사했어요')
  }
  function renderPeers() {
    if (!room || !room.startedAt || room.kind === 'coop') return
    const list = orderedPlayers().filter((p) => (room.activePids.has(p.pid) || p.status === 'playing') && (room.me.role === 'setter' || p.pid !== room.me.pid))
    const names = displayNames()
    $('#peers').innerHTML = list.map((p) => {
      const rows = Array.from({ length: TW.MAX_TRIES }, (_, row) => {
        const marks = p.rows?.[row] || []
        return `<div class="mini-row" style="--cols:${room.size}">${Array.from({ length: room.size }, (_, col) => `<i class="mini-tile ${marks[col] || ''}"></i>`).join('')}</div>`
      }).join('')
      return `<div class="peer ${p.online ? '' : 'offline'} ${['won', 'lost'].includes(p.status) ? 'done' : ''}" data-pid="${esc(p.pid)}"><b>${esc(names.get(p.pid))}${p.pid === room.me.pid ? ' (나)' : ''}</b><div class="mini">${rows}</div></div>`
    }).join('')
  }
  function onSyncRequest(payload) {
    if (!room?.host || !room.startedAt || payload.pid === room.me.pid) return
    const boards = {}
    for (const p of room.peers.values()) boards[p.pid] = (p.rows || []).map((marks) => encodeMarks(marks || []))
    Net.send('sync!', {
      pid: payload.pid, round: room.round, roundsTotal: room.roundsTotal, kind: room.kind, size: room.size,
      answer: H.encode(H.decompose(room.answer)), ts: Date.now(), setter: room.setterPid,
      participants: room.participants, turnPid: room.turnPid, boards, waitSeconds: room.waitSeconds,
      waitRemaining: room.waitEndsAt ? Math.max(1, Math.ceil((room.waitEndsAt - Date.now()) / 1000)) : 0,
      guesses: room.kind === 'coop' ? (TW.state?.guesses || []).map((g) => H.encode(g)) : [],
      scores: Array.from(room.results.values()), totals: totalsObject(), over: room.over, final: room.final, coopResult: room.coopResult,
    })
  }
  function onSync(payload) {
    if (!room || payload.pid !== room.me.pid) return
    if (room.startedAt) {
      if (room.kind !== 'coop' || Number(payload.round) !== room.round) return
      TW.applyRemote(() => {
        room.participants = validParticipants(payload); room.activePids = new Set(room.participants)
        room.turnPid = String(payload.turnPid || ''); room.coopPending = false
        TW.restoreRoomGame((payload.guesses || []).map((g) => H.decode(String(g))), payload.coopResult?.status || 'playing')
        renderBanner(); persistRoom()
      })
      return
    }
    const resume = room.resume
    const isParticipant = Array.isArray(payload.participants) && payload.participants.map(String).includes(room.me.pid)
    const canResume = Boolean(resume?.active && isParticipant && Number(resume.round) === Number(payload.round))
    beginRound(payload, !canResume)
    if (room.kind === 'coop') {
      TW.restoreRoomGame((payload.guesses || []).map((g) => H.decode(String(g))), payload.coopResult?.status || 'playing')
    } else if (canResume) {
      TW.restoreRoomGame((resume.guesses || []).map((g) => H.decode(String(g))), resume.status)
      room.me.role = 'player'; document.body.classList.remove('watching'); $('#keyboard').hidden = false; $('.board-wrap').hidden = false
    }
    room.resume = null
    for (const [pid, rows] of Object.entries(payload.boards || {})) {
      const p = room.peers.get(pid)
      if (p) p.rows = rows.map((marks) => decodeMarks(marks) || [])
    }
    for (const result of payload.scores || []) room.results.set(result.pid, result)
    room.totals = new Map(Object.entries(payload.totals || {})); renderPeers(); renderBanner()
    if (Number(payload.waitRemaining) > 0) beginWait({ round: room.round, seconds: Number(payload.waitRemaining) })
    if (payload.over) room.kind === 'coop' ? showCoopResult(payload.coopResult || payload) : showScoreboard(Array.from(room.results.values()), Boolean(payload.final))
  }

  document.addEventListener('click', (event) => {
    const chat = event.target.closest('[data-chat]')
    if (chat) { sendChat(chat.dataset.chat); return }
    const setter = event.target.closest('[data-setter]')
    if (setter && room?.host && room.kind === 'setter' && !room.startedAt) {
      room.setterPid = setter.dataset.setter; renderLobby(); broadcastLobby(); return
    }
    const target = event.target.closest('[data-rmode],[data-rsize],[data-rounds],[data-wait]')
    if (!target || target.disabled) return
    if (target.dataset.rmode) {
      draft.kind = target.dataset.rmode
      if (draft.kind !== 'relay') draft.roundsTotal = 1
      else if (draft.roundsTotal === 1) draft.roundsTotal = 3
      return TW.openSheet('create')
    }
    if (target.dataset.rsize !== undefined) draft.size = Number(target.dataset.rsize)
    if (target.dataset.rounds !== undefined) draft.roundsTotal = Number(target.dataset.rounds)
    if (target.dataset.wait !== undefined) draft.waitSeconds = Number(target.dataset.wait)
    for (const chip of target.parentElement.querySelectorAll('.chip')) chip.setAttribute('aria-pressed', String(chip === target))
  })
  document.addEventListener('input', (event) => { if (event.target.id === 'roomWord') paintSetterWord() })
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return
    if (event.target.id === 'roomJoinCode') TW.ACTIONS['room-join']()
    else if (event.target.id === 'roomNick' && $('#roomJoinCode')?.value) TW.ACTIONS['room-join']()
    else if (event.target.id === 'roomWord' && !$('#roomWordButton')?.disabled) submitSetterWord()
  })
  Net.on('roster', onRoster); Net.on('status', onStatus); Net.on('lobby', onLobby); Net.on('pick', onPick); Net.on('word', onWord)
  Net.on('start', (payload) => beginRound(payload, false)); Net.on('mark', onMark); Net.on('done', onDone); Net.on('turn', onTurn)
  Net.on('chat', onChat); Net.on('wait', beginWait)
  Net.on('over', onOver); Net.on('sync?', onSyncRequest); Net.on('sync!', onSync)

  const roomButton = $('#btnRooms')
  if (Net.available) {
    roomButton.hidden = false
    const resume = TW.store.get('tw.room.v1', null)
    if (globalThis.TWRoomHash) setTimeout(() => TW.openSheet('rooms'), 0)
    else if (resume?.code && resume?.nick) setTimeout(() => enterRoom(resume.code, resume.nick, { kind: resume.kind || 'versus', size: Number(resume.size) || 5, roundsTotal: Number(resume.roundsTotal) || 1, waitSeconds: [0, 30, 60, 90].includes(Number(resume.waitSeconds)) ? Number(resume.waitSeconds) : 60 }, resume), 0)
  } else { roomButton.remove(); globalThis.TWRoomHash = null }

  globalThis.Room = { get current() { return room }, localMark, localDone, submitCoop, canPlay, blockedInput, leave: leaveRoom, normalizeCode, repaintPeers: renderPeers }
})()
