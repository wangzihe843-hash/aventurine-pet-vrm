/**
 * V1 后端 flag 单测：env > config > 默认（W0-3 冻结语义），以及主进程 IPC 边界的生效值套用。
 */
import { describe, expect, it } from 'vitest'

import { DEFAULT_CONFIG, sanitizeConfig } from '@shared/config'
import {
  applyBackendEnvOverrides,
  hasBackendEnvOverride,
  resolveBackendFlags
} from '../src/main/backend-flags'

describe('resolveBackendFlags（env > config > 默认 vrm）', () => {
  it('无 env 时使用配置值', () => {
    expect(resolveBackendFlags({ modelBackend: 'legacy-pmx', animBackend: 'legacy-pmx' }, {})).toEqual(
      { modelBackend: 'legacy-pmx', animBackend: 'legacy-pmx' }
    )
    expect(resolveBackendFlags(DEFAULT_CONFIG, {})).toEqual({
      modelBackend: 'vrm',
      animBackend: 'vrm'
    })
  })

  it('env 覆盖配置（两个变量独立生效）', () => {
    const config = { modelBackend: 'legacy-pmx' as const, animBackend: 'legacy-pmx' as const }
    expect(resolveBackendFlags(config, { PET_MODEL_BACKEND: 'vrm' })).toEqual({
      modelBackend: 'vrm',
      animBackend: 'legacy-pmx'
    })
    expect(resolveBackendFlags(config, { PET_ANIM_BACKEND: 'vrm' })).toEqual({
      modelBackend: 'legacy-pmx',
      animBackend: 'vrm'
    })
  })

  it('非法/空白 env 回退配置值', () => {
    const config = { modelBackend: 'legacy-pmx' as const, animBackend: 'legacy-pmx' as const }
    for (const bad of ['', '  ', 'VRM', 'vrm2', 'true', 'legacy']) {
      expect(resolveBackendFlags(config, { PET_MODEL_BACKEND: bad, PET_ANIM_BACKEND: bad })).toEqual(
        { modelBackend: 'legacy-pmx', animBackend: 'legacy-pmx' }
      )
    }
  })

  it('env 值大小写/前后空白：只接受 trim 后精确匹配', () => {
    expect(
      resolveBackendFlags(DEFAULT_CONFIG, { PET_MODEL_BACKEND: ' legacy-pmx ' }).modelBackend
    ).toBe('legacy-pmx')
    expect(resolveBackendFlags(DEFAULT_CONFIG, { PET_MODEL_BACKEND: 'Vrm' }).modelBackend).toBe(
      'vrm'
    )
  })
})

describe('applyBackendEnvOverrides', () => {
  it('只覆盖 modelBackend/animBackend，其余字段原样、返回新对象', () => {
    const config = sanitizeConfig({ sizePercent: 70, fpsCap: 24 } as unknown)
    const next = applyBackendEnvOverrides(config, { PET_MODEL_BACKEND: 'legacy-pmx' })
    expect(next).not.toBe(config)
    expect(next.modelBackend).toBe('legacy-pmx')
    expect(next.animBackend).toBe('vrm')
    expect(next.sizePercent).toBe(70)
    expect(next.fpsCap).toBe(24)
  })

  it('env 未设置时返回值与输入等价（IPC 不改变用户设置语义）', () => {
    const config = sanitizeConfig({ modelBackend: 'legacy-pmx', animBackend: 'legacy-pmx' } as unknown)
    expect(applyBackendEnvOverrides(config, {})).toEqual(config)
  })
})

describe('hasBackendEnvOverride', () => {
  it('未设置/空字符串视为无覆盖', () => {
    expect(hasBackendEnvOverride({})).toBe(false)
    expect(hasBackendEnvOverride({ PET_MODEL_BACKEND: '', PET_ANIM_BACKEND: '   ' })).toBe(false)
  })

  it('任一变量非空即视为覆盖（不校验合法性）', () => {
    expect(hasBackendEnvOverride({ PET_MODEL_BACKEND: 'vrm' })).toBe(true)
    expect(hasBackendEnvOverride({ PET_ANIM_BACKEND: 'bogus' })).toBe(true)
  })
})
