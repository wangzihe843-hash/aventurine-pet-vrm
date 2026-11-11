#!/usr/bin/env node
/**
 * 占位图标生成脚本（assets/icons）
 * ---------------------------------------------------------------------------
 * 从 `assets/icons/src/*.svg` 生成 Wave 1 / 打包所需的占位 PNG：
 *   - trayTemplate.png      16×16（macOS template image：纯黑 + alpha，深浅色菜单栏自动反色）
 *   - trayTemplate@2x.png   32×32（Retina 版本，命名符合 macOS @2x 约定）
 *   - app-icon-placeholder.png  512×512（C4 打包时转 .icns 的占位应用图标）
 *
 * 用法：
 *   node assets/icons/generate.mjs
 *   （在仓库任意目录执行均可；需要主工作树已安装 devDependencies 里的 sharp）
 *
 * 说明：
 * - 图形全部自绘（见 src/*.svg），无第三方素材，版权干净；这是**占位**美术，
 *   后续换正式图标时：替换 src 里的 SVG → 重跑本脚本 → 检查输出尺寸/alpha。
 * - 本脚本只写 assets/icons/ 下的产物，不碰其它目录。
 * - 输出保持确定性（同一 sharp/libvips 版本下字节一致），便于 diff 审查。
 * - 落盘采用「临时文件 → 读回校验 → 原子 rename」；日志输出的是**落盘文件**的
 *   sha256 与 `changed` 状态（独立复验 LOW-11）。
 */
import { createHash } from 'node:crypto'
import { readFile, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import sharp from 'sharp'

const ICON_DIR = dirname(fileURLToPath(import.meta.url))
const SRC_DIR = join(ICON_DIR, 'src')

/** 渲染 SVG 时的采样密度：先高分辨率光栅化再降采样，避免 16px 边缘发虚。 */
const SVG_DENSITY = 1152

/** 生成任务表：源 SVG → 输出文件 + 目标尺寸 + 校验方式。 */
const TASKS = [
  { source: 'trayTemplate.svg', output: 'trayTemplate.png', size: 16, kind: 'template' },
  { source: 'trayTemplate.svg', output: 'trayTemplate@2x.png', size: 32, kind: 'template' },
  { source: 'app-icon.svg', output: 'app-icon-placeholder.png', size: 512, kind: 'regular' }
]

/** 极简 PNG 信息（用 sharp 读回时再补）。 */
function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/** 把 SVG 光栅化为指定边长的 PNG buffer。 */
async function renderPng(svgBuffer, size) {
  return sharp(svgBuffer, { density: SVG_DENSITY })
    .resize(size, size, { fit: 'fill', kernel: 'lanczos3' })
    .png({ compressionLevel: 9 })
    .toBuffer()
}

/** 校验 template 图：所有非透明像素必须接近纯黑（RGB=0），且 alpha 有透明/不透明两态。 */
async function assertTemplate(buffer, label) {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const { width, height, channels } = info
  let opaque = 0
  let transparent = 0
  let maxRgb = 0
  for (let i = 0; i < data.length; i += channels) {
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]
    const a = data[i + 3]
    maxRgb = Math.max(maxRgb, r, g, b)
    if (a === 255) opaque += 1
    if (a === 0) transparent += 1
  }
  if (maxRgb !== 0) throw new Error(`${label}: template 图的 RGB 必须全为 0（实际最大 ${maxRgb}）`)
  if (opaque === 0) throw new Error(`${label}: template 图没有不透明像素，图形不可见`)
  if (transparent === 0) throw new Error(`${label}: template 图没有透明像素（应为黑色剪影 + 透明背景）`)
  if (opaque === width * height) throw new Error(`${label}: template 图全不透明，模板图语义失效`)
  return { opaque, transparent, maxRgb }
}

/** 校验普通图：尺寸精确、有 alpha、内容非空（存在不透明像素）。 */
async function assertRegular(buffer, size, label) {
  const meta = await sharp(buffer).metadata()
  if (meta.width !== size || meta.height !== size) {
    throw new Error(`${label}: 尺寸应为 ${size}×${size}，实际 ${meta.width}×${meta.height}`)
  }
  if (!meta.hasAlpha) throw new Error(`${label}: 缺少 alpha 通道`)
  const stats = await sharp(buffer).stats()
  const alpha = stats.channels[3]
  if (!alpha || alpha.max === 0) throw new Error(`${label}: 图像全透明，内容为空`)
  return { width: meta.width, height: meta.height, hasAlpha: meta.hasAlpha }
}

async function main() {
  let failed = false
  for (const task of TASKS) {
    const label = task.output
    try {
      const svg = await readFile(join(SRC_DIR, task.source))
      const png = await renderPng(svg, task.size)
      const details =
        task.kind === 'template'
          ? await assertTemplate(png, label)
          : await assertRegular(png, task.size, label)
      // 先校验再写盘：临时文件 → 读回校验 → 原子 rename，失败不留半成品图标。
      const outputPath = join(ICON_DIR, task.output)
      let previousSha = null
      try {
        previousSha = sha256(await readFile(outputPath))
      } catch {
        // 旧文件不存在属正常（首次生成）
      }
      const tmpPath = `${outputPath}.tmp-${process.pid}`
      try {
        await sharp(png).png({ compressionLevel: 9 }).toFile(tmpPath)
        const written = await readFile(tmpPath)
        const writtenSha = sha256(written)
        const expectedSha = sha256(png)
        if (writtenSha !== expectedSha) {
          throw new Error(
            `落盘字节与校验 buffer 不一致（期望 ${expectedSha.slice(0, 16)}…，` +
              `实际 ${writtenSha.slice(0, 16)}…）`
          )
        }
        await rename(tmpPath, outputPath)
        const changed = previousSha !== writtenSha
        console.log(
          `[icons] OK ${label.padEnd(26)} ${String(task.size).padStart(3)}×${task.size}  ` +
            `${String(written.length).padStart(6)} B  sha256=${writtenSha.slice(0, 16)}…  ` +
            `changed=${changed}  ${JSON.stringify(details)}`
        )
      } catch (error) {
        await unlink(tmpPath).catch(() => {})
        throw error
      }
    } catch (error) {
      failed = true
      console.error(`[icons] FAIL ${label}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (failed) {
    console.error('[icons] 有图标生成/校验失败，请检查 assets/icons/src/*.svg')
    process.exitCode = 1
    return
  }
  console.log('[icons] 全部占位图标已生成并校验通过。')
}

await main()
