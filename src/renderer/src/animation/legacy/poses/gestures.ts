/**
 * 一次性手势/反应库（keyframe；作者以**度**书写）。
 *
 * 两类：
 * 1. **待机变体**（`IDLE_VARIANTS`，仅 `stand` 且无交互时随机播放）：
 *    按 `docs/aventurine-character-brief.md` §4.2 的权重取舍——只做无道具可读的动作：
 *    空手捻筹码 / 抛接硬币 / 整理衣领袖口 / 伸懒腰 / 望远处发呆 / 两指敬礼；
 *    **不做**骰子/扑克/轮盘/假道具持物、不做女性化娇羞摇摆。
 * 2. **反应**（`REACTIONS`，摸头/戳/甩出/落地）：高优先级、可打断待机变体；
 *    摸头按 brief 两段式「僵住 → 偷偷接受 → 意识到后直回去」。
 *
 * 关键帧约定：`at` 秒、pose 只写需要偏离基础姿态的骨；首/末帧用 `{}` 表示回到基础姿态。
 * 角度数值是设计起点，后续按 dev 截图回环微调（「慢—快—停半拍」的节奏优先于幅度）。
 */
import type { GestureDef, PoseDef } from '../types'

/** 上半身 mask（待机变体用：腿交给基础姿态/接地 IK，避免走路时腿被「手戏」带偏）。 */
export const UPPER_BODY_MASK: readonly string[] = [
  '上半身',
  '上半身2',
  '首',
  '頭',
  '左肩',
  '右肩',
  '左腕',
  '右腕',
  '左ひじ',
  '右ひじ',
  '左手首',
  '右手首'
]

/** 头/颈/肩 mask（摸头/戳脸反应）。 */
export const HEAD_MASK: readonly string[] = ['上半身', '上半身2', '首', '頭', '左肩', '右肩']

/** 躯干+手臂 mask（戳身体/缩身/落地平衡）。 */
export const TORSO_ARM_MASK: readonly string[] = [
  '上半身',
  '上半身2',
  '首',
  '頭',
  '左肩',
  '右肩',
  '左腕',
  '右腕',
  '左ひじ',
  '右ひじ',
  '左手首',
  '右手首'
]

/** 落地：冲击 crouchPulse 由管线按 impactSpeed 覆盖（默认 0.55 模型单位）。 */
export interface ReactionDefaults {
  /** 默认下蹲脉冲（模型单位；仅 grounded 时由 IK 转成屈膝）。 */
  crouchPulse?: number
}

/* ========================================================================== */
/* 待机变体                                                                    */
/* ========================================================================== */

