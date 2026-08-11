#!/usr/bin/env node
/**
 * 背景音床素材下载与响度归一化：npm run music
 *
 * ── 边界（写死，不接受参数覆盖）────────────────────────────────────────
 * 这个脚本**只**下载 assets/music-manifest.json 里明确列出的 URL。
 * 没有搜索、没有爬取、没有「自动发现音源」，一行都没有。
 * 授权判断由人工完成后写进 manifest；缺 license 或 author 的条目
 * 会让整个脚本报错退出，且一个文件都不下载。
 * ──────────────────────────────────────────────────────────────────
 *
 * 目标源（archive.org 一类）在国内经常断流，所以下载这段做了三件事：
 *   1. 断点续传：部分文件留在 .cache/music/{id}.part，重跑时发 Range 续
 *   2. 指数退避重试：最多 5 次，间隔 1/2/4/8/16 秒并加抖动
 *   3. 幂等：raw 大小与远端 Content-Length 一致就跳过，可以反复运行
 *
 * 下载完用 ffmpeg 两遍 loudnorm 归一化到 manifest 指定的 LUFS
 * （两遍是必要的：一遍测量、一遍按测量值线性修正，单遍是动态压缩，会毁掉音床）。
 */

import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, readFile, rename, stat, writeFile, unlink } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const run = promisify(execFile)

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const MANIFEST = path.join(ROOT, 'assets/music-manifest.json')
const CACHE_DIR = path.join(ROOT, '.cache/music')
const OUT_DIR = path.join(ROOT, 'public/audio/music')
const CREDITS = path.join(ROOT, 'public/CREDITS.md')
const RUNTIME_INDEX = path.join(OUT_DIR, 'index.json')

const MAX_RETRIES = 5
const DEFAULT_LUFS = -23
const TRUE_PEAK = -1.5
const LRA = 11
const ID_PATTERN = /^[a-z0-9_-]+$/

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
}

function fail(message) {
  console.error(`\n${c.red('✗ ' + message)}\n`)
  process.exit(1)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- manifest 校验 ---------------------------------------------------------

/**
 * 授权信息不全就整批拒绝，而不是跳过那一条 ——
 * 「漏了一条也照跑」会让人以为全部合规。
 */
function validate(tracks) {
  const problems = []
  const seen = new Set()

  tracks.forEach((t, i) => {
    const where = `tracks[${i}]${t.id ? ` (${t.id})` : ''}`
    if (!t.id) problems.push(`${where} 缺 id`)
    else if (!ID_PATTERN.test(t.id)) problems.push(`${where} id 只允许 [a-z0-9_-]`)
    else if (seen.has(t.id)) problems.push(`${where} id 重复`)
    else seen.add(t.id)

    if (!t.url) problems.push(`${where} 缺 url`)
    else {
      let u
      try {
        u = new URL(t.url)
      } catch {
        problems.push(`${where} url 不是合法地址`)
      }
      if (u && !/^https?:$/.test(u.protocol)) problems.push(`${where} url 必须是 http/https`)
    }

    // 这两条是硬性的：没有授权信息就不下载
    if (!t.license?.trim()) problems.push(`${where} 缺 license —— 授权不明的素材不下载`)
    if (!t.author?.trim()) problems.push(`${where} 缺 author —— 署名不明的素材不下载`)

    if (t.loopStart !== undefined && t.loopEnd !== undefined && !(t.loopEnd > t.loopStart)) {
      problems.push(`${where} loopEnd 必须大于 loopStart`)
    }
  })

  if (problems.length) {
    fail(`manifest 校验未通过，未下载任何文件：\n  - ${problems.join('\n  - ')}`)
  }
}

// ---- 下载：Range 续传 + 指数退避 -------------------------------------------

async function partialSize(file) {
  try {
    return (await stat(file)).size
  } catch {
    return 0
  }
}

/**
 * 单次下载尝试。返回 { done, total }。
 * 206 → 从断点续；200 → 服务器不支持 Range，从头重来；416 → 本地已经不小于远端。
 */
async function attempt(url, partFile) {
  const have = await partialSize(partFile)
  const headers = { 'user-agent': 'solarsystem-fetch-music/1.0' }
  if (have > 0) headers.range = `bytes=${have}-`

  const res = await fetch(url, { headers, redirect: 'follow' })

  if (res.status === 416) {
    // 已经下满或本地文件比远端还大：清掉重来一次最稳
    await unlink(partFile).catch(() => {})
    throw new Error('416（断点超出远端长度），已清除断点')
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)

  let total = 0
  let append = false
  if (res.status === 206) {
    const range = res.headers.get('content-range') ?? ''
    total = Number(range.split('/')[1] ?? 0)
    append = true
  } else {
    total = Number(res.headers.get('content-length') ?? 0)
    if (have > 0) console.log(c.dim(`      服务器忽略了 Range，从头下载`))
  }

  if (!res.body) throw new Error('响应没有 body')
  await pipeline(Readable.fromWeb(res.body), createWriteStream(partFile, { flags: append ? 'a' : 'w' }))

  const size = await partialSize(partFile)
  return { size, total }
}

async function download(track, rawFile) {
  const partFile = `${rawFile}.part`

  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      const { size, total } = await attempt(track.url, partFile)
      if (total && size < total) throw new Error(`只收到 ${size}/${total} 字节，连接被截断`)
      await rename(partFile, rawFile)
      return { size, total }
    } catch (err) {
      const last = i === MAX_RETRIES - 1
      if (last) throw new Error(`${MAX_RETRIES} 次尝试后仍然失败：${err.message}`)
      // 指数退避 + 抖动，别让多条音轨在同一秒一起重试
      const wait = 2 ** i * 1000 + Math.floor(Math.random() * 400)
      console.log(c.yellow(`      第 ${i + 1} 次失败：${err.message}；${(wait / 1000).toFixed(1)}s 后重试`))
      await sleep(wait)
    }
  }
  throw new Error('unreachable')
}

