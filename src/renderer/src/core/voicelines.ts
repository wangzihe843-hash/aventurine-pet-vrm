/**
 * 语音台词单一来源（**数据不在仓库里**；用户硬性要求：禁止自创/改写/扩写）
 *
 * 数据位置：`assets/voicelines.json`（本地私有资产，已在 `.gitignore` 中排除，不入公开库）。
 * 形状：`{ "schemaVersion": 1, "lines": [{ "char", "category", "text" }] }`；
 * 每条 `text` = 游戏内官方中文语音原文（含「…」「。」等原文标点），**不得改词**。
 * 干净 clone 没有该文件时本模块返回空表：宠物不说话，但不会崩、不会阻塞启动。
 *
 * 本文件只保留**读取 + 场景派生**逻辑：
 * - `char` 区分基础版「砂金」与 4.5 SP「砂金·戏浪」，两个版本的台词都可随机使用；
 * - 场景池由 `category` 白名单派生（见下方 `*_BUBBLES`），业务侧（B1 行为气泡、B7 DSH 反应）
 *   只允许从这里取词。
 *
 * 场景 → 官方语音分类映射（用户 2026-11-08 指示）：
 * - 任务成功 / 完成庆祝：开启战利品（含贵重）、终结技（激活/施放）、角色晋阶、角色满级、行迹激活；
 * - 失败 / 出错：无法战斗；
 * - 闲置：关于自己•* / 闲谈•* / 爱好 / 烦恼 / 分享 / 见闻 / 关于*（角色相关）/ 回合待机；
 * - 其余交互按同一逻辑取最接近的官方分类：
 *   鼠标靠近=问候；被摸头=回合待机+返回城镇（休闲闲聊）；被戳=轻受击；被拖拽=重受击；
 *   DSH 开始忙碌=战技/秘技/战斗开始（准备行动）。
 *
 * 本文件是纯数据 + 纯函数（无 DOM/three/Electron 依赖），可被单测直接 import。
 */

/** 台词所属角色版本。 */
export type VoiceChar = '砂金' | '砂金·戏浪'

/** 一条官方语音（分类 + 原文）。 */
export interface OfficialVoiceLine {
  char: VoiceChar
  category: string
  text: string
}

/** 私有数据文件（相对仓库根；打包时被内联进 renderer bundle，不随 git 发布）。 */
export const VOICE_LINES_ASSET = 'assets/voicelines.json'

/** 语音角色白名单（脏数据过滤用）。 */
const VOICE_CHARS: readonly VoiceChar[] = ['砂金', '砂金·戏浪']

/**
 * 读取私有台词文件：`import.meta.glob` 在文件缺失时返回空对象，
 * 因此干净 clone 也能正常编译（不会因为缺资产直接构建失败）。
 * 用**相对路径**（相对本文件）而非 `/assets/...`：renderer 的 Vite root 是 `src/renderer`，
 * 根路径写法会解析到 `src/renderer/assets/`，打包后静默读不到。
 */
const RAW_MODULES = import.meta.glob('../../../../assets/voicelines.json', {
  eager: true,
  query: '?raw',
  import: 'default'
}) as Record<string, string>

/** 解析 + 过滤脏数据（非法条目直接丢弃，不抛错）。 */
function parseVoiceLines(raw: string | undefined): readonly OfficialVoiceLine[] {
  if (typeof raw !== 'string' || raw.length === 0) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  const entries =
    Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object' && Array.isArray((parsed as { lines?: unknown }).lines)
        ? (parsed as { lines: unknown[] }).lines
        : []
  const seen = new Set<string>()
  const lines: OfficialVoiceLine[] = []
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    const { char, category, text } = entry as Record<string, unknown>
    if (typeof char !== 'string' || !VOICE_CHARS.includes(char as VoiceChar)) continue
    if (typeof category !== 'string' || category.trim().length === 0) continue
    if (typeof text !== 'string' || text.trim().length === 0) continue
    const key = `${char}\t${category}\t${text}`
    if (seen.has(key)) continue
    seen.add(key)
    lines.push({ char: char as VoiceChar, category, text })
  }
  return lines
}

/** 全部私有台词原文（文件缺失时为空数组）。 */
export const OFFICIAL_VOICE_LINES: readonly OfficialVoiceLine[] = parseVoiceLines(
  Object.values(RAW_MODULES)[0]
)

