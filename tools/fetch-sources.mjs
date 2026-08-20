// 원본 단어 데이터 1회 다운로드 → data/raw/
// 사용: node tools/fetch-sources.mjs
import { writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const RAW = join(ROOT, 'data', 'raw')

const SOURCES = [
  {
    // 국립국어원 한국어 학습용 어휘 목록 (약 5,900개) — 정답 풀로 사용
    name: 'learner-vocab.csv',
    url: 'https://raw.githubusercontent.com/3beol/3beol.github.io/master/%ED%95%9C%EA%B5%AD%EC%96%B4+%ED%95%99%EC%8A%B5%EC%9A%A9+%EC%96%B4%ED%9C%98+%EB%AA%A9%EB%A1%9D.csv',
  },
  {
    // 표준국어대사전 파생 단어 목록 (약 4.1MB) — 추측 검증용 사전
    name: 'dictionary.txt',
    url: 'https://raw.githubusercontent.com/acidsound/korean_wordlist/master/wordslistUnique.txt',
  },
]

await mkdir(RAW, { recursive: true })

for (const { name, url } of SOURCES) {
  process.stdout.write(`fetching ${name} ... `)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  await writeFile(join(RAW, name), buf)
  console.log(`${(buf.length / 1024).toFixed(0)} KB`)
}
console.log('done ->', RAW)