// ---- ffmpeg ---------------------------------------------------------------

async function ensureFfmpeg() {
  for (const bin of ['ffmpeg', 'ffprobe']) {
    try {
      await run(bin, ['-version'])
    } catch {
      fail(`找不到 ${bin}。macOS：brew install ffmpeg`)
    }
  }
}

async function probe(file) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'stream=sample_rate,channels:format=duration',
    '-of', 'json',
    file,
  ])
  const j = JSON.parse(stdout)
  return {
    sampleRate: Number(j.streams?.[0]?.sample_rate ?? 48000),
    channels: Number(j.streams?.[0]?.channels ?? 2),
    duration: Number(j.format?.duration ?? 0),
  }
}

/** loudnorm 把测量结果打在 stderr 的最后一段 JSON 里 */
function parseLoudnorm(stderr) {
  const start = stderr.lastIndexOf('{')
  const end = stderr.lastIndexOf('}')
  if (start < 0 || end < start) return null
  try {
    return JSON.parse(stderr.slice(start, end + 1))
  } catch {
    return null
  }
}

async function measure(file, targetLufs) {
  const filter = `loudnorm=I=${targetLufs}:TP=${TRUE_PEAK}:LRA=${LRA}:print_format=json`
  const { stderr } = await run(
    'ffmpeg',
    ['-nostats', '-hide_banner', '-i', file, '-af', filter, '-f', 'null', '-'],
    { maxBuffer: 1 << 24 },
  )
  return parseLoudnorm(stderr)
}

/**
 * 两遍 loudnorm。
 * 注意 -ar：loudnorm 内部按 192 kHz 工作，不显式指定采样率的话输出会被抬到 192k，
 * 文件白白大三四倍。
 */
