#!/usr/bin/env node
/**
 * 端到端校验：把 `watergun-attach.json` 的 policy 套到**真实/预期 app catalog** 上，
 * 确认「7 条 adv 白名单命中持枪、其余 128 条 + hsr/mate 全部隐藏」。
 *
 * 数据源优先级：
 *   1. `assets/motions/app-catalog.json` 里已有的 `set === "adv"` 条目（task-3 接入后）；
 *   2. 若 catalog 尚未接入 adv（`adv-*` = 0），用 `assets/motions/adv/index.json` + `scripts/vrm/motion/clips.adv-all.json`
 *      重建预期条目（id = `adv-<clip>`、tags 取 config）做 dry-run。
 *
 * Run: node scripts/props/check-watergun-policy.mjs
 * 输出：控制台表格 + `tests/tmp/props/watergun/data-probe/policy-check.json`
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const ATTACH = path.join(ROOT, 'src/renderer/src/vrm/watergun-attach.json')
const CATALOG = path.join(ROOT, 'assets/motions/app-catalog.json')
const ADV_INDEX = path.join(ROOT, 'assets/motions/adv/index.json')
const ADV_CONFIG = path.join(ROOT, 'scripts/vrm/motion/clips.adv-all.json')
const OUT = path.join(ROOT, 'tests/tmp/props/watergun/data-probe/policy-check.json')

/** 与 prop-config.ts `shouldHoldHandProp` 等价的纯逻辑（本脚本不 import TS）。 */
function shouldHold(clip, policy) {
  if (!clip) return false
  const set = policy.holdSets ?? []
  const tags = policy.holdTags ?? []
  const clipIds = policy.holdClipIds ?? []
  const allEmpty = set.length === 0 && tags.length === 0 && clipIds.length === 0
  const eff = allEmpty ? { holdSets: ['adv'], holdTags: ['skill'], holdClipIds: [] } : policy
  const ids = eff.holdClipIds ?? []
  if (ids.length > 0) return ids.includes(clip.id)
  const sets = eff.holdSets ?? []
  const tagList = eff.holdTags ?? []
  if (sets.length > 0 && !sets.includes(clip.set)) return false
  if (tagList.length > 0 && !tagList.some((t) => (clip.tags ?? []).includes(t))) return false
  return true
}

function loadExpectedAdvClips() {
  const index = JSON.parse(fs.readFileSync(ADV_INDEX, 'utf8'))
  const config = JSON.parse(fs.readFileSync(ADV_CONFIG, 'utf8'))
  const tagsById = new Map(config.clips.map((c) => [c.id, c.tags ?? []]))
  const clips = []
  for (const [sourceId, meta] of Object.entries(index.clips ?? {})) {
    clips.push({
      id: `adv-${sourceId}`,
      sourceId,
      set: 'adv',
      tags: tagsById.get(sourceId) ?? [],
      file: meta.file,
      slot: meta.slot ?? null,
    })
  }
  return { clips, source: 'adv/index.json + clips.adv-all.json (dry-run；app-catalog 尚未接入 adv)' }
}

function main() {
  const attach = JSON.parse(fs.readFileSync(ATTACH, 'utf8'))
  const policy = attach.policy ?? {}
  const expectedHold = [...(policy.holdClipIds ?? [])]

  const catalog = fs.existsSync(CATALOG) ? JSON.parse(fs.readFileSync(CATALOG, 'utf8')) : { clips: [] }
  const advInCatalog = (catalog.clips ?? []).filter((c) => c.set === 'adv')
  let entries
  let source
  if (advInCatalog.length > 0) {
    entries = [...catalog.clips]
    source = 'app-catalog.json（真实 catalog）'
  } else {
    const expected = loadExpectedAdvClips()
    const nonAdv = (catalog.clips ?? []).map((c) => ({
      id: c.id,
      set: c.set,
      tags: c.tags ?? []
    }))
    entries = [...expected.clips, ...nonAdv]
    source = expected.source
  }

  const holds = entries.filter((c) => shouldHold(c, policy))
  const holdAdv = holds.filter((c) => c.set === 'adv').map((c) => c.id).sort()
  const crosses = holds.filter((c) => c.set !== 'adv')
  const missing = expectedHold.filter((id) => !entries.some((c) => c.id === id))
  const unexpected = holdAdv.filter((id) => !expectedHold.includes(id))
  const results = {
    generatedAt: new Date().toISOString(),
    source,
    policy,
    totals: {
      clips: entries.length,
      advClips: entries.filter((c) => c.set === 'adv').length,
      holds: holds.length,
      holdAdv: holdAdv.length,
    },
    holdAdv,
    expectedHold,
    missingFromCatalog: missing,
    unexpectedHolds: unexpected,
    nonAdvHolds: crosses.map((c) => ({ id: c.id, set: c.set })),
    pass: missing.length === 0 && unexpected.length === 0 && crosses.length === 0 && holdAdv.length === expectedHold.length,
    clipTable: entries
      .filter((c) => c.set === 'adv')
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((c) => ({ id: c.id, tags: c.tags, hold: shouldHold(c, policy), slot: c.slot ?? null })),
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2))

  console.log(`source: ${source}`)
  console.log(`clips=${results.totals.clips} adv=${results.totals.advClips} holds=${results.totals.holds} (adv holds ${holdAdv.length})`)
  console.log(`白名单命中: ${holdAdv.join(', ')}`)
  console.log(`缺 catalog: ${JSON.stringify(missing)}  意外命中: ${JSON.stringify(unexpected)}  非 adv 误伤: ${JSON.stringify(results.nonAdvHolds)}`)
  console.log(results.pass ? 'POLICY_CHECK PASS' : 'POLICY_CHECK FAIL')
  if (!results.pass) process.exitCode = 1
}

main()
