/**
 * electron-builder `afterPack` 钩子：对本机自用的 macOS .app 做 **ad-hoc 签名**（Wave 3 / V9）。
 *
 * 为什么需要（2026-11-11 实机发现）：
 * - `electron-builder.yml` 用 `identity: null`（本机 0 个有效 Developer ID 证书）时产物**完全无签名**；
 *   macOS 27 的 AMFI 会拒绝 LaunchServices 启动「no CMS blob」的 app
 *   （统一日志：`AMFI: ... has no CMS blob? Unrecoverable CT signature issue, bailing out`
 *   → app 被拉起后立即退出，用户看到「点了没反应」）。
 * - 本机自用场景下 `codesign --sign -`（ad-hoc）足以让 app 通过 AMFI 启动；
 *   **不改变分发边界**：ad-hoc 签名不是 Developer ID，不能对外分发/不被 Gatekeeper 信任。
 *
 * 该钩子在 electron-builder 完成打包后、自带签名步骤之前执行；因为 `identity: null` 时
 * electron-builder 会跳过自己的签名，所以 ad-hoc 签名不会被覆盖。
 *
 * 将来启用 Developer ID 签名时：删除 electron-builder.yml 里的 `afterPack` 引用即可
 * （避免 ad-hoc 签名覆盖正式签名）。
 */
const { execFileSync } = require('node:child_process')
const { existsSync } = require('node:fs')
const { join } = require('node:path')

/**
 * @param {import('electron-builder').AfterPackContext} context electron-builder 上下文
 * @returns {Promise<void>}
 */
module.exports = async function afterPackAdhocSign(context) {
  if (process.platform !== 'darwin') return
  const productName = context.packager?.appInfo?.productFilename
  if (typeof productName !== 'string' || productName.length === 0) {
    console.warn('[after-pack] productFilename 缺失，跳过 ad-hoc 签名')
    return
  }
  const appPath = join(context.appOutDir, `${productName}.app`)
  if (!existsSync(appPath)) {
    console.warn(`[after-pack] .app 不存在，跳过 ad-hoc 签名：${appPath}`)
    return
  }
  try {
    execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appPath], {
      stdio: 'inherit'
    })
    console.log(`[after-pack] OK ad-hoc 签名：${appPath}`)
  } catch (error) {
    // 签名失败必须让构建可见地失败（否则产物「能构建但不能启动」，比失败更糟）。
    throw new Error(`[after-pack] ad-hoc 签名失败：${error instanceof Error ? error.message : String(error)}`)
  }
}
