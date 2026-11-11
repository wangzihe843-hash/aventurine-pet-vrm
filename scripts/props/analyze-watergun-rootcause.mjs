#!/usr/bin/env node
/**
 * 根因分析：解释 skill 类 clip 武器骨「距手 1.8~80m」现象，并给出可复核数字。
 *
 * 读 `probe-weapon-hierarchy.py` 的逐文件 trace（含 armature 空间 + world 空间 + Bip001 根对象变换），
 * 输出：
 *   - 每个 clip：武器骨 world 位移幅度、角色根（pelvis）world 位移幅度、武器骨到左右手 world 距离、
 *     武器骨是否「世界静止（staging 静置）」、根运动导致的 armature 空间放大倍数；
 *   - 跨 clip 边界连续性（武器骨/右手 position 对）：证明武器动画是作者数据而非导出损坏；
 *   - 结论分类：held_right / held_left / staged_world_static / fx_independent。
 *
 * Run: node scripts/props/analyze-watergun-rootcause.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const HIER_DIR = path.join(ROOT, 'tests/tmp/props/watergun/data-probe/hierarchy')
const OUT_DIR = path.join(ROOT, 'tests/tmp/props/watergun/data-probe')

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
const median = (vs) => {
  if (!vs.length) return null
  const s = [...vs].sort((a, b) => a - b)
  const n = s.length
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2
}
const maxPairwise = (pts) => {
  let m = 0
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) m = Math.max(m, dist(pts[i], pts[j]))
  return m
}

function loadClips() {
  const files = fs.readdirSync(HIER_DIR).filter((f) => f.endsWith('.json')).sort()
  const clips = []
  for (const f of files) {
    const d = JSON.parse(fs.readFileSync(path.join(HIER_DIR, f), 'utf8'))
    const trace = d.trace ?? []
    const gunKey = 'Gun_b_01_JNT'
    const handR = 'Bip001 R Hand'
    const handL = 'Bip001 L Hand'
    const usable = trace.filter((r) => r[gunKey]?.worldPos && r[handR]?.worldPos && r[handL]?.worldPos)
    if (!usable.length) {
      clips.push({ file: d.file, clip: f.replace(/_skel\.json$/, ''), error: 'no usable trace' })
      continue
    }
    const gunW = usable.map((r) => r[gunKey].worldPos)
    const handRW = usable.map((r) => r[handR].worldPos)
    const handLW = usable.map((r) => r[handL].worldPos)
    const pelvW = usable.map((r) => r['Bip001 Pelvis']?.worldPos ?? [0, 0, 0])
    const gunA = usable.map((r) => r[gunKey].pos)
    const gunHandR = usable.map((r, i) => dist(gunW[i], handRW[i]))
    const gunHandL = usable.map((r, i) => dist(gunW[i], handLW[i]))
    // 相对手稳定度（world 与 armature 等价：均匀缩放不改变距离/夹角）——用 armature 空间相对矩阵需 quat，
    // 这里用 hierarchy 未存相对矩阵，直接引用 probe 全量分析结果（analysis.json）里的 relHand。
    const armatureGunSpan = maxPairwise(gunA)
    const worldGunSpan = maxPairwise(gunW)
    const rootSpan = maxPairwise(pelvW)
    const gunStaticWorld = worldGunSpan <= 0.002 // 世界位移 < 2mm（Blender world 单位）→ 静置
    const ratio = worldGunSpan > 1e-9 ? armatureGunSpan / worldGunSpan : null
    clips.push({
      file: d.file,
      clip: f.replace(/_skel\.json$/, ''),
      fps: undefined,
      frames: usable.map((r) => r.f),
      gunWorldSpan: +worldGunSpan.toFixed(5),
      gunArmatureSpan: +armatureGunSpan.toFixed(3),
      rootPelvisWorldSpan: +rootSpan.toFixed(5),
      armatureOverWorldRatio: ratio === null ? null : +ratio.toFixed(2),
      gunStaticWorld,
      gunHandRWorld: {
        min: +Math.min(...gunHandR).toFixed(5),
        median: +median(gunHandR).toFixed(5),
        max: +Math.max(...gunHandR).toFixed(5),
      },
      gunHandLWorld: {
        min: +Math.min(...gunHandL).toFixed(5),
        median: +median(gunHandL).toFixed(5),
        max: +Math.max(...gunHandL).toFixed(5),
      },
    })
  }
  return clips
}

/** 跨 clip 边界连续性：从 hierarchy trace 取首/末帧的 Gun_b 与 R Hand 的 armature 空间位置。 */
function boundaries() {
  const pairs = [
    ['Skill01_skel', 'last', 'Skill01toSkill02_skel', 'first'],
    ['Skill01toSkill02_skel', 'last', 'Skill02_skel', 'first'],
    ['Skill02_skel', 'last', 'Skill02toSkill01_skel', 'first'],
    ['Skill02toSkill01_skel', 'last', 'Skill01_skel', 'first'],
    ['Skill01ReadyBS_skel', 'last', 'Skill01_skel', 'first'],
    ['Skill01_Ready_skel', 'last', 'Skill01_skel', 'first'],
    ['Skill01ReadyLoop_skel', 'first', 'Skill01_skel', 'first'],
    ['Skill01_Ready_Loop_skel', 'first', 'Skill01_skel', 'first'],
    ['Skill02ReadyLoop_skel', 'first', 'Skill02_skel', 'first'],
    ['Skill04_Ready_Loop_skel', 'first', 'Skill04_skel', 'first'],
    ['Skill03_Ready_skel', 'first', 'Skill03_skel', 'first'],
  ]
  const read = (name) => {
    const p = path.join(HIER_DIR, name + '.json')
    if (!fs.existsSync(p)) return null
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  }
  const pick = (rec, which, bone) => {
    const t = rec?.trace ?? []
    if (!t.length) return null
    const row = which === 'first' ? t[0] : t[t.length - 1]
    return row?.[bone]?.pos ?? null
  }
  const out = []
  for (const [a, aw, b, bw] of pairs) {
    const ra = read(a)
    const rb = read(b)
    if (!ra || !rb) continue
    const gunA = pick(ra, aw, 'Gun_b_01_JNT')
    const gunB = pick(rb, bw, 'Gun_b_01_JNT')
    const handA = pick(ra, aw, 'Bip001 R Hand')
    const handB = pick(rb, bw, 'Bip001 R Hand')
    out.push({
      from: `${a.replace(/_skel$/, '')}#${aw}`,
      to: `${b.replace(/_skel$/, '')}#${bw}`,
      gunPosDelta: gunA && gunB ? +dist(gunA, gunB).toFixed(4) : null,
      handPosDelta: handA && handB ? +dist(handA, handB).toFixed(4) : null,
      fromGun: gunA, toGun: gunB,
    })
  }
  return out
}