/** 待机变体 A：空手捻筹码（主待机，权重最高；视线看固定高度的手，不看镜头）。 */
const COIN_ROLL: GestureDef = {
  id: 'coinRoll',
  label: '空手捻筹码',
  duration: 3.8,
  fadeIn: 0.18,
  fadeOut: 0.25,
  mask: UPPER_BODY_MASK,
  emotion: 'smirk',
  emotionDelay: 2.7,
  keyframes: [
    { at: 0, pose: {} },
    // 取物：右手到腰侧虚握，肩下沉、肘弯 70–90°，头低 5–8° 看手
    {
      at: 0.55,
      pose: {
        右肩: { z: -4 },
        右腕: { z: 26, y: -12 },
        右ひじ: { x: -58 },
        右手首: { z: -6, x: -8 },
        上半身: { x: 1, y: -2 },
        首: { x: 7, y: 5 },
        頭: { x: 4, y: 4 }
      },
      gaze: { yawDeg: -7, pitchDeg: 17 }
    },
    // 亮物：手腕翻到掌心向上，停顿半拍
    {
      at: 1.05,
      pose: {
        右肩: { z: -4 },
        右腕: { z: 16, y: -32 },
        右ひじ: { x: -78 },
        右手首: { z: 22, x: 12 },
        上半身: { x: 1, y: -2 },
        首: { x: 8, y: 5 },
        頭: { x: 5, y: 4 }
      },
      gaze: { yawDeg: -6, pitchDeg: 20 }
    },
    // 指上滚（快）：拇指依次推过指节，手腕小幅内旋
    {
      at: 1.65,
      pose: {
        右腕: { z: 18, y: -34 },
        右ひじ: { x: -82 },
        右手首: { z: 38, x: 6 },
        首: { x: 7, y: 4 },
        頭: { x: 4, y: 3 }
      },
      gaze: { yawDeg: -6, pitchDeg: 19 }
    },
    // 抛：手抬到胸口/下巴高度，头抬 5–8°，眼睛追上去
    {
      at: 2.35,
      pose: {
        右腕: { z: 8, y: -54 },
        右ひじ: { x: -96 },
        右手首: { x: 26 },
        首: { x: 0, y: 3 },
        頭: { x: -3, y: 3 }
      },
      gaze: { yawDeg: -4, pitchDeg: 8 }
    },
    // 接：手掌在胸口高度合拢，手腕轻顿（snap）
    {
      at: 2.62,
      pose: {
        右腕: { z: 12, y: -46 },
        右ひじ: { x: -82 },
        右手首: { x: -4 },
        首: { x: 2, y: 4 },
        頭: { x: 0, y: 4 }
      },
      gaze: { yawDeg: -5, pitchDeg: 12 }
    },
    // 看结果：手腕外翻、头偏，`にやり` 从下往上看用户（停半拍）
    {
      at: 3.05,
      pose: {
        右腕: { z: 18, y: -40 },
        右ひじ: { x: -74 },
        右手首: { z: 26, x: 18 },
        首: { x: -2, y: -3 },
        頭: { x: -2, y: -5, z: 1 },
        上半身: { x: 0, y: 2 }
      },
      emotion: 'smirk',
      gaze: { yawDeg: -8, pitchDeg: 4 }
    },
    // 收：手收回腰侧、下巴抬起、回到呼吸
    {
      at: 3.45,
      pose: {
        右腕: { z: 22, x: -6 },
        右ひじ: { x: -40 },
        右手首: { x: -4 },
        首: { x: 0, y: 1 },
        頭: { x: -1, y: 2 }
      }
    },
    { at: 3.8, pose: {} }
  ]
}

/** 待机变体 B：抛接硬币看结果（短版，接住后看正面/反面再收）。 */
const COIN_TOSS: GestureDef = {
  id: 'coinToss',
  label: '抛接硬币看结果',
  duration: 2.9,
  fadeIn: 0.16,
  fadeOut: 0.22,
  mask: UPPER_BODY_MASK,
  keyframes: [
    { at: 0, pose: {} },
    {
      at: 0.45,
      pose: {
        右腕: { z: 24, y: -14 },
        右ひじ: { x: -62 },
        右手首: { z: -4, x: -6 },
        首: { x: 6, y: 4 },
        頭: { x: 3, y: 3 }
      },
      gaze: { yawDeg: -6, pitchDeg: 16 }
    },
    {
      at: 0.95,
      pose: {
        右腕: { z: 6, y: -56 },
        右ひじ: { x: -94 },
        右手首: { x: 24 },
        首: { x: -2, y: 2 },
        頭: { x: -4, y: 2 }
      },
      gaze: { yawDeg: -4, pitchDeg: 6 }
    },
    {
      at: 1.35,
      pose: {
        右腕: { z: 12, y: -44 },
        右ひじ: { x: -80 },
        右手首: { x: -6 },
        首: { x: 2, y: 3 },
        頭: { x: 0, y: 3 }
      },
      gaze: { yawDeg: -5, pitchDeg: 12 }
    },
    {
      at: 1.85,
      pose: {
        右腕: { z: 20, y: -38 },
        右ひじ: { x: -70 },
        右手首: { z: 28, x: 16 },
        首: { x: -1, y: -4 },
        頭: { x: -2, y: -6 }
      },
      emotion: 'smirk',
      gaze: { yawDeg: -8, pitchDeg: 2 }
    },
    { at: 2.4, pose: {} },
    { at: 2.9, pose: {} }
  ]
}

