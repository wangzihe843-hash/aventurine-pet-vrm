#!/usr/bin/env node
/**
 * U2 预览接触表生成（Wave 1.5 / U2；dev-only，依赖 sharp）
 *
 *   node scripts/unity-bake/contact-sheets.mjs [--dir tests/tmp/clip-preview] [--out DIR]
 *
 * 输入：`<dir>/<clip>-<pct>.png`（preview-clips.mjs 抓帧输出，例 idle-000.png）
 * 输出：
 * - 每 clip 一张 4 帧横向接触表：`<out>/<clip>-sheet.jpg`；
 * - 全 clip 首帧总览：`<out>/contact-firstframes.jpg`。
 *
 * 也被 `preview-clips.mjs --sheet` 以 `buildContactSheets()` 复用；本文件同时可独立运行。
 * 资产（PNG/VRM）都是私有/临时（tests/tmp、assets 均 gitignore），不提交。
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import sharp from 'sharp'
import { parseCliArgs, formatHelp } from './lib/cli-args.mjs'

const FRAME_PATTERN = /^(.+)-(\d{2,3})\.png$/i

const OPTIONS = {
  dir: {
    type: 'string',
    default: 'tests/tmp/clip-preview',
    valueHint: 'dir',
    description: '预览 PNG 目录（preview-clips.mjs 的输出目录）'
  },
  out: {
    type: 'string',
    valueHint: 'dir',
    description: '接触表输出目录（默认与 --dir 相同）'
  }
}

const HELP = formatHelp({
  command: 'node scripts/unity-bake/contact-sheets.mjs',
  description: 'U2：把 preview-clips.mjs 的抓帧 PNG 组成每 clip 4 帧接触表 + 全 clip 首帧总览 JPG。',
  usage: 'node scripts/unity-bake/contact-sheets.mjs [--dir <dir>] [--out <dir>]',
  options: OPTIONS,
  footer: '输出：<out>/<clip>-sheet.jpg（每 clip 4 帧）、<out>/contact-firstframes.jpg（首帧总览）。'
})

function toDisplayPath(target) {
  const rel = path.relative(process.cwd(), target)
  return rel && !rel.startsWith('..') ? rel : target
}

/**
 * 收集 `<clip>-<pct>.png` 并按 clip 分组。
 * @param {string} dir
 * @returns {Map<string, Array<{ pct: number, file: string }>>}
 */
export function collectPreviewFrames(dir) {
  /** @type {Map<string, Array<{ pct: number, file: string }>>} */
  const groups = new Map()
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return groups
  for (const file of fs.readdirSync(dir).sort()) {
    const match = FRAME_PATTERN.exec(file)
    if (!match) continue
    const clip = match[1]
    const pct = Number(match[2])
    if (!Number.isFinite(pct)) continue
    if (!groups.has(clip)) groups.set(clip, [])
    groups.get(clip).push({ pct, file: path.join(dir, file) })
  }
  for (const frames of groups.values()) frames.sort((a, b) => a.pct - b.pct)
  return groups
}

/** 从 N 帧里均匀挑 4 帧（不足 4 帧则全用）。 */
function pickSheetFrames(frames, count = 4) {
  if (frames.length <= count) return [...frames]
  const picked = []
  for (let i = 0; i < count; i += 1) {
    const index = Math.round((i * (frames.length - 1)) / (count - 1))
    const frame = frames[index]
    if (frame && !picked.includes(frame)) picked.push(frame)
  }
  return picked
}

async function resizePng(file, height) {
  const buffer = await sharp(file).resize({ height, fit: 'contain', background: '#f5f5f5' }).png().toBuffer()
  const meta = await sharp(buffer).metadata()
  return { buffer, width: meta.width ?? 0, height: meta.height ?? 0 }
}

/**
 * 生成接触表。
 *
 * @param {{
 *   dir: string,
 *   outDir?: string,
 *   sheetHeight?: number,
 *   overviewHeight?: number,
 *   overviewColumns?: number,
 *   quality?: number,
 *   logger?: (message: string) => void
 * }} options
 * @returns {Promise<{
 *   sheets: Array<{ clip: string, file: string, frames: number[] }>,
 *   overview: { file: string, clips: string[] } | null,
 *   skipped: string[]
 * }>}
 */
