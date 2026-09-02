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
  const MODES = { versus: '같은 단어 대결', setter: '출제 대결', relay: '연판', captain: '서바이벌', tournament: '토너먼트', roundtable: '원탁 모드', coop: '협동', team: '팀전', teamsetter: '팀 출제 대결', spy: '스파이전' }
  const MODE_GROUPS = { solo: ['versus', 'setter', 'relay', 'captain', 'tournament', 'roundtable'], team: ['coop', 'team', 'teamsetter', 'spy'] }
  const TEAM_NAMES = { red: '빨강팀', blue: '파랑팀' }
  const isTeamMode = (kind = room?.kind) => ['team', 'teamsetter', 'spy'].includes(kind)
  const QUICK_MESSAGES = ['ㅋㅋㅋ', '화이팅!', '오 거의 다 왔다!', '천천히 해도 돼']
  let room = null
  let draft = { kind: 'versus', size: 5, roundsTotal: 1, waitSeconds: 60, eliminateCount: 1, roundtableFreeWords: false }
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
      eliminateCount: room.eliminateCount, roundtableFreeWords: room.roundtableFreeWords,
      captainAlive: room.captainAlive, tournamentAlive: room.tournamentAlive,
      tournamentSeed: room.tournamentSeed, tournamentRounds: room.tournamentRounds,
    })
  }

  TW.SHEETS.rooms = () => {
    const player = savedPlayer()
    const preset = globalThis.TWRoomHash || ''
    if (preset) return `<h2>별명을 입력해 주세요</h2>
      <div style="margin-top:16px"><input class="field" id="roomNick" autofocus placeholder="별명" maxlength="16" value="${esc(player.nick)}" autocomplete="nickname" autocapitalize="off" spellcheck="false"><div class="hint" id="roomHint"></div></div>
      <div class="sheet-actions"><button class="btn primary" data-act="room-join">들어가기</button></div>`
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
    <div ${['coop', 'team', 'teamsetter', 'spy', 'roundtable', 'tournament'].includes(draft.kind) ? 'hidden' : ''}><p><b>첫 완주 후 대기</b></p><div class="room-options">${[30, 60, 90, 0].map((n) => `<button class="chip" data-wait="${n}" aria-pressed="${draft.waitSeconds === n}">${n ? `${n}초` : '제한 없음'}</button>`).join('')}</div></div>
    <div ${draft.kind === 'roundtable' ? '' : 'hidden'}><p><b>입력 단어</b></p><div class="room-options"><button class="chip" data-roundtable-free="false" aria-pressed="${!draft.roundtableFreeWords}">사전 단어만</button><button class="chip" data-roundtable-free="true" aria-pressed="${draft.roundtableFreeWords}">사전에 없는 단어도 허용</button></div></div>
    <p class="muted">${draft.kind === 'setter' ? '방장이 로비에서 출제자를 고릅니다.' : draft.kind === 'relay' ? '여러 판 점수를 더해 최종 승자를 정합니다.' : draft.kind === 'captain' ? '오답자는 모두 탈락하고, 전원이 맞히면 느린 참가자가 탈락합니다.' : draft.kind === 'tournament' ? '매 라운드 1대1로 겨뤄 먼저 맞힌 사람만 다음 대진에 진출합니다.' : draft.kind === 'roundtable' ? '원탁을 돌며 색 힌트를 공개하고, 눈치챈 사람은 언제든 정답에 도전합니다.' : draft.kind === 'coop' ? '한 보드를 공유하며 차례대로 한 줄씩 냅니다.' : draft.kind === 'team' ? '두 팀이 공유 보드로 풀며, 마지막 기회는 팀 정답률로 승부합니다.' : draft.kind === 'teamsetter' ? '각 팀 출제자가 상대 팀이 풀 서로 다른 단어를 냅니다.' : draft.kind === 'spy' ? '각 팀에 숨어든 스파이는 자기 팀이 져야 개인 승리합니다.' : '모두 같은 단어를 동시에 풉니다.'}</p>
    <div class="sheet-actions"><button class="btn primary" data-act="room-create">방 만들기</button></div>`
  TW.SHEETS.roommenu = () => {
    if (!room) return '<h2>방을 찾지 못했어요</h2>'
    const sec = room.startedAt ? Math.floor((Date.now() - room.startedAt) / 1000) : 0
    return `<h2>방 메뉴</h2><p class="muted">${MODES[room.kind]} · 방 코드 <b>${esc(room.code)}</b> · ${Math.floor(sec / 60)}분 ${sec % 60}초</p><div class="sheet-actions">
      <button class="btn ghost" data-act="room-copy">초대 ${TW.shareUrl() ? '링크' : '코드'} 복사</button>
      ${room.host && room.startedAt && !room.over ? '<button class="btn accent" data-act="room-force">모두 강제 종료</button>' : ''}
      <button class="btn ghost" data-go="leave">방 나가기</button></div>`
  }
  TW.SHEETS.changemode = () => {
    if (!room?.host || room.startedAt) return '<h2>지금은 모드를 바꿀 수 없어요</h2><p>게임이 끝나고 대기방으로 돌아오면 바꿀 수 있습니다.</p>'
    return `<h2>방 모드 바꾸기</h2><p class="muted">같은 방과 참가자를 유지한 채 다음 게임 설정을 바꿉니다.</p>${Object.entries(MODE_GROUPS).map(([group, kinds]) => `<p><b>${group === 'solo' ? '개인전' : '팀전'}</b></p><div class="room-mode-grid">${kinds.map((kind) => `<button class="btn" data-change-room-mode="${kind}" aria-pressed="${room.kind === kind}">${MODES[kind]}</button>`).join('')}</div>`).join('')}<p><b>칸 수</b></p><div class="room-options">${[4, 5, 6, 7, 0].map((size) => `<button class="chip" data-change-room-size="${size}" aria-pressed="${room.size === size}">${size || '랜덤'}${size ? '칸' : ''}</button>`).join('')}</div>${room.kind === 'roundtable' ? `<p><b>입력 단어</b></p><div class="room-options"><button class="chip" data-change-roundtable-free="false" aria-pressed="${!room.roundtableFreeWords}">사전 단어만</button><button class="chip" data-change-roundtable-free="true" aria-pressed="${room.roundtableFreeWords}">사전에 없는 단어도 허용</button></div>` : ''}<div class="sheet-actions"><button class="btn primary" data-close>설정 완료</button></div>`
  }
  TW.SHEETS.spyrole = () => {
    if (!room || room.kind !== 'spy') return '<h2>역할을 찾지 못했어요</h2>'
    const team = room.teams.get(room.me.pid)
    if (!team) return '<h2>이번 판은 관전합니다.</h2><p>다음 판부터 팀과 비밀 역할을 받을 수 있어요.</p><div class="sheet-actions"><button class="btn" data-close>관전하기</button></div>'
    return room.isSpy
      ? `<h2 class="spy-title">당신은 스파이입니다.</h2><p><b>${TEAM_NAMES[team]}</b>에 숨어들었어요. 이상한 추측으로 팀의 정답률을 낮추세요.</p><div class="spy-mission">내가 들어간 팀이 지면<br><b>스파이 개인 승리!</b></div><div class="sheet-actions"><button class="btn accent" data-close>역할 확인 완료</button></div>`
      : `<h2>${TEAM_NAMES[team]}입니다.</h2><p>팀원 중 상대편 스파이 한 명이 숨어 있어요. 서로 상의하며 높은 정답률을 만들어 보세요.</p><div class="sheet-actions"><button class="btn primary" data-close>시작하기</button></div>`
  }
  TW.SHEETS.tournamentmatch = () => {
    const match = tournamentMatchFor(room?.me.pid)
    if (!room || !match) return '<h2>대진 결과를 기다리는 중…</h2>'
    const won = match.winner === room.me.pid
    const ready = room.tournamentReady.has(room.me.pid)
    return `<h2>${won ? `${crownedName(playerName(room.me.pid))} 승리!` : '이번 대진에서 패배했어요'}</h2>
      <div class="answer-reveal"><b>${esc(match.word)}</b><span>${esc(playerName(match.winner))}님이 다음 라운드에 진출합니다.</span></div>
      <div class="sheet-actions">${won ? `<button class="btn primary" data-act="room-tournament-ready" ${ready ? 'disabled' : ''}>${ready ? '준비 완료 · 다른 대진 대기 중' : '다음 라운드 준비 완료'}</button>` : '<p class="muted">남은 대진을 관전할 수 있어요.</p>'}<button class="btn ghost" data-close>관전하기</button></div>`
  }
  TW.SHEETS.roundtableresult = () => {
    if (!room || room.kind !== 'roundtable') return '<h2>결과를 찾지 못했어요</h2>'
    const winner = room.roundtableWinner
    const history = room.roundtableRows.map((entry) => `<div class="roundtable-result-row"><b>${esc(playerName(entry.pid))}</b>${roundtableTiles(entry)}</div>`).join('')
    return `${celebration(Boolean(winner))}<h2>${winner ? `${crownedName(playerName(winner))}님이 정답을 알아냈어요!` : '원탁 모드 종료'}</h2><div class="answer-reveal"><b>${esc(room.answer || '')}</b><span>${winner ? '가장 먼저 정답 도전에 성공했습니다.' : '방장이 게임을 종료했습니다.'}</span></div><div class="roundtable-result-history">${history}</div><div class="sheet-actions">${rematchControls()}<button class="btn ghost" data-go="leave">나가기</button></div>`
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
    const code = normalizeCode($('#roomJoinCode')?.value || globalThis.TWRoomHash)
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
    'room-tournament-ready': requestTournamentReady,
    'room-roundtable-submit': () => TW.submit(),
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
    const wait = ['spy', 'roundtable', 'tournament'].includes(room.kind) ? ' · 제한시간 없음' : isTeamMode() ? ' · 선두 팀 후 30초' : room.kind !== 'coop' ? ` · 완주 후 ${room.waitSeconds ? `${room.waitSeconds}초` : '제한 없음'}` : ''
    const detail = `${room.size ? `${room.size}칸` : '랜덤 칸'}${room.kind === 'relay' ? ` · ${room.roundsTotal}라운드` : room.kind === 'captain' ? ` · 매 판 최소 ${room.eliminateCount}명 탈락` : room.kind === 'tournament' ? ' · 1대1 진출전' : room.kind === 'roundtable' ? ` · ${room.roundtableFreeWords ? '자유 단어 허용' : '사전 단어만'}` : ''}${wait}`
    const modeCard = `<div class="lobby-mode-card"><span>현재 모드</span><strong>${esc(MODES[room.kind])}</strong><small>${esc(detail)}</small></div>`
    const teamControls = room.host && isTeamMode() ? `<div class="sheet-actions team-lobby-actions">${room.teamsHidden ? '<button class="btn" data-act="room-manual-teams">수동 배정으로 바꾸기</button>' : '<button class="btn accent" data-act="room-random-teams">랜덤 팀 · 비공개</button>'}</div>` : ''
    const hiddenNotice = isTeamMode() && room.teamsHidden ? '<br><b>비밀 팀 배정 완료</b> · 게임이 시작되면 공개됩니다.' : ''
    $('#lobbyActions').innerHTML = room.host
      ? `${modeCard}<p class="muted">${hiddenNotice}${choose ? '<br>아래에서 출제자를 선택한 뒤 시작하세요.' : chooseTeam ? '<br>참가자를 두 팀으로 나눈 뒤 시작하세요.' : ''}</p>${teamControls}<button class="btn ghost" data-sheet="changemode">모드 바꾸기</button><button class="btn primary" data-act="room-start" ${Net.status === 'live' ? '' : 'disabled'}>시작하기</button><button class="btn ghost" data-go="leave">나가기</button>`
      : `${modeCard}<p class="muted">${hiddenNotice}<br>방장이 시작하기를 기다리는 중…</p><button class="btn ghost" data-go="leave">나가기</button>`
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
      roundtableFreeWords: Boolean(draft.roundtableFreeWords),
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
      tournamentAlive: [], tournamentPairs: [], tournamentByes: [], tournamentEliminated: [], tournamentChampion: null,
      tournamentSeed: (resume?.tournamentSeed || []).map(String), tournamentRounds: normalizeTournamentRounds(resume?.tournamentRounds),
      tournamentWords: {}, tournamentMatches: new Map(), tournamentReady: new Set(), tournamentNextAt: null,
      roundtableSeats: [], roundtableRows: [], roundtableLocked: new Set(), roundtableWinner: null, roundtablePending: false,
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
    document.body.classList.remove('watching', 'roundtable-playing')
    $('#keyboard').hidden = false; $('.board-wrap').hidden = false; $('#peers').hidden = true; $('#roundTable').hidden = true; $('#roundtableAction').hidden = true; $('#roomBanner').hidden = true; $('#quickChat').hidden = true; $('#lobbyChat').hidden = true; $('#finalChance').hidden = true
    $('#btnBack').dataset.go = 'home'; $('#btnMenu').dataset.sheet = 'stats'; $('#btnMenu').textContent = '☰'; $('#btnMenu').setAttribute('aria-label', '기록')
    TW.GOES.home()
  }

  function teamsObject() { return Object.fromEntries(room?.teams || []) }
  function lobbyPayload() { return { kind: room.kind, size: room.size, roundsTotal: room.roundsTotal, setterPid: room.setterPid, waitSeconds: room.waitSeconds, eliminateCount: room.eliminateCount, roundtableFreeWords: room.roundtableFreeWords, teamsHidden: room.teamsHidden, teams: room.teamsHidden ? {} : teamsObject(), teamSetters: room.teamsHidden ? {} : room.teamSetters } }
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
    room.roundtableFreeWords = Boolean(payload.roundtableFreeWords)
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
    if (room.kind === 'roundtable' && room.startedAt && !room.over) scheduleRoundtableSkip()
    if (isTeamMode() && room.startedAt && !room.over) scheduleTeamSkips()
    settleDisconnectedPlayers()
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
    if (room.host && room.over) room.kind === 'tournament' && !room.tournamentChampion ? publishTournamentReadyState() : publishReadyState()
  }
  function onStatus(status) {
    renderLobby()
    if (!room) return
    if (status === 'retry') TW.toast('연결이 끊겨 다시 연결하고 있어요', 2200)
    if (status === 'live') { Net.send('sync?', { pid: room.me.pid }); broadcastLobby() }
  }
  function resolvedRoomSize() { return room.size === 0 ? TW.SIZES[Math.floor(Math.random() * TW.SIZES.length)] : room.size }
  function roundParticipants(setterPid) { return onlinePlayers().filter((p) => p.pid !== setterPid).map((p) => p.pid) }
  function prepareTournamentRound() {
    const seeded = room.tournamentAlive.slice()
    const byes = []
    if (seeded.length % 2) byes.push(...seeded.splice((room.round - 1) % seeded.length, 1))
    const pairs = []
    for (let i = 0; i < seeded.length; i += 2) pairs.push([seeded[i], seeded[i + 1]])
    room.tournamentPairs = pairs; room.tournamentByes = byes; room.tournamentEliminated = []; room.tournamentWords = {}; room.tournamentMatches = new Map(); room.tournamentReady = new Set(); room.tournamentNextAt = null
  }
  function startRound() {
    if (!room?.host || Net.status !== 'live') return
    clearTimeout(nextTimer)
    const size = resolvedRoomSize()
    if (room.kind === 'captain' && !room.captainAlive.length) {
      room.captainAlive = onlinePlayers().map((p) => p.pid)
      if (room.captainAlive.length < 2) return TW.toast('서바이벌은 두 명 이상 필요해요')
    }
    if (room.kind === 'tournament') {
      if (!room.tournamentAlive.length) {
        room.tournamentAlive = onlinePlayers().map((p) => p.pid)
        for (let i = room.tournamentAlive.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [room.tournamentAlive[i], room.tournamentAlive[j]] = [room.tournamentAlive[j], room.tournamentAlive[i]] }
        room.tournamentSeed = room.tournamentAlive.slice(); room.tournamentRounds = []
      }
      if (room.tournamentAlive.length < 2) return TW.toast('토너먼트는 두 명 이상 필요해요')
      prepareTournamentRound()
    }
    if (room.kind === 'roundtable' && onlinePlayers().length < 2) return TW.toast('원탁 모드는 두 명 이상 필요해요')
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
      ? room.captainAlive.slice()
      : room.kind === 'tournament'
        ? room.tournamentPairs.flat()
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
    if (room.kind === 'tournament') {
      const used = new Set()
      for (const pair of room.tournamentPairs) {
        let word = TW.freeAnswer(size)
        for (let tries = 0; tries < 20 && used.has(word); tries++) word = TW.freeAnswer(size)
        used.add(word)
        for (const pid of pair) room.tournamentWords[pid] = word
      }
      answer = room.tournamentWords[participants[0]] || answer
    }
    if (room.kind === 'roundtable') {
      room.roundtableSeats = participants.slice()
      for (let i = room.roundtableSeats.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [room.roundtableSeats[i], room.roundtableSeats[j]] = [room.roundtableSeats[j], room.roundtableSeats[i]] }
    }
    const maxTries = room.kind === 'coop' ? Math.max(TW.MAX_TRIES, participants.length) : TW.MAX_TRIES
    const payload = {
      round: room.round, roundsTotal: room.roundsTotal, kind: room.kind, size,
      answer: H.encode(H.decompose(answer)), word: answer, setter: setterPid, participants, maxTries,
      turnPid: room.kind === 'coop' ? participants[0] : room.kind === 'roundtable' ? room.roundtableSeats[0] : null, waitSeconds: room.waitSeconds, ts: Date.now(),
      eliminateCount: room.eliminateCount, captainAlive: room.kind === 'captain' ? participants : null,
      tournamentAlive: room.kind === 'tournament' ? room.tournamentAlive : null, tournamentPairs: room.kind === 'tournament' ? room.tournamentPairs : null, tournamentByes: room.kind === 'tournament' ? room.tournamentByes : null,
      tournamentWords: room.kind === 'tournament' ? room.tournamentWords : null,
      tournamentSeed: room.kind === 'tournament' ? room.tournamentSeed : null, tournamentRounds: room.kind === 'tournament' ? room.tournamentRounds : null,
      roundtableSeats: room.kind === 'roundtable' ? room.roundtableSeats : null,
      roundtableFreeWords: room.kind === 'roundtable' ? room.roundtableFreeWords : null,
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
    if (room.kind === 'tournament') {
      room.tournamentAlive = Array.from(new Set((Array.isArray(payload.tournamentAlive) ? payload.tournamentAlive : room.participants).map(String)))
      room.tournamentPairs = (Array.isArray(payload.tournamentPairs) ? payload.tournamentPairs : []).flatMap((pair) => Array.isArray(pair) && pair.length === 2 ? [[String(pair[0]), String(pair[1])]] : [])
      room.tournamentByes = Array.from(new Set((Array.isArray(payload.tournamentByes) ? payload.tournamentByes : []).map(String)))
      room.tournamentWords = Object.fromEntries(Object.entries(payload.tournamentWords || {}).map(([pid, word]) => [String(pid), String(word)]))
      room.tournamentSeed = Array.from(new Set((Array.isArray(payload.tournamentSeed) ? payload.tournamentSeed : room.tournamentSeed).map(String)))
      room.tournamentRounds = normalizeTournamentRounds(payload.tournamentRounds ?? room.tournamentRounds)
      room.tournamentEliminated = []; room.tournamentChampion = null; room.tournamentMatches = new Map(); room.tournamentReady = new Set(); room.tournamentNextAt = null
      answer = room.tournamentWords[room.me.pid] || answer; room.answer = answer
    }
    if (room.kind === 'roundtable') {
      room.roundtableSeats = Array.from(new Set((Array.isArray(payload.roundtableSeats) ? payload.roundtableSeats : room.participants).map(String))).filter((pid) => room.activePids.has(pid))
      room.roundtableFreeWords = Boolean(payload.roundtableFreeWords)
      room.roundtableRows = []; room.roundtableLocked = new Set(); room.roundtableWinner = null; room.roundtablePending = false
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
    room.turnPid = ['coop', 'roundtable'].includes(room.kind) ? String(payload.turnPid || room.participants[0] || '') : null
    const myTeam = room.teams.get(room.me.pid)
    if (isTeamMode()) { answer = room.teamAnswers?.[myTeam] || room.teamAnswers?.red || answer; room.answer = answer; room.chatScope = myTeam ? 'team' : 'all' }
    room.maxTries = room.kind === 'roundtable' ? 1 : room.kind === 'coop' ? Math.max(TW.MAX_TRIES, Number(payload.maxTries) || room.participants.length) : isTeamMode() ? room.teamMaxTries[myTeam] || TW.MAX_TRIES : TW.MAX_TRIES
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
    document.body.classList.toggle('watching', watching); document.body.classList.toggle('roundtable-playing', room.kind === 'roundtable')
    $('#keyboard').hidden = watching; $('.board-wrap').hidden = watching
    $('#peers').hidden = ['coop', 'roundtable'].includes(room.kind); $('#roundTable').hidden = room.kind !== 'roundtable'
    $('#finalChance').hidden = true
    renderPeers(); renderRoundTable(); renderBanner(); renderQuickChat(); TW.refitBoard(); startTimer(); persistRoom()
    if (room.kind === 'spy') TW.openSheet('spyrole')
  }
  function startTimer() {
    clearInterval(timer)
    const tick = () => {
      if (!room?.startedAt || room.over) return
      const sec = Math.floor((Date.now() - room.startedAt) / 1000)
      const round = room.kind === 'relay' ? `${room.round}/${room.roundsTotal}R · ` : room.kind === 'captain' ? `${room.round}판 · 생존 ${room.captainAlive.length}명 · ` : room.kind === 'tournament' ? `토너먼트 ${room.round}R · ${room.tournamentAlive.length}명 · ` : ''
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
    else if (room.kind === 'roundtable') text = room.turnPid === room.me.pid ? '내 차례 · 색 힌트 단어를 공개하세요' : `${playerName(room.turnPid)}님의 색 힌트 차례 · 정답 도전은 언제든 가능`
    else if (room.me.role === 'finished') text = room.waitEndsAt ? '완료! 남은 참가자를 응원해 주세요' : '완료! 다른 참가자의 보드를 보고 있어요'
    else if (room.me.role === 'setter') text = `내가 낸 정답: ${room.answer}`
    else if (room.kind === 'captain' && room.me.role === 'spectator' && !room.captainAlive.includes(room.me.pid)) text = room.host ? '탈락했지만 방장으로 남아 관전 중 · 다음 판 진행 권한을 유지해요' : '탈락 후 방에 남아 관전 중이에요'
    else if (room.kind === 'tournament' && room.tournamentByes.includes(room.me.pid)) text = '이번 라운드는 부전승! 다음 대진을 기다리며 관전해요'
    else if (room.kind === 'tournament' && room.me.role === 'spectator' && !room.tournamentAlive.includes(room.me.pid)) text = room.host ? '탈락했지만 방장으로 남아 토너먼트를 진행해요' : '토너먼트 탈락 후 관전 중이에요'
    else if (room.me.role === 'spectator') text = '이번 라운드는 관전 중이에요'
    const myTeam = isTeamMode() ? room.teams.get(room.me.pid) : null
    const myTeamNames = myTeam ? teamMembers(myTeam).map((pid) => `${playerName(pid)}${pid === room.me.pid ? ' (나)' : ''}`).join(', ') : ''
    banner.innerHTML = `${esc(text)}${myTeamNames ? `<small>우리 팀 · ${esc(myTeamNames)}</small>` : ''}`; banner.hidden = !text && !myTeamNames
  }
  function canPlay() {
    if (!room || room.me.role !== 'player' || room.over || room.finalChance?.active) return false
    if (room.kind === 'roundtable') return !room.roundtablePending && (room.turnPid === room.me.pid || !room.roundtableLocked.has(room.me.pid))
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
    if (room.kind === 'roundtable') return TW.toast(room.roundtablePending ? '제출을 확인하는 중이에요' : room.roundtableLocked.has(room.me.pid) ? '다음 내 차례에 색 힌트를 낸 뒤 다시 도전할 수 있어요' : '지금은 입력할 수 없어요')
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
    const panel = room.chatOpen ? `<div class="chat-panel">${scopes}<div class="chat-messages">${messages.length ? messages.map((message) => `<p class="${message.pid === room.me.pid ? 'mine' : ''}"><b>${esc(playerName(message.pid))}</b><span>${esc(message.text)}</span></p>`).join('') : '<p class="chat-empty">아직 메시지가 없어요</p>'}</div><form class="chat-form" data-room-chat-form><input class="field" id="roomChatInput" maxlength="60" placeholder="메시지 입력" autocomplete="off"><button class="btn primary" id="roomChatSend" type="submit">보내기</button></form></div>` : ''
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
    Net.send('mark', { pid: room.me.pid, round: room.round, row, marks: encodeMarks(marks), guess: guess ? H.encode(guess) : '' }); renderPeers(); persistRoom()
  }
  function localDone(status, tries) {
    if (!room || room.me.role !== 'player') return
    if (room.kind === 'coop') { if (room.host) finishCoop(status, tries); return }
    const result = { pid: room.me.pid, round: room.round, status, tries, ms: Date.now() - room.startedAt }
    room.results.set(result.pid, result); Object.assign(room.peers.get(result.pid), result)
    Net.send('done', result); renderPeers(); persistRoom()
    if (room.kind === 'tournament') {
      if (room.host) processTournamentDone(result)
      else setTimeout(() => { if (room?.kind === 'tournament' && !room.over && !tournamentMatchFor(room.me.pid)) { Net.send('done', result); Net.send('sync?', { pid: room.me.pid }) } }, 1200)
      return
    }
    showWaitingView(); maybeStartWait(); maybeFinish()
  }
  function onMark(payload) {
    if (!room || room.kind === 'coop' || isTeamMode() || !room.startedAt || payload.pid === room.me.pid) return
    if (Number(payload.round) !== room.round) return
    const p = room.peers.get(String(payload.pid)); const marks = decodeMarks(payload.marks); const row = Number(payload.row)
    if (!p || !marks || !(row >= 0 && row < TW.MAX_TRIES)) return
    let guess = null
    try { guess = Array.from(H.decode(String(payload.guess || ''))) } catch (e) { /* 예전 클라이언트는 추측을 보내지 않는다 */ }
    if (guess?.length !== room.size) guess = null
    if (!p.rows) p.rows = []; if (!p.guesses) p.guesses = []; p.rows[row] = marks; if (guess) p.guesses[row] = guess; renderPeers()
  }
  function onDone(payload) {
    if (!room || room.kind === 'coop' || !room.startedAt || payload.pid === room.me.pid) return
    if (Number(payload.round) !== room.round) return
    const p = room.peers.get(String(payload.pid))
    if (!p || !room.activePids.has(p.pid)) return
    const result = { pid: p.pid, round: room.round, status: payload.status === 'won' ? 'won' : 'lost', tries: Math.max(1, Math.min(TW.MAX_TRIES, Number(payload.tries) || TW.MAX_TRIES)), ms: Math.max(0, Number(payload.ms) || 0) }
    room.results.set(result.pid, result); Object.assign(p, result); renderPeers()
    if (room.kind === 'tournament') { if (room.host) processTournamentDone(result); return }
    maybeStartWait(); maybeFinish()
  }
  function tournamentPair(pid) { return room?.tournamentPairs.find((pair) => pair.includes(String(pid))) || null }
  function tournamentPairKey(pair) { return pair?.map(String).join('|') || '' }
  function normalizeTournamentRounds(value) {
    if (!Array.isArray(value)) return []
    return value.flatMap((stage) => {
      const round = Math.max(1, Number(stage?.round) || 0)
      const pairs = (Array.isArray(stage?.pairs) ? stage.pairs : []).flatMap((pair) => Array.isArray(pair) && pair.length === 2 ? [[String(pair[0]), String(pair[1])]] : [])
      const byes = Array.from(new Set((Array.isArray(stage?.byes) ? stage.byes : []).map(String)))
      const matches = (Array.isArray(stage?.matches) ? stage.matches : []).flatMap((match) => {
        const pair = Array.isArray(match?.pair) ? match.pair.map(String) : []
        const winner = String(match?.winner || ''); const loser = String(match?.loser || '')
        return pair.length === 2 && pair.includes(winner) && pair.includes(loser) && winner !== loser ? [{ pair, winner, loser, word: String(match.word || '') }] : []
      })
      return round && (pairs.length || byes.length) ? [{ round, pairs, byes, matches }] : []
    }).sort((a, b) => a.round - b.round)
  }
  function recordTournamentRound() {
    const stage = { round: room.round, pairs: room.tournamentPairs.map((pair) => pair.slice()), byes: room.tournamentByes.slice(), matches: Array.from(room.tournamentMatches.values(), (match) => ({ ...match, pair: match.pair.slice() })) }
    room.tournamentRounds = normalizeTournamentRounds([...room.tournamentRounds.filter((item) => item.round !== room.round), stage])
  }
  function renderTournamentTree() {
    const stages = normalizeTournamentRounds(room.tournamentRounds)
    const first = stages[0]
    const seed = Array.from(new Set((room.tournamentSeed.length ? room.tournamentSeed : first ? [...first.pairs.flat(), ...first.byes] : room.tournamentAlive).map(String)))
    if (!seed.length) return '<p class="muted">대진을 만드는 중이에요.</p>'
    const leafOrder = first ? [...first.pairs.flat(), ...first.byes, ...seed.filter((pid) => !first.pairs.flat().includes(pid) && !first.byes.includes(pid))] : seed
    const totalRounds = Math.max(stages.at(-1)?.round || 0, Math.ceil(Math.log2(Math.max(2, seed.length))))
    const gapX = 88; const gapY = 92; const width = Math.max(320, leafOrder.length * gapX); const height = 74 + totalRounds * gapY
    const yFor = (level) => height - 34 - level * gapY
    const stageMap = new Map(stages.map((stage) => [stage.round, stage]))
    const levels = []; const edges = []
    let current = leafOrder.map((pid, index) => ({ pid, x: gapX / 2 + index * gapX, y: yFor(0), level: 0 }))
    levels.push(current)
    for (let level = 0; level < totalRounds; level++) {
      const stage = stageMap.get(level + 1); const next = []
      if (stage) {
        for (const pair of stage.pairs) {
          const children = pair.map((pid) => current.find((node) => node.pid === pid)).filter(Boolean)
          if (!children.length) continue
          const match = stage.matches.find((item) => tournamentPairKey(item.pair) === tournamentPairKey(pair))
          const parent = { pid: match?.winner || null, x: children.reduce((sum, node) => sum + node.x, 0) / children.length, y: yFor(level + 1), level: level + 1 }
          next.push(parent); for (const child of children) edges.push({ child, parent })
        }
        for (const pid of stage.byes) {
          const child = current.find((node) => node.pid === pid)
          if (!child) continue
          const parent = { pid, x: child.x, y: yFor(level + 1), level: level + 1, bye: true }
          next.push(parent); edges.push({ child, parent })
        }
      } else {
        const ordered = current.slice().sort((a, b) => a.x - b.x)
        const waiting = ordered.slice(); const bye = waiting.length % 2 ? waiting.splice(level % waiting.length, 1)[0] : null
        for (let index = 0; index < waiting.length; index += 2) {
          const children = waiting.slice(index, index + 2)
          const parent = { pid: null, x: children.reduce((sum, node) => sum + node.x, 0) / children.length, y: yFor(level + 1), level: level + 1, future: true }
          next.push(parent); for (const child of children) edges.push({ child, parent, future: true })
        }
        if (bye) { const parent = { pid: bye.pid, x: bye.x, y: yFor(level + 1), level: level + 1, future: true, bye: true }; next.push(parent); edges.push({ child: bye, parent, future: true }) }
      }
      current = next.sort((a, b) => a.x - b.x); levels.push(current)
    }
    const nodeState = (node) => {
      if (!node.pid) return { tone: 'pending', note: node.level === totalRounds ? '우승자' : `${node.level + 1}라운드` }
      if (node.level === totalRounds && room.tournamentChampion === node.pid) return { tone: 'champion', note: '우승' }
      const stage = stageMap.get(node.level + 1)
      if (!stage) return { tone: 'pending', note: node.bye ? '부전승' : '대기' }
      if (stage.byes.includes(node.pid)) return { tone: 'advance', note: '↑ 부전승' }
      const match = stage.matches.find((item) => item.pair.includes(node.pid))
      if (!match) return { tone: 'pending', note: '경기 중' }
      return match.winner === node.pid ? { tone: 'advance', note: '↑ 진출' } : { tone: 'eliminated', note: '탈락' }
    }
    const paths = edges.map(({ child, parent, future }) => {
      const middle = (child.y + parent.y) / 2; const tone = future ? 'future' : nodeState(child).tone
      return `<path class="${tone}" d="M ${child.x} ${child.y - 20} V ${middle} H ${parent.x} V ${parent.y + 20}"/>`
    }).join('')
    const nodes = levels.flat().map((node) => {
      const state = nodeState(node); const label = node.pid ? playerName(node.pid) : node.level === totalRounds ? '우승자' : `${node.level + 1}R 대기`
      return `<div class="tournament-tree-node ${state.tone}" style="--tree-x:${node.x}px;--tree-y:${node.y}px"><b>${state.tone === 'champion' ? crownedName(label) : esc(label)}</b><small>${state.note}</small></div>`
    }).join('')
    return `<div class="tournament-tree-scroll"><div class="tournament-tree" style="width:${width}px;height:${height}px"><svg viewBox="0 0 ${width} ${height}" aria-hidden="true">${paths}</svg>${nodes}</div></div><div class="tournament-tree-legend"><span>아래에서 시작</span><b>승자가 위로 진출 ↑</b></div>`
  }
  function tournamentMatchFor(pid) {
    const pair = tournamentPair(pid)
    return pair ? room.tournamentMatches.get(tournamentPairKey(pair)) || null : null
  }
  function processTournamentDone(result) {
    if (!room?.host || room.kind !== 'tournament' || room.over) return
    const pair = tournamentPair(result.pid); const key = tournamentPairKey(pair)
    if (!pair || room.tournamentMatches.has(key)) return
    const pairResults = pair.map((pid) => room.results.get(pid)).filter(Boolean)
    if (result.status !== 'won' && pairResults.length < 2) return
    const winnerResult = result.status === 'won' ? result : sortedResults(pairResults)[0]
    const winner = winnerResult.pid; const loser = pair.find((pid) => pid !== winner)
    const loserResult = room.results.get(loser) || { pid: loser, status: 'lost', tries: TW.MAX_TRIES, ms: winnerResult.ms, defeated: true }
    room.results.set(loser, loserResult)
    const match = { pair, winner, loser, word: room.tournamentWords[winner] || room.tournamentWords[loser] || room.answer, results: [winnerResult, loserResult] }
    const payload = { phase: 'tournament-match', round: room.round, ...match }
    Net.send('turn', payload); applyTournamentMatch(payload)
    for (const pid of pair) onSyncRequest({ pid })
    setTimeout(() => {
      if (!room?.host || room.kind !== 'tournament' || room.round !== payload.round || room.over || !room.tournamentMatches.has(key)) return
      Net.send('turn', payload)
      for (const pid of pair) onSyncRequest({ pid })
    }, 700)
    if (room.tournamentMatches.size === room.tournamentPairs.length) finishRound()
  }
  function applyTournamentMatch(payload) {
    if (!room || room.kind !== 'tournament' || Number(payload.round) !== room.round || !Array.isArray(payload.pair) || payload.pair.length !== 2) return
    const pair = payload.pair.map(String); const key = tournamentPairKey(pair)
    if (room.tournamentMatches.has(key)) return
    const winner = String(payload.winner || ''); const loser = String(payload.loser || '')
    if (!pair.includes(winner) || !pair.includes(loser) || winner === loser) return
    for (const result of Array.isArray(payload.results) ? payload.results : []) {
      if (!pair.includes(String(result.pid))) continue
      room.results.set(String(result.pid), { ...result, pid: String(result.pid) })
    }
    const match = { pair, winner, loser, word: String(payload.word || room.tournamentWords[winner] || room.answer) }
    room.tournamentMatches.set(key, match)
    const loserPeer = room.peers.get(loser); const winnerPeer = room.peers.get(winner)
    if (loserPeer) loserPeer.status = 'lost'; if (winnerPeer) winnerPeer.status = 'won'
    if (pair.includes(room.me.pid)) {
      room.me.role = room.me.pid === winner ? 'finished' : 'spectator'
      document.body.classList.add('watching'); $('#keyboard').hidden = true; $('.board-wrap').hidden = true
      TW.endRoomGame(); room.resultSheet = 'tournamentmatch'; renderPeers(); renderBanner(); renderQuickChat(); TW.openSheet('tournamentmatch')
    } else renderPeers()
    persistRoom()
  }
  function roundtableWord(value) {
    const raw = String(value || '').trim(); const decomposed = H.decompose(raw); const guess = Array.isArray(value) ? value.slice() : decomposed ? Array.from(decomposed) : []
    const exact = guess.join('') === Array.from(H.decompose(room?.answer || '') || '').join('')
    return { raw, guess, valid: guess.length === room?.size && (room?.roundtableFreeWords || exact || TW.isValid(guess)) }
  }
  function roundtableNext(pid, onlineOnly = false) {
    const seats = room?.roundtableSeats.filter((id) => room.activePids.has(id) && (!onlineOnly || room.peers.get(id)?.online)) || []
    if (!seats.length) return null
    const index = seats.indexOf(String(pid))
    return seats[(index + 1 + seats.length) % seats.length]
  }
  function roundtableTiles(entry) {
    return `<div class="roundtable-tiles" style="--cols:${room.size}">${entry.guess.map((jamo, index) => `<i class="${entry.marks[index] || 'absent'}">${esc(jamo)}</i>`).join('')}</div>`
  }
  function renderRoundTable() {
    const root = $('#roundTable')
    const action = $('#roundtableAction')
    if (!root || !room || room.kind !== 'roundtable' || !room.startedAt) { if (root) root.hidden = true; if (action) action.hidden = true; return }
    const total = Math.max(1, room.roundtableSeats.length)
    const seats = room.roundtableSeats.map((pid, index) => {
      const angle = -Math.PI / 2 + index * Math.PI * 2 / total
      const x = 50 + Math.cos(angle) * 43; const y = 50 + Math.sin(angle) * 41
      const current = pid === room.turnPid; const offline = !room.peers.get(pid)?.online; const locked = room.roundtableLocked.has(pid)
      return `<div class="roundtable-seat ${current ? 'current' : ''} ${offline ? 'offline' : ''} ${locked ? 'locked' : ''}" style="--seat-x:${x.toFixed(2)}%;--seat-y:${y.toFixed(2)}%"><b>${esc(playerName(pid))}${pid === room.me.pid ? ' (나)' : ''}</b><span>${current ? '차례' : locked ? '도전 잠김' : '대기'}</span></div>`
    }).join('')
    const rows = room.roundtableRows.length ? room.roundtableRows.slice(-8).map((entry) => `<div class="roundtable-history-row"><span>${esc(playerName(entry.pid))}</span>${roundtableTiles(entry)}</div>`).join('') : '<p class="roundtable-empty">첫 번째 색 힌트를 기다리는 중…</p>'
    const myTurn = room.turnPid === room.me.pid && room.me.role === 'player'; const locked = room.roundtableLocked.has(room.me.pid)
    root.innerHTML = `<div class="roundtable-arena">${seats}<section class="roundtable-center"><strong>원탁 공개 단어</strong><div class="roundtable-history">${rows}</div></section></div>`
    root.hidden = false
    if (action) {
      const disabled = room.me.role !== 'player' || room.roundtablePending || !myTurn && locked
      const tone = myTurn ? 'my-turn' : locked ? 'locked' : 'challenge-turn'
      const title = room.roundtablePending ? '제출을 확인하는 중…' : myTurn ? '내 차례 · 색 힌트 공개하기' : locked ? '정답 도전 기회 사용 중' : '다른 사람 차례 · 지금 정답 도전'
      const note = myTurn ? `입력한 단어와 색을 모두에게 공개합니다${room.roundtableFreeWords ? ' · 자유 단어 허용' : ''}` : locked ? '다음 내 차례에 색 힌트를 내면 다시 도전할 수 있습니다' : '틀리면 다음 내 차례까지 다시 도전할 수 없습니다'
      action.innerHTML = `<button class="roundtable-submit ${tone}" data-act="room-roundtable-submit" ${disabled ? 'disabled' : ''}><b>${title}</b><span>${note}</span></button>`
      action.hidden = room.me.role !== 'player' || room.over
    }
    TW.repaint?.()
  }
  function submitRoundtableClue(value) {
    if (!room || room.kind !== 'roundtable' || room.over || room.turnPid !== room.me.pid || room.roundtablePending) return
    const word = roundtableWord(value)
    if (!word.valid) return TW.toast(`자모 ${room.size}칸${room.roundtableFreeWords ? '을 모두' : '의 사전 단어를'} 입력해 주세요`)
    room.roundtablePending = true; renderRoundTable()
    const payload = { phase: 'roundtable-clue-submit', round: room.round, pid: room.me.pid, guess: H.encode(word.guess) }
    if (room.host) processRoundtableClue(payload); else Net.send('turn', payload)
  }
  function processRoundtableClue(payload) {
    if (!room?.host || room.kind !== 'roundtable' || room.over || payload.phase !== 'roundtable-clue-submit' || Number(payload.round) !== room.round) return
    const pid = String(payload.pid || '')
    if (pid !== room.turnPid || !room.activePids.has(pid)) return rejectRoundtable(pid, '지금은 내 차례가 아니에요')
    let guess
    try { guess = Array.from(H.decode(String(payload.guess || ''))) } catch (e) { return rejectRoundtable(pid, '단어를 다시 입력해 주세요') }
    const exact = guess.join('') === Array.from(H.decompose(room.answer) || '').join('')
    if (guess.length !== room.size || !room.roundtableFreeWords && !exact && !TW.isValid(guess)) return rejectRoundtable(pid, room.roundtableFreeWords ? `자모 ${room.size}칸을 입력해 주세요` : '사전에 있는 단어를 입력해 주세요')
    const marks = H.score(guess, Array.from(H.decompose(room.answer)))
    const commit = { phase: 'roundtable-clue-commit', round: room.round, pid, guess: H.encode(guess), marks: encodeMarks(marks), nextPid: exact ? null : roundtableNext(pid), won: exact }
    Net.send('turn', commit); applyRoundtableClue(commit)
    if (exact) finishRoundtable(pid)
  }
  function rejectRoundtable(pid, message) {
    const payload = { phase: 'roundtable-reject', round: room.round, pid, message }
    Net.send('turn', payload); applyRoundtableReject(payload)
  }
  function applyRoundtableReject(payload) {
    if (!room || String(payload.pid) !== room.me.pid || Number(payload.round) !== room.round) return
    room.roundtablePending = false; renderRoundTable(); TW.toast(String(payload.message || '다시 시도해 주세요'))
  }
  function applyRoundtableClue(payload) {
    if (!room || room.kind !== 'roundtable' || Number(payload.round) !== room.round || payload.phase !== 'roundtable-clue-commit') return
    let guess
    try { guess = Array.from(H.decode(String(payload.guess || ''))) } catch (e) { return }
    const marks = decodeMarks(payload.marks); const pid = String(payload.pid || '')
    if (!room.activePids.has(pid) || guess.length !== room.size || !marks) return
    const expected = H.score(guess, Array.from(H.decompose(room.answer)))
    if (expected.some((mark, index) => mark !== marks[index])) return
    room.roundtableRows.push({ pid, guess, marks }); room.roundtableLocked.delete(pid)
    room.roundtablePending = false
    if (pid === room.me.pid) TW.clearCurrent?.()
    if (!payload.won) room.turnPid = String(payload.nextPid || roundtableNext(pid) || '')
    renderRoundTable(); renderBanner(); scheduleRoundtableSkip(); persistRoom()
  }
  function submitRoundtableChallenge(value) {
    if (!room || room.kind !== 'roundtable' || room.over || room.roundtablePending || room.roundtableLocked.has(room.me.pid) || !room.activePids.has(room.me.pid)) return
    const word = roundtableWord(value)
    if (!word.valid) return TW.toast(`자모 ${room.size}칸${room.roundtableFreeWords ? '을 모두' : '의 사전 단어를'} 입력해 주세요`)
    room.roundtablePending = true; renderRoundTable()
    const payload = { phase: 'roundtable-answer-submit', round: room.round, pid: room.me.pid, guess: H.encode(word.guess) }
    if (room.host) processRoundtableChallenge(payload); else Net.send('turn', payload)
  }
  function processRoundtableChallenge(payload) {
    if (!room?.host || room.kind !== 'roundtable' || room.over || payload.phase !== 'roundtable-answer-submit' || Number(payload.round) !== room.round) return
    const pid = String(payload.pid || '')
    if (!room.activePids.has(pid) || room.roundtableLocked.has(pid)) return rejectRoundtable(pid, '아직 정답에 다시 도전할 수 없어요')
    let guess
    try { guess = Array.from(H.decode(String(payload.guess || ''))) } catch (e) { return rejectRoundtable(pid, '단어를 다시 입력해 주세요') }
    const exact = guess.join('') === Array.from(H.decompose(room.answer) || '').join('')
    if (guess.length !== room.size || !room.roundtableFreeWords && !exact && !TW.isValid(guess)) return rejectRoundtable(pid, room.roundtableFreeWords ? `자모 ${room.size}칸을 입력해 주세요` : '사전에 있는 단어를 입력해 주세요')
    if (exact) return finishRoundtable(pid)
    const failed = { phase: 'roundtable-answer-failed', round: room.round, pid }
    Net.send('turn', failed); applyRoundtableChallengeFailed(failed)
  }
  function applyRoundtableChallengeFailed(payload) {
    if (!room || room.kind !== 'roundtable' || Number(payload.round) !== room.round) return
    const pid = String(payload.pid || '')
    if (!room.activePids.has(pid)) return
    room.roundtableLocked.add(pid)
    if (pid === room.me.pid) room.roundtablePending = false
    if (pid === room.me.pid) TW.clearCurrent?.()
    renderRoundTable(); TW.toast(`${playerName(pid)}님 정답 도전 실패!`, 2200); persistRoom()
  }
  function finishRoundtable(winnerPid = null) {
    if (!room?.host || room.kind !== 'roundtable' || room.over) return
    room.over = true; room.roundtableWinner = winnerPid ? String(winnerPid) : null; clearTimeout(skipTimer)
    const payload = { round: room.round, roundtable: true, winnerPid: room.roundtableWinner, word: room.answer, rows: room.roundtableRows.map((entry) => ({ pid: entry.pid, guess: H.encode(entry.guess), marks: encodeMarks(entry.marks) })) }
    Net.send('over', payload); TW.applyRemote(() => showRoundtableResult(payload))
  }
  function showRoundtableResult(payload) {
    if (!room || room.kind !== 'roundtable') return
    room.over = true; room.roundtableWinner = payload.winnerPid ? String(payload.winnerPid) : null; room.resultSheet = 'roundtableresult'; room.answer = String(payload.word || room.answer)
    if (Array.isArray(payload.rows)) room.roundtableRows = payload.rows.flatMap((entry) => {
      try { const guess = Array.from(H.decode(String(entry.guess || ''))); const marks = decodeMarks(entry.marks); return guess.length === room.size && marks ? [{ pid: String(entry.pid), guess, marks }] : [] } catch (e) { return [] }
    })
    room.roundtablePending = false; clearTimeout(skipTimer); clearInterval(timer)
    renderRoundTable(); $('#roundtableAction').hidden = true; $('#keyboard').hidden = true; $('.board-wrap').hidden = true
    renderBanner(); renderQuickChat(); persistRoom(); TW.endRoomGame(); TW.openSheet('roundtableresult')
  }
  function scheduleRoundtableSkip() {
    clearTimeout(skipTimer)
    if (!room?.host || room.kind !== 'roundtable' || room.over || room.peers.get(room.turnPid)?.online) return
    const skippedPid = room.turnPid
    skipTimer = setTimeout(() => {
      if (!room?.host || room.over || room.turnPid !== skippedPid || room.peers.get(skippedPid)?.online) return
      const payload = { phase: 'roundtable-skip', round: room.round, pid: skippedPid, nextPid: roundtableNext(skippedPid, true) }
      Net.send('turn', payload); applyRoundtableSkip(payload)
    }, 10000)
  }
  function applyRoundtableSkip(payload) {
    if (!room || room.kind !== 'roundtable' || room.over || Number(payload.round) !== room.round || String(payload.pid) !== room.turnPid) return
    room.turnPid = String(payload.nextPid || ''); room.roundtablePending = false; renderRoundTable(); renderBanner(); scheduleRoundtableSkip()
  }
  function submitCoop(guess) {
    if (!room || room.kind !== 'coop' && room.kind !== 'roundtable' && !isTeamMode()) return false
    if (room.kind === 'roundtable') {
      if (!canPlay()) { blockedInput(); return true }
      if (room.turnPid === room.me.pid) submitRoundtableClue(guess)
      else submitRoundtableChallenge(guess)
      return true
    }
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
  function repeatedTeamGuess(team, guess) {
    const encoded = H.encode(guess)
    return room.teamBoards[team].some((entry) => H.encode(entry.guess) === encoded)
  }
  function submitTeam(guess) {
    if (!canPlay()) { blockedInput(); return true }
    const team = room.teams.get(room.me.pid)
    if (room.kind === 'spy' && room.isSpy && repeatedTeamGuess(team, guess)) {
      TW.toast('스파이는 팀에서 이미 입력한 단어를 다시 낼 수 없어요', 2400)
      return true
    }
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
    if (room.kind === 'spy' && Object.values(room.spies).includes(pid) && repeatedTeamGuess(team, guess)) {
      const rejected = { phase: 'team-reject', round: room.round, team, pid, reason: 'duplicate' }
      Net.send('turn', rejected); applyTeamReject(rejected); return
    }
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
    if (room.kind === 'spy' && Object.values(room.spies).includes(pid) && repeatedTeamGuess(team, guess)) return
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
  function applyTeamReject(payload) {
    if (!room || payload.phase !== 'team-reject' || Number(payload.round) !== room.round || String(payload.pid) !== room.me.pid) return
    room.teamPending = false; renderBanner()
    if (payload.reason === 'duplicate') TW.toast('스파이는 팀에서 이미 입력한 단어를 다시 낼 수 없어요', 2400)
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
    maybeFinishTeamFinal(team)
  }
  function onTeamFinalAck(payload) {
    const team = payload.team; const state = room?.teamFinals?.[team]; const pid = String(payload.pid || '')
    if (!state?.active || Number(payload.round) !== room.round || room.teams.get(pid) !== team || room.kind === 'spy' && Object.values(room.spies).includes(pid) || state.submitted.has(pid)) return
    state.results.set(pid, { pid, status: payload.status === 'won' ? 'won' : 'lost', ms: Math.max(0, Number(payload.ms) || 0) }); state.submitted.add(pid)
    if (pid === room.me.pid) state.localPending = false
    renderFinalChance(); persistRoom(); maybeFinishTeamFinal(payload.team)
  }
  function maybeFinishTeamFinal(team) {
    const state = room?.teamFinals?.[team]
    if (!room?.host || !state?.active) return
    const waitingOnline = teamFinalMembers(team).some((pid) => room.peers.get(pid)?.online && !state.submitted.has(pid))
    if (!waitingOnline) finishTeamFinal(team)
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
    if (room.host) afterTeamTerminal(payload.team)
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
    maybeFinishFinalChance()
  }
  function onFinalAck(payload) {
    if (!room?.finalChance?.active || Number(payload.round) !== room.round) return
    const pid = String(payload.pid)
    if (!room.activePids.has(pid) || room.finalChance.submitted.has(pid)) return
    room.finalChance.results.set(pid, { pid, status: payload.status === 'won' ? 'won' : 'lost', ms: Math.max(0, Number(payload.ms) || 0) })
    room.finalChance.submitted.add(pid)
    if (pid === room.me.pid) room.finalChance.localPending = false
    renderFinalChance(); persistRoom(); maybeFinishFinalChance()
  }
  function maybeFinishFinalChance() {
    if (!room?.host || !room.finalChance?.active) return
    const waitingOnline = Array.from(room.activePids).some((pid) => room.peers.get(pid)?.online && !room.finalChance.submitted.has(pid))
    if (!waitingOnline) finishFinalChance()
  }
  function onTurn(payload) {
    if (!room || !room.startedAt || room.over) return
    if (room.kind === 'roundtable') {
      if (payload.phase === 'roundtable-clue-submit') return TW.applyRemote(() => processRoundtableClue(payload))
      if (payload.phase === 'roundtable-clue-commit') return applyRoundtableClue(payload)
      if (payload.phase === 'roundtable-reject') return applyRoundtableReject(payload)
      if (payload.phase === 'roundtable-answer-submit') return TW.applyRemote(() => processRoundtableChallenge(payload))
      if (payload.phase === 'roundtable-answer-failed') return applyRoundtableChallengeFailed(payload)
      if (payload.phase === 'roundtable-skip') return applyRoundtableSkip(payload)
      return
    }
    if (room.kind === 'tournament') {
      const ms = Math.max(0, Date.now() - room.startedAt)
      for (const pair of room.tournamentPairs) {
        if (room.over || room.tournamentMatches.has(tournamentPairKey(pair))) continue
        const unresolved = pair.filter((pid) => !room.results.has(pid))
        if (unresolved.some((pid) => room.peers.get(pid)?.online)) continue
        for (const pid of unresolved) room.results.set(pid, { pid, status: 'lost', tries: TW.MAX_TRIES, ms, disconnected: true })
        const trigger = pair.map((pid) => room.results.get(pid)).find((result) => result?.status === 'won') || room.results.get(pair[0])
        if (trigger) processTournamentDone(trigger)
      }
      return
    }
    if (room.kind === 'tournament') {
      if (payload.phase === 'tournament-match') applyTournamentMatch(payload)
      return
    }
    if (isTeamMode()) {
      if (payload.phase === 'team-submit') return TW.applyRemote(() => processTeamSubmit(payload))
      if (payload.phase === 'team-reject') return applyTeamReject(payload)
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
    else settleDisconnectedPlayers()
  }
  function settleDisconnectedPlayers() {
    if (!room?.host || !room.startedAt || room.over) return
    if (room.kind === 'coop') {
      if (room.finalChance?.active) maybeFinishFinalChance()
      return
    }
    if (isTeamMode()) {
      for (const team of ['red', 'blue']) {
        if (room.teamFinals[team]?.active) maybeFinishTeamFinal(team)
        if (room.teamStatus[team] === 'playing' && !teamMembers(team, true).length) {
          const payload = { phase: 'team-force', round: room.round, team }
          Net.send('turn', payload); applyTeamForce(payload)
        }
      }
      return
    }
    const unresolved = Array.from(room.activePids).filter((pid) => !room.results.has(pid))
    if (!unresolved.length || unresolved.some((pid) => room.peers.get(pid)?.online)) return
    const ms = Math.max(0, Date.now() - room.startedAt)
    for (const pid of unresolved) room.results.set(pid, { pid, status: 'lost', tries: TW.MAX_TRIES, ms, disconnected: true })
    finishRound()
  }
  function forceRound() {
    if (!room?.host || room.over) return
    if (room.kind === 'roundtable') return finishRoundtable(null)
    if (room.kind === 'coop') return room.finalChance?.active ? finishFinalChance() : finishCoop('lost', TW.state?.guesses.length || 0)
    if (isTeamMode()) {
      for (const team of ['red', 'blue']) if (room.teamStatus[team] === 'playing') { room.teamStatus[team] = 'lost'; room.teamTurns[team] = null }
      return finishTeamMatch()
    }
    const ms = Date.now() - room.startedAt
    for (const pid of room.activePids) if (!room.results.has(pid)) room.results.set(pid, { pid, status: 'lost', tries: TW.MAX_TRIES, ms })
    if (room.kind === 'tournament') {
      for (const pair of room.tournamentPairs) {
        if (room.over || room.tournamentMatches.has(tournamentPairKey(pair))) continue
        processTournamentDone(room.results.get(pair[0]))
      }
      return
    }
    finishRound()
  }
  function finishRound() {
    if (!room || room.over) return
    room.over = true; clearTimeout(waitTimer); room.waitEndsAt = null
    const scores = Array.from(room.results.values())
    if (room.kind === 'captain') {
      const ranked = sortedResults(scores)
      const wrong = ranked.filter((result) => result.status !== 'won').map((result) => result.pid)
      const winners = ranked.filter((result) => result.status === 'won')
      const extraDropCount = Math.min(Math.max(0, room.eliminateCount - wrong.length), Math.max(0, winners.length - 1))
      const eliminated = Array.from(new Set([...wrong, ...winners.slice(winners.length - extraDropCount).map((result) => result.pid)]))
      room.captainEliminated = eliminated
      room.captainAlive = winners.filter((result) => !eliminated.includes(result.pid)).map((result) => result.pid)
      room.captainChampion = room.captainAlive.length === 1 ? room.captainAlive[0] : null
      const payload = { round: room.round, scores, totals: {}, final: room.captainAlive.length <= 1, captain: true, eliminated, alive: room.captainAlive, champion: room.captainChampion, eliminateCount: room.eliminateCount }
      Net.send('over', payload); TW.applyRemote(() => showScoreboard(scores, payload.final, payload)); return
    }
    if (room.kind === 'tournament') {
      recordTournamentRound()
      const advances = Array.from(room.tournamentMatches.values(), (match) => match.winner)
      const eliminated = Array.from(room.tournamentMatches.values(), (match) => match.loser)
      advances.push(...room.tournamentByes)
      room.tournamentAlive = Array.from(new Set(advances)); room.tournamentEliminated = eliminated
      room.tournamentChampion = room.tournamentAlive.length === 1 ? room.tournamentAlive[0] : null
      room.tournamentNextAt = room.tournamentChampion ? null : Date.now() + 10000
      const payload = { round: room.round, scores, totals: {}, final: Boolean(room.tournamentChampion), tournament: true, pairs: room.tournamentPairs, byes: room.tournamentByes, words: room.tournamentWords, matches: Array.from(room.tournamentMatches.values()), ready: Array.from(room.tournamentReady), nextAt: room.tournamentNextAt, eliminated, alive: room.tournamentAlive, champion: room.tournamentChampion, tournamentSeed: room.tournamentSeed, tournamentRounds: room.tournamentRounds }
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
    if (room.kind === 'roundtable' || payload.roundtable) return TW.applyRemote(() => showRoundtableResult(payload))
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
    if (room.kind === 'tournament' || meta.tournament) {
      room.tournamentPairs = (Array.isArray(meta.pairs) ? meta.pairs : Array.isArray(meta.tournamentPairs) ? meta.tournamentPairs : room.tournamentPairs).flatMap((pair) => Array.isArray(pair) && pair.length === 2 ? [[String(pair[0]), String(pair[1])]] : [])
      room.tournamentByes = (Array.isArray(meta.byes) ? meta.byes : Array.isArray(meta.tournamentByes) ? meta.tournamentByes : room.tournamentByes).map(String)
      room.tournamentEliminated = (Array.isArray(meta.eliminated) ? meta.eliminated : Array.isArray(meta.tournamentEliminated) ? meta.tournamentEliminated : []).map(String)
      room.tournamentAlive = (Array.isArray(meta.alive) ? meta.alive : Array.isArray(meta.tournamentAlive) ? meta.tournamentAlive : room.tournamentAlive).map(String)
      room.tournamentWords = Object.fromEntries(Object.entries(meta.words || meta.tournamentWords || room.tournamentWords).map(([pid, word]) => [String(pid), String(word)]))
      room.tournamentMatches = new Map((Array.isArray(meta.matches) ? meta.matches : Array.isArray(meta.tournamentMatches) ? meta.tournamentMatches : Array.from(room.tournamentMatches.values())).map((match) => [tournamentPairKey(match.pair), { ...match, pair: match.pair.map(String), winner: String(match.winner), loser: String(match.loser) }]))
      room.tournamentReady = new Set((Array.isArray(meta.ready) ? meta.ready : Array.isArray(meta.tournamentReady) ? meta.tournamentReady : Array.from(room.tournamentReady)).map(String))
      room.tournamentNextAt = Number(meta.nextAt || meta.tournamentNextAt) || null
      const champion = meta.champion || meta.tournamentChampion
      room.tournamentChampion = champion ? String(champion) : null
      room.tournamentSeed = Array.from(new Set((Array.isArray(meta.tournamentSeed) ? meta.tournamentSeed : room.tournamentSeed).map(String)))
      room.tournamentRounds = normalizeTournamentRounds(meta.tournamentRounds ?? room.tournamentRounds)
    }
    room.waitEndsAt = null; $('#quickChat').hidden = true
    TW.endRoomGame(); renderBanner(); persistRoom(); TW.openSheet('scoreboard')
    if (room.kind === 'relay' && !room.final && room.host) nextTimer = setTimeout(nextRound, 10000)
    if (room.kind === 'tournament' && !room.tournamentChampion && room.host) {
      clearTimeout(nextTimer); nextTimer = setTimeout(nextRound, Math.max(0, (room.tournamentNextAt || Date.now() + 10000) - Date.now()))
      setTimeout(maybeAdvanceTournament, 0)
    }
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

  function crownedName(name) {
    return `<span class="winner-name"><span class="winner-crown" aria-hidden="true">👑</span>${esc(name)}</span>`
  }
  function celebration(show) {
    if (!show) return ''
    const pieces = Array.from({ length: 14 }, (_, i) => `<i style="--x:${5 + i * 7}%;--delay:${(i * .035).toFixed(3)}s;--drift:${(i % 2 ? 1 : -1) * (10 + i)}px"></i>`).join('')
    return `<div class="result-celebration" aria-hidden="true">${pieces}</div>`
  }
  function sameResultRank(a, b) {
    return Boolean(a && b && a.status === b.status && (a.ms ?? null) === (b.ms ?? null) && (a.tries ?? null) === (b.tries ?? null))
  }

  TW.SHEETS.scoreboard = () => {
    if (!room) return '<h2>결과를 찾지 못했어요</h2>'
    if (isTeamMode()) {
      const results = room.teamResult || []
      const winner = room.teamWinner
      const myTeam = room.teams.get(room.me.pid)
      const personalWin = winner && (room.isSpy ? winner !== myTeam : winner === myTeam)
      const personalTitle = room.kind === 'spy' ? personalWin ? room.isSpy ? '스파이 개인 승리!' : '팀원 승리!' : winner ? room.isSpy ? '스파이 작전 실패' : '이번에는 패배했어요' : '무승부' : winner ? `${TEAM_NAMES[winner]} 승리!` : '무승부'
      return `${celebration(Boolean(winner))}<h2>${personalTitle}</h2>
        <div class="answer-reveal"><b>${room.kind === 'teamsetter' ? `빨강팀 문제 ${esc(room.teamAnswers?.red || '')} · 파랑팀 문제 ${esc(room.teamAnswers?.blue || '')}` : esc(room.answer || '')}</b><span>${MODES[room.kind]} · ${room.size}칸${winner ? ` · ${TEAM_NAMES[winner]} 승리` : ''}</span></div>
        <ol class="score-list team-score">${results.map((result, index) => {
          const members = teamMembers(result.team).map((pid) => playerName(pid)).join(', ')
          const spy = room.kind === 'spy' ? room.spies[result.team] : null
          const roster = `${members}${spy ? ` · 스파이: ${playerName(spy)}` : ''}`
          const outcome = result.status === 'won' ? `정규 ${result.tries}번째 성공 · ${(result.ms / 1000).toFixed(1)}초` : result.status === 'final' ? `마지막 기회 ${result.correctCount}/${result.total}명 · 정답률 ${Math.round(result.accuracy * 100)}%` : '정답자 없음'
          const teamWon = winner === result.team
          return `<li class="${result.team}${teamWon ? ' winner' : ''}"><strong>${teamWon ? '1' : winner ? '2' : '—'}</strong><b>${teamWon ? crownedName(TEAM_NAMES[result.team]) : esc(TEAM_NAMES[result.team])}<small>${esc(roster)}</small></b><span>${outcome}</span></li>`
        }).join('')}</ol>${room.kind === 'spy' ? `<p class="muted spy-reveal">${room.isSpy ? `내가 들어간 ${TEAM_NAMES[myTeam]}이 ${winner === myTeam ? '이겨서 작전 실패' : winner ? '져서 작전 성공' : '비겨서 작전 실패'}했어요.` : '게임 종료 후 양 팀의 스파이를 공개했어요.'}</p>` : ''}<div class="sheet-actions">${rematchControls()}<button class="btn accent" data-act="room-copy-result">결과 복사하기</button><button class="btn ghost" data-go="leave">나가기</button></div>`
    }
    if (room.kind === 'coop') {
      const won = room.coopResult?.status === 'won'
      const winner = room.coopResult?.winnerPid ? playerName(room.coopResult.winnerPid) : null
      const finalResults = (room.coopResult?.finalResults || []).slice().sort((a, b) => a.status === 'won' && b.status !== 'won' ? -1 : a.status !== 'won' && b.status === 'won' ? 1 : a.status === 'won' ? a.ms - b.ms : room.participants.indexOf(a.pid) - room.participants.indexOf(b.pid))
      const winnerCount = finalResults.filter((result) => result.status === 'won').length
      const soloWin = finalResults.length === 1 && winnerCount === 1
      const fastestMs = finalResults.find((result) => result.status === 'won')?.ms
      const fastestCount = finalResults.filter((result) => result.status === 'won' && result.ms === fastestMs).length
      const title = soloWin ? '마지막 기회 성공!' : fastestCount > 1 ? '공동 1위!' : winner ? `${crownedName(winner)}님 1위!` : won ? '함께 맞혔어요!' : '이번에는 아쉬워요'
      const detail = room.coopResult?.finalChance ? `정규 ${room.maxTries}회 실패 후 마지막 기회 · ${winnerCount}/${finalResults.length}명 정답` : soloWin ? '마지막 기회에서 정답을 맞혔어요' : winner ? `정답자 ${winnerCount}명 · 빠른 순서` : won ? `${room.coopResult.tries}/${room.maxTries}번 만에 성공` : `정답 · ${room.size}칸`
      let seenWinners = 0; let rank = 0; let previousMs = null
      const ranking = room.coopResult?.finalChance ? `<ol class="score-list">${finalResults.map((result) => {
        if (result.status === 'won') {
          if (result.ms !== previousMs) rank = seenWinners + 1
          seenWinners++; previousMs = result.ms
        }
        const place = result.status === 'won' ? rank : '—'
        const outcome = result.status === 'won' ? `${(result.ms / 1000).toFixed(1)}초` : result.status === 'timeout' ? '미제출' : '오답'
        const first = place === 1
        return `<li class="${first ? 'winner' : ''}"><strong>${place}</strong><b>${first ? crownedName(playerName(result.pid)) : esc(playerName(result.pid))}${result.pid === room.me.pid ? ' (나)' : ''}</b><span>${outcome}</span></li>`
      }).join('')}</ol>` : ''
      return `${celebration(won)}<h2>${title}</h2><div class="answer-reveal"><b>${esc(room.answer || '')}</b><span>${detail}</span></div>${ranking}<div class="sheet-actions">${rematchControls()}<button class="btn ghost" data-go="leave">나가기</button></div>`
    }
    if (room.kind === 'captain') {
      const names = displayNames(); const champion = room.captainChampion
      const hostEliminated = room.host && room.captainEliminated.includes(room.me.pid)
      const roundWinner = champion || room.scoreResults.find((result) => room.captainAlive.includes(result.pid))?.pid
      const ended = room.captainAlive.length <= 1
      const title = champion ? `${crownedName(playerName(champion))}님이 최후의 생존자!` : !room.captainAlive.length ? '전원 탈락!' : hostEliminated ? '탈락했지만 방장으로 남아있어요' : `${room.round}판 종료 · ${room.captainAlive.length}명 생존`
      return `${celebration(Boolean(roundWinner))}<h2>${title}</h2>${hostEliminated && !ended ? '<p class="muted">방을 나가지 않았어요. 다음 판을 시작하고 끝까지 관전할 수 있습니다.</p>' : ''}<div class="answer-reveal"><b>${esc(room.answer || '')}</b><span>${room.captainEliminated.length ? `이번 판 탈락: ${room.captainEliminated.map((pid) => esc(playerName(pid))).join(', ')}` : '탈락자 없음'}</span></div>
        <ol class="score-list">${room.scoreResults.map((r, i) => { const first = r.pid === roundWinner; const eliminated = room.captainEliminated.includes(r.pid); const outcome = r.disconnected ? '연결 종료 · 자동 탈락' : r.status === 'won' ? `${(r.ms / 1000).toFixed(1)}초 · ${r.tries}/${TW.MAX_TRIES}` : '오답 · 탈락'; return `<li class="${eliminated ? 'eliminated ' : ''}${first ? 'winner' : ''}"><strong>${first ? 1 : i + 1}</strong><b>${first ? crownedName(names.get(r.pid) || '나간 참가자') : esc(names.get(r.pid) || '나간 참가자')}${eliminated ? ' · 탈락' : ' · 생존'}</b><span>${outcome}</span></li>` }).join('')}</ol>
        <div class="sheet-actions">${ended ? rematchControls() : room.host ? '<button class="btn primary" data-act="room-next">생존자 다음 판</button>' : '<p class="muted">방장이 다음 판을 시작하기를 기다리는 중…</p>'}<button class="btn ghost" data-go="leave">나가기</button></div>`
    }
    if (room.kind === 'tournament') {
      const champion = room.tournamentChampion
      const title = champion ? `${crownedName(playerName(champion))}님 토너먼트 우승!` : `${room.round}라운드 종료 · ${room.tournamentAlive.length}명 진출`
      const ready = room.tournamentAlive.filter((pid) => room.tournamentReady.has(pid)).length
      const total = room.tournamentAlive.length
      const amAlive = room.tournamentAlive.includes(room.me.pid)
      const amReady = room.tournamentReady.has(room.me.pid)
      const controls = champion ? rematchControls() : `${amAlive ? `<button class="btn primary" data-act="room-tournament-ready" ${amReady ? 'disabled' : ''}>${amReady ? '준비 완료' : '다음 라운드 준비 완료'} · ${ready}/${total}</button>` : `<p class="muted">진출자 준비 ${ready}/${total} · 남은 경기를 관전합니다.</p>`}<p class="tournament-countdown">전원 준비 시 바로 시작 · 늦어도 10초 후 자동 시작</p>`
      return `${celebration(Boolean(champion))}<h2>${title}</h2><p class="muted">참가자는 아래에서 시작하고, 승자는 연결선을 따라 위 라운드로 올라갑니다.</p>${renderTournamentTree()}
        <div class="sheet-actions">${controls}<button class="btn ghost" data-go="leave">나가기</button></div>`
    }
    const names = displayNames(); const relay = room.kind === 'relay'
    const topResult = room.scoreResults[0]
    return `${celebration(Boolean(topResult))}<h2>${relay ? `${room.round}/${room.roundsTotal} 라운드 결과` : '대결 결과'}</h2>
      <div class="answer-reveal"><b>${esc(room.answer || '')}</b><span>${room.size}칸</span></div>
      <ol class="score-list">${room.scoreResults.map((r, i) => { const first = sameResultRank(r, topResult); return `<li class="${first ? 'winner' : ''}"><strong>${first ? 1 : i + 1}</strong><b>${first ? crownedName(names.get(r.pid) || '나간 참가자') : esc(names.get(r.pid) || '나간 참가자')}</b><span>${r.status === 'won' ? `${(r.ms / 1000).toFixed(1)}초 · ${r.tries}/${TW.MAX_TRIES}` : `X/${TW.MAX_TRIES}`}</span></li>` }).join('')}</ol>
      <div class="sheet-actions">${relay && room.final ? '<button class="btn primary" data-act="room-standings">최종 순위 보기</button>' : relay && room.host ? '<button class="btn primary" data-act="room-next">다음 라운드</button>' : relay ? '<p class="muted">방장이 다음 라운드를 시작하기를 기다리는 중…</p>' : rematchControls()}<button class="btn accent" data-act="room-copy-result">결과 복사하기</button><button class="btn ghost" data-go="leave">나가기</button></div>`
  }
  TW.SHEETS.standings = () => {
    if (!room) return '<h2>순위를 찾지 못했어요</h2>'
    const names = displayNames()
    const list = Array.from(room.totals, ([pid, points]) => ({ pid, points: Number(points) || 0 })).sort((a, b) => b.points - a.points || (names.get(a.pid) || '').localeCompare(names.get(b.pid) || ''))
    const topPoints = list[0]?.points
    let previousPoints = null; let place = 0
    const rows = list.map((e, i) => {
      if (e.points !== previousPoints) place = i + 1
      previousPoints = e.points
      const first = place === 1
      return `<li class="${first ? 'winner' : ''}"><strong>${place}</strong><b>${first ? crownedName(names.get(e.pid) || '나간 참가자') : esc(names.get(e.pid) || '나간 참가자')}</b><span>${e.points}점</span></li>`
    }).join('')
    return `${celebration(list.length > 0 && topPoints !== undefined)}<h2>최종 순위</h2><ol class="score-list">${rows}</ol><div class="sheet-actions">${rematchControls()}<button class="btn ghost" data-go="leave">나가기</button></div>`
  }
  function showStandings() { if (room) { room.resultSheet = 'standings'; TW.openSheet('standings') } }
  function nextRound() {
    if (!room?.host || !['relay', 'captain', 'tournament'].includes(room.kind) || room.kind === 'relay' && room.round >= room.roundsTotal || room.kind === 'captain' && room.captainAlive.length <= 1 || room.kind === 'tournament' && room.tournamentChampion) return
    clearTimeout(nextTimer); room.round++; room.startedAt = null; room.over = false; TW.closeSheet(); startRound()
  }
  function requestTournamentReady() {
    if (!room || room.kind !== 'tournament' || room.tournamentChampion || room.tournamentReady.has(room.me.pid)) return
    const match = tournamentMatchFor(room.me.pid)
    if (room.over ? !room.tournamentAlive.includes(room.me.pid) : !match || match.winner !== room.me.pid) return
    const payload = { phase: 'tournament-ready', round: room.round, pid: room.me.pid }
    if (room.host) processTournamentReady(payload)
    else Net.send('ready', payload)
  }
  function processTournamentReady(payload) {
    if (!room?.host || room.kind !== 'tournament' || room.tournamentChampion || payload.phase !== 'tournament-ready' || Number(payload.round) !== room.round) return
    const pid = String(payload.pid || '')
    const match = tournamentMatchFor(pid)
    if (room.over ? !room.tournamentAlive.includes(pid) : !match || match.winner !== pid) return
    const peer = room.peers.get(pid)
    if (peer) peer.online = true
    room.tournamentReady.add(pid); publishTournamentReadyState()
  }
  function publishTournamentReadyState() {
    if (!room?.host || room.kind !== 'tournament' || room.tournamentChampion) return
    const eligible = room.over ? room.tournamentAlive : Array.from(room.tournamentMatches.values(), (match) => match.winner)
    room.tournamentReady = new Set(Array.from(room.tournamentReady).filter((pid) => eligible.includes(pid)))
    const payload = { phase: 'tournament-ready-state', round: room.round, ready: Array.from(room.tournamentReady) }
    Net.send('ready', payload); applyTournamentReadyState(payload)
  }
  function applyTournamentReadyState(payload) {
    if (!room || room.kind !== 'tournament' || payload.phase !== 'tournament-ready-state' || Number(payload.round) !== room.round) return
    room.tournamentReady = new Set((Array.isArray(payload.ready) ? payload.ready : []).map(String))
    if (room.over) TW.openSheet('scoreboard')
    else if (tournamentMatchFor(room.me.pid)) TW.openSheet('tournamentmatch')
    persistRoom(); maybeAdvanceTournament()
  }
  function maybeAdvanceTournament() {
    if (!room?.host || room.kind !== 'tournament' || !room.over || room.tournamentChampion || !room.tournamentAlive.length) return
    if (room.tournamentAlive.every((pid) => room.tournamentReady.has(pid))) {
      clearTimeout(nextTimer); nextRound()
    }
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
    room.tournamentAlive = []; room.tournamentPairs = []; room.tournamentByes = []; room.tournamentEliminated = []; room.tournamentChampion = null; room.tournamentSeed = []; room.tournamentRounds = []
    room.tournamentWords = {}; room.tournamentMatches = new Map(); room.tournamentReady = new Set(); room.tournamentNextAt = null
    room.roundtableSeats = []; room.roundtableRows = []; room.roundtableLocked = new Set(); room.roundtableWinner = null; room.roundtablePending = false
    room.participants = []; room.activePids = new Set(); room.turnPid = null; room.pick = null; room.me.role = 'player'
    document.body.classList.remove('watching', 'roundtable-playing'); $('#roundTable').hidden = true; $('#roundtableAction').hidden = true; showLobby(); persistRoom(); broadcastLobby()
  }
  function onReady(payload) {
    if (!room) return
    if (payload.phase === 'tournament-ready') return processTournamentReady(payload)
    if (payload.phase === 'tournament-ready-state') return applyTournamentReadyState(payload)
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
    const myPair = room.kind === 'tournament' ? room.tournamentPairs.find((pair) => pair.includes(room.me.pid)) : null
    const list = orderedPlayers().filter((p) => (room.activePids.has(p.pid) || p.status === 'playing') && (room.me.role === 'setter' || p.pid !== room.me.pid) && (room.kind !== 'tournament' || room.me.role !== 'player' || myPair?.includes(p.pid)))
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
  function wireRoundtableState() {
    if (!room || room.kind !== 'roundtable') return null
    return { seats: room.roundtableSeats, turnPid: room.turnPid, freeWords: room.roundtableFreeWords, locked: Array.from(room.roundtableLocked), winnerPid: room.roundtableWinner, rows: room.roundtableRows.map((entry) => ({ pid: entry.pid, guess: H.encode(entry.guess), marks: encodeMarks(entry.marks) })) }
  }
  function applyRoundtableSync(state) {
    if (!room || room.kind !== 'roundtable' || !state) return
    room.roundtableSeats = Array.from(new Set((state.seats || []).map(String))).filter((pid) => room.activePids.has(pid))
    room.roundtableFreeWords = Boolean(state.freeWords)
    room.turnPid = String(state.turnPid || room.roundtableSeats[0] || ''); room.roundtableLocked = new Set((state.locked || []).map(String)); room.roundtableWinner = state.winnerPid ? String(state.winnerPid) : null
    room.roundtableRows = (state.rows || []).flatMap((entry) => {
      try { const guess = Array.from(H.decode(String(entry.guess || ''))); const marks = decodeMarks(entry.marks); return guess.length === room.size && marks ? [{ pid: String(entry.pid), guess, marks }] : [] } catch (e) { return [] }
    })
    room.roundtablePending = false; renderRoundTable(); renderBanner(); scheduleRoundtableSkip(); persistRoom()
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
      tournament: room.kind === 'tournament', tournamentAlive: room.tournamentAlive, tournamentPairs: room.tournamentPairs, tournamentByes: room.tournamentByes, tournamentEliminated: room.tournamentEliminated, tournamentChampion: room.tournamentChampion,
      tournamentWords: room.tournamentWords, tournamentMatches: Array.from(room.tournamentMatches.values()), tournamentReady: Array.from(room.tournamentReady), tournamentNextAt: room.tournamentNextAt,
      tournamentSeed: room.tournamentSeed, tournamentRounds: room.tournamentRounds,
      roundtable: room.kind === 'roundtable', roundtableSeats: room.roundtableSeats, roundtableFreeWords: room.roundtableFreeWords, roundtableState: wireRoundtableState(), winnerPid: room.roundtableWinner, rows: room.kind === 'roundtable' ? wireRoundtableState()?.rows : null,
      readyState: room.over ? room.kind === 'tournament' && !room.tournamentChampion
        ? { phase: 'tournament-ready-state', round: room.round, ready: Array.from(room.tournamentReady) }
        : { phase: 'state', round: room.round, ready: Array.from(room.readyPids), voters: Array.from(room.readyVoters.size ? room.readyVoters : new Set(onlinePlayers().map((p) => p.pid))) } : null,
      finalChanceState: room.finalChance?.active ? { seconds: Math.max(1, Math.ceil((room.finalChance.endsAt - Date.now()) / 1000)), elapsedMs: Math.max(0, Date.now() - room.finalChance.startedAt), results: Array.from(room.finalChance.results.values()) } : null,
    })
  }
  function onSync(payload) {
    if (!room || payload.pid !== room.me.pid) return
    if (room.startedAt) {
      if (room.over) { if (payload.readyState) payload.readyState.phase === 'tournament-ready-state' ? applyTournamentReadyState(payload.readyState) : applyReadyState(payload.readyState); return }
      if (Number(payload.round) !== room.round || room.kind !== 'coop' && !isTeamMode() && !['captain', 'tournament', 'roundtable'].includes(room.kind)) return
      TW.applyRemote(() => {
        room.participants = validParticipants(payload); room.activePids = new Set(room.participants)
        if (isTeamMode()) return applyTeamSync(payload.teamState)
        if (room.kind === 'tournament') {
          room.tournamentAlive = (payload.tournamentAlive || []).map(String); room.tournamentPairs = payload.tournamentPairs || []; room.tournamentByes = (payload.tournamentByes || []).map(String)
          room.tournamentWords = Object.fromEntries(Object.entries(payload.tournamentWords || {}).map(([pid, word]) => [String(pid), String(word)]))
          room.tournamentMatches = new Map((payload.tournamentMatches || []).map((match) => [tournamentPairKey(match.pair), { ...match, pair: match.pair.map(String), winner: String(match.winner), loser: String(match.loser) }]))
          room.tournamentReady = new Set((payload.tournamentReady || []).map(String)); room.tournamentNextAt = Number(payload.tournamentNextAt) || null
          room.tournamentSeed = Array.from(new Set((payload.tournamentSeed || room.tournamentSeed || []).map(String))); room.tournamentRounds = normalizeTournamentRounds(payload.tournamentRounds ?? room.tournamentRounds)
        }
        if (room.kind === 'roundtable') applyRoundtableSync(payload.roundtableState)
        room.turnPid = String(payload.turnPid || ''); room.coopPending = false
        if (room.kind !== 'roundtable') TW.restoreRoomGame((payload.guesses || []).map((g) => H.decode(String(g))), payload.coopResult?.status || 'playing')
        const tournamentMatch = room.kind === 'tournament' ? tournamentMatchFor(room.me.pid) : null
        if (tournamentMatch) {
          room.me.role = tournamentMatch.winner === room.me.pid ? 'finished' : 'spectator'
          document.body.classList.add('watching'); $('#keyboard').hidden = true; $('.board-wrap').hidden = true
          room.resultSheet = 'tournamentmatch'; TW.endRoomGame(); TW.openSheet('tournamentmatch')
        }
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
    } else if (room.kind === 'roundtable') {
      applyRoundtableSync(payload.roundtableState)
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
    if (payload.over) isTeamMode() ? showTeamResult({ round: room.round, team: true, word: room.answer, teamWords: payload.teamState?.teamWords, winner: payload.teamWinner, results: payload.teamResult || [] }) : room.kind === 'coop' ? showCoopResult(payload.coopResult || payload) : room.kind === 'roundtable' ? showRoundtableResult({ ...payload, rows: payload.rows || payload.roundtableState?.rows }) : showScoreboard(Array.from(room.results.values()), Boolean(payload.final), { ...payload, captain: payload.captain, alive: payload.captainAlive, eliminated: payload.captainEliminated, champion: payload.captainChampion, tournament: payload.tournament, pairs: payload.tournamentPairs, byes: payload.tournamentByes, words: payload.tournamentWords, matches: payload.tournamentMatches, ready: payload.tournamentReady, nextAt: payload.tournamentNextAt })
    if (payload.readyState) payload.readyState.phase === 'tournament-ready-state' ? applyTournamentReadyState(payload.readyState) : applyReadyState(payload.readyState)
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
    const changeMode = event.target.closest('[data-change-room-mode]')
    if (changeMode && room?.host && !room.startedAt && Object.hasOwn(MODES, changeMode.dataset.changeRoomMode)) {
      room.kind = changeMode.dataset.changeRoomMode; room.round = 1; room.roundsTotal = room.kind === 'relay' ? 3 : 1; room.setterPid = room.hostPid
      if (isTeamMode()) randomizeTeams()
      else { room.teamsHidden = false; broadcastLobby(); renderLobby() }
      persistRoom(); TW.openSheet('changemode'); return
    }
    const changeSize = event.target.closest('[data-change-room-size]')
    if (changeSize && room?.host && !room.startedAt) { const size = Number(changeSize.dataset.changeRoomSize); if ([0, ...TW.SIZES].includes(size)) { room.size = size; broadcastLobby(); renderLobby(); persistRoom(); TW.openSheet('changemode') } return }
    const changeFree = event.target.closest('[data-change-roundtable-free]')
    if (changeFree && room?.host && !room.startedAt && room.kind === 'roundtable') { room.roundtableFreeWords = changeFree.dataset.changeRoundtableFree === 'true'; broadcastLobby(); renderLobby(); persistRoom(); TW.openSheet('changemode'); return }
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
    const target = event.target.closest('[data-rmode],[data-rsize],[data-rounds],[data-wait],[data-eliminate],[data-roundtable-free]')
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
    if (target.dataset.roundtableFree !== undefined) draft.roundtableFreeWords = target.dataset.roundtableFree === 'true'
    for (const chip of target.parentElement.querySelectorAll('.chip')) chip.setAttribute('aria-pressed', String(chip === target))
  })
  document.addEventListener('input', (event) => {
    if (event.target.id === 'roomWord') paintSetterWord()
    if (event.target.id === 'finalWord') paintFinalWord()
  })
  document.addEventListener('submit', (event) => {
    const chatForm = event.target.closest('[data-room-chat-form]')
    if (!chatForm) return
    event.preventDefault()
    sendChat(chatForm.querySelector('#roomChatInput')?.value, room?.chatScope)
  })
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return
    if (event.target.id === 'roomJoinCode') TW.ACTIONS['room-join']()
    else if (event.target.id === 'roomNick' && ($('#roomJoinCode')?.value || globalThis.TWRoomHash)) TW.ACTIONS['room-join']()
    else if (event.target.id === 'roomWord' && !$('#roomWordButton')?.disabled) submitSetterWord()
    else if (event.target.id === 'finalWord' && !$('#finalSubmit')?.disabled) submitFinalWord()
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
    else if (resume?.code && resume?.nick) setTimeout(() => enterRoom(resume.code, resume.nick, { kind: resume.kind || 'versus', size: Number(resume.size) || 5, roundsTotal: Number(resume.roundsTotal) || 1, waitSeconds: [0, 30, 60, 90].includes(Number(resume.waitSeconds)) ? Number(resume.waitSeconds) : 60, eliminateCount: [1, 2].includes(Number(resume.eliminateCount)) ? Number(resume.eliminateCount) : 1, roundtableFreeWords: Boolean(resume.roundtableFreeWords) }, resume), 0)
  } else { roomButton.remove(); globalThis.TWRoomHash = null }

  globalThis.Room = {
    get current() { return room },
    localMark, localDone, submitCoop, canPlay, blockedInput,
    allowUnknownGuess: () => Boolean(room?.kind === 'roundtable' && room.roundtableFreeWords),
    keyboardRows: () => room?.kind === 'roundtable' ? room.roundtableRows : null,
    leave: leaveRoom, normalizeCode, repaintPeers: renderPeers,
  }
})()