/** 待机变体 C：整理衣领/袖口/手链（最安全、最贴「体面」人设，可高频）。 */
const ADJUST_CUFF: GestureDef = {
  id: 'adjustCuff',
  label: '整理衣领袖口',
  duration: 2.8,
  fadeIn: 0.2,
  fadeOut: 0.25,
  mask: UPPER_BODY_MASK,
  emotion: 'smirk',
  emotionDelay: 2.0,
  keyframes: [
    { at: 0, pose: {} },
    // 双手抬到领口
    {
      at: 0.55,
      pose: {
        左腕: { z: 26, y: -58 },
        右腕: { z: -20, y: 60 },
        左ひじ: { x: -104, y: 10 },
        右ひじ: { x: -108, y: -10 },
        左手首: { x: 14 },
        右手首: { x: 14 },
        首: { x: 5, y: 2 },
        頭: { x: 3, y: 2 }
      },
      gaze: { yawDeg: 0, pitchDeg: 14 }
    },
    // 拉平衣领
    {
      at: 1.1,
      pose: {
        左腕: { z: 28, y: -54 },
        右腕: { z: -22, y: 56 },
        左ひじ: { x: -108, y: 8 },
        右ひじ: { x: -112, y: -8 },
        左手首: { z: -10, x: 10 },
        右手首: { z: 10, x: 10 },
        上半身: { x: -1 },
        首: { x: 3, y: 1 },
        頭: { x: 2, y: 1 }
      }
    },
    // 拨袖口 / 转手腕让手链滑一下
    {
      at: 1.75,
      pose: {
        左腕: { z: -8, x: -16 },
        右腕: { z: 24, x: -20 },
        左ひじ: { x: -52 },
        右ひじ: { x: -70 },
        左手首: { z: 32, x: 6 },
        右手首: { z: -26, x: 8 },
        首: { x: 1, y: 3 },
        頭: { x: 0, y: 4 }
      },
      gaze: { yawDeg: -4, pitchDeg: 8 }
    },
    // 看用户一眼
    {
      at: 2.35,
      pose: {
        左腕: { z: -22, x: -6 },
        右腕: { z: 22, x: -8 },
        首: { x: -2, y: -2 },
        頭: { x: -2, y: -4, z: 1 },
        上半身: { y: 1 }
      },
      emotion: 'smirk',
      gaze: { yawDeg: 0, pitchDeg: -2 }
    },
    { at: 2.8, pose: {} }
  ]
}

/** 待机变体 D：伸懒腰/转脖子/活动手腕（久坐时加权；幅度克制，不做少女式伸展）。 */
const STRETCH: GestureDef = {
  id: 'stretch',
  label: '伸懒腰活动手腕',
  duration: 3.6,
  fadeIn: 0.28,
  fadeOut: 0.3,
  mask: UPPER_BODY_MASK,
  keyframes: [
    { at: 0, pose: {} },
    // 双手交扣上举（幅度别太大）
    {
      at: 0.85,
      pose: {
        左腕: { z: 122, x: -18, y: 8 },
        右腕: { z: -122, x: -18, y: -8 },
        左ひじ: { x: -30, y: 8 },
        右ひじ: { x: -30, y: -8 },
        左手首: { z: -8 },
        右手首: { z: 8 },
        上半身: { x: -7 },
        上半身2: { x: -4 },
        首: { x: -6, y: 0 },
        頭: { x: -5, y: 0 },
        左肩: { z: 4 },
        右肩: { z: -4 }
      },
      gaze: { yawDeg: 0, pitchDeg: -12 }
    },
    // 侧颈
    {
      at: 1.6,
      pose: {
        左腕: { z: 124, x: -16, y: 8 },
        右腕: { z: -124, x: -16, y: -8 },
        左ひじ: { x: -28 },
        右ひじ: { x: -28 },
        上半身: { x: -6, z: 3 },
        上半身2: { x: -3, z: 2 },
        首: { x: -4, z: 6 },
        頭: { x: -3, z: 8 },
        左肩: { z: 4 },
        右肩: { z: -4 }
      },
      gaze: { yawDeg: 4, pitchDeg: -8 }
    },
    // 收臂：先向前下方收（不要从头顶直接回落到「侧平举」，slerp 会扫过 T-pose）
    {
      at: 2.05,
      pose: {
        左腕: { z: 40, x: -62 },
        右腕: { z: -40, x: -62 },
        左ひじ: { x: -52 },
        右ひじ: { x: -52 },
        左手首: { x: 8 },
        右手首: { x: 8 },
        上半身: { x: 3 },
        首: { x: 0 },
        頭: { x: 0 }
      }
    },
    // 转手腕 + 呼一口气（肩落回）
    {
      at: 2.5,
      pose: {
        左腕: { z: -10, x: -18 },
        右腕: { z: 12, x: -18 },
        左ひじ: { x: -40 },
        右ひじ: { x: -40 },
        左手首: { z: 24 },
        右手首: { z: -24 },
        上半身: { x: 2 },
        首: { x: 1 },
        頭: { x: 0 }
      },
      emotion: 'soft'
    },
    { at: 3.0, pose: {} },
    { at: 3.6, pose: {} }
  ]
}