async function normalize(rawFile, outFile, targetLufs) {
  const info = await probe(rawFile)
  const m = await measure(rawFile, targetLufs)
  if (!m) throw new Error('loudnorm 第一遍没有返回测量结果')

  const filter = [
    `loudnorm=I=${targetLufs}`,
    `TP=${TRUE_PEAK}`,
    `LRA=${LRA}`,
    `measured_I=${m.input_i}`,
    `measured_TP=${m.input_tp}`,
    `measured_LRA=${m.input_lra}`,
    `measured_thresh=${m.input_thresh}`,
    `offset=${m.target_offset}`,
    'linear=true',
    'print_format=summary',
  ].join(':')

  await run(
    'ffmpeg',
    [
      '-y', '-nostats', '-hide_banner',
      '-i', rawFile,
      '-af', filter,
      '-ar', String(info.sampleRate),
      '-ac', String(Math.min(2, info.channels)),
      '-c:a', 'libmp3lame', '-q:a', '2',
      outFile,
    ],
    { maxBuffer: 1 << 24 },
  )

  const after = await probe(outFile)
  const check = await measure(outFile, targetLufs)
  return {
    before: info,
    after,
    achievedLufs: check ? Number(check.input_i) : null,
    inputLufs: Number(m.input_i),
  }
}

// ---- 主流程 ---------------------------------------------------------------

