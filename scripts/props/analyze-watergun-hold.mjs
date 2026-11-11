#!/usr/bin/env node
/**
 * 后处理：把 probe-watergun-hold.py 的逐文件原始指标 → 「该 clip 源数据是否持枪」判定，
 * 并与现有 `watergun-attach.json` 的 policy 交叉出差异清单。
 *
 * 判定依据（数据驱动，不看 tag）：
 *  1) 武器骨（Gun_b_01_JNT 为主）在 armature 空间的位置/姿态是否真的被动画；
 *  2) 武器骨相对左右手 `T = inv(H_hand) · G_gun` 是否跨帧近似恒定（稳定簇）→ 跟手；
 *  3) 武器骨到左右手的距离（armature 空间，单位≈归一化米）是否在手边。
 *
 * 注意：每个 _skel.fbx 的 bind/rest pose 是逐文件不同的（导出时把当前姿态写成 bind pose），
 * 所以「相对 rest 的偏差」不可跨文件比较；本脚本全部用 pose matrix 的绝对/相对量。
 *
 * Run: node scripts/props/analyze-watergun-hold.mjs [--json out.json] [--csv out.csv]
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const PROBE_DIR = path.join(ROOT, 'tests/tmp/props/watergun/data-probe/per-file')
const CONFIG_PATH = path.join(ROOT, 'scripts/vrm/motion/clips.adv-all.json')
const ATTACH_PATH = path.join(ROOT, 'src/renderer/src/vrm/watergun-attach.json')
const OUT_DIR = path.join(ROOT, 'tests/tmp/props/watergun/data-probe')

// ---- 阈值（单位：armature 空间，≈ 归一化米；1 单位 ≈ 1.20 真实米，见 REPORT）----
const THRESH = {
  nearHandM: 0.30,          // 武器骨到手骨距离 <= 30cm → 手边
  stablePosP90M: 0.05,      // 稳定簇内相对手位置 p90 <= 5cm
  stableRotP90Deg: 20,      // 稳定簇内相对手旋转 p90 <= 20°
  stableFrac: 0.5,          // 稳定簇覆盖帧比例 >= 50% → 跟手
  partialFrac: 0.15,        // 15%~50% → 部分跟手（draw/release 过渡）
  staticMotionP90M: 0.05,   // 武器骨自身运动 p90 <= 5cm → 武器骨未被动画
  groundZM: -0.60,          // armature 空间地面 ≈ -0.85；z < -0.6 视为贴地
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

function main() {
  const clipsConfig = readJson(CONFIG_PATH)
  const attach = readJson(ATTACH_PATH)
  const policy = attach.policy ?? {}
  const policySets = policy.holdSets ?? []
  const policyTags = policy.holdTags ?? []
  const policyIds = policy.holdClipIds ?? []

  const takeToClip = new Map()
  for (const clip of clipsConfig.clips) {
    takeToClip.set(String(clip.takeMatch).replace(/\.fbx$/i, ''), clip)
  }

  const files = fs.readdirSync(PROBE_DIR).filter((f) => f.endsWith('.json')).sort()
  const rows = []
  const unmatched = []

  for (const fname of files) {
    const d = readJson(path.join(PROBE_DIR, fname))
    const stem = fname.replace(/\.json$/, '').replace(/_skel$/, '')
    const clip = takeToClip.get(stem) ?? null
    if (!clip) unmatched.push({ file: fname, stem })
    const gun = d.weaponBones?.['Gun_b_01_JNT'] ?? d.weaponBones?.['prop_JNT'] ?? null
    const handR = d.handMotion?.R ?? null
    const series = d.series?.['Gun_b_01_JNT'] ?? d.series?.['prop_JNT'] ?? null
    const gunZ = series?.pos?.map((p) => p[2]) ?? []
    const zMedian = gunZ.length ? median(gunZ) : null
    const groundFrac = gunZ.length ? gunZ.filter((z) => z < THRESH.groundZM).length / gunZ.length : null
    const row = {
      file: fname,
      stem,
      clipId: clip?.id ?? null,
      takeMatch: clip?.takeMatch ?? null,
      tags: clip?.tags ?? [],
      loop: clip?.loop ?? null,
      fps: d.fps,
      frameRange: d.bipedFrameRange,
      samples: d.sampleFrames?.length ?? 0,
      error: d.error ?? null,
      handMoveP90: handR?.posP90 ?? null,
      gun: gun
        ? {
            motionPosP90: gun.motion?.posP90 ?? null,
            motionRotP90Deg: gun.motion?.rotP90Deg ?? null,
            scaleRange: gun.scaleRange ?? null,
            restDevPosMax: gun.restDev?.posMax ?? null,
            zMedian,
            groundFrac,
            relR: gun.relHand?.R ?? null,
            relL: gun.relHand?.L ?? null,
          }
        : null,
    }
    row.classification = classify(row)
    row.policyHold = clip
      ? policyIds.includes(clip.id) || (policySets.includes('adv') && policyTags.some((t) => (clip.tags ?? []).includes(t)))
      : null
    row.diff = diffLabel(row.policyHold, row.classification)
    rows.push(row)
  }

  // ---- 汇总 ----
  const clipped = rows.filter((r) => r.clipId)
  const counts = {}
  for (const r of clipped) {
    const v = r.classification.verdict
    counts[v] = (counts[v] ?? 0) + 1
  }
  const diffCounts = { policy_and_data_hold: 0, policy_only: 0, data_only: 0, neither: 0 }
  for (const r of clipped) diffCounts[r.diff] = (diffCounts[r.diff] ?? 0) + 1

  const analysis = {
    generatedAt: new Date().toISOString(),
    source: {
      probe: 'scripts/props/probe-watergun-hold.py',
      probeDir: path.relative(ROOT, PROBE_DIR),
      clipsConfig: path.relative(ROOT, CONFIG_PATH),
      attach: path.relative(ROOT, ATTACH_PATH),
    },
    units: 'armature space ≈ normalized meters (x1.20 real meters; ground z≈-0.85)',
    thresholds: THRESH,
    currentPolicy: { holdSets: policySets, holdTags: policyTags, holdClipIds: policyIds },
    summary: {
      probeFiles: files.length,
      matchedClips: clipped.length,
      unmatchedFiles: unmatched,
      verdicts: counts,
      diffs: diffCounts,
      probeErrors: rows.filter((r) => r.error).map((r) => ({ file: r.file, error: r.error })),
    },
    rows: rows.map((r) => ({
      ...r,
      gun: r.gun
        ? {
            ...r.gun,
            relR: slimRel(r.gun.relR),
            relL: slimRel(r.gun.relL),
          }
        : null,
    })),
  }

  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(path.join(OUT_DIR, 'analysis.json'), JSON.stringify(analysis, null, 2))
  fs.writeFileSync(path.join(OUT_DIR, 'analysis-table.md'), renderMarkdown(analysis))
  fs.writeFileSync(path.join(OUT_DIR, 'analysis-table.csv'), renderCsv(analysis))

  // stdout 摘要
  console.log(`probe files: ${files.length}; matched clips: ${clipped.length}; unmatched: ${JSON.stringify(unmatched.map((u) => u.file))}`)
  console.log('verdicts:', JSON.stringify(counts))
  console.log('diffs:', JSON.stringify(diffCounts))
  if (analysis.summary.probeErrors.length) console.log('PROBE ERRORS:', JSON.stringify(analysis.summary.probeErrors))
  console.log('\n=== 数据判定持枪 / 现有规则持枪 差异清单 ===')
  for (const r of clipped) {
    if (r.diff === 'neither') continue
    const g = r.gun
    console.log([
      r.clipId.padEnd(22),
      r.tags.join('+').padEnd(16),
      r.diff.padEnd(22),
      r.classification.verdict.padEnd(24),
      `dR=${fmt(g?.relR?.distToHand?.median)}`,
      `dL=${fmt(g?.relL?.distToHand?.median)}`,
      `stableR=${fmt(g?.relR?.stableFrac)}`,
      `mov=${fmt(g?.motionPosP90)}`,
      `z=${fmt(g?.zMedian)}`,
    ].join(' '))
  }
  console.log('\n=== 全部 clip 判定表 ===')
  for (const r of clipped) {
    console.log([
      r.clipId.padEnd(22),
      r.tags.join('+').padEnd(16),
      (r.policyHold ? 'HOLD' : '----').padEnd(5),
      r.classification.verdict.padEnd(26),
      r.classification.reason,
    ].join(' '))
  }
}

function median(values) {
  if (!values.length) return null
  const s = [...values].sort((a, b) => a - b)
  const n = s.length
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2
}

function fmt(v, digits = 3) {
  return v === null || v === undefined || Number.isNaN(v) ? '-' : Number(v).toFixed(digits)
}

function slimRel(rel) {
  if (!rel) return null
  return {
    stableFrac: rel.stableFrac,
    stableClusterSize: rel.stableClusterSize,
    clusterOffsetDist: rel.clusterMedianOffsetDist ?? null,
    clusterPosP90: rel.clusterPosP90 ?? null,
    clusterRotP90Deg: rel.clusterRotP90Deg ?? null,
    medianOffsetDist: rel.medianOffsetDist,
    distToHand: rel.distToHand,
    pairwise: rel.pairwise,
  }
}

/** 数据判定：返回 { verdict, side, reason, flags } */
function classify(row) {
  const g = row.gun
  if (!g) return { verdict: 'no_weapon_bones', side: null, reason: '武器骨缺失' }
  // 源动作把武器骨 scale 压到 0 = 枪在源动作里被隐藏（如 Idle_Show_01）；bind 矩阵也因此 NaN
  const scaleMax = Array.isArray(g.scaleRange) ? g.scaleRange[1] : null
  if (scaleMax !== null && scaleMax <= 0.01) {
    return {
      verdict: 'not_held_hidden_scale0',
      side: null,
      reason: `源动作把武器骨 scale 压到 0（范围 ${JSON.stringify(g.scaleRange)}）= 源里隐藏武器`,
      flags: { scaleRange: g.scaleRange },
    }
  }
  const relR = g.relR ?? null
  const relL = g.relL ?? null
  const dR = relR?.distToHand?.median ?? Infinity
  const dL = relL?.distToHand?.median ?? Infinity
  const nearR = dR <= THRESH.nearHandM
  const nearL = dL <= THRESH.nearHandM
  const motion = g.motionPosP90 ?? 0

  if (!nearR && !nearL) {
    if (motion <= THRESH.staticMotionP90M) {
      return {
        verdict: 'not_held_static',
        side: null,
        reason: `武器骨离双手远(dR=${fmt(dR)},dL=${fmt(dL)})且自身几乎不动(motionP90=${fmt(motion)})`,
        flags: { nearR, nearL, motion, dR, dL },
      }
    }
    // 武器动但离手远：贴地滑走 / 独立武器动画（含 Skill41 的数值爆走）
    return {
      verdict: 'not_held_independent',
      side: null,
      reason: `武器骨自身有动画(motionP90=${fmt(motion)})但离双手远(dR=${fmt(dR)},dL=${fmt(dL)})`,
      flags: { nearR, nearL, motion, dR, dL, groundFrac: g.groundFrac },
    }
  }

  const side = nearR && nearL ? (dR <= dL ? 'R' : 'L') : nearR ? 'R' : 'L'
  const rel = side === 'R' ? relR : relL
  const other = side === 'R' ? relL : relR
  const stableFrac = rel?.stableFrac ?? 0
  const posP90 = rel?.clusterPosP90 ?? null
  const rotP90 = rel?.clusterRotP90Deg ?? null
  const rigid = posP90 !== null && posP90 <= THRESH.stablePosP90M && (rotP90 === null || rotP90 <= THRESH.stableRotP90Deg)
  const flags = {
    nearR, nearL, side, dR, dL, stableFrac, posP90, rotP90, motion,
    otherDist: other?.distToHand?.median ?? null,
    clusterOffsetDist: rel?.clusterMedianOffsetDist ?? null,
    groundFrac: g.groundFrac,
  }
  if (stableFrac >= THRESH.stableFrac && rigid) {
    return {
      verdict: `held_${side.toLowerCase()}`,
      side,
      reason: `跟${side}手：稳定簇 ${(stableFrac * 100).toFixed(0)}% 帧，簇内位置p90=${fmt(posP90)}m 旋转p90=${fmt(rotP90, 1)}°，握持偏移=${fmt(rel.clusterMedianOffsetDist)}`,
      flags,
    }
  }
  if (stableFrac >= THRESH.stableFrac) {
    return {
      verdict: `held_${side.toLowerCase()}_rotating`,
      side,
      reason: `在${side}手中但相对旋转/位置有自身动画：稳定簇 ${(stableFrac * 100).toFixed(0)}%，位置p90=${fmt(posP90)} 旋转p90=${fmt(rotP90, 1)}°`,
      flags,
    }
  }
  if (stableFrac >= THRESH.partialFrac) {
    return {
      verdict: `partial_hold_${side.toLowerCase()}`,
      side,
      reason: `仅部分帧跟${side}手（稳定簇 ${(stableFrac * 100).toFixed(0)}%）：draw/收枪过渡`,
      flags,
    }
  }
  return {
    verdict: 'ambiguous_near_hand',
    side,
    reason: `武器骨在${side}手边(d=${fmt(side === 'R' ? dR : dL)})但相对变换不稳定（稳定簇 ${(stableFrac * 100).toFixed(0)}%）`,
    flags,
  }
}

