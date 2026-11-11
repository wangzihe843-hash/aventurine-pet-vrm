/**
 * Unity bake（Wave 1.5 / U2）测试用 fixture 工厂。
 *
 * 目标：不依赖私有 assets（gitignore）也能构造**合法** clip / selection 数据，
 * 再按需破坏单个字段来覆盖每条校验规则的正反例。
 *
 * 注意：本文件不是 `*.test.ts`，不会被 vitest 收集；被 4 个 unity-bake 测试文件 import。
 * lib 是纯 ESM（无类型声明），测试不纳入 `tsc`（tsconfig.node.json 只含 src/main|preload|shared），
 * 因此这里用 `// @ts-expect-error` 仅为编辑器提示兜底（vitest 走 esbuild 不做类型检查）。
 */
// @ts-expect-error -- scripts/unity-bake/lib/*.mjs 纯 ESM 无 .d.ts；vitest 运行时正常解析
import { CLIP_OPTIONAL_BONES, CLIP_REQUIRED_BONES } from '../../../scripts/unity-bake/lib/humanoid-map.mjs'

export type Quat = [number, number, number, number]

/** 单位四元数。 */
export function identityQuat(): Quat {
  return [0, 0, 0, 1]
}

/** 绕任意轴旋转 deg 度的四元数（轴无需归一化）。 */
export function axisAngleQuat(axis: [number, number, number], deg: number): Quat {
  const length = Math.hypot(axis[0], axis[1], axis[2]) || 1
  const half = (deg * Math.PI) / 180 / 2
  const sin = Math.sin(half)
  return [(axis[0] / length) * sin, (axis[1] / length) * sin, (axis[2] / length) * sin, Math.cos(half)]
}

/** 四元数乘法 a*b。 */
export function quatMul(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]
  ]
}

/** 四元数点积。 */
export function quatDot(a: Quat, b: Quat): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]
}

/** 四元数模长。 */
export function quatNorm(q: Quat): number {
  return Math.hypot(q[0], q[1], q[2], q[3])
}

/** 两个四元数夹角（度，0–180）。 */
export function quatAngleDeg(a: Quat, b: Quat): number {
  return (2 * Math.acos(Math.min(1, Math.abs(quatDot(a, b)))) * 180) / Math.PI
}

/** 默认逐帧旋转：每帧缓变 0.5°，保证「连续、非重复、无大跳变」。 */
export function defaultQuatAt(boneIndex: number, frame: number): Quat {
  return axisAngleQuat([0, 1, 0], 0.5 + frame * 0.5 + boneIndex * 0.01)
}

/** 30 根手指的额外轨道（默认逐帧缓变 0.5°），用于测试「含手指的 52 骨 clip」。 */
export function fingerExtraBones(
  frames: number,
  quatAt?: (boneName: string, frame: number, boneIndex: number) => Quat
): Record<string, { r: Quat[] }> {
  const generate =
    quatAt ?? ((_boneName: string, frame: number, boneIndex: number) => defaultQuatAt(boneIndex, frame))
  const extra: Record<string, { r: Quat[] }> = {}
  CLIP_OPTIONAL_BONES.forEach((boneName: string, boneIndex: number) => {
    const r: Quat[] = []
    for (let frame = 0; frame < frames; frame += 1) {
      r.push(generate(boneName, frame, CLIP_REQUIRED_BONES.length + boneIndex))
    }
    extra[boneName] = { r }
  })
  return extra
}

export interface ClipOptions {
  clip?: string
  mood?: string | null
  loop?: boolean
  fps?: number
  frames?: number
  duration?: number
  /** 逐骨覆盖 `bones[name]`（r/p 可单独覆盖；传 null 表示删掉该骨）。 */
  bones?: Record<string, { r?: unknown; p?: unknown } | null>
  /** 逐帧旋转生成器（默认 defaultQuatAt）。 */
  quatAt?: (boneName: string, frame: number, boneIndex: number) => Quat
  /** Hips p 生成器；返回 null 表示不输出 p。默认全零。 */
  hipsAt?: (frame: number) => [number, number, number] | null
  /** 从合法骨集里删除这些骨。 */
  omitBones?: string[]
  /** 额外骨骼（未知骨 / 非 Hips 带 p 等）。 */
  extraBones?: Record<string, unknown>
  version?: number
  space?: string
  sourceHeight?: number
}

/**
 * 生成一个默认**通过全部校验**的 clip 数据。
 * 默认：5 帧 / 30fps / loop，22 骨每帧 ~0.5° 缓变，Hips p 全零。
 */
