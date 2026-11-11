"""从 pilot 全场景 FBX 导出水枪挂点的「世界变换参照」（仅本机开发用）。

原理：
- 水枪 GLB 是从 Tpose.fbx 第 1 帧按「世界坐标 → ×100 → 居中」烘焙出来的；
  因此在游戏模型世界里，水枪在任意动画帧 f 的世界变换 W(f) 可由
  「Gun_b_01_JNT 骨骼从提取帧(e) 到帧(f) 的刚体变化」还原（武器网格基本刚性绑在该骨上）。
- 本脚本输出每个采样帧的 W_three（**three.js/glTF 坐标、米制** 的 4x4 矩阵），
  供预览查看器在浏览器里计算 T = inv(VRM右手世界矩阵) · W，从而反推道具挂载局部变换。

用法：
  Blender -b --factory-startup --python /tmp/calib_watergun.py -- \
    --tpose tests/tmp/adv-pilot-v3/fbx-pilot-v2-gui/pilot/Tpose.fbx \
    --skill tests/tmp/adv-pilot-v3/fbx-pilot-v2-gui/pilot/Skill01.fbx \
    --out tests/tmp/props/watergun/calib-skill01.json \
    --clip-indices 10,20,30,40,50,60,70,80
"""

import bpy
import json
import math
import os
import sys

from mathutils import Matrix, Vector

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []


def arg(name, default=None):
    key = '--' + name
    if key in argv:
        index = argv.index(key)
        if index + 1 < len(argv):
            return argv[index + 1]
    return default


root = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
tpose_fbx = arg('tpose', 'tests/tmp/adv-pilot-v3/fbx-pilot-v2-gui/pilot/Tpose.fbx')
skill_fbx = arg('skill', 'tests/tmp/adv-pilot-v3/fbx-pilot-v2-gui/pilot/Skill01.fbx')
out_path = arg('out', 'tests/tmp/props/watergun/calib-skill01.json')
clip_indices = [int(v) for v in arg('clip-indices', '10,20,30,40,50,60,70,80').split(',')]
# 水枪 GLB 提取时的居中偏移（Blender 坐标、米制）= meta.json 的 centerMeters
center_meters = json.loads(arg('center', '{"x":0.01525,"y":-0.07321,"z":0.0}'))
center_meters = Vector((center_meters['x'], center_meters['y'], center_meters['z']))


def resolve(path):
    return path if os.path.isabs(path) else os.path.join(root, path)


tpose_fbx = resolve(tpose_fbx)
skill_fbx = resolve(skill_fbx)
out_path = resolve(out_path) if out_path else os.path.join(root, 'tests/tmp/props/watergun/calib.json')

# Blender(Z-up, 1 unit = 100 real m) -> three.js/glTF(Y-up, 1 unit = 1 m)
M_B2T = Matrix.Rotation(math.radians(-90), 4, 'X') @ Matrix.Scale(100.0, 4)


def find_armature():
    for ob in bpy.data.objects:
        if ob.type == 'ARMATURE' and ob.name == 'Bip001':
            return ob
    for ob in bpy.data.objects:
        if ob.type == 'ARMATURE' and len(ob.data.bones) > 100:
            return ob
    raise RuntimeError('找不到 Bip001 骨架')


def gun_bone_world(arm):
    pb = arm.pose.bones.get('Gun_b_01_JNT')
    if pb is None:
        # 兼容不同命名
        names = [b.name for b in arm.pose.bones if 'Gun' in b.name or 'gun' in b.name]
        if not names:
            raise RuntimeError('找不到 Gun_b_01_JNT 骨骼')
        pb = arm.pose.bones[names[0]]
    return arm.matrix_world @ pb.matrix


# ---------------------------------------------------------------- pass 1: Tpose
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=tpose_fbx)
scene = bpy.context.scene
scene.frame_set(1)
arm_t = find_armature()
M_ARM_TPOSE = arm_t.matrix_world.copy()  # Tpose 场景的骨架 object 矩阵（提取 GLB 时的世界朝向）
A_e = gun_bone_world(arm_t)  # 提取帧的枪骨世界矩阵（Blender 坐标）

# 提取帧的武器网格世界 bbox 中心（Blender 坐标，用于还原 GLB 局部坐标原点 = bbox 中心）
deps = bpy.context.evaluated_depsgraph_get()
weapon = next((ob for ob in bpy.data.objects if ob.type == 'MESH' and 'Weapon' in ob.name), None)
if weapon is not None:
    evaluated = weapon.evaluated_get(deps)
    mesh = evaluated.to_mesh()
    points = [evaluated.matrix_world @ v.co for v in mesh.vertices]
    if points:
        lo = Vector((min(p.x for p in points), min(p.y for p in points), min(p.z for p in points)))
        hi = Vector((max(p.x for p in points), max(p.y for p in points), max(p.z for p in points)))
        measured_center = (lo + hi) / 2
        print(f'[calib] weapon bbox center (blender units) = {tuple(round(v, 6) for v in measured_center)}')
    evaluated.to_mesh_clear()

# GLB 局部原点（bbox 中心）在 three 坐标里的位置
C0 = Matrix.Rotation(math.radians(-90), 4, 'X') @ center_meters  # three 坐标（米）：B(centerMeters)

# ---------------------------------------------------------------- pass 2: Skill01
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=skill_fbx)
scene = bpy.context.scene
arm = find_armature()

samples = []
for clip_index in clip_indices:
    # clip JSON: frames 98, srcFrames [1,195] -> 均匀采样，Frame = 1 + 2*i
    frame = 1 + 2 * clip_index
    scene.frame_set(frame)
    # 两个 .max 场景的 armature object 矩阵不同（Tpose 场景多了 -90°Z 等旋转）：
    # 统一用 Tpose 场景的 object 矩阵，把 Skill01 的 armature-space 枪骨姿态映射回「提取 GLB 时的世界朝向」
    gun_pb = arm.pose.bones.get('Gun_b_01_JNT')
    A_f = M_ARM_TPOSE @ gun_pb.matrix
    D = A_f @ A_e.inverted()  # Blender 坐标下的刚体变化（统一到 Tpose 世界朝向）
    M = M_B2T @ D @ M_B2T.inverted()  # three 坐标下的刚体变化
    # 世界变换 W：glb 点 p -> three 世界 = M p + (M C0 - C0)
    t_offset = M @ C0 - C0
    W = M.copy()
    W.translation = t_offset
    samples.append({
        'clipIndex': clip_index,
        'sourceFrame': frame,
        'W': [round(value, 8) for row in W for value in row],
    })

result = {
    'source': {
        'tposeFbx': os.path.relpath(tpose_fbx, root),
        'skillFbx': os.path.relpath(skill_fbx, root),
        'extractionCenterMeters': list(center_meters),
    },
    'notes': 'W = 4x4 row-major，three.js/glTF 坐标、米制；把提取 GLB 放到该矩阵处即等同源动画里水枪的世界位置',
    'samples': samples,
}
os.makedirs(os.path.dirname(out_path), exist_ok=True)
with open(out_path, 'w', encoding='utf-8') as handle:
    json.dump(result, handle, ensure_ascii=False, indent=2)
print('[calib] wrote', out_path, 'samples:', len(samples))
print('[calib] DONE')
