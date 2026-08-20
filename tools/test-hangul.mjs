// 자모 분해/조합/채점 단위 테스트
// 채점 케이스는 첨부된 카카오톡 스크린샷 6장의 모든 행을 그대로 옮긴 것이다.
// 사용: node tools/test-hangul.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const H = require('../src/hangul.js')

// G = 초록(correct), Y = 노랑(present), X = 회색(absent)
const CODE = { G: 'correct', Y: 'present', X: 'absent' }
const expand = (s) => Array.from(s).map((c) => CODE[c])

test('분해: 스크린샷 정답 단어', () => {
  assert.equal(H.decompose('수명'), 'ㅅㅜㅁㅕㅇ')
  assert.equal(H.decompose('수상'), 'ㅅㅜㅅㅏㅇ')
  assert.equal(H.decompose('시민'), 'ㅅㅣㅁㅣㄴ')
  assert.equal(H.decompose('전세'), 'ㅈㅓㄴㅅㅓㅣ')   // ㅔ = ㅓ + ㅣ, 두 칸
  assert.equal(H.decompose('정치'), 'ㅈㅓㅇㅊㅣ')
  assert.equal(H.decompose('대응'), 'ㄷㅏㅣㅇㅡㅇ')   // ㅐ = ㅏ + ㅣ, 두 칸
})

test('분해: 쌍자음 · 겹받침 · 복합모음', () => {
  assert.equal(H.decompose('꽃'), 'ㄱㄱㅗㅊ')
  assert.equal(H.decompose('값'), 'ㄱㅏㅂㅅ')
  assert.equal(H.decompose('닭'), 'ㄷㅏㄹㄱ')
  assert.equal(H.decompose('과일'), 'ㄱㅗㅏㅇㅣㄹ')
  assert.equal(H.decompose('의사'), 'ㅇㅡㅣㅅㅏ')
  assert.equal(H.decompose('왜'), 'ㅇㅗㅏㅣ')
  assert.equal(H.decompose('훼손'), 'ㅎㅜㅓㅣㅅㅗㄴ')
  assert.equal(H.decompose('쌌다'), 'ㅅㅅㅏㅅㅅㄷㅏ')
})

test('분해: 한글이 아닌 글자는 null', () => {
  for (const w of ['abc', '한a', '漢字', 'ㄱㄴ', '3개']) assert.equal(H.decompose(w), null)
})

test('조합: 분해 결과가 원래 단어로 되돌아온다', () => {
  const words = ['시민', '전세', '대응', '정치', '수상', '수명', '과일', '앉다', '꽃', '값',
    '닭', '의사', '왜', '훼손', '고기', '곡이', '사이', '아이', '우유', '광장', '관심', '정원']
  for (const w of words) assert.equal(H.compose(H.decompose(w)), w, w)
})

test('조합: 불가능한 자모열은 null', () => {
  assert.equal(H.compose('ㅏㄱ'), null)      // 초성 없이 모음으로 시작
  assert.equal(H.compose('ㄱㄴㅏ'), null)     // 합쳐질 수 없는 자음 두 개
  assert.equal(H.compose('ㄱㅏㅗ'), null)     // 합쳐질 수 없는 모음 두 개
  assert.equal(H.compose('ㄱㅏㄴㅅ'), null)    // ㄴㅅ은 겹받침이 아니라 조합 불가
  assert.equal(H.compose('ㄱㅏㅂㅅ'), '값')   // ㅂㅅ은 겹받침이라 조합됨
  assert.equal(H.compose('ㅅㅣㅁ'), '심')
})

test('ASCII 인코딩 왕복', () => {
  for (const w of ['시민', '전세', '대응', '광장']) {
    const jamo = H.decompose(w)
    const enc = H.encode(jamo)
    assert.equal(enc.length, Array.from(jamo).length)
    assert.match(enc, /^[a-x]+$/)
    assert.equal(H.decode(enc), jamo)
  }
})