/** 待机变体 E：望远处发呆（负责「孤独底色」；低频率、慢呼吸、不笑）。 */
const GAZE_AWAY: GestureDef = {
  id: 'gazeAway',
  label: '望远处发呆',
  duration: 5.2,
  fadeIn: 0.4,
  fadeOut: 0.5,
  mask: UPPER_BODY_MASK,
  keyframes: [
    { at: 0, pose: {} },
    // 手插兜 + 头转 15–20° 看远处
    {
      at: 1.0,
      pose: {
        左腕: { z: -30, y: 14, x: 0 },
        左ひじ: { x: -24, y: 2 },
        左手首: { x: -6 },
        右腕: { z: 26, x: 0 },
        右ひじ: { x: -4 },
        上半身: { x: 0, y: 2, z: -2 },
        首: { x: 0, y: 7 },
        頭: { x: -2, y: 11, z: 1 }
      },
      gaze: { yawDeg: -20, pitchDeg: -2 }
    },
    // 呼吸变慢（保持）
    {
      at: 2.4,
      pose: {
        左腕: { z: -30, y: 14, x: 0 },
        左ひじ: { x: -24, y: 2 },
        左手首: { x: -6 },
        右腕: { z: 26, x: 0 },
        右ひじ: { x: -4 },
        上半身: { x: 1, y: 2, z: -2 },
        首: { x: 1, y: 7 },
        頭: { x: -1, y: 10, z: 1 }
      },
      gaze: { yawDeg: -21, pitchDeg: -3 }
    },
    // 回神：视线收回、头慢慢回正
    {
      at: 4.0,
      pose: {
        左腕: { z: -24, x: 6 },
        左ひじ: { x: -14 },
        右腕: { z: 25, x: -1 },
        右ひじ: { x: -6 },
        上半身: { x: 0, y: 1 },
        首: { x: 0, y: 3 },
        頭: { x: -1, y: 5 }
      },
      gaze: { yawDeg: 0, pitchDeg: 0 }
    },
    { at: 4.6, pose: {} },
    { at: 5.2, pose: {} }
  ]
}

/** 待机变体 F：两指敬礼（只在低权重/鼠标靠近时；克制，不做飞吻）。 */
const TWO_FINGER_SALUTE: GestureDef = {
  id: 'salute',
  label: '两指敬礼',
  duration: 2.2,
  fadeIn: 0.14,
  fadeOut: 0.2,
  mask: UPPER_BODY_MASK,
  keyframes: [
    { at: 0, pose: {} },
    // 右手抬到眉边
    {
      at: 0.5,
      pose: {
        右腕: { z: -34, y: 52 },
        右ひじ: { x: -112, y: -10 },
        右手首: { x: -8, z: 8 },
        首: { x: 3, y: -2 },
        頭: { x: 2, y: -3 },
        上半身: { y: 1 }
      },
      gaze: { yawDeg: 0, pitchDeg: 2 }
    },
    // 两指甩出
    {
      at: 0.95,
      pose: {
        右腕: { z: -26, y: 42 },
        右ひじ: { x: -94, y: -8 },
        右手首: { z: 22, x: 6 },
        首: { x: 0, y: -3 },
        頭: { x: -2, y: -5, z: 1 }
      },
      emotion: 'smirk',
      gaze: { yawDeg: -2, pitchDeg: 0 }
    },
    // 收手
    { at: 1.55, pose: {} },
    { at: 2.2, pose: {} }
  ]
}

