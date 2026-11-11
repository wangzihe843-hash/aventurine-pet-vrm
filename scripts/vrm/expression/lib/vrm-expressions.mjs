/**
 * 读取目标 VRM 的 expression 清单（preset + custom），供表情 clip 校验/预览使用。
 *
 * 纯只读；复用 `scripts/vrm/motion/lib/vrm-rest.mjs` 的 GLB JSON 解析（不重复实现）。
 */
import { parseGlbJson } from '../../motion/lib/vrm-rest.mjs'

/** VRM 1.0 preset 全集（与 `src/shared/vrm.ts` 一致；用于区分 preset/custom）。 */
export const VRM1_EXPRESSION_PRESETS = [
  'happy',
  'angry',
  'sad',
  'relaxed',
  'surprised',
  'aa',
  'ih',
  'ou',
  'ee',
  'oh',
  'blink',
  'blinkLeft',
  'blinkRight',
  'lookUp',
  'lookDown',
  'lookLeft',
  'lookRight',
  'neutral'
]

/**
 * 解析 VRM 文件里的 expression 清单。
 *
 * @param {string} vrmPath VRM/GLB 路径
 * @returns {{
 *   specVersion: string,
 *   presets: string[],
 *   customs: string[],
 *   all: string[],
 *   hasExpressionManager: boolean,
 *   warnings: string[]
 * }}
 */
export function readVrmExpressionInventory(vrmPath) {
  const warnings = []
  const { json } = parseGlbJson(vrmPath)
  const vrm = json.extensions?.VRMC_vrm ?? null
  const specVersion =
    typeof json.extensions?.VRM === 'object' && json.extensions?.VRM !== null ? '0.x' : '1.0'
  if (!vrm) {
    return {
      specVersion,
      presets: [],
      customs: [],
      all: [],
      hasExpressionManager: false,
      warnings: ['VRM 文件没有 VRMC_vrm 扩展（可能是 VRM 0.x 或普通 glTF）']
    }
  }
  const expressions = vrm.expressions ?? {}
  const presetMap = expressions.preset ?? {}
  const customMap = expressions.custom ?? {}
  const presets = Object.keys(presetMap)
  const customs = Object.keys(customMap)
  for (const name of presets) {
    if (!VRM1_EXPRESSION_PRESETS.includes(name)) {
      warnings.push(`VRMC_vrm.expressions.preset 出现非标准 preset 名：${name}`)
    }
  }
  const all = [...presets, ...customs]
  return {
    specVersion,
    presets,
    customs,
    all,
    hasExpressionManager: all.length > 0,
    warnings
  }
}