export async function buildContactSheets({
  dir,
  outDir = dir,
  sheetHeight = 360,
  overviewHeight = 200,
  overviewColumns = 6,
  quality = 85,
  logger = (message) => console.log(message)
}) {
  const resolvedDir = path.resolve(dir)
  const resolvedOut = path.resolve(outDir)
  const groups = collectPreviewFrames(resolvedDir)
  /** @type {string[]} */
  const skipped = []
  if (groups.size === 0) {
    return { sheets: [], overview: null, skipped: ['目录中没有 <clip>-<pct>.png 预览帧'] }
  }
  fs.mkdirSync(resolvedOut, { recursive: true })

  /** @type {Array<{ clip: string, file: string, frames: number[] }>} */
  const sheets = []
  const firstFrames = []
  for (const [clip, frames] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (frames.length === 0) continue
    const picked = pickSheetFrames(frames)
    const thumbs = []
    for (const frame of picked) thumbs.push(await resizePng(frame.file, sheetHeight))
    const totalWidth = thumbs.reduce((sum, thumb) => sum + thumb.width, 0)
    const outFile = path.join(resolvedOut, `${clip}-sheet.jpg`)
    await sharp({
      create: { width: totalWidth, height: sheetHeight, channels: 3, background: '#f5f5f5' }
    })
      .composite(
        thumbs.reduce((acc, thumb, index) => {
          const left = thumbs.slice(0, index).reduce((sum, prev) => sum + prev.width, 0)
          return [...acc, { input: thumb.buffer, left, top: 0 }]
        }, [])
      )
      .jpeg({ quality })
      .toFile(outFile)
    sheets.push({ clip, file: toDisplayPath(outFile), frames: picked.map((frame) => frame.pct) })
    firstFrames.push({ clip, frame: frames[0] })
  }

  // ---------- 全 clip 首帧总览 ----------
  let overview = null
  if (firstFrames.length > 0) {
    const thumbs = []
    for (const entry of firstFrames) {
      thumbs.push({ clip: entry.clip, ...(await resizePng(entry.frame.file, overviewHeight)) })
    }
    const columns = Math.max(1, Math.min(overviewColumns, thumbs.length))
    const rows = Math.ceil(thumbs.length / columns)
    const cellWidth = Math.max(...thumbs.map((thumb) => thumb.width))
    const outFile = path.join(resolvedOut, 'contact-firstframes.jpg')
    await sharp({
      create: {
        width: cellWidth * columns,
        height: overviewHeight * rows,
        channels: 3,
        background: '#f5f5f5'
      }
    })
      .composite(
        thumbs.map((thumb, index) => ({
          input: thumb.buffer,
          left: (index % columns) * cellWidth + Math.floor((cellWidth - thumb.width) / 2),
          top: Math.floor(index / columns) * overviewHeight
        }))
      )
      .jpeg({ quality })
      .toFile(outFile)
    overview = { file: toDisplayPath(outFile), clips: firstFrames.map((entry) => entry.clip) }
  }

  logger(
    `[contact-sheets] ${sheets.length} clip 接触表 + ${overview ? '1' : '0'} 张首帧总览 -> ${toDisplayPath(
      resolvedOut
    )}`
  )
  return { sheets, overview, skipped }
}

async function main() {
  const { values, errors, sawHelp } = parseCliArgs(process.argv.slice(2), OPTIONS)
  if (sawHelp) {
    console.log(HELP)
    process.exit(0)
  }
  if (errors.length > 0) {
    for (const error of errors) console.error(`[contact-sheets] 参数错误：${error}`)
    console.error(HELP)
    process.exit(2)
  }
  const dir = path.resolve(String(values.dir))
  const outDir = values.out !== undefined ? path.resolve(String(values.out)) : dir
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    console.error(`[contact-sheets] 预览目录不存在：${dir}`)
    process.exit(1)
  }
  try {
    const result = await buildContactSheets({ dir, outDir })
    for (const message of result.skipped) console.warn(`[contact-sheets] ${message}`)
    process.exit(0)
  } catch (error) {
    console.error(`[contact-sheets] FAIL：${error instanceof Error ? error.stack ?? error.message : String(error)}`)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main()
}