/** 待机变体定义（权重合计 100，冷却/不连续重复由 `idle-director` 管理）。 */
export interface IdleVariantDef {
  gesture: GestureDef
  /** 权重（brief §4.2 的建议值：25/18/22/15/12/8）。 */
  weight: number
  /** 冷却（秒）。 */
  cooldownSec: number
}

export const IDLE_VARIANTS: readonly IdleVariantDef[] = [
  { gesture: COIN_ROLL, weight: 25, cooldownSec: 40 },
  { gesture: COIN_TOSS, weight: 18, cooldownSec: 36 },
  { gesture: ADJUST_CUFF, weight: 22, cooldownSec: 24 },
  { gesture: STRETCH, weight: 15, cooldownSec: 45 },
  { gesture: GAZE_AWAY, weight: 12, cooldownSec: 60 },
  { gesture: TWO_FINGER_SALUTE, weight: 8, cooldownSec: 50 }
]

/* ========================================================================== */
/* 反应                                                                        */
/* ========================================================================== */

/** 摸头两段式：① 僵住/嫌弃 ② 偷偷接受（头往手心回顶）③ 意识到后直回去。 */
const PAT_REACTION: GestureDef = {
  id: 'patReact',
  label: '被摸头（僵→软→翻脸）',
  duration: 1.9,
  fadeIn: 0.1,
  fadeOut: 0.22,
  mask: HEAD_MASK,
  reaction: true,
  keyframes: [
    { at: 0, pose: {} },
    // ① 僵住：头往反方向偏、肩抬
    {
      at: 0.18,
      pose: {
        首: { x: 3, y: -7, z: 3 },
        頭: { x: 2, y: -9, z: 4 },
        左肩: { z: 4 },
        右肩: { z: -3 },
        上半身: { x: 2, z: 1.5 }
      },
      emotion: 'surprise'
    },
    // ② 偷偷接受：头往手心回顶 5°、眼睛闭起来
    {
      at: 0.5,
      pose: {
        首: { x: -2, y: -2, z: -1 },
        頭: { x: -5, y: -3, z: -3 },
        左肩: { z: 1 },
        右肩: { z: -1 },
        上半身: { x: -1 }
      },
      emotion: 'shy',
      gaze: { yawDeg: -3, pitchDeg: 6 }
    },
    {
      at: 1.1,
      pose: {
        首: { x: -2, y: -1 },
        頭: { x: -4, y: -2, z: -2 },
        上半身: { x: -1 }
      }
    },
    // ③ 意识到，直回去、挑眉
    {
      at: 1.5,
      pose: {
        首: { x: 0, y: 5 },
        頭: { x: -1, y: 7, z: -1 },
        左肩: { z: 1 },
        右肩: { z: -1 }
      },
      emotion: 'smirk'
    },
    { at: 1.9, pose: {} }
  ]
}

/** 戳头/脸：头后仰 + 皱眉（幅度小，不要全身一起弹）。 */
const POKED_HEAD: GestureDef = {
  id: 'pokedHead',
  label: '被戳头',
  duration: 0.9,
  fadeIn: 0.06,
  fadeOut: 0.18,
  mask: HEAD_MASK,
  reaction: true,
  keyframes: [
    { at: 0, pose: {} },
    {
      at: 0.1,
      pose: {
        首: { x: -4, y: 3 },
        頭: { x: -8, y: 5, z: 2 },
        上半身: { x: -4 },
        左肩: { z: 2 },
        右肩: { z: -2 }
      },
      emotion: 'surprise'
    },
    {
      at: 0.34,
      pose: {
        首: { x: 0, y: 1 },
        頭: { x: -2, y: 3 },
        上半身: { x: -1 }
      },
      emotion: 'annoyed'
    },
    { at: 0.9, pose: {} }
  ]
}