function isDataHold(verdict) {
  return verdict === 'held_r' || verdict === 'held_l' || verdict === 'held_r_rotating' ||
    verdict === 'held_l_rotating' || verdict === 'partial_hold_r' || verdict === 'partial_hold_l'
}

function diffLabel(policyHold, classification) {
  const dataHold = isDataHold(classification.verdict)
  if (policyHold && dataHold) return 'policy_and_data_hold'
  if (policyHold && !dataHold) return 'policy_only'
  if (!policyHold && dataHold) return 'data_only'
  return 'neither'
}

function renderMarkdown(analysis) {
  const lines = []
  lines.push('# 水枪持枪数据探针 — 判定表（machine generated）')
  lines.push('')
  lines.push(`生成时间：${analysis.generatedAt}`)
  lines.push('')
  lines.push(`探针文件 ${analysis.summary.probeFiles}；匹配 clip ${analysis.summary.matchedClips}；差异：\`${JSON.stringify(analysis.summary.diffs)}\``)
  lines.push('')
  lines.push('列说明：`stableR/L` = 相对右/左手稳定簇帧占比；`dR/dL` = 武器骨到右/左手距离中位数（armature 空间，≈归一化米）；`movP90` = 武器骨自身位移 p90；`zMed` = 武器骨 z 中位数（地面≈-0.85）。')
  lines.push('')
  lines.push('| clip | tags | 现有规则 | 数据判定 | stableR | stableL | dR | dL | movP90 | zMed | scale | 理由 |')
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const r of analysis.rows.filter((x) => x.clipId)) {
    const g = r.gun
    lines.push([
      `| \`${r.clipId}\``,
      r.tags.join('+') || '-',
      r.policyHold ? 'HOLD' : '-',
      `**${r.classification.verdict}**`,
      fmt(g?.relR?.stableFrac),
      fmt(g?.relL?.stableFrac),
      fmt(g?.relR?.distToHand?.median),
      fmt(g?.relL?.distToHand?.median),
      fmt(g?.motionPosP90),
      fmt(g?.zMedian),
      g?.scaleRange ? `${fmt(g.scaleRange[0], 2)}~${fmt(g.scaleRange[1], 2)}` : '-',
      r.classification.reason,
    ].join(' | ') + ' |')
  }
  return lines.join('\n') + '\n'
}

function renderCsv(analysis) {
  const header = ['clipId', 'tags', 'policyHold', 'verdict', 'side', 'stableR', 'stableL', 'dR', 'dL', 'movP90', 'zMedian', 'groundFrac', 'scaleMin', 'scaleMax', 'fps', 'frameStart', 'frameEnd', 'file']
  const lines = [header.join(',')]
  for (const r of analysis.rows.filter((x) => x.clipId)) {
    const g = r.gun
    lines.push([
      r.clipId,
      r.tags.join('+'),
      r.policyHold ? 1 : 0,
      r.classification.verdict,
      r.classification.side ?? '',
      fmt(g?.relR?.stableFrac),
      fmt(g?.relL?.stableFrac),
      fmt(g?.relR?.distToHand?.median),
      fmt(g?.relL?.distToHand?.median),
      fmt(g?.motionPosP90),
      fmt(g?.zMedian),
      fmt(g?.groundFrac),
      fmt(g?.scaleRange?.[0], 2),
      fmt(g?.scaleRange?.[1], 2),
      r.fps,
      r.frameRange?.[0] ?? '',
      r.frameRange?.[1] ?? '',
      r.file,
    ].join(','))
  }
  return lines.join('\n') + '\n'
}

main()
