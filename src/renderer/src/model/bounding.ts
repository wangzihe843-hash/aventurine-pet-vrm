/**
 * 绑定姿势包围盒（M-1 修复；纯函数，**不 import three**，可在 vitest node 环境单测）。
 *
 * 背景：three r171 的 `BufferGeometry.computeBoundingBox()` 会把 `morphAttributes.position`
 * 的全部 morph target 一起并入包围盒（`BufferGeometry.js` 的 morph 循环）。MMDLoader 为
 * 全部 85 个 morph（含 3 个零位移的材质 morph）都建了 position morph target，因此
 * `computeBoundingBox()` 得到的是「所有表情并集」而不是绑定姿势：
 * 真实模型 union 高 21.885147 vs 绑定姿势高 21.681044 → 用并集高做缩放基准会让实际渲染
 * 高度系统性偏小约 0.93%（540 → 约 535px）。
 *
 * 因此布局/缩放基准必须只读基础 `position` attribute（本模块），
 * 需要「表情不出框」参考时再另算 union，两者不能混用（docs/model-morphs.md）。
 *
 * 传参结构故意只要求 `{ array, count, itemSize }`：three 的 `BufferAttribute` 天然满足，
 * 单测无需 WebGL/DOM；传入非法/空数据时返回 null，由调用方决定兜底策略。
 */

/** position attribute 的最小结构（`THREE.BufferAttribute` 可直接传入）。 */
export interface PositionAttributeLike {
  readonly array: ArrayLike<number>
  readonly count: number
  readonly itemSize: number
}

/** 轴对齐包围盒（three 世界单位；本地模型坐标）。 */
export interface BindPoseBoundingBox {
  readonly minX: number
  readonly minY: number
  readonly minZ: number
  readonly maxX: number
  readonly maxY: number
  readonly maxZ: number
  /** 各轴尺寸（max − min）。 */
  readonly width: number
  readonly height: number
  readonly depth: number
}

/**
 * 由基础 `position` attribute 计算**绑定姿势**包围盒（忽略 morphAttributes）。
 *
 * - 只读取 `count` 个顶点的前 3 个分量（`itemSize` 可以是 3+，如带 padding 的 attribute）；
 * - 跳过含 NaN/Infinity 的顶点；全部无效/空 attribute 时返回 `null`；
 * - 不修改输入、不依赖 three，结果确定。
 */
export function computeBindPoseBoundingBox(
  position: PositionAttributeLike | null | undefined
): BindPoseBoundingBox | null {
  if (!position) return null
  const { array, count, itemSize } = position
  if (!Number.isFinite(count) || count <= 0) return null
  if (!Number.isFinite(itemSize) || itemSize < 3) return null
  if (!array || typeof array.length !== 'number' || array.length < count * itemSize) return null

  let minX = Infinity
  let minY = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let maxZ = -Infinity
  let validCount = 0

  for (let index = 0; index < count; index += 1) {
    const offset = index * itemSize
    const x = array[offset]
    const y = array[offset + 1]
    const z = array[offset + 2]
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue
    validCount += 1
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (z < minZ) minZ = z
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
    if (z > maxZ) maxZ = z
  }

  if (validCount === 0) return null

  return {
    minX,
    minY,
    minZ,
    maxX,
    maxY,
    maxZ,
    width: maxX - minX,
    height: maxY - minY,
    depth: maxZ - minZ
  }
}