/** 戳身体/腰：缩身、耸肩、退半步（用 crouchPulse 让 IK 屈膝，避免全身弹）。 */
const POKED_BODY: GestureDef = {
  id: 'pokedBody',
  label: '被戳身体',
  duration: 0.85,
  fadeIn: 0.06,
  fadeOut: 0.18,
  mask: TORSO_ARM_MASK,
  reaction: true,
  crouchPulse: 0.28,
  keyframes: [
    { at: 0, pose: {} },
    {
      at: 0.12,
      pose: {
        上半身: { x: 6, z: 2 },
        上半身2: { x: 3 },
        首: { x: 2, y: 2 },
        頭: { x: 1, y: 3 },
        左肩: { z: 5 },
        右肩: { z: -5 },
        左腕: { z: -18, x: -6 },
        右腕: { z: 22, x: -8 },
        左ひじ: { x: -22 },
        右ひじ: { x: -26 }
      },
      emotion: 'surprise'
    },
    {
      at: 0.4,
      pose: {
        上半身: { x: 2 },
        首: { x: 1 },
        左肩: { z: 2 },
        右肩: { z: -2 }
      },
      emotion: 'annoyed'
    },
    { at: 0.85, pose: {} }
  ]
}

/** 戳腿：低头看一眼 + 轻微屈膝（腿由 IK 覆盖，用 crouchPulse 表达）。 */
const POKED_LEG: GestureDef = {
  id: 'pokedLeg',
  label: '被戳腿',
  duration: 0.8,
  fadeIn: 0.06,
  fadeOut: 0.18,
  mask: TORSO_ARM_MASK,
  reaction: true,
  crouchPulse: 0.22,
  keyframes: [
    { at: 0, pose: {} },
    {
      at: 0.12,
      pose: {
        首: { x: 8, y: -5 },
        頭: { x: 5, y: -7 },
        上半身: { x: 4 },
        左肩: { z: 3 },
        右肩: { z: -3 }
      },
      emotion: 'surprise'
    },
    {
      at: 0.36,
      pose: {
        首: { x: 3, y: -2 },
        頭: { x: 2, y: -3 },
        上半身: { x: 1 }
      },
      emotion: 'annoyed'
    },
    { at: 0.8, pose: {} }
  ]
}

/** 被甩出瞬间：四肢张开、背微弓、头后仰（空中姿态由 base `fall` 接管）。 */
const THROWN: GestureDef = {
  id: 'thrown',
  label: '被甩出',
  duration: 0.6,
  fadeIn: 0.05,
  fadeOut: 0.15,
  reaction: true,
  keyframes: [
    { at: 0, pose: {} },
    {
      at: 0.12,
      pose: {
        上半身: { x: -10 },
        上半身2: { x: -5 },
        首: { x: -12 },
        頭: { x: -9 },
        左肩: { z: 4 },
        右肩: { z: -4 },
        左腕: { z: 34, x: -14, y: 6 },
        右腕: { z: -34, x: -14, y: -6 },
        左ひじ: { x: -24, y: 5 },
        右ひじ: { x: -24, y: -5 },
        下半身: { x: 5 },
        左足D: { x: -20, z: 10 },
        右足D: { x: -20, z: -10 },
        左ひざD: { x: 30 },
        右ひざD: { x: 30 },
        左足首D: { x: -24 },
        右足首D: { x: -24 }
      },
      emotion: 'surprise'
    },
    { at: 0.6, pose: {} }
  ]
}

/** 落地：屈膝缓冲 + 双臂外展保持平衡，随后「理所当然的胜利」式 smirk。 */
const LANDED: GestureDef = {
  id: 'landed',
  label: '落地缓冲',
  duration: 0.45,
  fadeIn: 0.04,
  fadeOut: 0.18,
  reaction: true,
  crouchPulse: 0.55,
  keyframes: [
    { at: 0, pose: {} },
    {
      at: 0.07,
      pose: {
        上半身: { x: 13 },
        上半身2: { x: 6 },
        首: { x: -5, y: 0 },
        頭: { x: -4, y: 2 },
        左肩: { z: 3 },
        右肩: { z: -3 },
        左腕: { z: -6, x: -20, y: 4 },
        右腕: { z: 8, x: -20, y: -4 },
        左ひじ: { x: -26 },
        右ひじ: { x: -26 }
      },
      emotion: 'surprise'
    },
    {
      at: 0.24,
      pose: {
        上半身: { x: 4 },
        首: { x: 0 },
        左腕: { z: -14, x: -8 },
        右腕: { z: 16, x: -8 },
        左ひじ: { x: -14 },
        右ひじ: { x: -14 }
      },
      emotion: 'smirk'
    },
    { at: 0.45, pose: {} }
  ]
}

