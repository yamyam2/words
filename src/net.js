// Supabase Realtime 의 Broadcast + Presence 만 쓰는 작은 Phoenix 채널 클라이언트.
// 네트워크/프로토콜 지식은 이 파일 밖으로 새지 않게 유지한다.
;(function (root, factory) {
  const api = factory(root)
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.Net = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict'

  const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ'
  const APP_EVENTS = ['start', 'mark', 'done', 'over', 'sync?', 'sync!', 'word', 'turn']

  function encodeFrame(frame) { return JSON.stringify(frame) }
  function decodeFrame(text) {
    if (typeof text !== 'string') return null
    try {
      const value = JSON.parse(text)
      return value && typeof value === 'object' && !Array.isArray(value) ? value : null
    } catch (e) { return null }
  }

  function presenceMetas(value) {
    if (!value) return []
    if (Array.isArray(value)) return value
    if (Array.isArray(value.metas)) return value.metas
    return [value]
  }
  function normalizePresence(state) {
    const roster = new Map()
    for (const [key, value] of Object.entries(state || {})) {
      for (const meta of presenceMetas(value)) {
        const pid = String(meta.pid || meta.presence_ref && key || key || '')
        if (!pid) continue
        const joinedAt = Number(meta.joinedAt) || Date.now()
        const prev = roster.get(pid)
        if (!prev || joinedAt < prev.joinedAt) roster.set(pid, {
          pid,
          nick: String(meta.nick || '이름 없음').slice(0, 16),
          joinedAt,
        })
      }
    }
    return roster
  }
  function mergePresence(roster, joins, leaves) {
    const next = new Map(roster instanceof Map ? roster : [])
    const leaving = normalizePresence(leaves)
    for (const pid of leaving.keys()) next.delete(pid)
    const joining = normalizePresence(joins)
    for (const [pid, player] of joining) next.set(pid, player)
    return next
  }
  function electHost(players) {
    return Array.from(players instanceof Map ? players.values() : players || [])
      .filter((p) => p && p.online !== false)
      .sort((a, b) => Number(a.joinedAt) - Number(b.joinedAt) || String(a.pid).localeCompare(String(b.pid)))[0]?.pid || null
  }
  function roomCode(random = Math.random) {
    let code = ''
    for (let i = 0; i < 6; i++) code += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)]
    return code
  }
  function awardPoints(results) {
    const points = [5, 3, 2]
    const ranked = (results || []).slice().sort((a, b) => {
      if (a.status === 'won' && b.status !== 'won') return -1
      if (a.status !== 'won' && b.status === 'won') return 1
      return (a.tries || 99) - (b.tries || 99) || (a.ms || Infinity) - (b.ms || Infinity)
    })
    const out = {}
    let place = 0
    for (const result of ranked) {
      out[result.pid] = result.status === 'won' ? (points[place++] || 1) : 0
    }
    return out
  }

  const cfg = root.TWConfig || { url: '', key: '' }
  const available = Boolean(cfg.url && cfg.key && typeof root.WebSocket === 'function')
  const listeners = new Map()
  let status = available ? 'down' : 'off'
  let socket = null
  let topic = null
  let code = null
  let me = null
  let ref = 0
  let joinRef = null
  let heartbeat = null
  let retryTimer = null
  let retryCount = 0
  let intentional = false
  let roster = new Map()
  const queue = []

  function emit(event, payload) {
    for (const fn of listeners.get(event) || []) {
      try { fn(payload) } catch (e) { setTimeout(() => { throw e }, 0) }
    }
  }
  function setStatus(value) {
    if (status === value) return
    status = value
    emit('status', value)
  }
  function on(event, cb) {
    if (!listeners.has(event)) listeners.set(event, new Set())
    listeners.get(event).add(cb)
    return () => listeners.get(event)?.delete(cb)
  }
  function nextRef() { return String(++ref) }
  function wireUrl() {
    const url = new URL(cfg.url)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.pathname = url.pathname.replace(/\/$/, '') + '/realtime/v1/websocket'
    url.search = ''
    url.searchParams.set('apikey', cfg.key)
    url.searchParams.set('vsn', '1.0.0')
    return url.href
  }
  function push(frame) {
    if (!socket || socket.readyState !== 1) return false
    socket.send(encodeFrame(frame))
    return true
  }
  function broadcast(event, payload) {
    return push({ topic, event: 'broadcast', ref: nextRef(), join_ref: joinRef, payload: {
      type: 'broadcast', event, payload,
    } })
  }
  function flush() {
    while (queue.length && status === 'live') {
      const item = queue.shift()
      if (!broadcast(item.event, item.payload)) { queue.unshift(item); break }
    }
  }
  function publishRoster() { emit('roster', Array.from(roster.values())) }
  function track() {
    push({ topic, event: 'presence', ref: nextRef(), join_ref: joinRef, payload: {
      type: 'presence', event: 'track', payload: {
        nick: me.nick, pid: me.pid, joinedAt: me.joinedAt,
      },
    } })
  }
  function handleMessage(event) {
    const frame = decodeFrame(typeof event.data === 'string' ? event.data : '')
    if (!frame) return
    if (frame.event === 'phx_reply' && frame.ref === joinRef) {
      if (frame.payload?.status === 'ok') {
        retryCount = 0
        setStatus('live')
        track()
        flush()
      } else {
        setStatus('down')
        socket?.close()
      }
      return
    }
    if (frame.event === 'presence_state') {
      roster = normalizePresence(frame.payload)
      publishRoster()
      return
    }
    if (frame.event === 'presence_diff') {
      roster = mergePresence(roster, frame.payload?.joins, frame.payload?.leaves)
      publishRoster()
      return
    }
    if (frame.event === 'broadcast') {
      const eventName = frame.payload?.event
      if (eventName) emit(eventName, frame.payload?.payload || {})
      return
    }
    if (frame.event === 'phx_error' || frame.event === 'phx_close') socket?.close()
  }
  function scheduleRetry() {
    if (intentional || !code) return
    clearTimeout(retryTimer)
    setStatus('retry')
    const delay = Math.min(30000, 1000 * (2 ** retryCount++))
    retryTimer = setTimeout(openSocket, delay)
  }
  function openSocket() {
    if (intentional || !code) return
    clearTimeout(retryTimer)
    clearInterval(heartbeat)
    setStatus(retryCount ? 'retry' : 'connecting')
    try { socket = new root.WebSocket(wireUrl()) } catch (e) { scheduleRetry(); return }
    socket.addEventListener('open', () => {
      joinRef = nextRef()
      push({ topic, event: 'phx_join', ref: joinRef, join_ref: joinRef, payload: {
        config: {
          broadcast: { self: false, ack: false },
          presence: { key: me.pid, enabled: true },
          postgres_changes: [],
          private: false,
        },
        ...(String(cfg.key).split('.').length === 3 ? { access_token: cfg.key } : {}),
      } })
      heartbeat = setInterval(() => push({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: nextRef() }), 30000)
    })
    socket.addEventListener('message', handleMessage)
    socket.addEventListener('error', () => setStatus('down'))
    socket.addEventListener('close', () => {
      clearInterval(heartbeat)
      socket = null
      if (!intentional) scheduleRetry()
    })
  }
  function connect(nextCode, player) {
    if (!available) return Promise.reject(new Error('멀티플레이 설정이 없습니다'))
    leave()
    code = String(nextCode || '').toUpperCase()
    if (!/^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{6}$/.test(code)) return Promise.reject(new Error('방 코드는 6자리입니다'))
    me = { pid: String(player.pid), nick: String(player.nick), joinedAt: Number(player.joinedAt) || Date.now() }
    topic = `realtime:tw:${code}`
    intentional = false
    openSocket()
    return new Promise((resolve, reject) => {
      const stop = on('status', (value) => {
        if (value === 'live') { stop(); clearTimeout(timer); resolve() }
      })
      const timer = setTimeout(() => { stop(); reject(new Error('방에 연결하는 중입니다')) }, 12000)
    })
  }
  function leave() {
    intentional = true
    clearTimeout(retryTimer)
    clearInterval(heartbeat)
    if (socket && socket.readyState === 1 && topic) push({ topic, event: 'phx_leave', payload: {}, ref: nextRef(), join_ref: joinRef })
    socket?.close()
    socket = null
    topic = null
    code = null
    me = null
    roster = new Map()
    queue.length = 0
    setStatus(available ? 'down' : 'off')
  }
  function send(event, payload) {
    if (!APP_EVENTS.includes(event)) return false
    if (status === 'live') return broadcast(event, payload)
    if (code) { queue.push({ event, payload }); return true }
    return false
  }

  return {
    available,
    get status() { return status },
    connect, leave, send, on,
    encodeFrame, decodeFrame, normalizePresence, mergePresence, electHost, roomCode, awardPoints,
    CODE_ALPHABET,
  }
})