export function makeClip(options: ClipOptions = {}): Record<string, unknown> {
  const frames = options.frames ?? 5
  const fps = options.fps ?? 30
  const loop = options.loop ?? true
  const duration = options.duration ?? (loop ? frames / fps : (frames - 1) / fps)
  const quatAt =
    options.quatAt ?? ((_boneName: string, frame: number, boneIndex: number) => defaultQuatAt(boneIndex, frame))
  const omit = new Set(options.omitBones ?? [])
  const hipsAt = options.hipsAt ?? (() => [0, 0, 0])

  const bones: Record<string, unknown> = {}
  CLIP_REQUIRED_BONES.forEach((boneName: string, boneIndex: number) => {
    if (omit.has(boneName)) return
    const r: Quat[] = []
    for (let frame = 0; frame < frames; frame += 1) r.push(quatAt(boneName, frame, boneIndex))
    const entry: Record<string, unknown> = { r }
    if (boneName === 'Hips') {
      const p: Array<[number, number, number] | null> = []
      for (let frame = 0; frame < frames; frame += 1) p.push(hipsAt(frame))
      if (p.every((point) => point !== null)) entry.p = p
    }
    bones[boneName] = entry
  })
  for (const [name, track] of Object.entries(options.bones ?? {})) {
    if (track === null) delete bones[name]
    else bones[name] = track
  }
  Object.assign(bones, options.extraBones ?? {})

  return {
    version: options.version ?? 1,
    clip: options.clip ?? 'fixtureClip',
    mood: options.mood ?? null,
    loop,
    fps,
    duration,
    sourceHeight: options.sourceHeight ?? 1.7,
    space: options.space ?? 'gltf-rh',
    frames,
    bones
  }
}

/** 把 nested 形状（`r=[[x,y,z,w],...]`、`p=[[dx,dy,dz],...]`）转成 flat 形状。 */
export function toFlatClip(clip: Record<string, unknown>): Record<string, unknown> {
  const bones = clip.bones as Record<string, { r?: unknown; p?: unknown }>
  const nextBones: Record<string, { r?: unknown; p?: unknown }> = {}
  for (const [name, track] of Object.entries(bones)) {
    const next: { r?: unknown; p?: unknown } = {}
    if (Array.isArray(track.r)) next.r = (track.r as unknown[][]).flat()
    if (Array.isArray(track.p)) next.p = (track.p as unknown[][]).flat()
    nextBones[name] = next
  }
  return { ...clip, bones: nextBones }
}

export interface SelectionOptions {
  fps?: number
  motionSet?: string
  requirements?: Record<string, number>
  clips?: Array<Record<string, unknown>>
}

/** 生成一个默认合法的 selection（clips.json 新 schema）。 */
export function makeSelection(options: SelectionOptions = {}): Record<string, unknown> {
  return {
    fps: options.fps ?? 30,
    motionSet: options.motionSet ?? 'mate',
    requirements: options.requirements ?? { idle: 1 },
    clips: options.clips ?? [
      {
        name: 'idle',
        path: 'PET_IDLE/PET_IDLE.anim',
        mood: 'idle',
        tags: ['idle'],
        loop: true,
        timeScale: 1,
        priority: 0,
        note: '待机循环（fixture）'
      }
    ]
  }
}

/** 生成一条 selection clip 条目（补默认值）。 */
export function makeSelectionClip(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'idle',
    path: 'PET_IDLE/PET_IDLE.anim',
    mood: 'idle',
    tags: ['idle'],
    loop: true,
    timeScale: 1,
    priority: 0,
    note: '待机循环（fixture）',
    ...overrides
  }
}

/** 构造两个默认合法 clip 的 { selection, clips } 组合。 */
export function makeSelectionBundle(): {
  selection: Record<string, unknown>
  clips: Record<string, Record<string, unknown>>
} {
  const idle = makeClip({ clip: 'idle', frames: 6 })
  const hide = makeClip({ clip: 'hideLeft', frames: 6 })
  const selection = makeSelection({
    requirements: { idle: 1, hiding: 1 },
    clips: [
      makeSelectionClip({ name: 'idle', tags: ['idle'] }),
      makeSelectionClip({
        name: 'hideLeft',
        path: 'PET_HIDING/PET_HIDE_SHOW_LOOP_LEFT.anim',
        mood: '',
        tags: ['hiding']
      })
    ]
  })
  return { selection, clips: { idle, hideLeft: hide } }
}