/** DSH 任务完成：抬双手「收筹码」再摊手（不蹦跳）。 */
const CHEER: GestureDef = {
  id: 'cheer',
  label: '收筹码/摊手',
  duration: 1.6,
  fadeIn: 0.12,
  fadeOut: 0.2,
  mask: UPPER_BODY_MASK,
  keyframes: [
    { at: 0, pose: {} },
    {
      at: 0.35,
      pose: {
        左腕: { z: 20, y: -52 },
        右腕: { z: -16, y: 54 },
        左ひじ: { x: -86, y: 8 },
        右ひじ: { x: -90, y: -8 },
        左手首: { x: 16 },
        右手首: { x: 16 },
        上半身: { x: 2 },
        首: { x: -2 },
        頭: { x: -2, y: 2 }
      },
      emotion: 'celebrate'
    },
    {
      at: 0.8,
      pose: {
        左腕: { z: 30, y: -22, x: 0 },
        右腕: { z: -28, y: 24, x: 0 },
        左ひじ: { x: -18 },
        右ひじ: { x: -18 },
        上半身: { x: -3 },
        首: { x: -4 },
        頭: { x: -3, y: 3 }
      },
      emotion: 'celebrate'
    },
    { at: 1.25, pose: {} },
    { at: 1.6, pose: {} }
  ]
}

/** 反应用手势 id 常量。 */
export const REACTION_IDS = {
  pat: 'patReact',
  pokedHead: 'pokedHead',
  pokedBody: 'pokedBody',
  pokedLeg: 'pokedLeg',
  thrown: 'thrown',
  landed: 'landed'
} as const

/** 反应表（id → 手势定义）。 */
export const REACTIONS: Readonly<Record<string, GestureDef>> = {
  [REACTION_IDS.pat]: PAT_REACTION,
  [REACTION_IDS.pokedHead]: POKED_HEAD,
  [REACTION_IDS.pokedBody]: POKED_BODY,
  [REACTION_IDS.pokedLeg]: POKED_LEG,
  [REACTION_IDS.thrown]: THROWN,
  [REACTION_IDS.landed]: LANDED
}

/** DSH 完成等一次性庆祝手势。 */
export const CHEER_GESTURE = CHEER

/** 全部手势（待机变体 + 反应 + 庆祝；自检用）。 */
export const ALL_GESTURES: readonly GestureDef[] = [
  ...IDLE_VARIANTS.map((variant) => variant.gesture),
  ...Object.values(REACTIONS),
  CHEER
]

/** 按 id 查手势（反应 + 待机 + 庆祝；未知返回 null）。 */
export function findGesture(id: string): GestureDef | null {
  for (const gesture of ALL_GESTURES) {
    if (gesture.id === id) return gesture
  }
  return null
}

/** 手势某时刻需要应用的表情（关键帧里最后一个 at ≤ t 的 emotion；没有则 null）。 */
export function gestureEmotionAt(gesture: GestureDef, t: number): string | null {
  let result: string | null = null
  for (const frame of gesture.keyframes) {
    if (frame.at > t) break
    if (frame.emotion) result = frame.emotion
  }
  if (result) return result
  if (gesture.emotion && t >= (gesture.emotionDelay ?? 0.15)) return gesture.emotion
  return null
}

/** 手势某时刻的强制注视（最后一个 at ≤ t 的 gaze；没有则 null）。 */
export function gestureGazeAt(
  gesture: GestureDef,
  t: number
): { yawDeg: number; pitchDeg: number } | null {
  let result: { yawDeg: number; pitchDeg: number } | null = null
  for (const frame of gesture.keyframes) {
    if (frame.at > t) break
    if (frame.gaze) result = frame.gaze
  }
  return result
}

/** 备用：空姿态（测试/降级）。 */
export const EMPTY_POSE: PoseDef = {}
