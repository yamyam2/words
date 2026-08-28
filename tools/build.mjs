// src/* 를 하나로 묶어 배포본을 만든다.
//   docs/index.html    GitHub Pages 가 서빙하는 파일 (커밋함)
//   dist/index.html    같은 내용. 로컬에서 그냥 열어 보거나 파일로 전달할 때 사용
//   dist/artifact.html 문서 껍데기 없는 본문만 — Artifact 로 게시할 때 사용
// 사용: node tools/build.mjs
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = (name) => readFileSync(join(ROOT, 'src', name), 'utf8')

// dotenv 의존성 없이 로컬 설정과 CI 환경변수를 읽는다. 빌드 결과에만 값이 들어가며
// src/config.js 에는 빈 기본값을 유지해 파일로 열었을 때 오프라인 게임이 된다.
const envFile = join(ROOT, '.env.local')
const env = {
  ...Object.fromEntries(
    (existsSync(envFile) ? readFileSync(envFile, 'utf8') : '')
      .split(/\r?\n/)
      .filter((line) => /^\s*\w+\s*=/.test(line))
      .map((line) => [line.slice(0, line.indexOf('=')).trim(), line.slice(line.indexOf('=') + 1).trim()]),
  ),
  ...process.env,
}
const offline = process.argv.includes('--offline')
const CONFIG = offline ? { url: '', key: '' } : { url: env.TW_SUPABASE_URL || '', key: env.TW_SUPABASE_KEY || '' }

let html = src('index.html')
  .replace(/<link rel="stylesheet" href="([^"]+)">/g, (_, f) => `<style>\n${src(f).trim()}\n</style>`)
  .replace(/<script src="([^"]+)"><\/script>/g, (_, f) => {
    let code = src(f).trim()
    if (f === 'config.js') code = code.replace(
      /globalThis\.TWConfig = \{[^}]*\} \/\*TWCONFIG\*\//,
      `globalThis.TWConfig = ${JSON.stringify(CONFIG)}`,
    )
    return `<script>\n${code}\n</script>`
  })

if (html.includes('href="') && /<link rel="stylesheet"/.test(html)) throw new Error('인라인되지 않은 스타일시트가 남아 있습니다')
if (/<script src=/.test(html)) throw new Error('인라인되지 않은 스크립트가 남아 있습니다')

const title = html.match(/<title>([^<]*)<\/title>/)[1]
const style = html.match(/<style>[\s\S]*?<\/style>/)[0]
const body = html.match(/<body>([\s\S]*)<\/body>/)[1].trim()

// Artifact 는 게시할 때 doctype/html/head/body 를 직접 감싸므로 본문만 넘긴다.
const artifact = `<title>${title}</title>\n${style}\n\n${body}\n`

const outputs = [
  ['docs', 'index.html', html],
  ['dist', 'index.html', html],
  ['dist', 'artifact.html', artifact],
]
for (const [dir, name, text] of outputs) {
  mkdirSync(join(ROOT, dir), { recursive: true })
  writeFileSync(join(ROOT, dir, name), text, 'utf8')
  console.log(`${dir}/${name.padEnd(14)} ${(Buffer.byteLength(text) / 1024).toFixed(0)} KB`)
}
console.log(CONFIG.url && CONFIG.key
  ? `멀티플레이: 켜짐 (${new URL(CONFIG.url).hostname})`
  : '멀티플레이: 꺼짐 (TW_SUPABASE_URL 또는 TW_SUPABASE_KEY 없음)')
