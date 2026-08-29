// 멀티플레이 모드의 방 UI와 상태 기계. 네트워크 세부사항은 Net 에만 맡긴다.
;(function () {
  'use strict'
  const Net = globalThis.Net
  const TW = globalThis.TW
  const H = globalThis.Hangul
  const W = globalThis.Words
  const $ = (s) => document.querySelector(s)
  const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  const TO_WIRE = { absent: '0', present: '1', correct: '2' }
  const FROM_WIRE = ['absent', 'present', 'correct']
  const MODES = { versus: '같은 단어 대결', setter: '출제 대결', relay: '연판', coop: '협동', team: '팀전', teamsetter: '팀 출제 대결', spy: '스파이전', captain: '대장전' }
  const MODE_GROUPS = { solo: ['versus', 'setter', 'relay'], team: ['coop', 'team', 'teamsetter', 'spy', 'captain'] }
  const TEAM_NAMES = { red: '빨강팀', blue: '파랑팀' }
  const isTeamMode = (kind = room?.kind) => ['team', 'teamsetter', 'spy'].includes(kind)
  const QUICK_MESSAGES = ['ㅋㅋㅋ', '화이팅!', '오 거의 다 왔다!', '천천히 해도 돼']
  let room = null
  let draft = { kind: 'versus', size: 5, roundsTotal: 1, waitSeconds: 60, eliminateCount: 1 }
  let roomCategory = null
  let timer = null
  let nextTimer = null
  let skipTimer = null
  let waitTimer = null
  let finalTimer = null
  let teamEndTimer = null
  const teamFinalTimers = { red: null, blue: null }
  const teamSkipTimers = { red: null, blue: null }
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
      eliminateCount: room.eliminateCount, captainAlive: room.captainAlive,
    })
  }

  TW.SHEETS.rooms = () => {
    const player = savedPlayer()
    const preset = globalThis.TWRoomHash || ''
    return `<h2>같이 하기</h2>
      <p class="muted">친구들과 실시간으로 대결하거나 한 보드를 함께 풀 수 있어요.</p>
      <div style="margin-top:16px"><input class="field" id="roomNick" ${preset ? 'autofocus' : ''} placeholder="닉네임" maxlength="16" value="${esc(player.nick)}" autocomplete="nickname" autocapitalize="off" spellcheck="false"><div class="hint" id="roomHint"></div></div>
      <p style="margin-top:18px"><b>게임 종류</b></p><div class="room-category-grid"><button class="btn" data-room-category="solo" aria-pressed="${roomCategory === 'solo'}">개인전</button><button class="btn" data-room-category="team" aria-pressed="${roomCategory === 'team'}">팀전</button></div>
      <div class="room-mode-step" id="roomModeStep" ${roomCategory ? '' : 'hidden'}><p><b>${roomCategory === 'team' ? '팀전 모드' : '개인전 모드'}</b></p><div class="room-mode-grid">${(MODE_GROUPS[roomCategory] || []).map((kind) => `<button class="btn" data-room-pick="${kind}" aria-pressed="${draft.kind === kind}">${MODES[kind]}</button>`).join('')}</div>
      <div class="sheet-actions"><button class="btn primary" data-act="room-open-create" ${Object.hasOwn(MODES, draft.kind) ? '' : 'disabled'}>방 만들기</button></div></div>
      <div class="hr"></div><p><b>방 코드로 들어가기</b></p>
      <div style="margin-top:10px"><input class="field" id="roomJoinCode" placeholder="6자리 코드" maxlength="80" value="${esc(preset)}" autocomplete="off" autocapitalize="characters" spellcheck="false"></div>
      <div class="sheet-actions"><button class="btn" data-act="room-join">들어가기</button></div>`
  }
  TW.SHEETS.create = () => `<h2>방 만들기</h2><p><b>모드</b></p>
    <div class="room-options">${Object.entries(MODES).filter(([k]) => (MODE_GROUPS[roomCategory] || []).includes(k)).map(([k, label]) => `<button class="chip" data-rmode="${k}" aria-pressed="${draft.kind === k}">${label}</button>`).join('')}</div>
    <p><b>칸 수</b></p><div class="room-options">${[4, 5, 6, 7, 0].map((n) => `<button class="chip" data-rsize="${n}" aria-pressed="${draft.size === n}">${n || '랜덤'}${n ? '칸' : ''}</button>`).join('')}</div>
    <div ${draft.kind === 'relay' ? '' : 'hidden'}><p><b>라운드</b></p><div class="room-options">${[1, 3, 5].map((n) => `<button class="chip" data-rounds="${n}" aria-pressed="${draft.roundsTotal === n}">${n}라운드</button>`).join('')}</div></div>
    <div ${draft.kind === 'captain' ? '' : 'hidden'}><p><b>매 판 탈락 인원</b></p><div class="room-options">${[1, 2].map((n) => `<button class="chip" data-eliminate="${n}" aria-pressed="${draft.eliminateCount === n}">${n}명씩 탈락</button>`).join('')}</div></div>
    <div ${['coop', 'team', 'teamsetter', 'spy'].includes(draft.kind) ? 'hidden' : ''}><p><b>첫 완주 후 대기</b></p><div class="room-options">${[30, 60, 90, 0].map((n) => `<button class="chip" data-wait="${n}" aria-pressed="${draft.waitSeconds === n}">${n ? `${n}초` : '제한 없음'}</button>`).join('')}</div></div>
    <p class="muted">${draft.kind === 'setter' ? '방장이 로비에서 출제자를 고릅니다.' : draft.kind === 'relay' ? '여러 판 점수를 더해 최종 승자를 정합니다.' : draft.kind === 'coop' ? '한 보드를 공유하며 차례대로 한 줄씩 냅니다.' : draft.kind === 'team' ? '두 팀이 공유 보드로 풀며, 마지막 기회는 팀 정답률로 승부합니다.' : draft.kind === 'teamsetter' ? '각 팀 출제자가 상대 팀이 풀 서로 다른 단어를 냅니다.' : draft.kind === 'spy' ? '각 팀에 숨어든 스파이는 자기 팀이 져야 개인 승리합니다.' : draft.kind === 'captain' ? '매 판 최하위가 탈락하고 마지막 한 명이 우승합니다.' : '모두 같은 단어를 동시에 풉니다.'}</p>
    <div class="sheet-actions"><button class="btn primary" data-act="room-create">방 만들기</button></div>`
  TW.SHEETS.roommenu = () => {
    if (!room) return '<h2>방을 찾지 못했어요</h2>'
    const sec = room.startedAt ? Math.floor((Date.now() - room.startedAt) / 1000) : 0
    return `<h2>방 메뉴</h2><p class="muted">${MODES[room.kind]} · 방 코드 <b>${esc(room.code)}</b> · ${Math.floor(sec / 60)}분 ${sec % 60}초</p><div class="sheet-actions">
      <button class="btn ghost" data-act="room-copy">초대 ${TW.shareUrl() ? '링크' : '코드'} 복사</button>
      ${room.host && room.startedAt && !room.over ? '<button class="btn accent" data-act="room-force">모두 강제 종료</button>' : ''}
      <button class="btn ghost" data-go="leave">방 나가기</button></div>`
  }
  TW.SHEETS.spyrole = () => {
    if (!room || room.kind !== 'spy') return '<h2>역할을 찾지 못했어요</h2>'
    const team = room.teams.get(room.me.pid)
    if (!team) return '<h2>이번 판은 관전합니다.</h2><p>다음 판부터 팀과 비밀 역할을 받을 수 있어요.</p><div class="sheet-actions"><button class="btn" data-close>관전하기</button></div>'
    return room.isSpy
      ? `<h2 class="spy-title">당신은 스파이입니다.</h2><p><b>${TEAM_NAMES[team]}</b>에 숨어들었어요. 이상한 추측으로 팀의 정답률을 낮추세요.</p><div class="spy-mission">내가 들어간 팀이 지면<br><b>스파이 개인 승리!</b></div><div class="sheet-actions"><button class="btn accent" data-close>역할 확인 완료</button></div>`
      : `<h2>${TEAM_NAMES[team]}입니다.</h2><p>팀원 중 상대편 스파이 한 명이 숨어 있어요. 서로 상의하며 높은 정답률을 만들어 보세요.</p><div class="sheet-actions"><button class="btn primary" data-close>시작하기</button></div>`
  }
  TW.SHEETS.pickword = () => `<h2>문제 내기</h2><p class="muted">${room?.kind === 'teamsetter' ? `<b>${TEAM_NAMES[room.pick?.targetTeam]}</b>이 풀 단어를 내 주세요. ` : ''}한글 단어를 입력하세요. 자음과 모음으로 펼쳤을 때 <b>${room?.pick?.size || room?.size || 5}칸</b>이어야 합니다.</p>
    <div style="margin-top:16px"><input class="field" id="roomWord" autofocus placeholder="예: 시민" maxlength="8" autocomplete="off" spellcheck="false"><div class="hint" id="roomWordHint">단어를 입력해 주세요</div></div>
    <div class="sheet-actions"><button class="btn primary" id="roomWordButton" data-act="room-word" disabled>이 단어 내기</button></div>`

  TW.GOES.rooms = () => { draft.kind = null; roomCategory = null; TW.openSheet('rooms') }
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
    'room-start': startRound, 'room-next': nextRound, 'room-again': requestRematch,
    'room-standings': showStandings, 'room-force': forceRound,
    'room-copy': () => TW.copyAndTell(inviteText(), TW.shareUrl() ? '초대 링크를 복사했어요' : '방 코드를 복사했어요'),
    'room-copy-result': copyResult, 'room-word': submitSetterWord, 'room-final-submit': submitFinalWord,
    'room-chat-toggle': () => { if (room) { room.chatOpen = !room.chatOpen; renderQuickChat(); if (room.chatOpen) setTimeout(() => $('#roomChatInput')?.focus(), 0) } },
    'room-chat-send': () => sendChat($('#roomChatInput')?.value, room?.chatScope),
    'room-random-teams': randomizeTeams,
    'room-manual-teams': () => { if (room?.host && isTeamMode() && !room.startedAt) { room.teamsHidden = false; balanceTeams(); ensureTeamSetters(); renderLobby(); broadcastLobby() } },
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
    room.chatScope = 'all'
    $('#roomCode').textContent = room.code
    renderLobby()
  }
  function renderLobby() {
    if (!room || $('#lobby').hidden) return
    const list = orderedPlayers().filter((p) => p.online)
    const names = displayNames()
    const choose = room.host && room.kind === 'setter' && !room.startedAt
    const chooseTeam = room.host && isTeamMode() && !room.startedAt && !room.teamsHidden
    const invite = $('#roomInvite')
    if (invite) {
      const base = TW.shareUrl()
      invite.hidden = !room.host
      invite.innerHTML = room.host ? `<div class="room-invite">${base ? `<textarea class="linkbox" readonly>${esc(inviteText())}</textarea>` : '<p class="muted" style="text-align:left;flex:1">게임 주소와 이 코드를 함께 보내세요.</p>'}<button class="btn ghost" data-act="room-copy">${base ? '링크 복사' : '코드 복사'}</button></div>` : ''
    }
    $('#roomCount').textContent = `${list.length}명`
    $('#roomRoster').innerHTML = list.map((p) => {
      const selected = p.pid === room.setterPid
      const role = room.kind === 'setter' && selected ? '출제자' : p.pid === room.hostPid ? '방장' : '참가자'
      const pick = choose ? `<button class="setter-pick" data-setter="${esc(p.pid)}" aria-pressed="${selected}">${selected ? '선택됨' : '출제자로 선택'}</button>` : ''
      const team = room.teams.get(p.pid) || 'red'
      const teamPick = chooseTeam ? `<span class="team-picks"><button data-team-pid="${esc(p.pid)}" data-team="red" aria-pressed="${team === 'red'}">빨강</button><button data-team-pid="${esc(p.pid)}" data-team="blue" aria-pressed="${team === 'blue'}">파랑</button></span>` : ''
      const setterTeam = room.kind === 'teamsetter' && room.teamSetters[team] === p.pid
      const teamSetterPick = chooseTeam && room.kind === 'teamsetter' ? `<button class="setter-pick" data-team-setter="${esc(p.pid)}" aria-pressed="${setterTeam}">${setterTeam ? '팀 출제자' : '출제자로 선택'}</button>` : ''
      const teamRole = isTeamMode() && !room.teamsHidden ? `<em class="team-label ${team}">${TEAM_NAMES[team]}${setterTeam ? ' · 출제자' : ''}</em>` : ''
      return `<li><b>${esc(names.get(p.pid))}${p.pid === room.me.pid ? ' (나)' : ''}</b>${teamRole}<span>${role}</span>${pick}${teamPick}${teamSetterPick}</li>`
    }).join('')
    const wait = room.kind === 'spy' ? ' · 제한시간 없음' : isTeamMode() ? ' · 선두 팀 후 30초' : room.kind !== 'coop' ? ` · 완주 후 ${room.waitSeconds ? `${room.waitSeconds}초` : '제한 없음'}` : ''
    const detail = `${MODES[room.kind]} · ${room.size ? `${room.size}칸` : '랜덤 칸'}${room.kind === 'relay' ? ` · ${room.roundsTotal}라운드` : room.kind === 'captain' ? ` · 매 판 ${room.eliminateCount}명 탈락` : ''}${wait}`
    const teamControls = room.host && isTeamMode() ? `<div class="sheet-actions team-lobby-actions">${room.teamsHidden ? '<button class="btn" data-act="room-manual-teams">수동 배정으로 바꾸기</button>' : '<button class="btn accent" data-act="room-random-teams">랜덤 팀 · 비공개</button>'}</div>` : ''
    const hiddenNotice = isTeamMode() && room.teamsHidden ? '<br><b>비밀 팀 배정 완료</b> · 게임이 시작되면 공개됩니다.' : ''
    $('#lobbyActions').innerHTML = room.host
      ? `<p class="muted">${detail}${hiddenNotice}${choose ? '<br>아래에서 출제자를 선택한 뒤 시작하세요.' : chooseTeam ? '<br>참가자를 두 팀으로 나눈 뒤 시작하세요.' : ''}</p>${teamControls}<button class="btn primary" data-act="room-start" ${Net.status === 'live' ? '' : 'disabled'}>시작하기</button><button class="btn ghost" data-go="leave">나가기</button>`
      : `<p class="muted">${detail}${hiddenNotice}<br>방장이 시작하기를 기다리는 중…</p><button class="btn ghost" data-go="leave">나가기</button>`
    $('#lobbyStatus').textContent = ({ off: '오프라인', connecting: '연결하는 중…', live: '연결됨', retry: '다시 연결하는 중…', down: '연결을 기다리는 중…' })[Net.status] || Net.status
    renderQuickChat()
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
      eliminateCount: [1, 2].includes(Number(draft.eliminateCount)) ? Number(draft.eliminateCount) : 1,
      me, host: false, hostPid: null, peers: new Map([[me.pid, { ...me, rows: [], status: 'waiting', online: true }]]),
      activePids: new Set(), participants: [], results: new Map(), totals: new Map(Object.entries(resume?.totals || {})),
      startedAt: null, answer: null, over: false, final: false, scoreResults: [],
      setterPid: resume?.setterPid || me.pid, turnPid: resume?.turnPid || null, pick: null, resume: resume || null,
      waitEndsAt: null, coopPending: false, finalChance: null, maxTries: TW.MAX_TRIES,
      readyPids: new Set(), readyVoters: new Set(), resultSheet: 'scoreboard', messages: [], chatOpen: false, chatScope: 'all', lobbyChatAutoOpened: false, lastChatAt: 0,
      teams: new Map(), teamsHidden: false, hiddenRosterKey: '', teamSetters: { red: null, blue: null }, teamPicks: null, teamAnswers: null,
      teamBoards: { red: [], blue: [] }, teamTurns: { red: null, blue: null }, teamStatus: { red: 'waiting', blue: 'waiting' },
      teamMaxTries: { red: TW.MAX_TRIES, blue: TW.MAX_TRIES }, teamFinishMs: { red: null, blue: null }, teamFinals: { red: null, blue: null }, teamPending: false, teamDeadline: null, teamResult: null, teamWinner: null,
      spies: { red: null, blue: null }, isSpy: false,
      captainAlive: [], captainEliminated: [], captainChampion: null,
    }
    globalThis.TWRoomHash = null
    persistRoom(); showLobby()
    Net.connect(code, me).catch(() => { if (room?.code === code) TW.toast('방을 깨우는 중이에요. 자동으로 다시 연결할게요', 2600) })
  }
  function leaveRoom() {
    clearInterval(timer); clearTimeout(nextTimer); clearTimeout(skipTimer); clearTimeout(waitTimer); clearTimeout(finalTimer)
    clearTimeout(teamEndTimer); clearTimeout(teamFinalTimers.red); clearTimeout(teamFinalTimers.blue); clearTimeout(teamSkipTimers.red); clearTimeout(teamSkipTimers.blue)
    timer = nextTimer = skipTimer = waitTimer = finalTimer = null
    teamEndTimer = teamFinalTimers.red = teamFinalTimers.blue = teamSkipTimers.red = teamSkipTimers.blue = null
    Net.leave(); room = null; TW.store.set('tw.room.v1', null)
    document.body.classList.remove('watching')
    $('#keyboard').hidden = false; $('.board-wrap').hidden = false; $('#peers').hidden = true; $('#roomBanner').hidden = true; $('#quickChat').hidden = true; $('#lobbyChat').hidden = true; $('#finalChance').hidden = true
    $('#btnBack').dataset.go = 'home'; $('#btnMenu').dataset.sheet = 'stats'; $('#btnMenu').textContent = '☰'; $('#btnMenu').setAttribute('aria-label', '기록')
    TW.GOES.home()
  }

  function teamsObject() { return Object.fromEntries(room?.teams || []) }
  function lobbyPayload() { return { kind: room.kind, size: room.size, roundsTotal: room.roundsTotal, setterPid: room.setterPid, waitSeconds: room.waitSeconds, eliminateCount: room.eliminateCount, teamsHidden: room.teamsHidden, teams: room.teamsHidden ? {} : teamsObject(), teamSetters: room.teamsHidden ? {} : room.teamSetters } }
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
    room.eliminateCount = [1, 2].includes(Number(payload.eliminateCount)) ? Number(payload.eliminateCount) : 1
    if (isTeamMode(payload.kind)) {
      room.teamsHidden = Boolean(payload.teamsHidden)
      room.teams = new Map(Object.entries(payload.teams || {}).filter(([, team]) => team === 'red' || team === 'blue'))
      room.teamSetters = { red: String(payload.teamSetters?.red || '') || null, blue: String(payload.teamSetters?.blue || '') || null }
    }
    renderLobby(); persistRoom()
  }
  function balanceTeams() {
    if (!room?.host || !isTeamMode() || room.startedAt) return
    const online = onlinePlayers()
    const ids = new Set(online.map((p) => p.pid))
    for (const pid of room.teams.keys()) if (!ids.has(pid)) room.teams.delete(pid)
    for (const player of online) {
      if (room.teams.has(player.pid)) continue
      const red = Array.from(room.teams.values()).filter((team) => team === 'red').length
      const blue = room.teams.size - red
      room.teams.set(player.pid, red <= blue ? 'red' : 'blue')
    }
    ensureTeamSetters()
  }
  function ensureTeamSetters() {
    if (!room || room.kind !== 'teamsetter') return
    for (const team of ['red', 'blue']) {
      if (room.teams.get(room.teamSetters[team]) !== team || !room.peers.get(room.teamSetters[team])?.online) room.teamSetters[team] = onlinePlayers().find((p) => room.teams.get(p.pid) === team)?.pid || null
    }
  }
  function randomizeTeams() {
    if (!room?.host || !isTeamMode() || room.startedAt) return
    const players = onlinePlayers().slice()
    for (let i = players.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [players[i], players[j]] = [players[j], players[i]] }
    room.teams = new Map(players.map((player, index) => [player.pid, index % 2 ? 'blue' : 'red']))
    room.teamsHidden = true; room.hiddenRosterKey = players.map((p) => p.pid).sort().join('|'); room.teamSetters = { red: null, blue: null }; ensureTeamSetters()
    renderLobby(); broadcastLobby(); TW.toast('팀을 비밀로 배정했어요. 시작할 때 공개됩니다.')
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
    if (!room.startedAt && !room.host && !room.lobbyChatAutoOpened) { room.lobbyChatAutoOpened = true; room.chatOpen = true; room.chatScope = 'all' }
    if (!room.setterPid || !room.peers.get(room.setterPid)?.online) room.setterPid = room.hostPid
    const rosterKey = onlinePlayers().map((p) => p.pid).sort().join('|')
    if (room.host && room.teamsHidden && !room.startedAt && rosterKey !== room.hiddenRosterKey) randomizeTeams()
    else balanceTeams()
    renderLobby(); renderPeers(); renderBanner()
    if (!room.startedAt) {
      if (room.host) broadcastLobby()
      else if (Net.status === 'live') Net.send('sync?', { pid: room.me.pid })
    }
    if (room.kind === 'coop' && room.startedAt && !room.over) scheduleTurnSkip()
    if (isTeamMode() && room.startedAt && !room.over) scheduleTeamSkips()
    if (room.host && room.finalChance?.active && !room.over) {
      clearTimeout(finalTimer)
      finalTimer = setTimeout(finishFinalChance, Math.max(0, room.finalChance.endsAt - Date.now()))
    }
    if (room.host && room.waitEndsAt && !room.over) {
      clearTimeout(waitTimer)
      waitTimer = setTimeout(forceRound, Math.max(0, room.waitEndsAt - Date.now()))
    }
    if (room.host && isTeamMode() && !room.over) {
      for (const team of ['red', 'blue']) {
        const final = room.teamFinals[team]
        if (final?.active && final.endsAt) { clearTimeout(teamFinalTimers[team]); teamFinalTimers[team] = setTimeout(() => finishTeamFinal(team), Math.max(0, final.endsAt - Date.now())) }
      }
      if (room.teamDeadline) { clearTimeout(teamEndTimer); teamEndTimer = setTimeout(forceTeamDeadline, Math.max(0, room.teamDeadline.endsAt - Date.now())) }
    }
    if (room.host && room.over) publishReadyState()
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
    if (room.kind === 'captain' && !room.captainAlive.length) {
      room.captainAlive = onlinePlayers().map((p) => p.pid)
      if (room.captainAlive.length < 2) return TW.toast('대장전은 두 명 이상 필요해요')
    }
    if (room.kind === 'setter') {
      const setterPid = room.peers.get(room.setterPid)?.online ? room.setterPid : room.hostPid
      room.setterPid = setterPid; room.pick = { round: room.round, setterPid, size }
      Net.send('pick', room.pick); onPick(room.pick); return
    }
    if (room.kind === 'teamsetter') {
      balanceTeams(); ensureTeamSetters()
      const participants = roundParticipants(null)
      const red = participants.filter((pid) => room.teams.get(pid) === 'red'); const blue = participants.filter((pid) => room.teams.get(pid) === 'blue')
      if (!red.length || !blue.length) return TW.toast('빨강팀과 파랑팀에 한 명 이상 필요해요')
      if (!room.teamSetters.red || !room.teamSetters.blue) return TW.toast('각 팀 출제자를 정해 주세요')
      const payload = { kind: 'teamsetter', round: room.round, size, teams: teamsObject(), setters: room.teamSetters }
      room.teamPicks = { round: room.round, size, setters: { ...room.teamSetters }, words: {} }
      Net.send('pick', payload); onPick(payload); return
    }
    sendStart(TW.freeAnswer(size), null, size)
  }
  function sendStart(answer, setterPid, size, teamAnswers = null) {
    if (!room?.host) return
    const participants = room.kind === 'captain' && room.captainAlive.length
      ? room.captainAlive.filter((pid) => room.peers.get(pid)?.online)
      : roundParticipants(setterPid)
    if (!participants.length) return TW.toast('플레이할 참가자가 없어요')
    if (isTeamMode()) {
      balanceTeams()
      const red = participants.filter((pid) => room.teams.get(pid) === 'red')
      const blue = participants.filter((pid) => room.teams.get(pid) === 'blue')
      if (!red.length || !blue.length) return TW.toast('빨강팀과 파랑팀에 한 명 이상 필요해요')
      if (room.kind === 'spy' && (red.length < 2 || blue.length < 2)) return TW.toast('스파이전은 팀마다 두 명 이상 필요해요')
      const teamMaxTries = { red: Math.max(TW.MAX_TRIES, red.length), blue: Math.max(TW.MAX_TRIES, blue.length) }
      const spies = room.kind === 'spy' ? { red: red[Math.floor(Math.random() * red.length)], blue: blue[Math.floor(Math.random() * blue.length)] } : { red: null, blue: null }
      const redAnswer = teamAnswers?.red || answer; const blueAnswer = teamAnswers?.blue || answer
      const payload = {
        round: room.round, roundsTotal: 1, kind: room.kind, size,
        answer: H.encode(H.decompose(redAnswer)), word: redAnswer, teamWords: { red: redAnswer, blue: blueAnswer }, setter: null, participants,
        teams: teamsObject(), teamTurns: { red: red[0], blue: blue[0] }, teamMaxTries, spies,
        waitSeconds: 30, ts: Date.now(),
      }
      Net.send('start', payload); beginRound(payload, false); return
    }
    const maxTries = room.kind === 'coop' ? Math.max(TW.MAX_TRIES, participants.length) : TW.MAX_TRIES
    const payload = {
      round: room.round, roundsTotal: room.roundsTotal, kind: room.kind, size,
      answer: H.encode(H.decompose(answer)), word: answer, setter: setterPid, participants, maxTries,
      turnPid: room.kind === 'coop' ? participants[0] : null, waitSeconds: room.waitSeconds, ts: Date.now(),
      eliminateCount: room.eliminateCount, captainAlive: room.kind === 'captain' ? participants : null,
    }
    Net.send('start', payload); beginRound(payload, false)
  }
  function onPick(payload) {
    if (!room || room.startedAt) return
    const size = Number(payload.size)
    if (Number(payload.round) !== room.round || !TW.SIZES.includes(size)) return
    if (payload.kind === 'teamsetter') {
      room.kind = 'teamsetter'; room.teamsHidden = false
      room.teams = new Map(Object.entries(payload.teams || {}).filter(([, team]) => team === 'red' || team === 'blue'))
      room.teamSetters = { red: String(payload.setters?.red || '') || null, blue: String(payload.setters?.blue || '') || null }
      if (!room.teamPicks || room.teamPicks.round !== room.round) room.teamPicks = { round: room.round, size, setters: { ...room.teamSetters }, words: {} }
      const ownTeam = room.teams.get(room.me.pid); const targetTeam = ownTeam === 'red' ? 'blue' : 'red'
      const isSetter = room.teamSetters[ownTeam] === room.me.pid
      room.pick = isSetter ? { round: room.round, size, setterPid: room.me.pid, team: ownTeam, targetTeam } : null
      if (isSetter && (!payload.retryPid || payload.retryPid === room.me.pid)) {
        if (payload.message) TW.toast(payload.message)
        TW.openSheet('pickword')
      } else if (!payload.retryPid) TW.toast('각 팀 출제자가 서로 다른 문제를 고르는 중이에요', 2200)
      renderLobby(); return
    }
    room.kind = 'setter'; room.pick = { round: room.round, setterPid: String(payload.setterPid), size }; room.setterPid = room.pick.setterPid
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
    const payload = { pid: room.me.pid, round: room.pick.round, answer: H.encode(word.jamo), word: word.raw, size: word.size, team: room.pick.team || null }
    TW.closeSheet()
    if (room.host) onWord(payload); else Net.send('word', payload)
  }
  function onWord(payload) {
    if (!room?.host) return
    if (room.kind === 'teamsetter') {
      const team = payload.team === 'red' || payload.team === 'blue' ? payload.team : null
      const picks = room.teamPicks
      if (!team || !picks || Number(payload.round) !== picks.round || String(payload.pid) !== picks.setters[team]) return
      const answer = decodeWireWord(payload)
      if (!answer || Array.from(H.decompose(answer) || '').length !== picks.size) return
      const otherWord = picks.words[team === 'red' ? 'blue' : 'red']
      if (otherWord && H.encode(H.decompose(otherWord)) === H.encode(H.decompose(answer))) {
        const retry = { kind: 'teamsetter', round: picks.round, size: picks.size, teams: teamsObject(), setters: picks.setters, retryPid: String(payload.pid), message: '상대 팀과 다른 단어를 내 주세요' }
        Net.send('pick', retry); onPick(retry); return
      }
      picks.words[team] = answer
      if (!picks.words.red || !picks.words.blue) return TW.toast(`${TEAM_NAMES[team]} 출제 완료 · 다른 팀을 기다리는 중이에요`)
      room.pick = null; room.teamPicks = null
      return sendStart(picks.words.blue, null, picks.size, { red: picks.words.blue, blue: picks.words.red })
    }
    if (!room.pick || room.kind !== 'setter') return
    if (String(payload.pid) !== room.pick.setterPid || Number(payload.round) !== room.pick.round) return
    const answer = decodeWireWord(payload)
    if (!answer || Array.from(H.decompose(answer) || '').length !== room.pick.size) return
    const pick = room.pick; room.pick = null; sendStart(answer, pick.setterPid, pick.size)
  }
  function decodeAnswer(value) {
    try { return H.compose(H.decode(String(value || ''))) } catch (e) { return null }
  }
  function decodeWireWord(payload) {
    const word = String(payload?.word || '')
    return H.decompose(word) ? word : decodeAnswer(payload?.answer)
  }
  function validParticipants(payload) {
    const raw = Array.isArray(payload.participants) ? payload.participants.map(String) : []
    // 방장이 정한 순서를 그대로 쓴다. Presence 도착 순서로 다시 거르면 기기마다 턴 순서가 달라진다.
    return Array.from(new Set(raw.filter((pid) => pid && pid.length <= 64)))
  }
  function beginRound(payload, spectator) {
    if (!room || Number(payload.round) < room.round) return
    let answer = decodeWireWord(payload); const size = Number(payload.size)
    if (!answer || !TW.SIZES.includes(size) || !Object.hasOwn(MODES, payload.kind)) return
    room.round = Number(payload.round) || 1; room.roundsTotal = Math.max(1, Number(payload.roundsTotal) || room.roundsTotal || 1)
    room.kind = payload.kind; room.size = size; room.answer = answer
    room.waitSeconds = [0, 30, 60, 90].includes(Number(payload.waitSeconds)) ? Number(payload.waitSeconds) : room.waitSeconds
    room.setterPid = payload.setter ? String(payload.setter) : null
    room.participants = validParticipants(payload); room.activePids = new Set(room.participants)
    if (room.kind === 'captain') {
      room.eliminateCount = [1, 2].includes(Number(payload.eliminateCount)) ? Number(payload.eliminateCount) : room.eliminateCount
      room.captainAlive = room.participants.slice(); room.captainEliminated = []; room.captainChampion = null
    }
    if (isTeamMode()) {
      room.teamsHidden = false
      room.teams = new Map(Object.entries(payload.teams || {}).filter(([pid, team]) => room.activePids.has(pid) && (team === 'red' || team === 'blue')))
      const redWord = H.decompose(String(payload.teamWords?.red || '')) ? String(payload.teamWords.red) : answer
      const blueWord = H.decompose(String(payload.teamWords?.blue || '')) ? String(payload.teamWords.blue) : answer
      room.teamAnswers = { red: redWord, blue: blueWord }
      room.teamTurns = { red: String(payload.teamTurns?.red || ''), blue: String(payload.teamTurns?.blue || '') }
      room.teamMaxTries = {
        red: Math.max(TW.MAX_TRIES, Number(payload.teamMaxTries?.red) || Array.from(room.teams.values()).filter((team) => team === 'red').length),
        blue: Math.max(TW.MAX_TRIES, Number(payload.teamMaxTries?.blue) || Array.from(room.teams.values()).filter((team) => team === 'blue').length),
      }
      room.teamBoards = { red: [], blue: [] }; room.teamStatus = { red: 'playing', blue: 'playing' }; room.teamFinishMs = { red: null, blue: null }
      room.teamFinals = { red: null, blue: null }; room.teamDeadline = null; room.teamResult = null; room.teamPending = false
      room.teamWinner = null; room.spies = { red: String(payload.spies?.red || '') || null, blue: String(payload.spies?.blue || '') || null }
      room.isSpy = room.kind === 'spy' && Object.values(room.spies).includes(room.me.pid)
    }
    room.turnPid = room.kind === 'coop' ? String(payload.turnPid || room.participants[0] || '') : null
    const myTeam = room.teams.get(room.me.pid)
    if (isTeamMode()) { answer = room.teamAnswers?.[myTeam] || room.teamAnswers?.red || answer; room.answer = answer; room.chatScope = myTeam ? 'team' : 'all' }
    room.maxTries = room.kind === 'coop' ? Math.max(TW.MAX_TRIES, Number(payload.maxTries) || room.participants.length) : isTeamMode() ? room.teamMaxTries[myTeam] || TW.MAX_TRIES : TW.MAX_TRIES
    room.startedAt = Date.now(); room.over = false; room.final = false; room.results = new Map(); room.scoreResults = []
    room.waitEndsAt = null; room.coopPending = false; room.finalChance = null
    room.readyPids = new Set(); room.readyVoters = new Set(); room.resultSheet = 'scoreboard'; clearTimeout(waitTimer); clearTimeout(finalTimer)
    for (const p of room.peers.values()) {
      p.rows = []; p.guesses = []; p.status = room.activePids.has(p.pid) ? 'playing' : p.pid === room.setterPid ? 'setter' : 'spectator'; p.tries = null; p.ms = null
    }
    const isSetter = room.me.pid === room.setterPid; const isActive = room.activePids.has(room.me.pid)
    room.me.role = isSetter ? 'setter' : spectator || !isActive ? 'spectator' : 'player'
    TW.startGame(room.kind, room.size, answer, false, room.maxTries)
    $('#btnBack').dataset.go = 'leave'; $('#btnMenu').dataset.sheet = 'roommenu'; $('#btnMenu').textContent = '☰'; $('#btnMenu').setAttribute('aria-label', '방 메뉴')
    const watching = room.me.role !== 'player'
    document.body.classList.toggle('watching', watching); $('#keyboard').hidden = watching; $('.board-wrap').hidden = watching
    $('#peers').hidden = room.kind === 'coop'
    $('#finalChance').hidden = true
    renderPeers(); renderBanner(); renderQuickChat(); TW.refitBoard(); startTimer(); persistRoom()
    if (room.kind === 'spy') TW.openSheet('spyrole')
  }
  function startTimer() {
    clearInterval(timer)
    const tick = () => {
      if (!room?.startedAt || room.over) return
      const sec = Math.floor((Date.now() - room.startedAt) / 1000)
      const round = room.kind === 'relay' ? `${room.round}/${room.roundsTotal}R · ` : room.kind === 'captain' ? `${room.round}판 · 생존 ${room.captainAlive.length}명 · ` : ''
      const left = room.waitEndsAt ? Math.max(0, Math.ceil((room.waitEndsAt - Date.now()) / 1000)) : null
      const ownTeam = isTeamMode() ? room.teams.get(room.me.pid) : null
      const finalState = ownTeam ? room.teamFinals[ownTeam] : room.finalChance
      const finalLeft = finalState?.active && finalState.endsAt ? Math.max(0, Math.ceil((finalState.endsAt - Date.now()) / 1000)) : null
      const teamLeft = room.teamDeadline ? Math.max(0, Math.ceil((room.teamDeadline.endsAt - Date.now()) / 1000)) : null
      $('#gameSub').textContent = finalLeft !== null ? `마지막 기회 · ${finalLeft}초` : teamLeft !== null ? `상대 팀 마감까지 ${teamLeft}초` : left === null
        ? `${round}${room.size}칸 · ${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`
        : `${round}마감까지 ${left}초`
      const countdown = $('#finalCountdown')
      if (countdown && finalLeft !== null) countdown.textContent = `${finalLeft}초`
    }
    tick(); timer = setInterval(tick, 1000)
  }
  function renderBanner() {
    const banner = $('#roomBanner')
    if (!banner || !room?.startedAt) { if (banner) banner.hidden = true; return }
    let text = ''
    if (room.over) text = `정답: ${room.answer}`
    else if (room.finalChance?.active) text = '마지막 기회! 모두 동시에 한 번씩 도전하세요'
    else if (isTeamMode() && room.teamPending) text = '팀 제출을 확인하는 중…'
    else if (isTeamMode()) {
      const team = room.teams.get(room.me.pid)
      const other = team === 'red' ? 'blue' : 'red'
      if (!team) text = '팀전을 관전하고 있어요'
      else if (room.kind === 'spy' && room.isSpy && room.teamFinals[team]?.active) text = '스파이는 마지막 기회 없이 팀원들의 도전을 관전해요'
      else if (room.teamStatus[team] !== 'playing') text = `${TEAM_NAMES[team]} 완료 · ${TEAM_NAMES[other]} 상황을 보고 있어요`
      else text = room.teamTurns[team] === room.me.pid ? `${TEAM_NAMES[team]} · 내 차례예요` : `${TEAM_NAMES[team]} · ${playerName(room.teamTurns[team])}님 차례`
    }
    else if (room.kind === 'coop' && room.coopPending) text = '제출을 확인하는 중…'
    else if (room.kind === 'coop') text = room.turnPid === room.me.pid ? '내 차례예요' : `지금은 ${playerName(room.turnPid)}님 차례`
    else if (room.me.role === 'finished') text = room.waitEndsAt ? '완료! 남은 참가자를 응원해 주세요' : '완료! 다른 참가자의 보드를 보고 있어요'
    else if (room.me.role === 'setter') text = `내가 낸 정답: ${room.answer}`
    else if (room.kind === 'captain' && room.me.role === 'spectator' && !room.captainAlive.includes(room.me.pid)) text = room.host ? '탈락했지만 방장으로 남아 관전 중 · 다음 판 진행 권한을 유지해요' : '탈락 후 방에 남아 관전 중이에요'
    else if (room.me.role === 'spectator') text = '이번 라운드는 관전 중이에요'
    banner.textContent = text; banner.hidden = !text
  }
  function canPlay() {
    if (!room || room.me.role !== 'player' || room.over || room.finalChance?.active) return false
    if (room.kind === 'coop') return room.turnPid === room.me.pid && !room.coopPending
    if (isTeamMode()) {
      const team = room.teams.get(room.me.pid)
      return Boolean(team && room.teamStatus[team] === 'playing' && !room.teamFinals[team]?.active && room.teamTurns[team] === room.me.pid && !room.teamPending)
    }
    return true
  }
  function blockedInput() {
    if (!room || Date.now() - lastBlocked < 1200) return
    lastBlocked = Date.now()
    const team = isTeamMode() ? room.teams.get(room.me.pid) : null
    TW.toast(room.me.role !== 'player' ? '이번 라운드는 관전 중이에요' : room.coopPending || room.teamPending ? '제출을 확인하는 중이에요' : `${playerName(team ? room.teamTurns[team] : room.turnPid)}님 차례예요`)
  }
  function renderQuickChat() {
    const gameBar = $('#quickChat'); const lobbyBar = $('#lobbyChat')
    if (gameBar) gameBar.hidden = true
    if (lobbyBar) lobbyBar.hidden = true
    if (!room || room.over) return
    const inLobby = !$('#lobby').hidden && !room.startedAt
    const inGame = Boolean(room.startedAt && !$('#game').hidden)
    if (!inLobby && !inGame) return
    const bar = inLobby ? lobbyBar : gameBar
    if (!bar) return
    const force = inGame && room.host && room.kind !== 'coop' && !isTeamMode() ? '<button class="btn accent" data-act="room-force">지금 결과 보기</button>' : ''
    const scopes = inGame && isTeamMode() && room.teams.has(room.me.pid)
      ? `<div class="chat-tabs"><button data-chat-scope="all" aria-pressed="${room.chatScope === 'all'}">전체</button><button data-chat-scope="team" aria-pressed="${room.chatScope === 'team'}">우리 팀</button></div>` : ''
    const messages = room.messages.filter((message) => message.scope === 'all' || inGame && message.team === room.teams.get(room.me.pid)).slice(-30)
    const panel = room.chatOpen ? `<div class="chat-panel">${scopes}<div class="chat-messages">${messages.length ? messages.map((message) => `<p class="${message.pid === room.me.pid ? 'mine' : ''}"><b>${esc(playerName(message.pid))}</b><span>${esc(message.text)}</span></p>`).join('') : '<p class="chat-empty">아직 메시지가 없어요</p>'}</div><div class="chat-form"><input class="field" id="roomChatInput" maxlength="60" placeholder="메시지 입력" autocomplete="off"><button class="btn primary" data-act="room-chat-send">보내기</button></div></div>` : ''
    const quickMessages = inLobby ? '' : QUICK_MESSAGES.map((text) => `<button class="chip" data-chat="${esc(text)}">${esc(text)}</button>`).join('')
    bar.innerHTML = `<div class="quick-actions">${quickMessages}<button class="chip chat-toggle" data-act="room-chat-toggle" aria-pressed="${room.chatOpen}">채팅${room.messages.length ? ` ${room.messages.length}` : ''}</button>${force}</div>${panel}`
    bar.hidden = false
    if (room.chatOpen) requestAnimationFrame(() => { const box = bar.querySelector('.chat-messages'); if (box) box.scrollTop = box.scrollHeight })
  }
  function showWaitingView() {
    if (!room || room.kind === 'coop' || room.over) return
    room.me.role = 'finished'
    document.body.classList.add('watching')
    $('#keyboard').hidden = true; $('.board-wrap').hidden = true; $('#peers').hidden = false
    renderPeers(); renderBanner(); renderQuickChat()
  }
  function sendChat(value, scope = 'all') {
    if (!room || room.over) return
    const text = String(value || '').trim().replace(/\s+/g, ' ').slice(0, 60)
    if (!text || Date.now() - room.lastChatAt < 700) return
    const team = room.teams.get(room.me.pid)
    const safeScope = room.startedAt && isTeamMode() && team && scope === 'team' ? 'team' : 'all'
    const payload = { id: `${room.me.pid}:${Date.now()}`, pid: room.me.pid, text, scope: safeScope, team: safeScope === 'team' ? team : null, round: room.round }
    room.lastChatAt = Date.now(); onChat(payload); Net.send('chat', payload)
    const input = $('#roomChatInput'); if (input) input.value = ''
  }
  function onChat(payload) {
    if (!room || room.over || Number(payload.round) !== room.round) return
    const pid = String(payload.pid || ''); const sender = room.peers.get(pid)
    const text = String(payload.text || '').trim().replace(/\s+/g, ' ').slice(0, 60)
    const scope = payload.scope === 'team' ? 'team' : 'all'; const team = payload.team === 'red' || payload.team === 'blue' ? payload.team : null
    if (!sender || !text || scope === 'team' && (!team || room.teams.get(pid) !== team || room.teams.get(room.me.pid) !== team)) return
    const id = String(payload.id || `${pid}:${payload.round}:${text}`)
    if (room.messages.some((message) => message.id === id)) return
    room.messages.push({ id, pid, text, scope, team }); room.messages = room.messages.slice(-30)
    const wasOpen = room.chatOpen; renderQuickChat()
    if (!wasOpen || QUICK_MESSAGES.includes(text)) TW.toast(`${playerName(pid)}: ${text}`, 2200)
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
    if (room.kind === 'coop' || isTeamMode()) return
    const p = room.peers.get(room.me.pid)
    const guess = TW.state?.guesses?.[row]
    if (p) { if (!p.rows) p.rows = []; if (!p.guesses) p.guesses = []; p.rows[row] = marks.slice(); if (guess) p.guesses[row] = guess.slice() }
    Net.send('mark', { pid: room.me.pid, row, marks: encodeMarks(marks), guess: guess ? H.encode(guess) : '' }); renderPeers(); persistRoom()
  }
  function localDone(status, tries) {
    if (!room || room.me.role !== 'player') return
    if (room.kind === 'coop') { if (room.host) finishCoop(status, tries); return }
    const result = { pid: room.me.pid, status, tries, ms: Date.now() - room.startedAt }
    room.results.set(result.pid, result); Object.assign(room.peers.get(result.pid), result)
    Net.send('done', result); renderPeers(); persistRoom(); showWaitingView(); maybeStartWait(); maybeFinish()
  }
  function onMark(payload) {
    if (!room || room.kind === 'coop' || isTeamMode() || !room.startedAt || payload.pid === room.me.pid) return
    const p = room.peers.get(String(payload.pid)); const marks = decodeMarks(payload.marks); const row = Number(payload.row)
    if (!p || !marks || !(row >= 0 && row < TW.MAX_TRIES)) return
    let guess = null
    try { guess = Array.from(H.decode(String(payload.guess || ''))) } catch (e) { /* 예전 클라이언트는 추측을 보내지 않는다 */ }
    if (guess?.length !== room.size) guess = null
    if (!p.rows) p.rows = []; if (!p.guesses) p.guesses = []; p.rows[row] = marks; if (guess) p.guesses[row] = guess; renderPeers()
  }
  function onDone(payload) {
    if (!room || room.kind === 'coop' || !room.startedAt || payload.pid === room.me.pid) return
    const p = room.peers.get(String(payload.pid))
    if (!p || !room.activePids.has(p.pid)) return
    const result = { pid: p.pid, status: payload.status === 'won' ? 'won' : 'lost', tries: Math.max(1, Math.min(TW.MAX_TRIES, Number(payload.tries) || TW.MAX_TRIES)), ms: Math.max(0, Number(payload.ms) || 0) }
    room.results.set(result.pid, result); Object.assign(p, result); renderPeers(); maybeStartWait(); maybeFinish()
  }
  function submitCoop(guess) {
    if (!room || room.kind !== 'coop' && !isTeamMode()) return false
    if (isTeamMode()) return submitTeam(guess)
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
    const needsFinalChance = !won && row + 1 >= room.maxTries
    const status = won ? 'won' : 'playing'
    const commit = {
      phase: 'commit', pid, row, guess: H.encode(guess), marks: encodeMarks(marks), status,
      nextPid: status === 'playing' && !needsFinalChance ? nextParticipant(pid, false) : null,
      finalChance: needsFinalChance, round: room.round,
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
      if (payload.finalChance && room.host) startFinalChance()
      else if (status !== 'playing' && room.host) finishCoop(status, row + 1)
      else scheduleTurnSkip()
    }))
  }
  function teamMembers(team, onlineOnly = false) {
    return room.participants.filter((pid) => room.teams.get(pid) === team && (!onlineOnly || room.peers.get(pid)?.online))
  }
  function teamFinalMembers(team) {
    return teamMembers(team).filter((pid) => room.kind !== 'spy' || !Object.values(room.spies).includes(pid))
  }
  function teamAnswerJamo(team) {
    return Array.from(H.decompose(room.teamAnswers?.[team] || room.answer) || '')
  }
  function nextTeamParticipant(team, pid, onlineOnly = false, excludeSpies = false) {
    const list = teamMembers(team, onlineOnly).filter((id) => !excludeSpies || !Object.values(room.spies).includes(id))
    if (!list.length) return null
    const index = list.indexOf(pid)
    return list[(index + 1 + list.length) % list.length]
  }
  function submitTeam(guess) {
    if (!canPlay()) { blockedInput(); return true }
    const team = room.teams.get(room.me.pid)
    room.teamPending = true; renderBanner()
    const payload = { phase: 'team-submit', round: room.round, team, pid: room.me.pid, row: room.teamBoards[team].length, guess: H.encode(guess) }
    if (room.host) processTeamSubmit(payload)
    else Net.send('turn', payload)
    setTimeout(() => {
      if (!room?.teamPending || !isTeamMode() || Number(payload.round) !== room.round) return
      room.teamPending = false; renderBanner(); TW.toast('팀 제출이 전달되지 않았어요. 다시 눌러 주세요'); Net.send('sync?', { pid: room.me.pid })
    }, 6000)
    return true
  }
  function processTeamSubmit(payload) {
    if (!room?.host || !isTeamMode() || room.over || payload.phase !== 'team-submit') return
    const team = payload.team === 'red' || payload.team === 'blue' ? payload.team : null
    const pid = String(payload.pid || ''); const row = Number(payload.row)
    if (!team || Number(payload.round) !== room.round || room.teams.get(pid) !== team || room.teamTurns[team] !== pid || room.teamStatus[team] !== 'playing' || room.teamFinals[team]?.active || row !== room.teamBoards[team].length) return
    let guess
    try { guess = Array.from(H.decode(String(payload.guess || ''))) } catch (e) { return }
    if (guess.length !== room.size) return
    const marks = H.score(guess, teamAnswerJamo(team))
    const won = marks.every((mark) => mark === 'correct')
    const needsFinalChance = !won && row + 1 >= room.teamMaxTries[team]
    const commit = {
      phase: 'team-commit', round: room.round, team, pid, row, guess: H.encode(guess), marks: encodeMarks(marks),
      status: won ? 'won' : 'playing', finishMs: won ? Date.now() - room.startedAt : null,
      nextPid: !won && !needsFinalChance ? nextTeamParticipant(team, pid, false, room.kind === 'spy' && row + 2 === room.teamMaxTries[team]) : null, finalChance: needsFinalChance,
    }
    Net.send('turn', commit); applyTeamCommit(commit)
  }
  function applyTeamCommit(payload) {
    if (!room || !isTeamMode() || room.over || payload.phase !== 'team-commit') return
    const team = payload.team === 'red' || payload.team === 'blue' ? payload.team : null
    const pid = String(payload.pid || ''); const row = Number(payload.row)
    const finalAlreadyStarted = Boolean(payload.finalChance && room.teamFinals[team]?.active)
    if (!team || Number(payload.round) !== room.round || room.teams.get(pid) !== team || !finalAlreadyStarted && room.teamTurns[team] !== pid || row !== room.teamBoards[team].length) return
    let guess
    try { guess = Array.from(H.decode(String(payload.guess || ''))) } catch (e) { return }
    const marks = decodeMarks(payload.marks)
    if (guess.length !== room.size || !marks) return
    const expected = H.score(guess, teamAnswerJamo(team))
    if (expected.some((mark, i) => mark !== marks[i])) return
    const status = payload.status === 'won' ? 'won' : 'playing'
    room.teamBoards[team].push({ pid, guess, marks }); room.teamTurns[team] = status === 'playing' ? String(payload.nextPid || '') : null
    if (status === 'won') { room.teamStatus[team] = 'won'; room.teamFinishMs[team] = Math.max(0, Number(payload.finishMs) || 0) }
    if (pid === room.me.pid) room.teamPending = false
    const mine = room.teams.get(room.me.pid) === team
    const after = () => {
      renderPeers(); renderBanner(); persistRoom()
      if (payload.finalChance && room.host) startTeamFinal(team)
      else if (status === 'won' && room.host) afterTeamTerminal(team)
      else scheduleTeamSkips()
      if (mine && status === 'won') showTeamWaiting()
    }
    if (mine) TW.applyRemote(() => TW.applyRoomTurn(guess, marks, status, after))
    else after()
  }
  function startTeamFinal(team) {
    if (!room?.host || room.over || room.teamFinals[team]?.active) return
    const payload = { phase: 'team-final-start', round: room.round, team, seconds: room.kind === 'spy' ? 0 : 30, unlimited: room.kind === 'spy', elapsedMs: 0, results: [] }
    Net.send('turn', payload); beginTeamFinal(payload)
  }
  function beginTeamFinal(payload) {
    if (!room || !isTeamMode() || room.over || Number(payload.round) !== room.round || !['red', 'blue'].includes(payload.team)) return
    const team = payload.team; const unlimited = Boolean(payload.unlimited) || room.kind === 'spy'; const seconds = unlimited ? 0 : Math.max(1, Math.min(60, Number(payload.seconds) || 30)); const elapsedMs = Math.max(0, Number(payload.elapsedMs) || 0)
    const results = new Map()
    for (const item of Array.isArray(payload.results) ? payload.results : []) {
      const pid = String(item?.pid || '')
      if (room.teams.get(pid) !== team || room.kind === 'spy' && Object.values(room.spies).includes(pid) || results.has(pid)) continue
      results.set(pid, { pid, status: item.status === 'won' ? 'won' : 'lost', ms: Math.max(0, Number(item.ms) || 0) })
    }
    room.teamTurns[team] = null
    room.teamFinals[team] = { active: true, unlimited, startedAt: Date.now() - elapsedMs, endsAt: unlimited ? null : Date.now() + seconds * 1000, submitted: new Set(results.keys()), results, localPending: false }
    clearTimeout(teamFinalTimers[team])
    if (room.host && !unlimited) teamFinalTimers[team] = setTimeout(() => finishTeamFinal(team), seconds * 1000)
    if (room.teams.get(room.me.pid) === team) {
      $('#keyboard').hidden = true
      if (room.kind === 'spy' && room.isSpy) { $('#finalChance').hidden = true; showTeamWaiting() } else renderFinalChance()
    }
    renderBanner(); persistRoom()
  }
  function renderTeamFinalChance() {
    const panel = $('#finalChance'); const team = room?.teams.get(room.me.pid); const state = team ? room.teamFinals[team] : null
    if (!panel || !state?.active || room.me.role !== 'player' || room.kind === 'spy' && room.isSpy) { if (panel) panel.hidden = true; return }
    const submitted = state.submitted.has(room.me.pid); const pending = state.localPending
    panel.hidden = false
    panel.innerHTML = `<strong>${TEAM_NAMES[team]} 마지막 기회${state.endsAt ? ` · <span id="finalCountdown">${Math.max(0, Math.ceil((state.endsAt - Date.now()) / 1000))}초</span>` : ''}</strong>
      <p>${room.kind === 'spy' ? '스파이를 제외한 팀원들이' : '팀원 모두'} 한 번씩 비공개로 제출해요. 팀 정답률이 승패를 결정합니다.</p>
      ${submitted || pending ? `<div class="hint ok">${submitted ? '제출 완료! 팀원의 결과를 기다리는 중…' : '정답을 확인하는 중…'}</div>` : `<div class="final-form"><input class="field" id="finalWord" autofocus placeholder="마지막 추측" maxlength="8" autocomplete="off" spellcheck="false"><button class="btn accent" id="finalSubmit" data-act="room-final-submit" disabled>제출</button></div><div class="hint" id="finalHint">한 번만 제출할 수 있어요</div>`}`
  }
  function submitTeamFinal() {
    const team = room?.teams.get(room.me.pid); const state = team ? room.teamFinals[team] : null
    if (!state?.active || room.kind === 'spy' && room.isSpy || state.submitted.has(room.me.pid) || state.localPending) return
    const value = finalWordValue(); const exact = value.jamo.join('') === teamAnswerJamo(team).join('')
    if (!value.validLength || !TW.isValid(value.jamo) && !exact) return paintFinalWord()
    state.localPending = true; renderFinalChance()
    const payload = { phase: 'team-final-submit', round: room.round, team, pid: room.me.pid, guess: H.encode(value.jamo) }
    if (room.host) processTeamFinalSubmit(payload)
    else Net.send('turn', payload)
  }
  function processTeamFinalSubmit(payload) {
    if (!room?.host || !isTeamMode() || room.over || payload.phase !== 'team-final-submit' || Number(payload.round) !== room.round || !['red', 'blue'].includes(payload.team)) return
    const team = payload.team; const state = room.teamFinals[team]; const pid = String(payload.pid || '')
    if (!state?.active || room.teams.get(pid) !== team || room.kind === 'spy' && Object.values(room.spies).includes(pid) || state.submitted.has(pid)) return
    let guess
    try { guess = Array.from(H.decode(String(payload.guess || ''))) } catch (e) { return }
    if (guess.length !== room.size) return
    const ack = { phase: 'team-final-ack', round: room.round, team, pid, status: guess.join('') === teamAnswerJamo(team).join('') ? 'won' : 'lost', ms: Math.max(0, Date.now() - state.startedAt) }
    Net.send('turn', ack); onTeamFinalAck(ack)
    if (teamFinalMembers(team).every((id) => state.submitted.has(id))) finishTeamFinal(team)
  }
  function onTeamFinalAck(payload) {
    const team = payload.team; const state = room?.teamFinals?.[team]; const pid = String(payload.pid || '')
    if (!state?.active || Number(payload.round) !== room.round || room.teams.get(pid) !== team || room.kind === 'spy' && Object.values(room.spies).includes(pid) || state.submitted.has(pid)) return
    state.results.set(pid, { pid, status: payload.status === 'won' ? 'won' : 'lost', ms: Math.max(0, Number(payload.ms) || 0) }); state.submitted.add(pid)
    if (pid === room.me.pid) state.localPending = false
    renderFinalChance(); persistRoom()
  }
  function finishTeamFinal(team) {
    if (!room?.host || room.over || !room.teamFinals[team]?.active) return
    const state = room.teamFinals[team]
    const members = teamFinalMembers(team)
    const results = members.map((pid) => state.results.get(pid) || { pid, status: 'timeout', ms: null })
    const winners = results.filter((result) => result.status === 'won').sort((a, b) => a.ms - b.ms || members.indexOf(a.pid) - members.indexOf(b.pid))
    const total = results.length; const correctCount = winners.length
    const payload = { phase: 'team-final-result', round: room.round, team, status: 'final', correctCount, total, accuracy: total ? correctCount / total : 0, finishMs: winners.length ? Math.max(0, state.startedAt - room.startedAt + winners[0].ms) : null, results }
    Net.send('turn', payload); applyTeamFinalResult(payload)
  }
  function applyTeamFinalResult(payload) {
    if (!room || !isTeamMode() || room.over || payload.phase !== 'team-final-result' || Number(payload.round) !== room.round || !['red', 'blue'].includes(payload.team)) return
    const team = payload.team; clearTimeout(teamFinalTimers[team])
    if (room.teamFinals[team]) room.teamFinals[team].active = false
    room.teamStatus[team] = 'final'; room.teamFinishMs[team] = payload.finishMs === null ? null : Math.max(0, Number(payload.finishMs) || 0)
    room.teamFinals[team] = { ...(room.teamFinals[team] || {}), active: false, finalResults: Array.isArray(payload.results) ? payload.results : [], correctCount: Math.max(0, Number(payload.correctCount) || 0), total: Math.max(0, Number(payload.total) || 0), accuracy: Math.max(0, Math.min(1, Number(payload.accuracy) || 0)) }
    if (room.teams.get(room.me.pid) === team) { $('#finalChance').hidden = true; showTeamWaiting() }
    renderPeers(); renderBanner(); persistRoom(); if (room.host) afterTeamTerminal(team)
  }
  function showTeamWaiting() {
    if (!room || !isTeamMode()) return
    room.me.role = 'finished'; document.body.classList.add('watching'); $('#keyboard').hidden = true; $('.board-wrap').hidden = true; $('#peers').hidden = false
    renderPeers(); renderBanner(); renderQuickChat()
  }
  function afterTeamTerminal(team) {
    if (!room?.host || room.over) return
    const other = team === 'red' ? 'blue' : 'red'
    if (room.teamStatus[other] !== 'playing') return finishTeamMatch()
    if (room.kind !== 'spy' && ['won', 'final'].includes(room.teamStatus[team]) && !room.teamDeadline) {
      const payload = { phase: 'team-deadline', round: room.round, team: other, seconds: 30 }
      Net.send('turn', payload); beginTeamDeadline(payload)
    }
  }
  function beginTeamDeadline(payload) {
    if (!room || !isTeamMode() || room.over || payload.phase !== 'team-deadline' || Number(payload.round) !== room.round) return
    room.teamDeadline = { team: payload.team, endsAt: Date.now() + Math.max(1, Number(payload.seconds) || 30) * 1000 }
    clearTimeout(teamEndTimer)
    if (room.host) teamEndTimer = setTimeout(forceTeamDeadline, Math.max(0, room.teamDeadline.endsAt - Date.now()))
    renderBanner()
  }
  function forceTeamDeadline() {
    if (!room?.host || room.over || !room.teamDeadline) return
    const team = room.teamDeadline.team
    if (room.teamStatus[team] === 'playing') {
      const payload = { phase: 'team-force', round: room.round, team }
      Net.send('turn', payload); applyTeamForce(payload)
    } else finishTeamMatch()
  }
  function applyTeamForce(payload) {
    if (!room || !isTeamMode() || room.over || payload.phase !== 'team-force' || Number(payload.round) !== room.round || !['red', 'blue'].includes(payload.team)) return
    room.teamStatus[payload.team] = 'lost'; room.teamTurns[payload.team] = null
    if (room.teamFinals[payload.team]) room.teamFinals[payload.team].active = false
    if (room.teams.get(room.me.pid) === payload.team) showTeamWaiting()
    if (room.host) finishTeamMatch()
  }
  function finishTeamMatch() {
    if (!room?.host || room.over) return
    const results = ['red', 'blue'].map((team) => {
      const final = room.teamFinals[team]
      return { team, status: ['won', 'final'].includes(room.teamStatus[team]) ? room.teamStatus[team] : 'lost', ms: room.teamFinishMs[team], tries: room.teamBoards[team].length, finalResults: final?.finalResults || [], correctCount: final?.correctCount || 0, total: final?.total || teamFinalMembers(team).length, accuracy: final?.accuracy || 0 }
    })
    const winner = decideTeamWinner(results)
    const teamWords = room.teamAnswers || { red: room.answer, blue: room.answer }
    const payload = { round: room.round, team: true, winner, answer: H.encode(H.decompose(teamWords.red)), word: teamWords.red, teamWords, results }
    Net.send('over', payload); TW.applyRemote(() => showTeamResult(payload))
  }
  function decideTeamWinner(results) {
    const [red, blue] = results
    const strength = (result) => result.status === 'won' ? 3 : result.status === 'final' && result.accuracy > 0 ? 2 : 0
    const redStrength = strength(red); const blueStrength = strength(blue)
    if (redStrength !== blueStrength) return redStrength > blueStrength ? red.team : blue.team
    if (!redStrength) return null
    if (red.status === 'final' && blue.status === 'final' && red.accuracy !== blue.accuracy) return red.accuracy > blue.accuracy ? red.team : blue.team
    const redMs = red.ms ?? Infinity; const blueMs = blue.ms ?? Infinity
    return redMs === blueMs ? null : redMs < blueMs ? red.team : blue.team
  }
  function startFinalChance() {
    if (!room?.host || room.over || room.finalChance?.active) return
    const payload = { phase: 'final-start', round: room.round, seconds: 30, elapsedMs: 0, results: [] }
    Net.send('turn', payload); beginFinalChance(payload)
  }
  function beginFinalChance(payload) {
    if (!room || room.kind !== 'coop' || room.over || Number(payload.round) !== room.round) return
    const seconds = Math.max(1, Math.min(60, Number(payload.seconds) || 30))
    const elapsedMs = Math.max(0, Number(payload.elapsedMs) || 0)
    const results = new Map()
    for (const item of Array.isArray(payload.results) ? payload.results : []) {
      const pid = String(item?.pid || '')
      if (!room.activePids.has(pid) || results.has(pid)) continue
      results.set(pid, { pid, status: item.status === 'won' ? 'won' : 'lost', ms: Math.max(0, Number(item.ms) || 0) })
    }
    for (const pid of Array.isArray(payload.submitted) ? payload.submitted.map(String) : []) {
      if (room.activePids.has(pid) && !results.has(pid)) results.set(pid, { pid, status: 'lost', ms: elapsedMs })
    }
    room.turnPid = null; room.coopPending = false
    room.finalChance = {
      active: true, startedAt: Date.now() - elapsedMs, endsAt: Date.now() + seconds * 1000,
      submitted: new Set(results.keys()), results,
      localPending: false,
    }
    $('#keyboard').hidden = true; $('#finalChance').hidden = room.me.role !== 'player'
    clearTimeout(finalTimer)
    if (room.host) finalTimer = setTimeout(finishFinalChance, seconds * 1000)
    renderFinalChance(); renderBanner(); persistRoom()
  }
  function renderFinalChance() {
    if (isTeamMode()) return renderTeamFinalChance()
    const panel = $('#finalChance')
    if (!panel || !room?.finalChance?.active || room.me.role !== 'player') { if (panel) panel.hidden = true; return }
    const submitted = room.finalChance.submitted.has(room.me.pid)
    const pending = room.finalChance.localPending
    panel.hidden = false
    panel.innerHTML = `<strong>마지막 기회 · <span id="finalCountdown">${Math.max(0, Math.ceil((room.finalChance.endsAt - Date.now()) / 1000))}초</span></strong>
      <p>각자 한 번만 제출할 수 있어요. 모두 제출한 뒤 정답자 순위를 알려드려요.</p>
      ${submitted || pending ? `<div class="hint ok">${submitted ? '제출 완료! 다른 참가자의 결과를 기다리는 중…' : '정답을 확인하는 중…'}</div>` : `<div class="final-form"><input class="field" id="finalWord" autofocus placeholder="마지막 추측" maxlength="8" autocomplete="off" spellcheck="false"><button class="btn accent" id="finalSubmit" data-act="room-final-submit" disabled>제출</button></div><div class="hint" id="finalHint">한 번만 제출할 수 있어요</div>`}`
  }
  function finalWordValue() {
    const raw = String($('#finalWord')?.value || '').trim()
    const decomposed = H.decompose(raw); const jamo = decomposed ? Array.from(decomposed) : []
    return { raw, jamo, validLength: Boolean(raw && decomposed && jamo.length === room?.size) }
  }
  function paintFinalWord() {
    const hint = $('#finalHint'); const button = $('#finalSubmit')
    if (!hint || !button) return
    const value = finalWordValue(); const exact = value.jamo.join('') === TW.state?.answerJamo?.join('')
    button.disabled = !value.validLength || !TW.isValid(value.jamo) && !exact
    if (!value.raw) { hint.textContent = '한 번만 제출할 수 있어요'; hint.className = 'hint'; return }
    if (!value.validLength) { hint.textContent = `자모 ${room.size}칸에 맞는 한글 단어를 입력해 주세요`; hint.className = 'hint bad'; return }
    if (!TW.isValid(value.jamo) && !exact) { hint.textContent = '사전에 없는 단어예요'; hint.className = 'hint bad'; return }
    hint.textContent = '제출할 수 있어요'; hint.className = 'hint ok'
  }
  function submitFinalWord() {
    if (isTeamMode()) return submitTeamFinal()
    if (!room?.finalChance?.active || room.finalChance.submitted.has(room.me.pid) || room.finalChance.localPending) return
    const value = finalWordValue(); const exact = value.jamo.join('') === TW.state?.answerJamo?.join('')
    if (!value.validLength || !TW.isValid(value.jamo) && !exact) return paintFinalWord()
    room.finalChance.localPending = true; renderFinalChance()
    const payload = { phase: 'final-submit', round: room.round, pid: room.me.pid, guess: H.encode(value.jamo) }
    if (room.host) processFinalSubmit(payload)
    else Net.send('turn', payload)
  }
  function processFinalSubmit(payload) {
    if (!room?.host || !room.finalChance?.active || payload.phase !== 'final-submit' || Number(payload.round) !== room.round) return
    const pid = String(payload.pid)
    if (!room.activePids.has(pid) || room.finalChance.submitted.has(pid)) return
    let guess
    try { guess = Array.from(H.decode(String(payload.guess || ''))) } catch (e) { return }
    if (guess.length !== room.size) return
    const ack = {
      phase: 'final-ack', round: room.round, pid,
      status: guess.join('') === TW.state.answerJamo.join('') ? 'won' : 'lost',
      ms: Math.max(0, Date.now() - room.finalChance.startedAt),
    }
    Net.send('turn', ack); onFinalAck(ack)
    if (Array.from(room.activePids).every((id) => room.finalChance.submitted.has(id))) finishFinalChance()
  }
  function onFinalAck(payload) {
    if (!room?.finalChance?.active || Number(payload.round) !== room.round) return
    const pid = String(payload.pid)
    if (!room.activePids.has(pid) || room.finalChance.submitted.has(pid)) return
    room.finalChance.results.set(pid, { pid, status: payload.status === 'won' ? 'won' : 'lost', ms: Math.max(0, Number(payload.ms) || 0) })
    room.finalChance.submitted.add(pid)
    if (pid === room.me.pid) room.finalChance.localPending = false
    renderFinalChance(); persistRoom()
  }
  function onTurn(payload) {
    if (!room || !room.startedAt || room.over) return
    if (isTeamMode()) {
      if (payload.phase === 'team-submit') return TW.applyRemote(() => processTeamSubmit(payload))
      if (payload.phase === 'team-commit') return applyTeamCommit(payload)
      if (payload.phase === 'team-final-start') return TW.applyRemote(() => beginTeamFinal(payload))
      if (payload.phase === 'team-final-submit') return TW.applyRemote(() => processTeamFinalSubmit(payload))
      if (payload.phase === 'team-final-ack') return onTeamFinalAck(payload)
      if (payload.phase === 'team-final-result') return applyTeamFinalResult(payload)
      if (payload.phase === 'team-deadline') return beginTeamDeadline(payload)
      if (payload.phase === 'team-force') return applyTeamForce(payload)
      if (payload.phase === 'team-skip') {
        const team = payload.team
        if (!['red', 'blue'].includes(team) || String(payload.pid) !== room.teamTurns[team]) return
        room.teamTurns[team] = String(payload.nextPid || ''); room.teamPending = false; renderBanner(); scheduleTeamSkips(); return
      }
      return
    }
    if (room.kind !== 'coop') return
    if (payload.phase === 'final-start') return TW.applyRemote(() => beginFinalChance(payload))
    if (payload.phase === 'final-submit') return TW.applyRemote(() => processFinalSubmit(payload))
    if (payload.phase === 'final-ack') return onFinalAck(payload)
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
  function scheduleTeamSkips() {
    if (!room?.host || !isTeamMode() || room.over) return
    for (const team of ['red', 'blue']) {
      clearTimeout(teamSkipTimers[team]); teamSkipTimers[team] = null
      const turnPid = room.teamTurns[team]
      if (room.teamStatus[team] !== 'playing' || !turnPid || room.teamFinals[team]?.active || room.peers.get(turnPid)?.online) continue
      teamSkipTimers[team] = setTimeout(() => {
        if (!room?.host || room.over || room.teamTurns[team] !== turnPid || room.peers.get(turnPid)?.online) return
        const nextPid = nextTeamParticipant(team, turnPid, true)
        if (!nextPid) return
        const payload = { phase: 'team-skip', round: room.round, team, pid: turnPid, nextPid }
        Net.send('turn', payload); room.teamTurns[team] = nextPid; renderBanner(); persistRoom()
      }, 15000)
    }
  }
  function maybeFinish() {
    if (!room?.host || room.over || !room.activePids.size) return
    if (Array.from(room.activePids).every((pid) => room.results.has(pid))) finishRound()
  }
  function forceRound() {
    if (!room?.host || room.over) return
    if (room.kind === 'coop') return room.finalChance?.active ? finishFinalChance() : finishCoop('lost', TW.state?.guesses.length || 0)
    if (isTeamMode()) {
      for (const team of ['red', 'blue']) if (room.teamStatus[team] === 'playing') { room.teamStatus[team] = 'lost'; room.teamTurns[team] = null }
      return finishTeamMatch()
    }
    const ms = Date.now() - room.startedAt
    for (const pid of room.activePids) if (!room.results.has(pid)) room.results.set(pid, { pid, status: 'lost', tries: TW.MAX_TRIES, ms })
    finishRound()
  }
  function finishRound() {
    if (!room || room.over) return
    room.over = true; clearTimeout(waitTimer); room.waitEndsAt = null
    const scores = Array.from(room.results.values())
    if (room.kind === 'captain') {
      const ranked = sortedResults(scores)
      const dropCount = Math.min(room.eliminateCount, Math.max(0, ranked.length - 1))
      const eliminated = ranked.slice(ranked.length - dropCount).map((result) => result.pid)
      room.captainEliminated = eliminated
      room.captainAlive = ranked.filter((result) => !eliminated.includes(result.pid)).map((result) => result.pid)
      room.captainChampion = room.captainAlive.length === 1 ? room.captainAlive[0] : null
      const payload = { round: room.round, scores, totals: {}, final: Boolean(room.captainChampion), captain: true, eliminated, alive: room.captainAlive, champion: room.captainChampion, eliminateCount: room.eliminateCount }
      Net.send('over', payload); TW.applyRemote(() => showScoreboard(scores, payload.final, payload)); return
    }
    if (room.kind === 'relay') {
      const points = Net.awardPoints(scores)
      for (const [pid, point] of Object.entries(points)) room.totals.set(pid, (Number(room.totals.get(pid)) || 0) + point)
    }
    const payload = { round: room.round, scores, totals: totalsObject(), final: room.kind !== 'relay' || room.round >= room.roundsTotal }
    Net.send('over', payload); TW.applyRemote(() => showScoreboard(scores, payload.final, payload))
  }
  function finishFinalChance() {
    if (!room?.host || room.over || !room.finalChance?.active) return
    const byPid = room.finalChance.results
    const finalResults = room.participants.filter((pid) => room.activePids.has(pid)).map((pid) => byPid.get(pid) || { pid, status: 'timeout', ms: null })
    const winners = finalResults.filter((result) => result.status === 'won').sort((a, b) => a.ms - b.ms || room.participants.indexOf(a.pid) - room.participants.indexOf(b.pid))
    finishCoop(winners.length ? 'won' : 'lost', room.maxTries, winners[0]?.pid || null, true, finalResults)
  }
  function finishCoop(status, tries, winnerPid = null, fromFinalChance = false, finalResults = []) {
    if (!room?.host || room.over) return
    room.over = true; clearTimeout(finalTimer)
    if (room.finalChance) room.finalChance.active = false
    const payload = {
      round: room.round, coop: true, status: status === 'won' ? 'won' : 'lost', tries: Math.max(0, Number(tries) || 0),
      answer: H.encode(H.decompose(room.answer)), word: room.answer, winnerPid: winnerPid ? String(winnerPid) : null, finalChance: Boolean(fromFinalChance),
      finalResults: Array.isArray(finalResults) ? finalResults.map((result) => ({ pid: String(result.pid), status: ['won', 'lost', 'timeout'].includes(result.status) ? result.status : 'lost', ms: result.ms === null ? null : Math.max(0, Number(result.ms) || 0) })) : [],
    }
    Net.send('over', payload); TW.applyRemote(() => showCoopResult(payload))
  }
  function onOver(payload) {
    if (!room || Number(payload.round) !== room.round) return
    if (isTeamMode() || payload.team) return TW.applyRemote(() => showTeamResult(payload))
    if (room.kind === 'coop' || payload.coop) return TW.applyRemote(() => showCoopResult(payload))
    if (!Array.isArray(payload.scores)) return
    room.totals = new Map(Object.entries(payload.totals || {}))
    TW.applyRemote(() => showScoreboard(payload.scores, Boolean(payload.final), payload))
  }
  function sortedResults(results) {
    return results.slice().sort((a, b) => a.status === 'won' && b.status !== 'won' ? -1 : a.status !== 'won' && b.status === 'won' ? 1 : (a.ms || Infinity) - (b.ms || Infinity) || (a.tries || 99) - (b.tries || 99))
  }
  function showScoreboard(results, final, meta = {}) {
    if (!room) return
    clearInterval(timer); clearTimeout(nextTimer); clearTimeout(waitTimer)
    room.over = true; room.final = Boolean(final); room.scoreResults = sortedResults(results); room.resultSheet = 'scoreboard'
    if (room.kind === 'captain' || meta.captain) {
      room.captainEliminated = Array.isArray(meta.eliminated) ? meta.eliminated.map(String) : []
      room.captainAlive = Array.isArray(meta.alive) ? meta.alive.map(String) : room.captainAlive
      room.captainChampion = meta.champion ? String(meta.champion) : null
    }
    room.waitEndsAt = null; $('#quickChat').hidden = true
    TW.endRoomGame(); renderBanner(); persistRoom(); TW.openSheet('scoreboard')
    if (room.kind === 'relay' && !room.final && room.host) nextTimer = setTimeout(nextRound, 10000)
  }
  function showCoopResult(payload) {
    if (!room) return
    clearInterval(timer); clearTimeout(skipTimer); clearTimeout(waitTimer); clearTimeout(finalTimer)
    const seen = new Set()
    const finalResults = (Array.isArray(payload.finalResults) ? payload.finalResults : []).flatMap((result) => {
      const pid = String(result?.pid || '')
      if (!pid || seen.has(pid)) return []
      seen.add(pid)
      return [{ pid, status: ['won', 'lost', 'timeout'].includes(result.status) ? result.status : 'lost', ms: result.ms === null ? null : Math.max(0, Number(result.ms) || 0) }]
    })
    room.over = true; room.resultSheet = 'scoreboard'; room.coopResult = { status: payload.status === 'won' ? 'won' : 'lost', tries: Math.max(0, Number(payload.tries) || 0), winnerPid: payload.winnerPid ? String(payload.winnerPid) : null, finalChance: Boolean(payload.finalChance), finalResults }
    if (room.finalChance) room.finalChance.active = false
    room.turnPid = null; room.coopPending = false; $('#quickChat').hidden = true; $('#finalChance').hidden = true
    TW.endRoomGame(); renderBanner(); persistRoom(); TW.openSheet('scoreboard')
  }
  function showTeamResult(payload) {
    if (!room || !Array.isArray(payload.results)) return
    clearInterval(timer); clearTimeout(teamEndTimer)
    for (const team of ['red', 'blue']) { clearTimeout(teamFinalTimers[team]); clearTimeout(teamSkipTimers[team]) }
    const seen = new Set()
    const results = payload.results.flatMap((result) => {
      const team = result?.team
      if (!['red', 'blue'].includes(team) || seen.has(team)) return []
      seen.add(team)
      return [{ team, status: ['won', 'final'].includes(result.status) ? result.status : 'lost', ms: result.ms === null ? null : Math.max(0, Number(result.ms) || 0), tries: Math.max(0, Number(result.tries) || 0), finalResults: Array.isArray(result.finalResults) ? result.finalResults : [], correctCount: Math.max(0, Number(result.correctCount) || 0), total: Math.max(0, Number(result.total) || teamMembers(team).length), accuracy: Math.max(0, Math.min(1, Number(result.accuracy) || 0)) }]
    })
    if (results.length !== 2) return
    const declaredWinner = ['red', 'blue'].includes(payload.winner) ? payload.winner : decideTeamWinner(results)
    results.sort((a, b) => a.team === declaredWinner ? -1 : b.team === declaredWinner ? 1 : a.team.localeCompare(b.team))
    const fallback = decodeWireWord(payload) || room.answer
    room.teamAnswers = { red: H.decompose(String(payload.teamWords?.red || '')) ? String(payload.teamWords.red) : fallback, blue: H.decompose(String(payload.teamWords?.blue || '')) ? String(payload.teamWords.blue) : fallback }
    room.answer = room.teamAnswers[room.teams.get(room.me.pid)] || room.teamAnswers.red; room.over = true; room.resultSheet = 'scoreboard'; room.teamResult = results; room.teamWinner = declaredWinner
    room.teamDeadline = null; room.teamPending = false; $('#quickChat').hidden = true; $('#finalChance').hidden = true
    TW.endRoomGame(); renderBanner(); persistRoom(); TW.openSheet('scoreboard')
  }

  TW.SHEETS.scoreboard = () => {
    if (!room) return '<h2>결과를 찾지 못했어요</h2>'
    if (isTeamMode()) {
      const results = room.teamResult || []
      const winner = room.teamWinner
      const myTeam = room.teams.get(room.me.pid)
      const personalWin = winner && (room.isSpy ? winner !== myTeam : winner === myTeam)
      const personalTitle = room.kind === 'spy' ? personalWin ? room.isSpy ? '스파이 개인 승리!' : '팀원 승리!' : winner ? room.isSpy ? '스파이 작전 실패' : '이번에는 패배했어요' : '무승부' : winner ? `${TEAM_NAMES[winner]} 승리!` : '무승부'
      return `<h2>${personalTitle}</h2>
        <div class="answer-reveal"><b>${room.kind === 'teamsetter' ? `빨강팀 문제 ${esc(room.teamAnswers?.red || '')} · 파랑팀 문제 ${esc(room.teamAnswers?.blue || '')}` : esc(room.answer || '')}</b><span>${MODES[room.kind]} · ${room.size}칸${winner ? ` · ${TEAM_NAMES[winner]} 승리` : ''}</span></div>
        <ol class="score-list team-score">${results.map((result, index) => {
          const members = teamMembers(result.team).map((pid) => playerName(pid)).join(', ')
          const spy = room.kind === 'spy' ? room.spies[result.team] : null
          const roster = `${members}${spy ? ` · 스파이: ${playerName(spy)}` : ''}`
          const outcome = result.status === 'won' ? `정규 ${result.tries}번째 성공 · ${(result.ms / 1000).toFixed(1)}초` : result.status === 'final' ? `마지막 기회 ${result.correctCount}/${result.total}명 · 정답률 ${Math.round(result.accuracy * 100)}%` : '정답자 없음'
          return `<li class="${result.team}"><strong>${winner === result.team ? '1' : winner ? '2' : '—'}</strong><b>${TEAM_NAMES[result.team]}<small>${esc(roster)}</small></b><span>${outcome}</span></li>`
        }).join('')}</ol>${room.kind === 'spy' ? `<p class="muted spy-reveal">${room.isSpy ? `내가 들어간 ${TEAM_NAMES[myTeam]}이 ${winner === myTeam ? '이겨서 작전 실패' : winner ? '져서 작전 성공' : '비겨서 작전 실패'}했어요.` : '게임 종료 후 양 팀의 스파이를 공개했어요.'}</p>` : ''}<div class="sheet-actions">${rematchControls()}<button class="btn accent" data-act="room-copy-result">결과 복사하기</button><button class="btn ghost" data-go="leave">나가기</button></div>`
    }
    if (room.kind === 'coop') {
      const won = room.coopResult?.status === 'won'
      const winner = room.coopResult?.winnerPid ? playerName(room.coopResult.winnerPid) : null
      const finalResults = (room.coopResult?.finalResults || []).slice().sort((a, b) => a.status === 'won' && b.status !== 'won' ? -1 : a.status !== 'won' && b.status === 'won' ? 1 : a.status === 'won' ? a.ms - b.ms : room.participants.indexOf(a.pid) - room.participants.indexOf(b.pid))
      const winnerCount = finalResults.filter((result) => result.status === 'won').length
      const soloWin = finalResults.length === 1 && winnerCount === 1
      const title = soloWin ? '마지막 기회 성공!' : winner ? `${esc(winner)}님 1위!` : won ? '함께 맞혔어요!' : '이번에는 아쉬워요'
      const detail = room.coopResult?.finalChance ? `정규 ${room.maxTries}회 실패 후 마지막 기회 · ${winnerCount}/${finalResults.length}명 정답` : soloWin ? '마지막 기회에서 정답을 맞혔어요' : winner ? `정답자 ${winnerCount}명 · 빠른 순서` : won ? `${room.coopResult.tries}/${room.maxTries}번 만에 성공` : `정답 · ${room.size}칸`
      let rank = 0
      const ranking = room.coopResult?.finalChance ? `<ol class="score-list">${finalResults.map((result) => {
        const place = result.status === 'won' ? ++rank : '—'
        const outcome = result.status === 'won' ? `${(result.ms / 1000).toFixed(1)}초` : result.status === 'timeout' ? '미제출' : '오답'
        return `<li><strong>${place}</strong><b>${esc(playerName(result.pid))}${result.pid === room.me.pid ? ' (나)' : ''}</b><span>${outcome}</span></li>`
      }).join('')}</ol>` : ''
      return `<h2>${title}</h2><div class="answer-reveal"><b>${esc(room.answer || '')}</b><span>${detail}</span></div>${ranking}<div class="sheet-actions">${rematchControls()}<button class="btn ghost" data-go="leave">나가기</button></div>`
    }
    if (room.kind === 'captain') {
      const names = displayNames(); const champion = room.captainChampion
      const hostEliminated = room.host && room.captainEliminated.includes(room.me.pid)
      const title = champion ? `${esc(playerName(champion))}님이 최후의 대장!` : hostEliminated ? '탈락했지만 방장으로 남아있어요' : `${room.round}판 종료 · ${room.captainAlive.length}명 생존`
      return `<h2>${title}</h2>${hostEliminated && !champion ? '<p class="muted">방을 나가지 않았어요. 다음 판을 시작하고 끝까지 관전할 수 있습니다.</p>' : ''}<div class="answer-reveal"><b>${esc(room.answer || '')}</b><span>${room.captainEliminated.length ? `이번 판 탈락: ${room.captainEliminated.map((pid) => esc(playerName(pid))).join(', ')}` : '탈락자 없음'}</span></div>
        <ol class="score-list">${room.scoreResults.map((r, i) => `<li class="${room.captainEliminated.includes(r.pid) ? 'eliminated' : ''}"><strong>${i + 1}</strong><b>${esc(names.get(r.pid) || '나간 참가자')}${room.captainEliminated.includes(r.pid) ? ' · 탈락' : ' · 생존'}</b><span>${r.status === 'won' ? `${(r.ms / 1000).toFixed(1)}초 · ${r.tries}/${TW.MAX_TRIES}` : `X/${TW.MAX_TRIES}`}</span></li>`).join('')}</ol>
        <div class="sheet-actions">${champion ? rematchControls() : room.host ? '<button class="btn primary" data-act="room-next">생존자 다음 판</button>' : '<p class="muted">방장이 다음 판을 시작하기를 기다리는 중…</p>'}<button class="btn ghost" data-go="leave">나가기</button></div>`
    }
    const names = displayNames(); const relay = room.kind === 'relay'
    return `<h2>${relay ? `${room.round}/${room.roundsTotal} 라운드 결과` : '대결 결과'}</h2>
      <div class="answer-reveal"><b>${esc(room.answer || '')}</b><span>${room.size}칸</span></div>
      <ol class="score-list">${room.scoreResults.map((r, i) => `<li><strong>${i + 1}</strong><b>${esc(names.get(r.pid) || '나간 참가자')}</b><span>${r.status === 'won' ? `${(r.ms / 1000).toFixed(1)}초 · ${r.tries}/${TW.MAX_TRIES}` : `X/${TW.MAX_TRIES}`}</span></li>`).join('')}</ol>
      <div class="sheet-actions">${relay && room.final ? '<button class="btn primary" data-act="room-standings">최종 순위 보기</button>' : relay && room.host ? '<button class="btn primary" data-act="room-next">다음 라운드</button>' : relay ? '<p class="muted">방장이 다음 라운드를 시작하기를 기다리는 중…</p>' : rematchControls()}<button class="btn accent" data-act="room-copy-result">결과 복사하기</button><button class="btn ghost" data-go="leave">나가기</button></div>`
  }
  TW.SHEETS.standings = () => {
    if (!room) return '<h2>순위를 찾지 못했어요</h2>'
    const names = displayNames()
    const list = Array.from(room.totals, ([pid, points]) => ({ pid, points: Number(points) || 0 })).sort((a, b) => b.points - a.points || (names.get(a.pid) || '').localeCompare(names.get(b.pid) || ''))
    return `<h2>최종 순위</h2><ol class="score-list">${list.map((e, i) => `<li><strong>${i + 1}</strong><b>${esc(names.get(e.pid) || '나간 참가자')}</b><span>${e.points}점</span></li>`).join('')}</ol><div class="sheet-actions">${rematchControls()}<button class="btn ghost" data-go="leave">나가기</button></div>`
  }
  function showStandings() { if (room) { room.resultSheet = 'standings'; TW.openSheet('standings') } }
  function nextRound() {
    if (!room?.host || room.kind !== 'relay' && room.kind !== 'captain' || room.kind === 'relay' && room.round >= room.roundsTotal || room.kind === 'captain' && room.captainChampion) return
    clearTimeout(nextTimer); room.round++; room.startedAt = null; room.over = false; TW.closeSheet(); startRound()
  }
  function rematchControls() {
    const voters = new Set(room?.readyVoters?.size ? room.readyVoters : onlinePlayers().map((p) => p.pid))
    // 결과를 보고 있는 본인은 Presence 명단 갱신이 잠깐 늦어도 다시 하기에 참여할 수 있어야 한다.
    if (room?.over && room.me?.pid) voters.add(room.me.pid)
    const ready = Array.from(room?.readyPids || []).filter((pid) => voters.has(pid)).length
    const total = voters.size
    const mine = room?.readyPids?.has(room.me.pid)
    if (!total || !voters.has(room.me.pid)) return `<p class="muted">다시 하기 준비 ${ready}/${total}</p>`
    return `<p class="muted">다시 하기 준비 <b>${ready}/${total}</b></p><button class="btn primary" data-act="room-again" ${mine ? 'disabled' : ''}>${mine ? `기다리는 중… (${ready}/${total})` : `한 번 더!! (${ready}/${total})`}</button>`
  }
  function requestRematch() {
    if (!room?.over || room.readyPids.has(room.me.pid)) return
    const payload = { phase: 'request', round: room.round, pid: room.me.pid }
    if (room.host) processReady(payload)
    else Net.send('ready', payload)
  }
  function processReady(payload) {
    if (!room?.host || !room.over || payload.phase !== 'request' || Number(payload.round) !== room.round) return
    const pid = String(payload.pid || '')
    const peer = room.peers.get(pid)
    if (!peer && !room.activePids.has(pid) && pid !== room.setterPid) return
    // 준비 요청을 방장이 방금 받았다는 사실 자체가 이 참가자가 연결되어 있다는 증거다.
    if (peer) peer.online = true
    room.readyPids.add(pid); publishReadyState(pid)
  }
  function publishReadyState(connectedPid = null) {
    if (!room?.host || !room.over) return
    const voters = onlinePlayers().map((p) => p.pid)
    if (connectedPid && !voters.includes(connectedPid)) voters.push(connectedPid)
    room.readyPids = new Set(Array.from(room.readyPids).filter((pid) => voters.includes(pid)))
    const payload = { phase: 'state', round: room.round, ready: Array.from(room.readyPids), voters }
    Net.send('ready', payload); applyReadyState(payload)
    if (voters.length && voters.every((pid) => room.readyPids.has(pid))) {
      const lobby = { phase: 'lobby', round: room.round }
      Net.send('ready', lobby); returnToLobby(lobby)
    }
  }
  function applyReadyState(payload) {
    if (!room?.over || payload.phase !== 'state' || Number(payload.round) !== room.round) return
    room.readyPids = new Set(Array.isArray(payload.ready) ? payload.ready.map(String) : [])
    room.readyVoters = new Set(Array.isArray(payload.voters) ? payload.voters.map(String) : [])
    TW.openSheet(room.resultSheet || 'scoreboard')
  }
  function returnToLobby(payload) {
    if (!room || !room.over || payload.phase !== 'lobby' || Number(payload.round) !== room.round) return
    clearTimeout(nextTimer); clearTimeout(waitTimer); clearTimeout(finalTimer); clearTimeout(skipTimer); clearTimeout(teamEndTimer)
    for (const team of ['red', 'blue']) { clearTimeout(teamFinalTimers[team]); clearTimeout(teamSkipTimers[team]); teamFinalTimers[team] = teamSkipTimers[team] = null }
    room.round = 1; room.totals = new Map(); room.startedAt = null; room.answer = null; room.over = false; room.final = false
    room.results = new Map(); room.scoreResults = []; room.coopResult = null; room.finalChance = null; room.readyPids = new Set(); room.readyVoters = new Set()
    room.teamBoards = { red: [], blue: [] }; room.teamTurns = { red: null, blue: null }; room.teamStatus = { red: 'waiting', blue: 'waiting' }; room.teamFinishMs = { red: null, blue: null }; room.teamFinals = { red: null, blue: null }; room.teamDeadline = null; room.teamResult = null; room.teamWinner = null; room.teamPending = false; room.spies = { red: null, blue: null }; room.isSpy = false
    room.teamAnswers = null; room.teamPicks = null; room.captainAlive = []; room.captainEliminated = []; room.captainChampion = null
    room.participants = []; room.activePids = new Set(); room.turnPid = null; room.pick = null; room.me.role = 'player'
    document.body.classList.remove('watching'); showLobby(); persistRoom(); broadcastLobby()
  }
  function onReady(payload) {
    if (!room) return
    if (payload.phase === 'request') return processReady(payload)
    if (payload.phase === 'state') return applyReadyState(payload)
    if (payload.phase === 'lobby') return returnToLobby(payload)
  }
  function copyResult() {
    if (!room) return
    if (isTeamMode()) {
      const rows = (room.teamResult || []).map((result) => `${room.teamWinner === result.team ? '1.' : room.teamWinner ? '2.' : '—'} ${TEAM_NAMES[result.team]} · ${result.status === 'won' ? `정규 ${result.tries}번째 · ${(result.ms / 1000).toFixed(1)}초` : result.status === 'final' ? `마지막 기회 ${result.correctCount}/${result.total}명 · ${Math.round(result.accuracy * 100)}%` : '정답자 없음'}`)
      return TW.copyAndTell([`오늘의 단어 ${MODES[room.kind]} · ${room.size}칸`, `정답 ${room.answer}`, ...rows, inviteText()].join('\n'), `${MODES[room.kind]} 결과를 복사했어요`)
    }
    if (room.kind === 'coop') {
      const winnerCount = (room.coopResult?.finalResults || []).filter((result) => result.status === 'won').length
      const score = room.coopResult?.finalChance ? `정규 ${room.maxTries}회 실패 후 마지막 기회 ${winnerCount}/${room.coopResult.finalResults.length}명 정답` : room.coopResult?.status === 'won' ? `${room.coopResult.tries}/${room.maxTries}` : `X/${room.maxTries}`
      const finalRanks = (room.coopResult?.finalResults || []).filter((result) => result.status === 'won').sort((a, b) => a.ms - b.ms).map((result, i) => `${i + 1}. ${playerName(result.pid)} · ${(result.ms / 1000).toFixed(1)}초`)
      return TW.copyAndTell([`오늘의 단어 협동 · ${room.size}칸 · ${score}`, ...finalRanks, `정답 ${room.answer}`, inviteText()].filter(Boolean).join('\n'), '협동 결과를 복사했어요')
    }
    const rows = room.scoreResults.map((r, i) => `${i + 1}. ${room.peers.get(r.pid)?.nick || '나간 참가자'} · ${r.status === 'won' ? `${(r.ms / 1000).toFixed(1)}초 · ${r.tries}/${TW.MAX_TRIES}` : `X/${TW.MAX_TRIES}`}`)
    TW.copyAndTell([`오늘의 단어 ${MODES[room.kind]} · ${room.size}칸`, `정답 ${room.answer}`, ...rows, inviteText()].join('\n'), '대결 결과를 복사했어요')
  }
  function guessLabel(guess) {
    if (!Array.isArray(guess) || guess.length !== room?.size) return ''
    const encoded = H.encode(guess)
    return W?.answers?.[room.size]?.find((word) => H.encode(H.decompose(word)) === encoded) || H.compose(guess) || guess.join('')
  }
  function miniRows(rows, maxTries, revealWords) {
    return Array.from({ length: maxTries }, (_, row) => {
      const entry = rows?.[row]
      const marks = Array.isArray(entry) ? entry : entry?.marks || []
      const guess = Array.isArray(entry) ? null : entry?.guess
      const tiles = `<div class="mini-row" style="--cols:${room.size}">${Array.from({ length: room.size }, (_, col) => `<i class="mini-tile ${marks[col] || ''}"></i>`).join('')}</div>`
      return revealWords && guess ? `<div class="mini-line">${tiles}<span>${esc(guessLabel(guess))}</span></div>` : tiles
    }).join('')
  }
  function renderPeers() {
    const peers = $('#peers')
    if (!peers || !room || !room.startedAt || room.kind === 'coop') return
    if (isTeamMode()) {
      const mine = room.teams.get(room.me.pid)
      const teams = mine ? [mine === 'red' ? 'blue' : 'red'] : ['red', 'blue']
      const revealWords = room.me.role !== 'player'
      peers.innerHTML = teams.map((team) => {
        const members = teamMembers(team).map((pid) => playerName(pid)).join(', ')
        const done = room.teamStatus[team] !== 'playing'
        return `<div class="peer team-peer ${team} ${done ? 'done' : ''}" data-team-board="${team}"><b>${TEAM_NAMES[team]}${done ? ' · 완료' : ''}</b><small>${esc(members)}</small><div class="mini">${miniRows(room.teamBoards[team], room.teamMaxTries[team], revealWords)}</div></div>`
      }).join('')
      peers.hidden = false
      return
    }
    const list = orderedPlayers().filter((p) => (room.activePids.has(p.pid) || p.status === 'playing') && (room.me.role === 'setter' || p.pid !== room.me.pid))
    const names = displayNames(); const revealWords = ['setter', 'finished', 'spectator'].includes(room.me.role)
    peers.innerHTML = list.map((p) => {
      const entries = Array.from({ length: TW.MAX_TRIES }, (_, row) => ({ marks: p.rows?.[row] || [], guess: p.guesses?.[row] || null }))
      return `<div class="peer ${p.online ? '' : 'offline'} ${['won', 'lost'].includes(p.status) ? 'done' : ''}" data-pid="${esc(p.pid)}"><b>${esc(names.get(p.pid))}${p.pid === room.me.pid ? ' (나)' : ''}</b><div class="mini">${miniRows(entries, TW.MAX_TRIES, revealWords)}</div></div>`
    }).join('')
  }
  function wireTeamState() {
    if (!room || !isTeamMode()) return null
    const finals = {}
    for (const team of ['red', 'blue']) {
      const state = room.teamFinals[team]
      finals[team] = state ? {
        active: Boolean(state.active), unlimited: Boolean(state.unlimited), seconds: state.active && state.endsAt ? Math.max(1, Math.ceil((state.endsAt - Date.now()) / 1000)) : 0,
        elapsedMs: state.active ? Math.max(0, Date.now() - state.startedAt) : 0,
        results: Array.from(state.results?.values?.() || state.finalResults || []), finalResults: state.finalResults || [], correctCount: state.correctCount || 0, total: state.total || 0, accuracy: state.accuracy || 0,
      } : null
    }
    return {
      teams: teamsObject(), turns: room.teamTurns, status: room.teamStatus, maxTries: room.teamMaxTries, finishMs: room.teamFinishMs, spies: room.spies, teamWords: room.teamAnswers,
      boards: Object.fromEntries(['red', 'blue'].map((team) => [team, room.teamBoards[team].map((entry) => ({ pid: entry.pid, guess: H.encode(entry.guess), marks: encodeMarks(entry.marks) }))])),
      finals, deadline: room.teamDeadline ? { team: room.teamDeadline.team, seconds: Math.max(1, Math.ceil((room.teamDeadline.endsAt - Date.now()) / 1000)) } : null,
    }
  }
  function applyTeamSync(state) {
    if (!room || !isTeamMode() || !state) return
    room.teams = new Map(Object.entries(state.teams || {}).filter(([pid, team]) => room.activePids.has(pid) && ['red', 'blue'].includes(team)))
    room.spies = { red: String(state.spies?.red || '') || null, blue: String(state.spies?.blue || '') || null }; room.isSpy = room.kind === 'spy' && Object.values(room.spies).includes(room.me.pid)
    if (state.teamWords) { room.teamAnswers = { red: String(state.teamWords.red || room.answer), blue: String(state.teamWords.blue || room.answer) }; room.answer = room.teamAnswers[room.teams.get(room.me.pid)] || room.teamAnswers.red }
    room.teamTurns = { red: String(state.turns?.red || ''), blue: String(state.turns?.blue || '') }
    room.teamStatus = { red: ['playing', 'won', 'final', 'lost'].includes(state.status?.red) ? state.status.red : 'playing', blue: ['playing', 'won', 'final', 'lost'].includes(state.status?.blue) ? state.status.blue : 'playing' }
    room.teamMaxTries = { red: Math.max(TW.MAX_TRIES, Number(state.maxTries?.red) || 0), blue: Math.max(TW.MAX_TRIES, Number(state.maxTries?.blue) || 0) }
    room.teamFinishMs = { red: state.finishMs?.red === null ? null : Math.max(0, Number(state.finishMs?.red) || 0), blue: state.finishMs?.blue === null ? null : Math.max(0, Number(state.finishMs?.blue) || 0) }
    for (const team of ['red', 'blue']) {
      room.teamBoards[team] = (Array.isArray(state.boards?.[team]) ? state.boards[team] : []).flatMap((entry) => {
        let guess
        try { guess = Array.from(H.decode(String(entry?.guess || ''))) } catch (e) { return [] }
        const marks = decodeMarks(entry?.marks)
        return guess.length === room.size && marks ? [{ pid: String(entry.pid || ''), guess, marks }] : []
      }).slice(0, room.teamMaxTries[team])
      room.teamFinals[team] = null
      const final = state.finals?.[team]
      if (final?.active) beginTeamFinal({ phase: 'team-final-start', round: room.round, team, seconds: final.seconds, unlimited: final.unlimited, elapsedMs: final.elapsedMs, results: final.results })
      else if (final) room.teamFinals[team] = { active: false, finalResults: Array.isArray(final.finalResults) ? final.finalResults : [], correctCount: Math.max(0, Number(final.correctCount) || 0), total: Math.max(0, Number(final.total) || 0), accuracy: Math.max(0, Math.min(1, Number(final.accuracy) || 0)) }
    }
    const mine = room.teams.get(room.me.pid)
    if (mine) {
      room.maxTries = room.teamMaxTries[mine]
      TW.restoreRoomGame(room.teamBoards[mine].map((entry) => entry.guess), room.teamStatus[mine] === 'playing' ? 'playing' : room.teamStatus[mine] === 'won' ? 'won' : 'lost')
      if (room.teamStatus[mine] !== 'playing') showTeamWaiting()
    }
    if (state.deadline) beginTeamDeadline({ phase: 'team-deadline', round: room.round, team: state.deadline.team, seconds: state.deadline.seconds })
    renderPeers(); renderBanner(); renderQuickChat(); scheduleTeamSkips(); persistRoom()
  }
  function onSyncRequest(payload) {
    if (!room?.host || payload.pid === room.me.pid) return
    if (!room.startedAt) { broadcastLobby(); return }
    const boards = {}; const guessBoards = {}
    for (const p of room.peers.values()) { boards[p.pid] = (p.rows || []).map((marks) => encodeMarks(marks || [])); guessBoards[p.pid] = (p.guesses || []).map((guess) => guess ? H.encode(guess) : '') }
    Net.send('sync!', {
      pid: payload.pid, round: room.round, roundsTotal: room.roundsTotal, kind: room.kind, size: room.size,
      answer: H.encode(H.decompose(room.answer)), word: room.answer, ts: Date.now(), setter: room.setterPid, spies: room.spies,
      participants: room.participants, turnPid: room.turnPid, boards, guessBoards, waitSeconds: room.waitSeconds, maxTries: room.maxTries, teamState: wireTeamState(),
      waitRemaining: room.waitEndsAt ? Math.max(1, Math.ceil((room.waitEndsAt - Date.now()) / 1000)) : 0,
      guesses: room.kind === 'coop' ? (TW.state?.guesses || []).map((g) => H.encode(g)) : [],
      scores: Array.from(room.results.values()), totals: totalsObject(), over: room.over, final: room.final, coopResult: room.coopResult, teamResult: room.teamResult, teamWinner: room.teamWinner,
      captain: room.kind === 'captain', captainAlive: room.captainAlive, captainEliminated: room.captainEliminated, captainChampion: room.captainChampion, eliminateCount: room.eliminateCount,
      readyState: room.over ? { phase: 'state', round: room.round, ready: Array.from(room.readyPids), voters: Array.from(room.readyVoters.size ? room.readyVoters : new Set(onlinePlayers().map((p) => p.pid))) } : null,
      finalChanceState: room.finalChance?.active ? { seconds: Math.max(1, Math.ceil((room.finalChance.endsAt - Date.now()) / 1000)), elapsedMs: Math.max(0, Date.now() - room.finalChance.startedAt), results: Array.from(room.finalChance.results.values()) } : null,
    })
  }
  function onSync(payload) {
    if (!room || payload.pid !== room.me.pid) return
    if (room.startedAt) {
      if (room.over) { if (payload.readyState) applyReadyState(payload.readyState); return }
      if (Number(payload.round) !== room.round || room.kind !== 'coop' && !isTeamMode() && room.kind !== 'captain') return
      TW.applyRemote(() => {
        room.participants = validParticipants(payload); room.activePids = new Set(room.participants)
        if (isTeamMode()) return applyTeamSync(payload.teamState)
        room.turnPid = String(payload.turnPid || ''); room.coopPending = false
        TW.restoreRoomGame((payload.guesses || []).map((g) => H.decode(String(g))), payload.coopResult?.status || 'playing')
        if (payload.finalChanceState) beginFinalChance({ phase: 'final-start', round: room.round, ...payload.finalChanceState })
        renderBanner(); persistRoom()
      })
      return
    }
    const resume = room.resume
    const isParticipant = Array.isArray(payload.participants) && payload.participants.map(String).includes(room.me.pid)
    const canResume = Boolean(resume?.active && isParticipant && Number(resume.round) === Number(payload.round))
    beginRound(payload, !canResume)
    if (isTeamMode()) {
      applyTeamSync(payload.teamState)
    } else if (room.kind === 'coop') {
      TW.restoreRoomGame((payload.guesses || []).map((g) => H.decode(String(g))), payload.coopResult?.status || 'playing')
    } else if (canResume) {
      TW.restoreRoomGame((resume.guesses || []).map((g) => H.decode(String(g))), resume.status)
      room.me.role = 'player'; document.body.classList.remove('watching'); $('#keyboard').hidden = false; $('.board-wrap').hidden = false
    }
    room.resume = null
    for (const [pid, rows] of Object.entries(payload.boards || {})) {
      const p = room.peers.get(pid)
      if (p) { p.rows = rows.map((marks) => decodeMarks(marks) || []); p.guesses = (payload.guessBoards?.[pid] || []).map((guess) => { try { return Array.from(H.decode(String(guess || ''))) } catch (e) { return null } }) }
    }
    for (const result of payload.scores || []) room.results.set(result.pid, result)
    room.totals = new Map(Object.entries(payload.totals || {})); renderPeers(); renderBanner()
    if (Number(payload.waitRemaining) > 0) beginWait({ round: room.round, seconds: Number(payload.waitRemaining) })
    if (payload.finalChanceState) beginFinalChance({ phase: 'final-start', round: room.round, ...payload.finalChanceState })
    if (payload.over) isTeamMode() ? showTeamResult({ round: room.round, team: true, word: room.answer, teamWords: payload.teamState?.teamWords, winner: payload.teamWinner, results: payload.teamResult || [] }) : room.kind === 'coop' ? showCoopResult(payload.coopResult || payload) : showScoreboard(Array.from(room.results.values()), Boolean(payload.final), { ...payload, captain: payload.captain, alive: payload.captainAlive, eliminated: payload.captainEliminated, champion: payload.captainChampion })
    if (payload.readyState) applyReadyState(payload.readyState)
  }

  document.addEventListener('click', (event) => {
    const insideChat = event.composedPath().some((node) => node?.classList?.contains('quick-chat'))
    if (room?.chatOpen && !insideChat) { room.chatOpen = false; renderQuickChat() }
    const category = event.target.closest('[data-room-category]')
    if (category && ['solo', 'team'].includes(category.dataset.roomCategory)) {
      const nick = $('#roomNick')?.value || ''
      const joinCode = $('#roomJoinCode')?.value || ''
      roomCategory = category.dataset.roomCategory
      draft.kind = null
      TW.openSheet('rooms')
      const nickInput = $('#roomNick'); if (nickInput) nickInput.value = nick
      const joinInput = $('#roomJoinCode'); if (joinInput) joinInput.value = joinCode
      return
    }
    const roomMode = event.target.closest('[data-room-pick]')
    if (roomMode && Object.hasOwn(MODES, roomMode.dataset.roomPick)) {
      draft.kind = roomMode.dataset.roomPick
      if (draft.kind !== 'relay') draft.roundsTotal = 1
      else if (draft.roundsTotal === 1) draft.roundsTotal = 3
      for (const button of document.querySelectorAll('[data-room-pick]')) button.setAttribute('aria-pressed', String(button === roomMode))
      const create = document.querySelector('[data-act=room-open-create]'); if (create) create.disabled = false
      return
    }
    const chat = event.target.closest('[data-chat]')
    if (chat) { sendChat(chat.dataset.chat, room?.chatScope); return }
    const scope = event.target.closest('[data-chat-scope]')
    if (scope && room) { room.chatScope = scope.dataset.chatScope === 'team' ? 'team' : 'all'; renderQuickChat(); return }
    const teamPick = event.target.closest('[data-team-pid][data-team]')
    if (teamPick && room?.host && isTeamMode() && !room.startedAt && ['red', 'blue'].includes(teamPick.dataset.team)) {
      room.teamsHidden = false; room.teams.set(teamPick.dataset.teamPid, teamPick.dataset.team); ensureTeamSetters(); renderLobby(); broadcastLobby(); return
    }
    const teamSetter = event.target.closest('[data-team-setter]')
    if (teamSetter && room?.host && room.kind === 'teamsetter' && !room.startedAt && !room.teamsHidden) {
      const pid = teamSetter.dataset.teamSetter; const team = room.teams.get(pid)
      if (team) { room.teamSetters[team] = pid; renderLobby(); broadcastLobby() }
      return
    }
    const setter = event.target.closest('[data-setter]')
    if (setter && room?.host && room.kind === 'setter' && !room.startedAt) {
      room.setterPid = setter.dataset.setter; renderLobby(); broadcastLobby(); return
    }
    const target = event.target.closest('[data-rmode],[data-rsize],[data-rounds],[data-wait],[data-eliminate]')
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
    if (target.dataset.eliminate !== undefined) draft.eliminateCount = Number(target.dataset.eliminate)
    for (const chip of target.parentElement.querySelectorAll('.chip')) chip.setAttribute('aria-pressed', String(chip === target))
  })
  document.addEventListener('input', (event) => {
    if (event.target.id === 'roomWord') paintSetterWord()
    if (event.target.id === 'finalWord') paintFinalWord()
  })
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return
    if (event.target.id === 'roomJoinCode') TW.ACTIONS['room-join']()
    else if (event.target.id === 'roomNick' && $('#roomJoinCode')?.value) TW.ACTIONS['room-join']()
    else if (event.target.id === 'roomWord' && !$('#roomWordButton')?.disabled) submitSetterWord()
    else if (event.target.id === 'finalWord' && !$('#finalSubmit')?.disabled) submitFinalWord()
    else if (event.target.id === 'roomChatInput') { event.preventDefault(); sendChat(event.target.value, room?.chatScope) }
  })
  Net.on('roster', onRoster); Net.on('status', onStatus); Net.on('lobby', onLobby); Net.on('pick', onPick); Net.on('word', onWord)
  Net.on('start', (payload) => beginRound(payload, false)); Net.on('mark', onMark); Net.on('done', onDone); Net.on('turn', onTurn)
  Net.on('chat', onChat); Net.on('wait', beginWait); Net.on('ready', onReady)
  Net.on('over', onOver); Net.on('sync?', onSyncRequest); Net.on('sync!', onSync)

  const roomButton = $('#btnRooms')
  if (Net.available) {
    roomButton.hidden = false
    const resume = TW.store.get('tw.room.v1', null)
    if (globalThis.TWRoomHash) setTimeout(() => { draft.kind = null; roomCategory = null; TW.openSheet('rooms') }, 0)
    else if (resume?.code && resume?.nick) setTimeout(() => enterRoom(resume.code, resume.nick, { kind: resume.kind || 'versus', size: Number(resume.size) || 5, roundsTotal: Number(resume.roundsTotal) || 1, waitSeconds: [0, 30, 60, 90].includes(Number(resume.waitSeconds)) ? Number(resume.waitSeconds) : 60, eliminateCount: [1, 2].includes(Number(resume.eliminateCount)) ? Number(resume.eliminateCount) : 1 }, resume), 0)
  } else { roomButton.remove(); globalThis.TWRoomHash = null }

  globalThis.Room = { get current() { return room }, localMark, localDone, submitCoop, canPlay, blockedInput, leave: leaveRoom, normalizeCode, repaintPeers: renderPeers }
})()