// ── 스크린샷 채점 케이스 ────────────────────────────────────────────────
// [정답, [추측, 기대색상], ...]
const SHOTS = [
  ['수명 (5칸)', '수명', [
    ['ㄱㅗㅈㅏㅇ', 'XXXXG'],   // 고장
    ['ㅅㅓㄴㅂㅣ', 'GXXXX'],   // 선비
    ['ㅅㅜㅁㅕㅇ', 'GGGGG'],   // 수명 (정답)
  ]],
  ['수상 (5칸)', '수상', [
    // 추측에 ㅏ가 두 번: 4번 자리가 초록으로 소진되어 2번 자리는 회색
    ['ㅅㅏㅈㅏㅇ', 'GXXGG'],   // 사장
    ['ㅅㅜㅅㅏㅇ', 'GGGGG'],   // 수상 (정답)
  ]],
  ['시민 (5칸)', '시민', [
    ['ㅎㅛㄱㅏㅁ', 'XXXXY'],   // 효감
    ['ㅇㅓㅈㅓㄴ', 'XXXXG'],   // 어전
    ['ㅂㅜㄷㅗㄹ', 'XXXXX'],   // 부돌
    ['ㅅㅣㅁㅣㄴ', 'GGGGG'],   // 시민 (정답)
  ]],
  ['전세 (6칸)', '전세', [
    ['ㅂㅗㅇㄷㅜㄴ', 'XXXXXY'],   // 봉둔
    ['ㅁㅏㅣㅈㅏㄱ', 'XXYYXX'],   // 매작
    // 추측에 ㅣ가 두 번, 정답에는 한 번: 왼쪽 것만 노랑
    ['ㅈㅣㄴㅅㅣㄹ', 'GYGGXX'],   // 진실
    ['ㅈㅓㄴㅅㅓㅣ', 'GGGGGG'],   // 전세 (정답)
  ]],
  ['정치 (5칸)', '정치', [
    ['ㅅㅓㄴㅈㅏ', 'XGXYX'],   // 선자
    ['ㅂㅗㅇㄷㅜ', 'XXGXX'],   // 봉두
    ['ㄱㅣㄹㅊㅣ', 'XXXGG'],   // 길치
    ['ㅈㅓㅇㅊㅣ', 'GGGGG'],   // 정치 (정답)
  ]],
  ['대응 (6칸)', '대응', [
    ['ㅅㅓㄴㅈㅏㅇ', 'XXXXYG'],   // 선장
    ['ㄷㅗㄱㄹㅣㅂ', 'GXXXYX'],   // 독립
    ['ㅊㅜㅁㅍㅏㄴ', 'XXXXYX'],   // 춤판
    ['ㅌㅏㅣㅎㅕㅇ', 'XGGXXG'],   // 태형
    // 추측에 ㄷ이 두 번: 1번 자리가 초록으로 소진되어 4번 자리는 회색
    ['ㄷㅏㅣㄷㅡㅇ', 'GGGXGG'],   // 대등
  ]],
]

for (const [label, answerWord, rows] of SHOTS) {
  test(`채점: ${label}`, () => {
    const answer = H.decompose(answerWord)
    for (const [guess, expected] of rows) {
      assert.equal(Array.from(guess).length, Array.from(answer).length, `길이 불일치: ${guess}`)
      assert.deepEqual(H.score(guess, answer), expand(expected), `${answerWord} <- ${guess}`)
    }
  })
}

// 스크린샷 속 플레이어가 실제로 제출했던 단어들이 우리 사전에도 들어 있어야 한다.
// (효감·부돌처럼 벽지 단어까지 통과했던 것으로 보아 카카오톡도 넓은 사전을 쓴다)
test('사전: 스크린샷에 나온 모든 추측이 제출 가능하다', async () => {
  const W = require('../src/words.js')
  const words = ['고장', '선비', '수명', '사장', '수상', '효감', '어전', '부돌', '시민',
    '봉둔', '매작', '진실', '전세', '선자', '봉두', '길치', '정치',
    '선장', '독립', '춤판', '태형', '대등', '대응']
  for (const w of words) {
    const jamo = H.decompose(w)
    const n = Array.from(jamo).length
    assert.ok(W.validSet(n).has(H.encode(jamo)), `${w} 가 사전에 없습니다`)
  }
})
