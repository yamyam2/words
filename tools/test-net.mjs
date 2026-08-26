import test from 'node:test'
import assert from 'node:assert/strict'
import Net from '../src/net.js'

test('Phoenix 프레임을 JSON 객체로 왕복한다', () => {
  const frame = { topic: 'realtime:tw:ABC234', event: 'broadcast', ref: '7', payload: { event: 'mark' } }
  assert.deepEqual(Net.decodeFrame(Net.encodeFrame(frame)), frame)
  assert.equal(Net.decodeFrame('{broken'), null)
  assert.equal(Net.decodeFrame('[]'), null)
})

test('presence_state 를 pid 기준 명단으로 정규화한다', () => {
  const roster = Net.normalizePresence({
    alpha: { metas: [{ pid: 'alpha', nick: '가', joinedAt: 20 }] },
    beta: [{ pid: 'beta', nick: '나', joinedAt: 10 }],
  })
  assert.deepEqual(Array.from(roster.values()), [
    { pid: 'alpha', nick: '가', joinedAt: 20 },
    { pid: 'beta', nick: '나', joinedAt: 10 },
  ])
})

test('presence_diff 의 leave 와 join 을 병합한다', () => {
  const before = new Map([
    ['a', { pid: 'a', nick: '가', joinedAt: 1 }],
    ['b', { pid: 'b', nick: '나', joinedAt: 2 }],
  ])
  const after = Net.mergePresence(before,
    { c: { metas: [{ pid: 'c', nick: '다', joinedAt: 3 }] } },
    { a: { metas: [{ pid: 'a', nick: '가', joinedAt: 1 }] } },
  )
  assert.deepEqual(Array.from(after.keys()), ['b', 'c'])
})

test('가장 먼저 들어온 온라인 플레이어를 방장으로 뽑는다', () => {
  assert.equal(Net.electHost([
    { pid: 'late', joinedAt: 30 },
    { pid: 'offline', joinedAt: 1, online: false },
    { pid: 'host', joinedAt: 10 },
  ]), 'host')
})

test('방 코드는 혼동 문자가 없는 6자리다', () => {
  for (let i = 0; i < 100; i++) {
    const code = Net.roomCode()
    assert.match(code, /^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{6}$/)
    assert.doesNotMatch(code, /[01ILOU]/)
  }
})

test('완주 순위에 5, 3, 2, 1점을 주고 미완주는 0점이다', () => {
  assert.deepEqual(Net.awardPoints([
    { pid: 'third', status: 'won', tries: 4, ms: 1000 },
    { pid: 'lost', status: 'lost', tries: 5, ms: 500 },
    { pid: 'first', status: 'won', tries: 2, ms: 2000 },
    { pid: 'fourth', status: 'won', tries: 5, ms: 2000 },
    { pid: 'second', status: 'won', tries: 2, ms: 3000 },
  ]), { first: 5, second: 3, third: 2, fourth: 1, lost: 0 })
})