/** 是否成功从私有文件读到台词（供启动日志 / 测试判断）。 */
export const VOICE_LINES_LOADED = OFFICIAL_VOICE_LINES.length > 0

/**
 * 台词全表规范化（稳定性校验用）。
 *
 * - 每条台词按 `char + '\t' + category + '\t' + text` 组织；
 * - 按数据顺序以 '\n' 连接（无结尾换行），UTF-8 编码。
 */
export function canonicalVoiceLineTable(
  lines: readonly OfficialVoiceLine[] = OFFICIAL_VOICE_LINES
): string {
  return lines.map((line) => `${line.char}\t${line.category}\t${line.text}`).join('\n')
}

/** 按分类正则 + 可选角色过滤取原文（保持数据顺序；按文本去重）。 */
function pickLines(predicate: (line: OfficialVoiceLine) => boolean): readonly string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const line of OFFICIAL_VOICE_LINES) {
    if (!predicate(line)) continue
    if (seen.has(line.text)) continue
    seen.add(line.text)
    result.push(line.text)
  }
  return result
}

/** 成功/完成类：开启战利品（含「开启贵重战利品」）、终结技（激活/施放）、角色晋阶、角色满级、行迹激活。 */
export const SUCCESS_BUBBLES: readonly string[] = pickLines(
  (line) =>
    /^开启.*战利品/.test(line.category) ||
    /^终结技/.test(line.category) ||
    line.category === '角色晋阶' ||
    line.category === '角色满级' ||
    line.category === '行迹激活'
)

/** 失败类：无法战斗（战败语音）。 */
export const DEFEAT_BUBBLES: readonly string[] = pickLines((line) => line.category === '无法战斗')

/** 闲置类：关于自己/闲谈/爱好/烦恼/分享/见闻/关于*（角色相关）/回合待机。 */
export const IDLE_BUBBLES: readonly string[] = pickLines(
  (line) =>
    /^关于/.test(line.category) ||
    /^闲谈/.test(line.category) ||
    line.category === '爱好' ||
    line.category === '烦恼' ||
    line.category === '分享' ||
    line.category === '见闻' ||
    line.category === '回合待机'
)

/** 鼠标靠近（问候）。 */
export const GREETING_BUBBLES: readonly string[] = pickLines((line) => line.category === '问候')

/** 被摸头（休闲闲聊类：回合待机 + 返回城镇）。 */
export const PAT_BUBBLES: readonly string[] = pickLines(
  (line) => line.category === '回合待机' || line.category === '返回城镇'
)

/** 被戳（轻受击）。 */
export const POKE_BUBBLES: readonly string[] = pickLines((line) => line.category === '轻受击')

/** 被拖拽（重受击）。 */
export const DRAG_BUBBLES: readonly string[] = pickLines((line) => line.category === '重受击')

/** DSH 任务开始/忙碌（准备行动：战技 + 秘技 + 战斗开始）。 */
export const BUSY_BUBBLES: readonly string[] = pickLines(
  (line) =>
    /^战技/.test(line.category) ||
    line.category === '秘技' ||
    /^战斗开始/.test(line.category)
)

/** 全部已核实官方原文集合（测试用：任何气泡文本必须 ∈ 本集合）。 */
export const OFFICIAL_LINE_TEXTS: ReadonlySet<string> = new Set(
  OFFICIAL_VOICE_LINES.map((line) => line.text)
)

/** 判断文本是否为已核实官方原文（trim 后比较；供测试防自创回归）。 */
export function isOfficialVoiceLine(text: string): boolean {
  return typeof text === 'string' && OFFICIAL_LINE_TEXTS.has(text.trim())
}

/** 数据统计（文档/测试用）。 */
export const VOICE_LINE_STATS = {
  total: OFFICIAL_VOICE_LINES.length,
  base: OFFICIAL_VOICE_LINES.filter((line) => line.char === '砂金').length,
  wave: OFFICIAL_VOICE_LINES.filter((line) => line.char === '砂金·戏浪').length,
  success: SUCCESS_BUBBLES.length,
  defeat: DEFEAT_BUBBLES.length,
  idle: IDLE_BUBBLES.length,
  busy: BUSY_BUBBLES.length
} as const
