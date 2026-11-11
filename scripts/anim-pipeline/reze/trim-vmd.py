#!/usr/bin/env python3
"""裁剪 VMD 帧范围（可平移起点），保留相机/灯光/阴影/IK 段。

用途：从长动作里切出「落地」等片段（例如 Mixamo fall-to-landing 只取前 1s 的
「下落→触地→缓冲」），再作为 `landed` 一次性事件动作接进桌宠。

用法：
  python3 scripts/anim-pipeline/reze/trim-vmd.py <src.vmd> <dst.vmd> --start 0 --end 30
  # 帧号闭区间；输出帧号整体平移 start→0（IK 段也平移）。

实现：VMD 骨骼帧 111B（frame u32 + ...）；morph 帧 23B；相机帧 61B；
灯光 28B/帧、自阴影 6B/帧、IK 段含帧号。未给出的段原样保留。
"""
import struct
import sys


def read_u32(buf, offset):
    return struct.unpack_from('<I', buf, offset)[0], offset + 4


def trim(src, dst, start, end):
    with open(src, 'rb') as handle:
        buf = handle.read()
    offset = 0
    header = buf[offset:offset + 30]
    offset += 30
    model = buf[offset:offset + 20]
    offset += 20
    bone_count, offset = read_u32(buf, offset)
    bones = []
    for _ in range(bone_count):
        rec = buf[offset:offset + 111]
        offset += 111
        # VMD 骨骼帧：name(15) + frame(u32) + ...；帧号在 offset 15。
        frame = struct.unpack_from('<I', rec, 15)[0]
        if start <= frame <= end:
            moved = bytearray(rec)
            struct.pack_into('<I', moved, 15, frame - start)
            bones.append(bytes(moved))
    morph_count, offset = read_u32(buf, offset)
    morphs = []
    for _ in range(morph_count):
        rec = buf[offset:offset + 23]
        offset += 23
        # VMD morph 帧：name(15) + frame(u32) + weight(f32)。
        frame = struct.unpack_from('<I', rec, 15)[0]
        if start <= frame <= end:
            moved = bytearray(rec)
            struct.pack_into('<I', moved, 15, frame - start)
            morphs.append(bytes(moved))
    cam_count, offset = read_u32(buf, offset)
    cameras = []
    for _ in range(cam_count):
        rec = buf[offset:offset + 61]
        offset += 61
        frame = struct.unpack_from('<I', rec, 0)[0]
        if start <= frame <= end:
            moved = bytearray(rec)
            struct.pack_into('<I', moved, 0, frame - start)
            cameras.append(bytes(moved))
    light_count, offset = read_u32(buf, offset)
    lights = []
    for _ in range(light_count):
        rec = buf[offset:offset + 28]
        offset += 28
        frame = struct.unpack_from('<I', rec, 0)[0]
        if start <= frame <= end:
            moved = bytearray(rec)
            struct.pack_into('<I', moved, 0, frame - start)
            lights.append(bytes(moved))
    shadow_count, offset = read_u32(buf, offset)
    shadows = []
    for _ in range(shadow_count):
        rec = buf[offset:offset + 6]
        offset += 6
        frame = struct.unpack_from('<I', rec, 0)[0]
        if start <= frame <= end:
            moved = bytearray(rec)
            struct.pack_into('<I', moved, 0, frame - start)
            shadows.append(bytes(moved))
    # IK 段：帧号 + visible + ikCount + [(name20 + enable1)] * ikCount
    ik_count, offset = read_u32(buf, offset)
    iks = []
    for _ in range(ik_count):
        frame = struct.unpack_from('<I', buf, offset)[0]
        visible = buf[offset + 4]
        count, cursor = read_u32(buf, offset + 5)
        body = buf[cursor:cursor + count * 21]
        cursor += count * 21
        if start <= frame <= end:
            iks.append(struct.pack('<I', frame - start) + bytes([visible]) + struct.pack('<I', count) + body)
    out = bytearray(header + model)
    out += struct.pack('<I', len(bones)) + b''.join(bones)
    out += struct.pack('<I', len(morphs)) + b''.join(morphs)
    out += struct.pack('<I', len(cameras)) + b''.join(cameras)
    out += struct.pack('<I', len(lights)) + b''.join(lights)
    out += struct.pack('<I', len(shadows)) + b''.join(shadows)
    out += struct.pack('<I', len(iks)) + b''.join(iks)
    with open(dst, 'wb') as handle:
        handle.write(out)
    print(f'{src} -> {dst}: frames[{start},{end}] bones {bone_count}->{len(bones)}, morph {morph_count}->{len(morphs)}, cam {cam_count}->{len(cameras)}, ik {ik_count}->{len(iks)}, bytes {len(out)}')


if __name__ == '__main__':
    args = sys.argv[1:]
    if len(args) < 2:
        print(__doc__)
        sys.exit(2)
    start = 0
    end = 2**31 - 1
    positional = []
    index = 0
    while index < len(args):
        if args[index] == '--start':
            start = int(args[index + 1]); index += 2
        elif args[index] == '--end':
            end = int(args[index + 1]); index += 2
        else:
            positional.append(args[index]); index += 1
    trim(positional[0], positional[1], start, end)
