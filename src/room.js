// 멀티플레이 방 UI와 상태 기계. 네트워크 구현 세부사항은 Net 에만 맡긴다.
;(function () {
  'use strict'

  const Net = globalThis.Net
  const TW = globalThis.TW
  const H = globalThis.Hangul
  const $ = (sel) => document.querySelector(sel)
  const esc = (value) => String(value).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  const MARK_TO_WIRE = { absent: '0', present: '1', correct: '2' }
  const WIRE_TO_MARK = ['absent', 'present', 'correct']

  let room = null
  let draft = { kind: 'versus', size: 5, roundsTotal: 1 }
  let timer = null

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
    const match = String(value || '').toUpperCase().match(/(?:[#&?]r=)?([23456789ABCDEFGHJKMNPQRSTVWXYZ]{6})(?:\b|$)/)
    return match ? match[1] : null
  }
  function inviteText() {
    const base = TW.shareUrl()
    return base ? `${base}#r=${room.code}` : room.code
  }
  function playerRows(player) {
    if (!player.rows) player.rows = []
    return player.rows
  }
  function displayNames(players) {
    const counts = new Map()
    return players.map((player) => {
      const n = (counts.get(player.nick) || 0) + 1
      counts.set(player.nick, n)
      return [player.pid, n === 1 ? player.nick : `${player.nick}${n}`]
    })
  }
  function players() { return room ? Array.from(room.peers.values()) : [] }
  function persistRoom() {
    if (!room) return TW.store.set('tw.room.v1', null)
    const state = TW.state
    TW.store.set('tw.room.v1', {
      code: room.code, nick: room.me.nick, kind: room.kind, size: room.size,
      round: room.round, roundsTotal: room.roundsTotal,
      active: Boolean(room.startedAt),
      guesses: state?.room === room.code ? state.guesses.map((guess) => H.encode(guess)) : [],
      status: state?.room === room.code ? state.status : 'playing',
    })
  }

  TW.SHEETS.rooms = () => {
    const player = savedPlayer()
    const preset = globalThis.TWRoomHash || ''
    return `
      <h2>같이 하기</h2>
      <p class="muted">친구들과 같은 문제를 동시에 풀고, 서로의 색상 보드를 실시간으로 볼 수 있어요.</p>
      <div style="margin-top:16px">
        <input class="field" id="roomNick" ${preset ? 'autofocus' : ''} placeholder="닉네임" maxlength="16"
               value="${esc(player.nick)}" autocomplete="nickname" autocapitalize="off" spellcheck="false">
        <div class="hint" id="roomHint"></div>
      </div>
      <div class="sheet-actions">
        <button class="btn primary" data-act="room-open-create">새 방 만들기</button>
      </div>
      <div class="hr"></div>
      <p><b>방 코드로 들어가기</b></p>
      <div style="margin-top:10px">
        <input class="field" id="roomJoinCode" placeholder="6자리 코드" maxlength="80"
               value="${esc(preset)}" autocomplete="off" autocapitalize="characters" spellcheck="false">
      </div>
      <div class="sheet-actions">
        <button class="btn" data-act="room-join">들어가기</button>
      </div>`
  }
  TW.SHEETS.create = () => `
    <h2>방 만들기</h2>
    <p><b>모드</b></p>
    <div class="room-options" id="roomModes">
      <button class="chip" data-rmode="versus" aria-pressed="${draft.kind === 'versus'}">같은 단어 대결</button>
      <button class="chip" data-rmode="setter" disabled>출제 대결</button>
      <button class="chip" data-rmode="relay" disabled>릴레이</button>
      <button class="chip" data-rmode="coop" disabled>협동</button>
    </div>
    <p><b>칸 수</b></p>
    <div class="room-options" id="roomSizes">
      ${[4, 5, 6, 7, 0].map((n) => `<button class="chip" data-rsize="${n}" aria-pressed="${draft.size === n}">${n || '랜덤'}${n ? '칸' : ''}</button>`).join('')}
    </div>
    <p class="muted">현재는 같은 단어 대결을 먼저 지원합니다. 나머지 모드는 단계적으로 열립니다.</p>
    <div class="sheet-actions">
      <button class="btn primary" data-act="room-create">방 만들기</button>
    </div>`
  TW.SHEETS.roommenu = () => {
    if (!room) return '<h2>방을 찾지 못했어요</h2>'
    const elapsed = room.startedAt ? Math.floor((Date.now() - room.startedAt) / 1000) : 0
    return `
      <h2>대결 메뉴</h2>
      <p class="muted">방 코드 <b>${esc(room.code)}</b> · ${Math.floor(elapsed / 60)}분 ${elapsed % 60}초</p>
      <div class="sheet-actions">
        <button class="btn ghost" data-act="room-copy">초대 ${TW.shareUrl() ? '링크' : '코드'} 복사</button>
        ${room.host && room.startedAt && !room.over ? '<button class="btn accent" data-act="room-force">모두 강제 종료</button>' : ''}
        <button class="btn ghost" data-go="leave">방 나가기</button>
      </div>`
  }

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
  TW.ACTIONS['room-start'] = startRound
  TW.ACTIONS['room-force'] = forceRound
  TW.ACTIONS['room-copy'] = () => TW.copyAndTell(inviteText(), TW.shareUrl() ? '초대 링크를 복사했어요' : '방 코드를 복사했어요')
  TW.ACTIONS['room-copy-result'] = copyResult

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
    TW.closeSheet()
    $('#home').hidden = true
    $('#game').hidden = true
    $('#lobby').hidden = false
    $('#roomCode').textContent = room.code
    const base = TW.shareUrl()
    $('#roomInvite').innerHTML = `<div class="room-invite">
      ${base ? `<textarea class="linkbox" readonly>${esc(inviteText())}</textarea>` : '<p class="muted" style="text-align:left;flex:1">게임 주소와 이 코드를 함께 보내세요.</p>'}
      <button class="btn ghost" data-act="room-copy">${base ? '링크 복사' : '코드 복사'}</button>
    </div>`
    renderLobby()
  }
  function renderLobby() {
    if (!room || $('#lobby').hidden) return
    const list = players().sort((a, b) => a.joinedAt - b.joinedAt || a.pid.localeCompare(b.pid))
    const names = new Map(displayNames(list))
    $('#roomCount').textContent = `${list.length}명`
    $('#roomRoster').innerHTML = list.map((player) => `<li>
      <b>${esc(names.get(player.pid))}${player.pid === room.me.pid ? ' (나)' : ''}</b>
      <span>${player.pid === room.hostPid ? '방장' : '참가자'}</span>
    </li>`).join('')
    const live = Net.status === 'live'
    $('#lobbyActions').innerHTML = room.host
      ? `<button class="btn primary" data-act="room-start" ${live ? '' : 'disabled'}>시작하기</button>
         <button class="btn ghost" data-go="leave">나가기</button>`
      : `<p class="muted">방장이 시작하기를 기다리는 중…</p><button class="btn ghost" data-go="leave">나가기</button>`
    $('#lobbyStatus').textContent = statusLabel(Net.status)
  }
  function statusLabel(status) {
    return ({ off: '오프라인', connecting: '연결하는 중…', live: '연결됨', retry: '다시 연결하는 중…', down: '연결을 기다리는 중…' })[status] || status
  }

  function enterRoom(code, nick, options, resume) {
    const old = savedPlayer()
    const me = { pid: old.pid, nick, joinedAt: Date.now(), role: 'player' }
    TW.store.set('tw.player.v1', { pid: me.pid, nick })
    draft = { ...draft, ...options }
    room = {
      code, kind: draft.kind, round: 1, roundsTotal: draft.roundsTotal,
      size: draft.size, me, host: false, hostPid: null,
      peers: new Map([[me.pid, { ...me, rows: [], status: 'waiting', online: true }]]),
      activePids: new Set(), results: new Map(), startedAt: null, answer: null, over: false,
      resume: resume || null,
    }
    globalThis.TWRoomHash = null
    persistRoom()
    showLobby()
    Net.connect(code, me).catch(() => {
      if (room?.code === code) TW.toast('방을 깨우는 중이에요. 자동으로 다시 연결할게요', 2600)
    })
  }
  function leaveRoom() {
    clearInterval(timer)
    timer = null
    Net.leave()
    room = null
    TW.store.set('tw.room.v1', null)
    document.body.classList.remove('watching')
    $('#keyboard').hidden = false
    $('.board-wrap').hidden = false
    $('#peers').hidden = true
    $('#btnBack').dataset.go = 'home'
    $('#btnMenu').dataset.sheet = 'stats'
    $('#btnMenu').textContent = '☰'
    $('#btnMenu').setAttribute('aria-label', '기록')
    TW.GOES.home()
  }

  function onRoster(roster) {
    if (!room) return
    const online = new Set()
    for (const person of roster) {
      online.add(person.pid)
      const previous = room.peers.get(person.pid) || { rows: [], status: room.startedAt ? 'spectator' : 'waiting' }
      room.peers.set(person.pid, { ...previous, ...person, online: true })
    }
    for (const player of room.peers.values()) player.online = online.has(player.pid)
    room.hostPid = Net.electHost(roster)
    room.host = room.hostPid === room.me.pid
    renderLobby()
    renderPeers()
  }
  function onStatus(status) {
    renderLobby()
    if (!room) return
    if (status === 'retry') TW.toast('연결이 끊겨 다시 연결하고 있어요', 2200)
    if (status === 'live') Net.send('sync?', { pid: room.me.pid })
  }

  function resolvedRoomSize() {
    return draft.size === 0 ? TW.SIZES[Math.floor(Math.random() * TW.SIZES.length)] : draft.size
  }
  function startRound() {
    if (!room?.host || Net.status !== 'live') return
    const size = resolvedRoomSize()
    const answer = TW.freeAnswer(size)
    const payload = { round: room.round, kind: room.kind, size, answer: H.encode(H.decompose(answer)), setter: null, ts: Date.now() }
    Net.send('start', payload)
    beginRound(payload)
  }
  function decodeAnswer(value) {
    try { return H.compose(H.decode(String(value || ''))) } catch (e) { return null }
  }
  function beginRound(payload, spectator) {
    if (!room || Number(payload.round) < room.round) return
    const answer = decodeAnswer(payload.answer)
    if (!answer || !TW.SIZES.includes(Number(payload.size))) return
    room.round = Number(payload.round) || 1
    room.kind = payload.kind || 'versus'
    room.size = Number(payload.size)
    room.answer = answer
    room.startedAt = Date.now()
    room.over = false
    room.results = new Map()
    room.activePids = new Set(players().filter((p) => p.online).map((p) => p.pid))
    for (const player of room.peers.values()) {
      player.rows = []
      player.status = spectator && player.pid === room.me.pid ? 'spectator' : 'playing'
      player.tries = null
      player.ms = null
    }
    room.me.role = spectator ? 'spectator' : 'player'
    TW.startGame(room.kind, room.size, answer)
    $('#btnBack').dataset.go = 'leave'
    $('#btnMenu').dataset.sheet = 'roommenu'
    $('#btnMenu').textContent = '☰'
    $('#btnMenu').setAttribute('aria-label', '대결 메뉴')
    document.body.classList.toggle('watching', Boolean(spectator))
    $('#keyboard').hidden = Boolean(spectator)
    $('.board-wrap').hidden = Boolean(spectator)
    $('#peers').hidden = false
    renderPeers()
    startTimer()
    persistRoom()
  }
  function startTimer() {
    clearInterval(timer)
    const tick = () => {
      if (!room?.startedAt || room.over) return
      const seconds = Math.floor((Date.now() - room.startedAt) / 1000)
      const mm = String(Math.floor(seconds / 60)).padStart(2, '0')
      const ss = String(seconds % 60).padStart(2, '0')
      $('#gameSub').textContent = `${room.size}칸 · ${mm}:${ss}`
    }
    tick()
    timer = setInterval(tick, 1000)
  }

  function localMark(row, marks) {
    if (!room) return
    const player = room.peers.get(room.me.pid)
    if (player) playerRows(player)[row] = marks.slice()
    Net.send('mark', { pid: room.me.pid, row, marks: marks.map((m) => MARK_TO_WIRE[m]).join('') })
    renderPeers()
    persistRoom()
  }
  function localDone(status, tries) {
    if (!room || room.me.role === 'spectator') return
    const result = { pid: room.me.pid, status, tries, ms: Date.now() - room.startedAt }
    room.results.set(result.pid, result)
    Object.assign(room.peers.get(result.pid), result)
    Net.send('done', result)
    renderPeers()
    persistRoom()
    maybeFinish()
  }
  function onMark(payload) {
    if (!room || !room.startedAt || payload.pid === room.me.pid) return
    const player = room.peers.get(String(payload.pid))
    if (!player || !/^[012]+$/.test(String(payload.marks)) || String(payload.marks).length !== room.size) return
    const row = Number(payload.row)
    if (!(row >= 0 && row < TW.MAX_TRIES)) return
    playerRows(player)[row] = Array.from(String(payload.marks), (n) => WIRE_TO_MARK[Number(n)] || 'absent')
    renderPeers()
  }
  function onDone(payload) {
    if (!room || !room.startedAt || payload.pid === room.me.pid) return
    const player = room.peers.get(String(payload.pid))
    if (!player) return
    const result = {
      pid: player.pid,
      status: payload.status === 'won' ? 'won' : 'lost',
      tries: Math.max(1, Math.min(TW.MAX_TRIES, Number(payload.tries) || TW.MAX_TRIES)),
      ms: Math.max(0, Number(payload.ms) || 0),
    }
    room.results.set(result.pid, result)
    Object.assign(player, result)
    renderPeers()
    maybeFinish()
  }
  function maybeFinish() {
    if (!room?.host || room.over || !room.activePids.size) return
    if (Array.from(room.activePids).every((pid) => room.results.has(pid))) finishRound()
  }
  function forceRound() {
    if (!room?.host || room.over) return
    const elapsed = Date.now() - room.startedAt
    for (const pid of room.activePids) {
      if (!room.results.has(pid)) room.results.set(pid, { pid, status: 'lost', tries: TW.MAX_TRIES, ms: elapsed })
    }
    finishRound()
  }
  function finishRound() {
    if (!room || room.over) return
    room.over = true
    const scores = Array.from(room.results.values())
    const payload = { round: room.round, scores }
    Net.send('over', payload)
    TW.applyRemote(() => showScoreboard(scores))
  }
  function onOver(payload) {
    if (!room || Number(payload.round) !== room.round || !Array.isArray(payload.scores)) return
    TW.applyRemote(() => showScoreboard(payload.scores))
  }
  function sortedResults(results) {
    return results.slice().sort((a, b) => {
      if (a.status === 'won' && b.status !== 'won') return -1
      if (a.status !== 'won' && b.status === 'won') return 1
      return (a.tries || 99) - (b.tries || 99) || (a.ms || Infinity) - (b.ms || Infinity)
    })
  }
  function showScoreboard(results) {
    if (!room) return
    clearInterval(timer)
    room.over = true
    room.scoreResults = sortedResults(results)
    TW.endRoomGame()
    persistRoom()
    TW.openSheet('scoreboard')
  }
  TW.SHEETS.scoreboard = () => {
    const list = room?.scoreResults || []
    const names = new Map(displayNames(players().sort((a, b) => a.joinedAt - b.joinedAt)))
    return `
      <h2>대결 결과</h2>
      <div class="answer-reveal"><b>${esc(room?.answer || '')}</b><span>${room?.size || ''}칸</span></div>
      <ol class="score-list">${list.map((result, i) => `<li>
        <strong>${i + 1}</strong><b>${esc(names.get(result.pid) || '나간 참가자')}</b>
        <span>${result.status === 'won' ? `${result.tries}/${TW.MAX_TRIES} · ${(result.ms / 1000).toFixed(1)}초` : `X/${TW.MAX_TRIES}`}</span>
      </li>`).join('')}</ol>
      <div class="sheet-actions">
        <button class="btn accent" data-act="room-copy-result">결과 복사하기</button>
        <button class="btn ghost" data-go="leave">나가기</button>
      </div>`
  }
  function copyResult() {
    const rows = room.scoreResults.map((result, i) => `${i + 1}. ${room.peers.get(result.pid)?.nick || '나간 참가자'} · ${result.status === 'won' ? `${result.tries}/${TW.MAX_TRIES} · ${(result.ms / 1000).toFixed(1)}초` : `X/${TW.MAX_TRIES}`}`)
    TW.copyAndTell([`오늘의 단어 같이 하기 · ${room.size}칸`, `정답 ${room.answer}`, ...rows, inviteText()].join('\n'), '대결 결과를 복사했어요')
  }

  function renderPeers() {
    if (!room || !room.startedAt) return
    const peerList = players().filter((p) => p.pid !== room.me.pid)
    const names = new Map(displayNames(players().sort((a, b) => a.joinedAt - b.joinedAt)))
    $('#peers').innerHTML = peerList.map((player) => {
      const rows = Array.from({ length: TW.MAX_TRIES }, (_, row) => {
        const marks = player.rows?.[row] || []
        return `<div class="mini-row" style="--cols:${room.size}">${Array.from({ length: room.size }, (_, col) => `<i class="mini-tile ${marks[col] || ''}"></i>`).join('')}</div>`
      }).join('')
      return `<div class="peer ${player.online ? '' : 'offline'} ${player.status === 'won' || player.status === 'lost' ? 'done' : ''}" data-pid="${esc(player.pid)}">
        <b>${esc(names.get(player.pid))}</b><div class="mini">${rows}</div>
      </div>`
    }).join('')
  }

  function onSyncRequest(payload) {
    if (!room?.host || !room.startedAt || payload.pid === room.me.pid) return
    const boards = {}
    for (const player of room.peers.values()) boards[player.pid] = (player.rows || []).map((marks) => (marks || []).map((m) => MARK_TO_WIRE[m]).join(''))
    Net.send('sync!', {
      pid: payload.pid, round: room.round, kind: room.kind, size: room.size,
      answer: H.encode(H.decompose(room.answer)), ts: Date.now(), boards,
      scores: Array.from(room.results.values()), over: room.over,
    })
  }
  function onSync(payload) {
    if (!room || payload.pid !== room.me.pid || room.startedAt) return
    const resume = room.resume
    const canResume = Boolean(resume?.active && Number(resume.round) === Number(payload.round))
    beginRound(payload, !canResume)
    if (canResume) {
      const guesses = (resume.guesses || []).map((guess) => H.decode(String(guess)))
      TW.restoreRoomGame(guesses, resume.status)
      room.me.role = 'player'
    }
    room.resume = null
    for (const [pid, rows] of Object.entries(payload.boards || {})) {
      const player = room.peers.get(pid)
      if (!player) continue
      player.rows = rows.map((marks) => Array.from(String(marks), (n) => WIRE_TO_MARK[Number(n)] || 'absent'))
    }
    for (const result of payload.scores || []) room.results.set(result.pid, result)
    renderPeers()
    if (payload.over) showScoreboard(Array.from(room.results.values()))
  }

  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-rmode],[data-rsize]')
    if (!target || target.disabled) return
    if (target.dataset.rmode) draft.kind = target.dataset.rmode
    if (target.dataset.rsize !== undefined) draft.size = Number(target.dataset.rsize)
    const parent = target.parentElement
    for (const chip of parent.querySelectorAll('.chip')) chip.setAttribute('aria-pressed', String(chip === target))
  })
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return
    if (event.target.id === 'roomJoinCode') TW.ACTIONS['room-join']()
    else if (event.target.id === 'roomNick' && $('#roomJoinCode')?.value) TW.ACTIONS['room-join']()
  })

  Net.on('roster', onRoster)
  Net.on('status', onStatus)
  Net.on('start', (payload) => beginRound(payload, false))
  Net.on('mark', onMark)
  Net.on('done', onDone)
  Net.on('over', onOver)
  Net.on('sync?', onSyncRequest)
  Net.on('sync!', onSync)

  const roomButton = $('#btnRooms')
  if (Net.available) {
    roomButton.hidden = false
    const resume = TW.store.get('tw.room.v1', null)
    if (globalThis.TWRoomHash) setTimeout(() => TW.openSheet('rooms'), 0)
    else if (resume?.code && resume?.nick) setTimeout(() => enterRoom(
      resume.code, resume.nick,
      { kind: resume.kind || 'versus', size: Number(resume.size) || 5, roundsTotal: Number(resume.roundsTotal) || 1 },
      resume,
    ), 0)
  } else {
    // 설정이 없을 때는 기존 홈 DOM/레이아웃까지 동일하게 유지한다.
    roomButton.remove()
    globalThis.TWRoomHash = null
  }

  globalThis.Room = {
    get current() { return room },
    localMark, localDone, leave: leaveRoom,
    normalizeCode, repaintPeers: renderPeers,
  }
})()
