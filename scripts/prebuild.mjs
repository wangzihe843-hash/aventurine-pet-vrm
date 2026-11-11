#!/usr/bin/env node
/**
 * 用途（Purpose）
 * ---------------------------------------------------------------------------
 * `pnpm build` 的前置步骤（C-02 / R-11）：保证「干净 clone → pnpm build」不会在
 * 缺少原生 helper / 私有资源时静默产出残缺应用。
 *
 *   1. 编译原生助手：`node scripts/build-native.mjs`（幂等；失败 → exit 1）。
 *      `pnpm dev` 由 package.json 的 `predev` 直接调用 build-native，不经过本脚本。
 *   2. 校验私有资产：除非 `AVENTURINE_SKIP_ASSETS_CHECK=1`，否则运行
 *      `node scripts/prepare-assets.mjs --check`（只读重算并比对 manifest）。
 *      assets/model、贴图、动作等属于私有资产（版权原因不入库），干净 clone 后
 *      必须先由资产持有者执行 `pnpm assets:prepare`；校验失败时打印清晰指引并 exit 1。
 *
 * 用法（Usage）
 * ---------------------------------------------------------------------------
 *   pnpm build                              # pnpm 自动先跑本脚本（prebuild 钩子）
 *   node scripts/prebuild.mjs               # 手动执行（与 pnpm build 前置等价）
 *   AVENTURINE_SKIP_ASSETS_CHECK=1 pnpm build
 *                                           # 跳过私有资产校验（仅限无资产环境的
 *                                           #  typecheck/构建排查；产物不可运行）
 *
 * 退出码：0 前置检查全部通过；1 原生构建失败或私有资产缺失/过期。
 */

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..')

/** 以仓库根为 cwd 运行 node 子脚本（继承 stdio，保持输出顺序）。 */
function runNodeScript(script, args = []) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: REPO_ROOT,
    stdio: 'inherit'
  })
}

function prebuildFail(message) {
  console.error(`PREBUILD_FAIL ${message}`)
  return 1
}

function main() {
  const native = runNodeScript('scripts/build-native.mjs')
  if (native.error) {
    return prebuildFail(`cannot run scripts/build-native.mjs: ${native.error.message}`)
  }
  if (native.status !== 0) {
    return prebuildFail(
      `native helper build failed (exit ${native.status})；` +
        '检查 Xcode Command Line Tools / scripts/build-native.mjs 输出后重试'
    )
  }

  if (process.env['AVENTURINE_SKIP_ASSETS_CHECK'] === '1') {
    console.log(
      'PREBUILD_SKIP_ASSETS_CHECK 已跳过私有资产校验（AVENTURINE_SKIP_ASSETS_CHECK=1）'
    )
    return 0
  }

  const assets = runNodeScript('scripts/prepare-assets.mjs', ['--check'])
  if (assets.error) {
    return prebuildFail(`cannot run scripts/prepare-assets.mjs: ${assets.error.message}`)
  }
  if (assets.status !== 0) {
    console.error('')
    console.error('私有资产缺失/过期：assets/model/ 与 src/shared/assets-manifest.json 不一致。')
    console.error('这些文件因版权原因不入库（见 .gitignore 的 `assets/model/`）。')
    console.error('请先执行：')
    console.error('  pnpm assets:prepare     # 从本机 assets/model 重新生成 optimized/ 与 manifest')
    console.error('若只是无资产环境下排查 typecheck/构建，可临时跳过校验（产物不可运行）：')
    console.error('  AVENTURINE_SKIP_ASSETS_CHECK=1 pnpm build')
    return prebuildFail(`private assets check failed (exit ${assets.status})`)
  }
  return 0
}

process.exitCode = main()