/** 从全量 analysis.json 提取每 clip 的 relHand 判定（避免重复计算）。 */
function fromAnalysis() {
  const p = path.join(OUT_DIR, 'analysis.json')
  if (!fs.existsSync(p)) return new Map()
  const a = JSON.parse(fs.readFileSync(p, 'utf8'))
  return new Map(a.rows.filter((r) => r.clipId).map((r) => [r.stem, r]))
}

function main() {
  const clips = loadClips()
  const bounds = boundaries()
  const analysis = fromAnalysis()
  for (const c of clips) {
    const a = analysis.get(c.clip)
    c.verdict = a?.classification?.verdict ?? null
    c.tags = a?.tags ?? null
    c.relR = a?.gun?.relR
      ? { stableFrac: a.gun.relR.stableFrac, distMedian: a.gun.relR.distToHand?.median, clusterOffsetDist: a.gun.relR.clusterOffsetDist }
      : null
    c.relL = a?.gun?.relL
      ? { stableFrac: a.gun.relL.stableFrac, distMedian: a.gun.relL.distToHand?.median, clusterOffsetDist: a.gun.relL.clusterOffsetDist }
      : null
  }
  const out = {
    generatedAt: new Date().toISOString(),
    note: 'world 单位 = Blender 世界单位（角色高≈0.0183）；armature 空间 1 单位≈0.92 真实米（×0.01 到 world，×92.13 到真实米）。armatureOverWorldRatio≈100 说明两空间差 100 倍（armature 单位是 cm 级），不是数据异常。',
    clips,
    boundaries: bounds,
  }
  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(path.join(OUT_DIR, 'rootcause.json'), JSON.stringify(out, null, 2))

  const lines = []
  lines.push('# 武器骨异常根因分析（machine generated）')
  lines.push('')
  lines.push('world 单位：Blender world（角色高≈0.0183）；armature 空间 1 单位≈0.92 真实米。')
  lines.push('')
  lines.push('| clip | tags | 判定 | gunWorldSpan | rootPelvisSpan | gunStaticWorld | arm/world | gun→R手 world(min/med/max) | gun→L手 world |')
  lines.push('|---|---|---|---|---|---|---|---|---|')
  for (const c of clips) {
    if (c.error) { lines.push(`| ${c.clip} | - | ERROR ${c.error} |`); continue }
    lines.push([
      `| \`${c.clip}\``,
      (c.tags ?? []).join('+') || '-',
      c.verdict ?? '-',
      c.gunWorldSpan,
      c.rootPelvisWorldSpan,
      c.gunStaticWorld ? '**YES**' : 'no',
      c.armatureOverWorldRatio,
      `${c.gunHandRWorld.min}/${c.gunHandRWorld.median}/${c.gunHandRWorld.max}`,
      `${c.gunHandLWorld.min}/${c.gunHandLWorld.median}/${c.gunHandLWorld.max}`,
    ].join(' | ') + ' |')
  }
  lines.push('')
  lines.push('## 跨 clip 边界连续性（armature 空间，两 clip 首/末帧对）')
  lines.push('')
  lines.push('| from | to | gunPosDelta | handPosDelta |')
  lines.push('|---|---|---|---|')
  for (const b of bounds) lines.push(`| ${b.from} | ${b.to} | ${b.gunPosDelta} | ${b.handPosDelta} |`)
  lines.push('')
  lines.push('解读：gunPosDelta ≈ handPosDelta（<0.05）说明武器骨在 clip 边界的落点与手/作者意图连续，动画是有效作者数据；')
  lines.push('`Skill01toSkill02#last ↔ Skill02#first` 与 `Skill02#last ↔ Skill02toSkill01#first` 若都小，证明 Skill02 的武器位移是设计好的过渡/FX 轨迹，不是导出损坏。')
  fs.writeFileSync(path.join(OUT_DIR, 'rootcause.md'), lines.join('\n') + '\n')

  console.log(lines.join('\n'))
}

main()