async function main() {
  if (!existsSync(MANIFEST)) fail(`找不到 ${path.relative(ROOT, MANIFEST)}`)
  const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'))
  const tracks = manifest.tracks ?? []

  console.log(c.bold(`\n背景音床素材　${tracks.length} 条`))
  console.log(c.dim('只下载 manifest 明确列出的 URL —— 不搜索、不爬取、不自动发现音源\n'))

  if (!tracks.length) {
    console.log(c.yellow('manifest 里还没有音轨。往 assets/music-manifest.json 的 tracks 里加条目后重跑。'))
    console.log(c.dim('（运行时没有音轨会静默降级：开关按钮仍在，只是不出声）\n'))
    return
  }

  validate(tracks)
  await ensureFfmpeg()
  await mkdir(CACHE_DIR, { recursive: true })
  await mkdir(OUT_DIR, { recursive: true })

  const results = []

  for (const track of tracks) {
    const lufs = track.targetLoudness_LUFS ?? DEFAULT_LUFS
    const rawFile = path.join(CACHE_DIR, `${track.id}.raw`)
    const outFile = path.join(OUT_DIR, `${track.id}.mp3`)
    console.log(c.bold(`  ${track.id}`))

    // 幂等：先问远端多大，本地 raw 一样大就不重下
    let remoteSize = 0
    try {
      const head = await fetch(track.url, { method: 'HEAD', redirect: 'follow' })
      if (head.ok) remoteSize = Number(head.headers.get('content-length') ?? 0)
    } catch {
      /* HEAD 不被支持是常事，交给下载那步用 Range 自己判断 */
    }
    const localSize = await partialSize(rawFile)

    if (localSize > 0 && remoteSize > 0 && localSize === remoteSize) {
      console.log(c.dim(`      已有 ${(localSize / 1e6).toFixed(2)} MB，大小一致，跳过下载`))
    } else {
      console.log(c.dim(`      下载 ${track.url}`))
      const { size } = await download(track, rawFile)
      console.log(c.dim(`      收到 ${(size / 1e6).toFixed(2)} MB`))
    }

    // 归一化也做幂等：输出比 raw 新就不重做（两遍 loudnorm 不便宜）
    const rawStat = await stat(rawFile)
    let outStat = null
    try {
      outStat = await stat(outFile)
    } catch {
      /* 还没归一化过 */
    }

    let norm
    if (outStat && outStat.mtimeMs >= rawStat.mtimeMs) {
      const after = await probe(outFile)
      const check = await measure(outFile, lufs)
      norm = { before: after, after, achievedLufs: check ? Number(check.input_i) : null, inputLufs: null }
      console.log(c.dim(`      已归一化，跳过（实测 ${norm.achievedLufs?.toFixed(1) ?? '—'} LUFS）`))
    } else {
      console.log(c.dim(`      两遍 loudnorm → ${lufs} LUFS`))
      norm = await normalize(rawFile, outFile, lufs)
      console.log(
        c.dim(`      ${norm.inputLufs?.toFixed(1)} → ${norm.achievedLufs?.toFixed(1)} LUFS，` +
          `${norm.after.duration.toFixed(2)} 秒`),
      )
    }

    // mp3 重编码会带上编码器延迟，时长通常会漂几十毫秒 —— 循环点是按秒标的，值得提醒
    const drift = Math.abs(norm.after.duration - norm.before.duration)
    if (norm.inputLufs !== null && drift > 0.05) {
      console.log(c.yellow(`      注意：重编码后时长变了 ${(drift * 1000).toFixed(0)} ms，循环点请以输出文件为准`))
    }

    const hasLoop = track.loopStart !== undefined && track.loopEnd !== undefined
    if (!hasLoop) {
      console.log(c.yellow(`      未标定循环点，运行时会退化成整文件循环`))
    } else if (track.loopEnd > norm.after.duration + 0.01) {
      console.log(
        c.yellow(`      loopEnd ${track.loopEnd}s 超出实际时长 ${norm.after.duration.toFixed(2)}s，运行时会忽略`),
      )
    }
    if (norm.after.duration > 300) {
      console.log(c.yellow(`      时长超过 5 分钟，运行时改用流式播放（循环接缝可能听得出来）`))
    }

    results.push({
      id: track.id,
      title: track.title ?? track.id,
      license: track.license,
      author: track.author,
      source: track.source ?? '',
      file: `audio/music/${track.id}.mp3`,
      duration: Number(norm.after.duration.toFixed(3)),
      loopStart: hasLoop ? track.loopStart : null,
      loopEnd: hasLoop ? track.loopEnd : null,
      targetLoudness_LUFS: lufs,
      achievedLoudness_LUFS: norm.achievedLufs === null ? null : Number(norm.achievedLufs.toFixed(1)),
      note: track.note ?? '',
    })

    if (!track.source) console.log(c.yellow(`      没有 source，CREDITS 里将无法追溯来源`))
    console.log(c.green(`      ✓ public/${`audio/music/${track.id}.mp3`}`))
  }

  // 运行时索引：只放播放需要的字段，时长是 ffprobe 实测值（决定走缓冲还是流式）
  await writeFile(
    RUNTIME_INDEX,
    JSON.stringify(
      { _generated: '由 scripts/fetch-music.js 生成，勿手改；改 assets/music-manifest.json 后重跑', tracks: results },
      null,
      2,
    ) + '\n',
  )

  await writeCredits(results)

  console.log(c.green(`\n完成 ${results.length} 条。CREDITS.md 与运行时索引已更新。\n`))
}

async function writeCredits(results) {
  const rows = results.map(
    (t) =>
      `| ${t.title} | \`${t.id}\` | ${t.license} | ${t.author} | ${t.source ? `[来源](${t.source})` : '—'} | ${fmt(t.duration)} | ${t.achievedLoudness_LUFS ?? '—'} |`,
  )
  const body = `# 音频素材授权

本页由 \`scripts/fetch-music.js\` 自动生成，数据源是 \`assets/music-manifest.json\`。
每条音轨的授权由人工确认后写进 manifest —— 脚本不会自行寻找或判断音源。

| 曲目 | id | 授权 | 作者 | 来源 | 时长 | 实测响度 |
| --- | --- | --- | --- | --- | --- | --- |
${rows.join('\n')}

所有音轨均已用 ffmpeg 两遍 \`loudnorm\` 归一化，目标 ${DEFAULT_LUFS} LUFS、真峰 ${TRUE_PEAK} dBTP，
以免不同来源的音量参差。原始文件未经修改地保留在 \`.cache/music/\`（不进版本库）。
`
  await writeFile(CREDITS, body)
}

function fmt(seconds) {
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

main().catch((err) => fail(err.message))
