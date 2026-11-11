/**
 * 材质 morph 控制器（r171 `MMDLoader` 不实现 PMX 材质 morph 的补丁层）。
 *
 * 背景（PLAN §18.2 / docs/model-morphs.md）：
 * - `MMDLoader` 对 `morph.type === 8`（材质 morph）只生成一个零位移 morphTarget，
 *   不会改材质；本模型有 3 个材质 morph：`照れ`（颜赤 +alpha）、`目影消`（目影 ×(1-w)）、
 *   `目影濃`（目影 +alpha）。
 * - 因此每帧读 `mesh.morphTargetInfluences`，按加载时记录的**基线 alpha**重算，
 *   而不是在上一帧结果上累加（避免 w 变化/归零后残留误差）。
 *
 * 材质按名称（trim 后）解析的绑定由纯模块 `model/morph-map.ts` 提供。
 *
 * 已知限制（F16）：只处理材质 morph 的 **diffuse alpha** 通道。当前模型的 3 个材质
 * morph（`照れ`/`目影消`/`目影濃`）元素只含 `diffuse[3]`，所以这是完备的；但 PMX 材质
 * morph 还能改 diffuse RGB / specular / ambient / edge 等通道，换模型/加表情时需要扩展
 * （否则规则命中却不生效）。详见 `docs/model-morphs.md`。
 */
import type { Material, SkinnedMesh } from 'three'

import type { MaterialMorphBinding, MaterialMorphMode } from '../model/morph-map'

/** 同一材质 + 同一作用目标的一组规则（按规则表顺序叠加）。 */
interface MaterialMorphGroup {
  material: Material
  /** 加载时的原始 alpha（`颜赤` 默认 0、`目影` 默认 0.3）。 */
  baselineOpacity: number
  rules: MaterialMorphBinding[]
}

/** morph 权重钳制到 [0, 1]（MMD 表达式权重正常为 0–1）。 */
function clampWeight(weight: number | undefined): number {
  if (typeof weight !== 'number' || !Number.isFinite(weight)) return 0
  if (weight < 0) return 0
  if (weight > 1) return 1
  return weight
}

/** alpha 钳制到 [0, 1]。 */
function clampAlpha(alpha: number): number {
  if (!Number.isFinite(alpha)) return 0
  if (alpha < 0) return 0
  if (alpha > 1) return 1
  return alpha
}

/** 按 mode 把一条权重作用到当前 alpha 上。 */
function applyRule(mode: MaterialMorphMode, alpha: number, weight: number): number {
  return mode === 'multiply-hide' ? alpha * (1 - weight) : alpha + weight
}

export class MaterialMorphController {
  private readonly mesh: SkinnedMesh
  private readonly groups: MaterialMorphGroup[]
  /** 已绑定的材质名（调试/日志用）。 */
  readonly boundMaterialNames: string[]

  constructor(mesh: SkinnedMesh, bindings: readonly MaterialMorphBinding[]) {
    this.mesh = mesh
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]

    // 按 (材质索引, 目标) 分组：同目标的多条规则按规则表顺序叠加（先乘算再加算）。
    const groupByKey = new Map<string, MaterialMorphGroup>()
    for (const binding of bindings) {
      const material = materials[binding.materialIndex]
      if (!material) continue
      const key = `${binding.materialIndex}:${binding.target}`
      const existing = groupByKey.get(key)
      if (existing) {
        existing.rules.push(binding)
      } else {
        groupByKey.set(key, {
          material,
          baselineOpacity: material.opacity,
          rules: [binding]
        })
      }
    }

    this.groups = [...groupByKey.values()]
    this.boundMaterialNames = [...new Set(this.groups.map((group) => group.material.name ?? ''))]

    // 材质 morph 会改透明件的 alpha：强制走透明通道（loader 通常已置 true，这里防御性兜底）。
    for (const group of this.groups) {
      if (!group.material.transparent) {
        group.material.transparent = true
        group.material.needsUpdate = true
      }
    }
  }

  /** 每帧调用：读取 morph 权重并重算目标材质 alpha。 */
  update(): void {
    if (this.groups.length === 0) return
    const influences = this.mesh.morphTargetInfluences
    if (!influences) return

    for (const group of this.groups) {
      let alpha = group.baselineOpacity
      for (const rule of group.rules) {
        alpha = applyRule(rule.mode, alpha, clampWeight(influences[rule.morphIndex]))
      }
      const nextAlpha = clampAlpha(alpha)
      if (Math.abs(group.material.opacity - nextAlpha) > 1e-4) {
        group.material.opacity = nextAlpha
      }
    }
  }
}
