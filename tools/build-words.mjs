// data/raw/* -> src/words.js
// 정답 풀 : 국립국어원 한국어 학습용 어휘 목록에서 뽑은 흔한 2음절 단어
// 검증 사전: 표준국어대사전 파생 목록 전체를 자모열로 정규화한 집합
// 사용: node tools/build-words.mjs
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const H = require('../src/hangul.js')

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const RAW = join(ROOT, 'data', 'raw')
const LENGTHS = [4, 5, 6, 7] // 게임에서 지원하는 칸 수
const MIN_ANSWERS = 120      // 이보다 적으면 경고

const lines = (file) =>
  readFileSync(join(RAW, file), 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)

// ── 1. 정답 풀 ────────────────────────────────────────────────────────
const answers = Object.fromEntries(LENGTHS.map((n) => [n, new Set()]))

const addAnswer = (word) => {
  if (Array.from(word).length !== 2) return false   // 2음절만
  if (word.endsWith('다')) return false             // 동사·형용사 기본형 제외
  const jamo = H.decompose(word)
  if (!jamo) return false
  const n = Array.from(jamo).length
  if (!answers[n]) return false
  answers[n].add(word)
  return true
}

for (const raw of lines('learner-vocab.csv').slice(1)) {
  addAnswer(raw.replace(/\d+$/, '').trim())        // '가격03' -> '가격'
}

// 버킷이 얇으면 직접 큐레이션한 목록으로 보충한다
const extraPath = join(ROOT, 'tools', 'extra-answers.txt')
let extraAdded = 0
if (existsSync(extraPath)) {
  for (const w of readFileSync(extraPath, 'utf8').split(/\r?\n/)) {
    const word = w.split('#')[0].trim()
    if (word && addAnswer(word)) extraAdded++
  }
}

// ── 2. 검증 사전 ──────────────────────────────────────────────────────
const valid = Object.fromEntries(LENGTHS.map((n) => [n, new Set()]))
let scanned = 0, kept = 0

for (const word of lines('dictionary.txt')) {
  scanned++
  const jamo = H.decompose(word)                    // 완성형 음절이 아니면 null (어미 항목 등)
  if (!jamo) continue
  const n = Array.from(jamo).length
  if (!valid[n]) continue
  valid[n].add(H.encode(jamo))
  kept++
}

// 정답은 반드시 제출 가능해야 한다
for (const n of LENGTHS) for (const w of answers[n]) valid[n].add(H.encode(H.decompose(w)))

// ── 3. 산출 ───────────────────────────────────────────────────────────
const answersOut = {}, validOut = {}
for (const n of LENGTHS) {
  answersOut[n] = [...answers[n]].sort()
  validOut[n] = [...valid[n]].sort().join('')       // 구분자 없는 고정폭 문자열
}

const body = `// 자동 생성 파일 — 직접 고치지 말고 \`node tools/build-words.mjs\` 로 다시 만드세요.
// answers[n] : 정답 후보 (자모 n개짜리 흔한 2음절 단어)
// valid[n]   : 제출 가능한 자모열 집합. 자모 1개를 'a'~'x' 한 글자로 인코딩해
//              구분자 없이 n글자씩 이어붙인 문자열.
;(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.Words = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict'
  const answers = ${JSON.stringify(answersOut)}
  const packed = ${JSON.stringify(validOut)}
  const cache = {}
  // 필요한 길이의 집합만 그때그때 펼친다
  function validSet(n) {
    if (!cache[n]) {
      const s = new Set(), p = packed[n] || ''
      for (let i = 0; i < p.length; i += n) s.add(p.slice(i, i + n))
      cache[n] = s
    }
    return cache[n]
  }
  const lengths = Object.keys(answers).map(Number).sort()
  return { answers, lengths, validSet }
})
`
const outPath = join(ROOT, 'src', 'words.js')
writeFileSync(outPath, body, 'utf8')

// ── 4. 통계 ───────────────────────────────────────────────────────────
console.log(`사전 원본 ${scanned.toLocaleString()}개 중 ${kept.toLocaleString()}개 채택 (자모 ${LENGTHS[0]}~${LENGTHS.at(-1)}개)`)
if (extraAdded) console.log(`extra-answers.txt 에서 ${extraAdded}개 보충`)
console.log('')
console.log(' 칸수 |   정답 |   검증')
console.log('------+--------+--------')
for (const n of LENGTHS) {
  const a = answersOut[n].length, v = validOut[n].length / n
  console.log(`  ${n}칸 | ${String(a).padStart(6)} | ${String(v).padStart(6)}`)
  if (a < MIN_ANSWERS) console.warn(`  !! ${n}칸 정답이 ${a}개뿐입니다 — tools/extra-answers.txt 로 보충하세요`)
}
console.log('')
console.log(`src/words.js  ${(Buffer.byteLength(body) / 1024).toFixed(0)} KB`)
