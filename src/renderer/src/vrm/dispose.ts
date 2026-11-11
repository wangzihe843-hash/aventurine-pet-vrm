/**
 * three.js 子树 GPU 资源释放工具（R-01/R-04）—— **纯函数、node 环境可单测**，不依赖 DOM/WebGLRenderer。
 *
 * 用途：
 * - `VrmPetScene.dispose()` 的兜底遍历（`VRMUtils.deepDispose` 之后的补充）；
 * - `prop-layer.dispose()` 释放道具 GLB 子树自己的 geometry/material/texture
 *   （道具必须先 detach，否则 `VRMUtils.deepDispose` 会把道具资源一并释放）。
 *
 * 语义（对齐 three.js cleanup 手册）：
 * - 对子树里每个节点释放 `geometry` 与 `material`（可为数组），
 *   并从 `material` 的字段里收集 `isTexture` 的贴图一起释放；
 * - 用**同一个 `Set`** 去重：共享 geometry/material/texture 只 `dispose()` 一次；
 * - 单个资源 `dispose()` 抛错只 warn、不中断其余释放（卸载路径不得反向把主流程炸掉）。
 *
 * 注意：three.js 的 `dispose()` 是「事件通知」，重复调用本身是安全的（渲染器第二次收到事件时
 * 已无对应 GPU 资源）；去重是为了避免共享资源被重复通知、也便于单测断言。
 */
import type { BufferGeometry, Material, Object3D, Texture } from 'three'

type DisposableLike = { dispose: () => void }

function isDisposable(value: unknown): value is DisposableLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { dispose?: unknown }).dispose === 'function'
  )
}

function isGeometry(value: unknown): value is BufferGeometry {
  return isDisposable(value) && (value as { isBufferGeometry?: boolean }).isBufferGeometry === true
}

function isMaterial(value: unknown): value is Material {
  return isDisposable(value) && (value as { isMaterial?: boolean }).isMaterial === true
}

function isTexture(value: unknown): value is Texture {
  return isDisposable(value) && (value as { isTexture?: boolean }).isTexture === true
}

/** 单个资源释放：失败只 warn（卸载路径不抛）。 */
function safeDispose(resource: DisposableLike, label: string): void {
  try {
    resource.dispose()
  } catch (error) {
    console.warn(`[vrm-dispose] ${label} 释放失败（已忽略）：`, error)
  }
}

/**
 * 释放一个材质（或材质数组）及其贴图。
 *
 * @param material 材质/材质数组（null/undefined = no-op）
 * @param disposed 共享去重集合（多个材质/多棵树复用时传入同一个 Set）
 */
export function disposeMaterialResources(
  material: Material | Material[] | null | undefined,
  disposed: Set<object> = new Set<object>()
): void {
  if (material === null || material === undefined) return
  const materials: readonly unknown[] = Array.isArray(material) ? material : [material]
  for (const item of materials) {
    if (!isMaterial(item) || disposed.has(item)) continue
    disposed.add(item)
    // 贴图字段：MToon/标准材质的贴图都是材质上的直接字段（map/normalMap/…），
    // `Object.values` 即可覆盖；未知字段里 `isTexture` 的也一并释放。
    // 先释放贴图再释放材质（材质 dispose 不会替我们释放贴图 GPU 资源）。
    for (const value of Object.values(item)) {
      if (!isTexture(value) || disposed.has(value)) continue
      disposed.add(value)
      safeDispose(value, 'texture')
    }
    // ShaderMaterial/MToonMaterial 的贴图不在自身可枚举字段上，而在 `uniforms.<name>.value`；
    // 补一层（与 VRMUtils.deepDispose 的收集口径一致），避免兜底路径漏贴图。
    const uniforms = (item as { uniforms?: unknown }).uniforms
    if (typeof uniforms === 'object' && uniforms !== null) {
      for (const uniform of Object.values(uniforms)) {
        const value = (uniform as { value?: unknown }).value
        if (!isTexture(value) || disposed.has(value)) continue
        disposed.add(value)
        safeDispose(value, 'texture')
      }
    }
    safeDispose(item, 'material')
  }
}

/**
 * 释放整棵 three.js 子树的 geometry/material/texture。
 *
 * @param root 子树根（null/undefined = no-op；不会遍历/修改父节点）
 * @param disposed 共享去重集合（多棵树/与外部资源表复用时传入同一个 Set）
 */
export function disposeObjectTreeResources(
  root: Object3D | null | undefined,
  disposed: Set<object> = new Set<object>()
): void {
  if (root === null || root === undefined) return
  root.traverse((object) => {
    const node = object as Object3D & { geometry?: unknown; material?: unknown }
    const geometry = node.geometry
    if (isGeometry(geometry) && !disposed.has(geometry)) {
      disposed.add(geometry)
      safeDispose(geometry, 'geometry')
    }
    disposeMaterialResources(node.material as Material | Material[] | null | undefined, disposed)
  })
}
