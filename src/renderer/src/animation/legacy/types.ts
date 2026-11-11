/**
 * B3 动画/姿态系统的纯数据类型（**不 import three / DOM / Electron**）。
 *
 * 设计依据：`docs/anim-tech-survey.md` 方案 B（自研姿态表 + 分层权重混合）。
 * 所有姿态以「度」书写、以 PMX 骨骼名寻址；运行期转成四元数后按层混合。
 */

/** 三维向量（模型单位 = PMX 模型空间；y 向上、+z 朝镜头）。 */
export interface Vec3 {
  x: number
  y: number
  z: number
}

/** 四元数（three 的 `Quat` 同构；纯结构体，避免纯函数模块 import three）。 */
export interface Quat {
  x: number
  y: number
  z: number
  w: number
}

/** 欧拉角（弧度；顺序 YXZ：先绕 y、再 x、最后 z，MMD 作者习惯）。 */
export interface Euler3 {
  x: number
  y: number
  z: number
}

/** 作者书写的欧拉角（**度**，分量可省略；缺省 = 0）。 */
export interface EulerDeg {
  x?: number
  y?: number
  z?: number
}

/**
 * 一个姿态 = 骨名 → 局部旋转偏移（相对 bind pose，单位「度」）。
 * 未列出的受控骨 = 恒等；未在 `CONTROLLED_BONES` 白名单里的骨一律非法（单测锁死）。
 */
export type PoseDef = Readonly<Record<string, EulerDeg>>

/** 骨名 → 局部旋转四元数（运行时姿态）。 */
export type PoseQuats = Map<string, Quat>

/** 脚目标偏移（模型单位；forward = +z 朝镜头、lift = 抬起高度）。 */
export interface FootOffset {
  /** 前后偏移（+ 朝镜头/前）。 */
  forward?: number
  /** 抬起高度（模型单位；0 = 贴地）。 */
  lift?: number
  /** 脚尖外八/内八（度；左正 = 外八）。 */
  yawDeg?: number
  /** 脚掌世界俯仰（度；正 = 脚尖上翘/脚跟着地，负 = 脚尖下压/蹬离）。 */
  pitchDeg?: number
  /** 左右张开（模型单位；左正 = 更靠外）。占位：Wave 2 矢状面 IK 暂不使用。 */
  spread?: number
}

/** 姿态元数据（不参与混合的静态信息：贴地/重心/呼吸缩放等）。 */
export interface PoseMeta {
  /** 姿态 id（与 base pose 表一致）。 */
  id: string
  /** 中文标签（调试/README 用）。 */
  label: string
  /** 是否用解析二骨 IK 把脚钉在地面（站/走/沮丧等接地姿态 = true；坐/睡/爬/腾空 = false）。 */
  grounded?: boolean
  /** 基础重心下沉量（模型单位，正数 = 压低；仅 grounded 姿态使用）。 */
  crouch?: number
  /**
   * `センター.position.y` 额外偏移（模型单位；正数 = 抬高）。
   * 仅非 grounded 姿态需要（例如坐姿把髋部降到表面高度、睡姿微调）。
   */
  centerY?: number
  /** `センター` 绕 Z 轴翻滚（度；睡姿侧躺用；0 = 不翻滚）。 */
  centerRollDeg?: number
  /**
   * `センター` 绕 Y 轴旋转（度；3/4 侧身，正 = 面朝屏幕右）。默认 stand/walk = 8。
   * 让默认姿势不再正对镜头（去掉「T-pose 图纸感」）。
   */
  centerYawDeg?: number
  /** `センター.position.x` 基准偏移（模型单位；正 = 角色左侧；contrapposto 承重脚用）。 */
  centerX?: number
  /** 双脚目标偏移（仅 grounded 姿态使用；缺省 = 站在 bind pose 原位）。 */
  foot?: { left?: FootOffset; right?: FootOffset }
  /** 呼吸/微动层缩放（0 = 关闭，1 = 标准；睡眠 ≈ 0.5）。 */
  breathScale?: number
  /** 呼吸频率缩放（睡眠 ≈ 0.55）。 */
  breathRate?: number
  /** 是否允许随机待机变体（仅 stand 为 true）。 */
  idleVariants?: boolean
  /** 待机微表情（该姿态下的基线表情；在 emotion.ts 里定义）。 */
  baseEmotion?: string
}

/** 情绪 id（emotion.ts 的 `EMOTION_DEFS` 键；用字符串别名避免循环 import）。 */
export type EmotionId =
  | 'neutral'
  | 'business'
  | 'smirk'
  | 'realSmile'
  | 'tired'
  | 'wry'
  | 'shy'
  | 'annoyed'
  | 'angry'
  | 'sad'
  | 'surprise'
  | 'celebrate'
  | 'busy'
  | 'soft'

/** 注视目标（弧度；已由死区/上限处理前是「原始视觉角度」）。 */
export interface GazeTarget {
  yaw: number
  pitch: number
}

/** 手势关键帧（`at` = 秒；`pose` 为该时刻的局部旋转目标，单位「度」）。 */
export interface GestureKeyframe {
  /** 相对手势开始的秒数。 */
  at: number
  /** 该时刻的姿态（作者用「度」书写）。 */
  pose: PoseDef
  /** 可选：该时刻切换的表情（用于「僵住→软→翻脸」这种分段反应）。 */
  emotion?: EmotionId
  /** 可选：该时刻的强制注视（度；覆盖鼠标注视，例如看手里的「硬币」）。 */
  gaze?: { yawDeg: number; pitchDeg: number }
}

/** 一次性手势/反应定义（待机变体 + 摸头/戳/甩出/落地反应共用一套 keyframe 结构）。 */
export interface GestureDef {
  id: string
  /** 中文标签。 */
  label: string
  /** 总时长（秒）。 */
  duration: number
  /** 淡入时长（秒；默认 0.12）。 */
  fadeIn?: number
  /** 淡出时长（秒；默认 0.2）。 */
  fadeOut?: number
  /** 只影响这些骨（bone mask）；缺省 = 全身覆盖（仍受受控骨白名单约束）。 */
  mask?: readonly string[]
  /** 关键帧（至少 2 个；按 `at` 升序）。 */
  keyframes: readonly GestureKeyframe[]
  /** 手势级表情（进入后 `emotionDelay` 秒生效）。 */
  emotion?: EmotionId
  /** 手势表情延迟（秒；默认 0.15）。 */
  emotionDelay?: number
  /** 是否反应类手势（反应类会打断待机变体、优先级更高）。 */
  reaction?: boolean
  /** 落地/被戳时的重心下沉脉冲（模型单位；仅 grounded 时由 IK 转化为屈膝）。 */
  crouchPulse?: number
}

/** 姿态过渡默认时长（秒，smoothstep）。 */
export const DEFAULT_POSE_FADE_SEC = 0.25

/** 单帧 dt 上限（秒；与 `PetScene.MAX_FRAME_DELTA_SECONDS` 同口径）。 */
export const MAX_DT_SEC = 0.1
