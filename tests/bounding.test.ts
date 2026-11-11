/**
 * 单测：绑定姿势包围盒（`src/renderer/src/model/bounding.ts`，M-1 回归）。
 *
 * 关键口径：three r171 `BufferGeometry.computeBoundingBox()` 会把 `morphAttributes.position`
 * 并入包围盒（MMDLoader 为全部 85 个 morph 都建了 position target），
 * 而缩放/摆放基准必须是**绑定姿势**（只读基础 position attribute）。
 * 本单测用 three 构造「基础姿势 + 抬高额头的 morph target」的最小几何体：
 * - helper 结果应等于基础姿势 bbox，且与 `Box3().setFromBufferAttribute(position)` 一致；
 * - `computeBoundingBox()` 结果（union）严格更大 —— 正是修复前的错误基准。
 */
import { Box3, BufferAttribute, BufferGeometry } from 'three'
import { describe, expect, it } from 'vitest'

import {
  computeBindPoseBoundingBox,
  type PositionAttributeLike
} from '../src/renderer/src/model/bounding'

/** 基础姿势顶点：(0,0,0) (2,0,0) (1,4,0) → bbox 2×4。 */
const BASE_POSITIONS = [0, 0, 0, 2, 0, 0, 1, 4, 0]

/** morph target（非相对坐标）：把头顶顶点从 y=4 抬到 y=7 → union 高度 7。 */
const MORPH_POSITIONS = [0, 0, 0, 2, 0, 0, 1, 7, 0]

function createGeometryWithMorph(): BufferGeometry {
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(BASE_POSITIONS), 3))
  geometry.morphAttributes.position = [
    new BufferAttribute(new Float32Array(MORPH_POSITIONS), 3)
  ]
  // MMDLoader 的行为：morphTargetsRelative = false（morph attribute 是绝对坐标）
  geometry.morphTargetsRelative = false
  geometry.computeBoundingBox()
  return geometry
}

describe('computeBindPoseBoundingBox：只算绑定姿势（不含 morph）', () => {
  it('返回基础 position attribute 的包围盒尺寸', () => {
    const geometry = createGeometryWithMorph()
    const bindPose = computeBindPoseBoundingBox(geometry.getAttribute('position'))
    expect(bindPose).not.toBeNull()
    expect(bindPose?.width).toBeCloseTo(2, 6)
    expect(bindPose?.height).toBeCloseTo(4, 6)
    expect(bindPose?.minX).toBeCloseTo(0, 6)
    expect(bindPose?.maxX).toBeCloseTo(2, 6)
    expect(bindPose?.minY).toBeCloseTo(0, 6)
    expect(bindPose?.maxY).toBeCloseTo(4, 6)
  })

  it('three r171 computeBoundingBox 会把 morph target 并入 → union 更大（修复前的错误基准）', () => {
    const geometry = createGeometryWithMorph()
    const union = geometry.boundingBox
    expect(union).not.toBeNull()
    const unionHeight = (union?.max.y ?? 0) - (union?.min.y ?? 0)
    expect(unionHeight).toBeCloseTo(7, 6)

    const bindPose = computeBindPoseBoundingBox(geometry.getAttribute('position'))
    expect(bindPose).not.toBeNull()
    expect(unionHeight).toBeGreaterThan(bindPose?.height ?? Number.POSITIVE_INFINITY)

    // 用 union 高做缩放会偏小（这里 4/7），真实模型是 21.681/21.885 ≈ 0.9907。
    const renderedHeightAt = (targetPx: number, boxHeight: number): number =>
      targetPx * (bindPose?.height ?? 1) / boxHeight
    expect(renderedHeightAt(540, unionHeight)).toBeCloseTo(540 * (4 / 7), 6)
  })

  it('与 Box3.setFromBufferAttribute（不含 morph 的 three 等价 API）结果一致', () => {
    const geometry = createGeometryWithMorph()
    const position = geometry.getAttribute('position') as BufferAttribute
    const expected = new Box3().setFromBufferAttribute(position)
    const bindPose = computeBindPoseBoundingBox(position)
    expect(bindPose).not.toBeNull()
    expect(bindPose?.minX).toBeCloseTo(expected.min.x, 6)
    expect(bindPose?.minY).toBeCloseTo(expected.min.y, 6)
    expect(bindPose?.minZ).toBeCloseTo(expected.min.z, 6)
    expect(bindPose?.maxX).toBeCloseTo(expected.max.x, 6)
    expect(bindPose?.maxY).toBeCloseTo(expected.max.y, 6)
    expect(bindPose?.maxZ).toBeCloseTo(expected.max.z, 6)
  })

  it('接受任意 { array, count, itemSize } 结构（itemSize 可 > 3，读取前 3 个分量）', () => {
    const padded: PositionAttributeLike = {
      array: [0, 0, 0, 99, 3, 5, -1, 99, 1, 2, 4, 99],
      count: 3,
      itemSize: 4
    }
    const bounds = computeBindPoseBoundingBox(padded)
    expect(bounds).not.toBeNull()
    expect(bounds?.width).toBeCloseTo(3, 6)
    expect(bounds?.height).toBeCloseTo(5, 6)
    expect(bounds?.depth).toBeCloseTo(5, 6)
  })

  it('跳过 NaN/Infinity 顶点；全部无效时返回 null', () => {
    const bounds = computeBindPoseBoundingBox({
      array: [0, 0, 0, Number.NaN, 1, 1, 2, 3, 0],
      count: 3,
      itemSize: 3
    })
    expect(bounds).not.toBeNull()
    expect(bounds?.width).toBeCloseTo(2, 6)
    expect(bounds?.height).toBeCloseTo(3, 6)

    const allInvalid = computeBindPoseBoundingBox({
      array: [Number.NaN, Number.NaN, Number.NaN],
      count: 1,
      itemSize: 3
    })
    expect(allInvalid).toBeNull()
  })

  it('非法输入安全返回 null（null / 空 count / itemSize<3 / array 长度不足）', () => {
    expect(computeBindPoseBoundingBox(null)).toBeNull()
    expect(computeBindPoseBoundingBox(undefined)).toBeNull()
    expect(computeBindPoseBoundingBox({ array: [], count: 0, itemSize: 3 })).toBeNull()
    expect(computeBindPoseBoundingBox({ array: [0, 0], count: 1, itemSize: 2 })).toBeNull()
    expect(computeBindPoseBoundingBox({ array: [0, 0, 0], count: 2, itemSize: 3 })).toBeNull()
  })
})
