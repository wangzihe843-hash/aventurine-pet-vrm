#!/usr/bin/env python3
"""从 VMD 中剥离 morph（表情/口型）关键帧，保留骨骼/相机/灯光/阴影/IK 段。

为什么需要：R2V/MMD 原生动作常带大量 morph 轨道；three r171 `MMDLoader.animationBuilder.build`
在本模型上处理某些 morph 名会抛错（如 `Cannot read properties of undefined (reading '真面目')`）。
本 app 的表情统一由 B3 管（`vmd-clip` 也会二次剥 morph），所以下载动作接入前先剥掉更稳。

用法：
  python3 scripts/anim-pipeline/reze/strip-vmd-morphs.py <src.vmd> <dst.vmd>
  python3 scripts/anim-pipeline/reze/strip-vmd-morphs.py <src.vmd> <dst.vmd> --keep   # 只统计不写
"""
import struct
import sys


def read_u32(buf, offset):
    return struct.unpack_from('<I', buf, offset)[0], offset + 4


def strip_morphs(src, dst):
    with open(src, 'rb') as handle:
        buf = handle.read()
    offset = 0
    header = buf[offset:offset + 30]
    offset += 30
    model = buf[offset:offset + 20]
    offset += 20
    bone_count, offset = read_u32(buf, offset)
    bone_bytes = buf[offset:offset + bone_count * 111]
    offset += bone_count * 111
    morph_count, offset = read_u32(buf, offset)
    # morph 帧大小 23 字节（frame u32 + morphName 15 + weight f32）
    offset += morph_count * 23
    rest = buf[offset:]  # camera / light / self-shadow / IK 等原样保留
    out = header + model + struct.pack('<I', bone_count) + bone_bytes
    out += struct.pack('<I', 0) + rest
    with open(dst, 'wb') as handle:
        handle.write(out)
    print(f'{src} -> {dst}: bone frames {bone_count}, stripped morph frames {morph_count}, bytes {len(out)}')
    return bone_count, morph_count


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(2)
    strip_morphs(sys.argv[1], sys.argv[2])
