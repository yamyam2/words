// 한글 자모 유틸 — 24자모 분해 / 두벌식 조합 / ASCII 인코딩 / 워들 채점
// 브라우저에서는 globalThis.Hangul, node 에서는 module.exports 로 노출된다.
;(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.Hangul = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict'

  // 게임에서 쓰는 자모 24개 (두벌식 키보드에서 시프트 없이 칠 수 있는 것)
  const CONSONANTS = 'ㄱㄴㄷㄹㅁㅂㅅㅇㅈㅊㅋㅌㅍㅎ'
  const VOWELS = 'ㅏㅑㅓㅕㅗㅛㅜㅠㅡㅣ'
  const ALPHABET = CONSONANTS + VOWELS // 24개, 인덱스가 곧 ASCII 인코딩 순서

  // 유니코드 완성형 음절 분해용 테이블
  const CHO = ['ㄱ','ㄲ','ㄴ','ㄷ','ㄸ','ㄹ','ㅁ','ㅂ','ㅃ','ㅅ','ㅆ','ㅇ','ㅈ','ㅉ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ']
  const JUNG = ['ㅏ','ㅐ','ㅑ','ㅒ','ㅓ','ㅔ','ㅕ','ㅖ','ㅗ','ㅘ','ㅙ','ㅚ','ㅛ','ㅜ','ㅝ','ㅞ','ㅟ','ㅠ','ㅡ','ㅢ','ㅣ']
  const JONG = ['','ㄱ','ㄲ','ㄳ','ㄴ','ㄵ','ㄶ','ㄷ','ㄹ','ㄺ','ㄻ','ㄼ','ㄽ','ㄾ','ㄿ','ㅀ','ㅁ','ㅂ','ㅄ','ㅅ','ㅆ','ㅇ','ㅈ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ']

  // 24자모 밖의 자모를 기본 자모열로 펼치는 표
  const EXPAND = {
    // 쌍자음
    'ㄲ': 'ㄱㄱ', 'ㄸ': 'ㄷㄷ', 'ㅃ': 'ㅂㅂ', 'ㅆ': 'ㅅㅅ', 'ㅉ': 'ㅈㅈ',
    // 겹받침
    'ㄳ': 'ㄱㅅ', 'ㄵ': 'ㄴㅈ', 'ㄶ': 'ㄴㅎ', 'ㄺ': 'ㄹㄱ', 'ㄻ': 'ㄹㅁ', 'ㄼ': 'ㄹㅂ',
    'ㄽ': 'ㄹㅅ', 'ㄾ': 'ㄹㅌ', 'ㄿ': 'ㄹㅍ', 'ㅀ': 'ㄹㅎ', 'ㅄ': 'ㅂㅅ',
    // 복합모음
    'ㅐ': 'ㅏㅣ', 'ㅒ': 'ㅑㅣ', 'ㅔ': 'ㅓㅣ', 'ㅖ': 'ㅕㅣ', 'ㅘ': 'ㅗㅏ', 'ㅙ': 'ㅗㅏㅣ',
    'ㅚ': 'ㅗㅣ', 'ㅝ': 'ㅜㅓ', 'ㅞ': 'ㅜㅓㅣ', 'ㅟ': 'ㅜㅣ', 'ㅢ': 'ㅡㅣ',
  }

  // 조합용 역방향 표 (두벌식 오토마타)
  const MERGE_JUNG = {
    'ㅏㅣ': 'ㅐ', 'ㅑㅣ': 'ㅒ', 'ㅓㅣ': 'ㅔ', 'ㅕㅣ': 'ㅖ', 'ㅗㅏ': 'ㅘ', 'ㅘㅣ': 'ㅙ',
    'ㅗㅣ': 'ㅚ', 'ㅜㅓ': 'ㅝ', 'ㅝㅣ': 'ㅞ', 'ㅜㅣ': 'ㅟ', 'ㅡㅣ': 'ㅢ',
  }
  const MERGE_CHO = { 'ㄱㄱ': 'ㄲ', 'ㄷㄷ': 'ㄸ', 'ㅂㅂ': 'ㅃ', 'ㅅㅅ': 'ㅆ', 'ㅈㅈ': 'ㅉ' }
  const MERGE_JONG = {
    'ㄱㄱ': 'ㄲ', 'ㄱㅅ': 'ㄳ', 'ㄴㅈ': 'ㄵ', 'ㄴㅎ': 'ㄶ', 'ㄹㄱ': 'ㄺ', 'ㄹㅁ': 'ㄻ',
    'ㄹㅂ': 'ㄼ', 'ㄹㅅ': 'ㄽ', 'ㄹㅌ': 'ㄾ', 'ㄹㅍ': 'ㄿ', 'ㄹㅎ': 'ㅀ', 'ㅂㅅ': 'ㅄ', 'ㅅㅅ': 'ㅆ',
  }
  // 받침이 다음 글자 초성으로 넘어갈 때 쪼개는 표
  const SPLIT_JONG = {}
  for (const [pair, merged] of Object.entries(MERGE_JONG)) SPLIT_JONG[merged] = [pair[0], pair[1]]

  // 게임에 없는 자모(ㅐ, ㄲ, ㄳ ...)를 기본 자모열로 펼친다. 기본 자모면 그대로, 그 밖이면 ''.
  const expand = (jamo) => (ALPHABET.includes(jamo) ? jamo : EXPAND[jamo] || '')

  const isVowel = (j) => VOWELS.includes(j)
  const isConsonant = (j) => CONSONANTS.includes(j)
  const isSyllable = (ch) => ch >= '\uAC00' && ch <= '\uD7A3'

  // "시민" -> "ㅅㅣㅁㅣㄴ". 완성형 음절이 아닌 글자가 섞여 있으면 null.
  function decompose(word) {
    let out = ''
    for (const ch of word) {
      if (!isSyllable(ch)) return null
      const s = ch.charCodeAt(0) - 0xac00
      const parts = [CHO[Math.floor(s / 588)], JUNG[Math.floor((s % 588) / 28)], JONG[s % 28]]
      for (const p of parts) {
        if (!p) continue
        out += EXPAND[p] || p
      }
    }
    return out
  }

  // "ㅅㅣㅁㅣㄴ" -> "시민". 두벌식 입력기와 같은 규칙으로 조합한다.
  // 조합이 불가능한 자모열(홀소리로 시작, 홀자음으로 끝 등)이면 null.
  function compose(jamo) {
    let out = ''
    let cho = '', jung = '', jong = ''

    const flush = () => {
      if (!cho) return true
      if (!jung) return false // 홀로 남은 자음 -> 조합 실패
      const ci = CHO.indexOf(cho), vi = JUNG.indexOf(jung), ti = JONG.indexOf(jong)
      if (ci < 0 || vi < 0 || ti < 0) return false
      out += String.fromCharCode(0xac00 + ci * 588 + vi * 28 + ti)
      cho = jung = jong = ''
      return true
    }

    for (const j of jamo) {
      if (isVowel(j)) {
        if (!cho) return null // 초성 없이 모음이 먼저 나올 수 없다
        if (!jung) { jung = j; continue }
        if (!jong) {
          const merged = MERGE_JUNG[jung + j]
          if (!merged) return null // 모음 뒤에 못 붙는 모음
          jung = merged
          continue
        }
        // 받침이 있는데 모음이 오면 받침이 다음 글자의 초성으로 넘어간다
        const split = SPLIT_JONG[jong]
        const moved = split ? split[1] : jong
        jong = split ? split[0] : ''
        if (!flush()) return null
        cho = moved; jung = j; jong = ''
        continue
      }
      if (!isConsonant(j)) return null
      if (!cho) { cho = j; continue }
      if (!jung) {
        const merged = MERGE_CHO[cho + j]
        if (!merged) return null // 자음 두 개가 겹칠 수 없다
        cho = merged
        continue
      }
      if (!jong) {
        if (JONG.indexOf(j) < 0) return null
        jong = j
        continue
      }
      const merged = MERGE_JONG[jong + j]
      if (merged) { jong = merged; continue }
      if (!flush()) return null
      cho = j
    }
    if (!flush()) return null
    return out
  }

  // 자모열 <-> ASCII (자모 1개 = 'a'~'x' 1글자). 단어 목록 용량을 3배 줄인다.
  function encode(jamo) {
    let out = ''
    for (const j of jamo) {
      const i = ALPHABET.indexOf(j)
      if (i < 0) return null
      out += String.fromCharCode(97 + i)
    }
    return out
  }
  function decode(ascii) {
    let out = ''
    for (const c of ascii) out += ALPHABET[c.charCodeAt(0) - 97]
    return out
  }

  // 워들 채점. 중복 자모는 초록 먼저 배정하고 남는 개수만큼 왼쪽부터 노랑.
  // guess/answer: 같은 길이의 자모 배열 또는 문자열 -> ['correct'|'present'|'absent', ...]
  function score(guess, answer) {
    const g = Array.from(guess), a = Array.from(answer)
    const result = new Array(g.length).fill('absent')
    const left = new Map()
    for (let i = 0; i < g.length; i++) {
      if (g[i] === a[i]) result[i] = 'correct'
      else left.set(a[i], (left.get(a[i]) || 0) + 1)
    }
    for (let i = 0; i < g.length; i++) {
      if (result[i] === 'correct') continue
      const n = left.get(g[i]) || 0
      if (n > 0) { result[i] = 'present'; left.set(g[i], n - 1) }
    }
    return result
  }

  return {
    CONSONANTS, VOWELS, ALPHABET,
    isVowel, isConsonant, isSyllable, expand,
    decompose, compose, encode, decode, score,
  }
})
