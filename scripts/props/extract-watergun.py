#!/usr/bin/env python3
"""从 .max 导出的全场景 FBX 中提取「砂金·戏浪」水枪网格（dev-only，本机私有资产）。

背景（2026-11-09 实测）：
  - `assets/model/星穹铁道—砂金·戏浪.pmx` 只有身体（39 材质，水枪.png 未引用）；
  - 但 Windows 侧 3ds Max 导出的**全场景 FBX**（pilot/full 版）里带游戏角色模型：
    `0000_Body`…`0008_Hair` + **`0009_Weapon`**（4642 顶点 / 4508 面），
    贴图引用 `Avatar_AventurineW_00_Weapon_Color.png`（= 本地 `assets/model/水枪.png` 同一张 2K 图，
    已用 UV 贴图渲染验证），骨骼侧另有独立 `Gun_b/c/d/e_01_JNT` + `prop_JNT` 武器骨。
  - 源场景单位约为真实米制的 1/100（角色 bbox 高 ≈0.017 场景单位 ≈ 1.70 m 真人比例），
    提取时按“角色身高 = 1.70 m”归一化缩放。

产物（默认）：
  assets/props/watergun/watergun.glb      # 米制、贴图内嵌、网格居中到原点（姿态 = 源 FBX 的 bind pose）
  assets/props/watergun/meta.json         # 尺寸/来源/校验数据（供运行时 bbox sanity check 与校准）

用法：
  /Volumes/4TB外置盘/deepseek-harness/tools/blender/Blender.app/Contents/MacOS/Blender \\
    -b --factory-startup --python scripts/props/extract-watergun.py -- \\
    --fbx tests/tmp/adv-pilot-v3/fbx-pilot-v2-gui/pilot/Tpose.fbx \\
    --texture assets/model/水枪.png \\
    --out assets/props/watergun

注意：只读取本机私有资产，产物沿用游戏资产版权约定（仅本机开发，禁止分发/商用）。
"""

import bpy
import json
import math
import os
import sys

from mathutils import Matrix, Vector

# ---------------------------------------------------------------- CLI parsing
argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []


def arg(name, default=None):
    key = '--' + name
    if key in argv:
        index = argv.index(key)
        if index + 1 < len(argv):
            return argv[index + 1]
    return default


fbx_path = arg('fbx', 'tests/tmp/adv-pilot-v3/fbx-pilot-v2-gui/pilot/Tpose.fbx')
texture_path = arg('texture', 'assets/model/水枪.png')
out_dir = arg('out', 'assets/props/watergun')
frame = int(arg('frame', '1'))
target_height = float(arg('target-height', '1.70'))
max_edge = int(arg('max-edge', '2048'))

root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
fbx_path = os.path.join(root, fbx_path) if not os.path.isabs(fbx_path) else fbx_path
texture_path = os.path.join(root, texture_path) if not os.path.isabs(texture_path) else texture_path
out_dir = os.path.join(root, out_dir) if not os.path.isabs(out_dir) else out_dir

assert os.path.isfile(fbx_path), f'FBX not found: {fbx_path}'
assert os.path.isfile(texture_path), f'texture not found: {texture_path}'
os.makedirs(out_dir, exist_ok=True)

# ------------------------------------------------------------------- import
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=fbx_path)
scene = bpy.context.scene
scene.frame_set(frame)

weapon = next((ob for ob in bpy.data.objects if ob.type == 'MESH' and 'Weapon' in ob.name), None)
assert weapon is not None, 'FBX 中找不到名称含 Weapon 的 mesh（请确认导出了 full 版而非 _skel 版）'

# --------------------------------------------- body height -> scene->meter scale
depsgraph = bpy.context.evaluated_depsgraph_get()


def world_bounds(objects):
    minimum = Vector((1e30, 1e30, 1e30))
    maximum = Vector((-1e30, -1e30, -1e30))
    for ob in objects:
        evaluated = ob.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        for vertex in mesh.vertices:
            point = evaluated.matrix_world @ vertex.co
            for axis in range(3):
                minimum[axis] = min(minimum[axis], point[axis])
                maximum[axis] = max(maximum[axis], point[axis])
        evaluated.to_mesh_clear()
    return minimum, maximum


body_objects = [ob for ob in bpy.data.objects if ob.type == 'MESH' and 'Weapon' not in ob.name]
body_min, body_max = world_bounds(body_objects)
body_height_scene = body_max.z - body_min.z
scale = target_height / body_height_scene
print(f'[extract] body height (scene units) = {body_height_scene:.6f}  scale -> meters = {scale:.4f}')

# ---------------------------------------------------- bake weapon to a static mesh
weapon_eval = weapon.evaluated_get(depsgraph)
temp_mesh = weapon_eval.to_mesh()
static_mesh = temp_mesh.copy()
weapon_eval.to_mesh_clear()

gun = bpy.data.objects.new('WaterGun', static_mesh)
bpy.context.collection.objects.link(gun)
# 把 evaluate 后的局部坐标变换到世界坐标，再乘场景->米比例
gun.data.transform(weapon.matrix_world)
gun.data.transform(Matrix.Scale(scale, 4))
gun.matrix_world = Matrix.Identity(4)

# 居中（保留源 bind pose 朝向；挂点偏移在运行时/预览里校准）
xs = [v.co.copy() for v in gun.data.vertices]
minimum = Vector((min(v.x for v in xs), min(v.y for v in xs), min(v.z for v in xs)))
maximum = Vector((max(v.x for v in xs), max(v.y for v in xs), max(v.z for v in xs)))
center = (minimum + maximum) / 2
gun.data.transform(Matrix.Translation(-center))
gun.data.update()
dims = maximum - minimum
print(f'[extract] gun dims (m): x={dims.x:.4f} y={dims.y:.4f} z={dims.z:.4f}  longest={max(dims):.4f}')

# ------------------------------------------------------------- material + texture
image = bpy.data.images.load(texture_path)
if max(image.size) > max_edge:
    image.scale(max_edge, max_edge)

material = bpy.data.materials.get('WaterGun') or bpy.data.materials.new('WaterGun')
material.use_nodes = True
nodes = material.node_tree
for node in list(nodes.nodes):
    nodes.nodes.remove(node)
output = nodes.nodes.new('ShaderNodeOutputMaterial')
bsdf = nodes.nodes.new('ShaderNodeBsdfPrincipled')
texture = nodes.nodes.new('ShaderNodeTexImage')
texture.image = image
texture.interpolation = 'Linear'
nodes.links.new(texture.outputs['Color'], bsdf.inputs['Base Color'])
nodes.links.new(bsdf.outputs['BSDF'], output.inputs['Surface'])
bsdf.inputs['Roughness'].default_value = 0.55
bsdf.inputs['Metallic'].default_value = 0.0
# 游戏武器贴图是已烘焙的 toon 色，贴图直出即可；保留一个近似常量自发光避免死黑
gun.data.materials.clear()
gun.data.materials.append(material)
for polygon in gun.data.polygons:
    polygon.use_smooth = True

# 只导出水枪
for ob in bpy.data.objects:
    ob.select_set(ob is gun)
bpy.context.view_layer.objects.active = gun

# --------------------------------------------------------------------- export GLB
glb_path = os.path.join(out_dir, 'watergun.glb')
bpy.ops.export_scene.gltf(
    filepath=glb_path,
    export_format='GLB',
    use_selection=True,
    export_apply=True,
    export_materials='EXPORT',
    export_image_format='AUTO',
    export_yup=True,
)

# --------------------------------------------------------------------- meta.json
meta = {
    'schemaVersion': 1,
    'generatedAt': '2026-11-09T18:40:00+08:00',
    'generatedBy': 'scripts/props/extract-watergun.py',
    'source': {
        'fbx': os.path.relpath(fbx_path, root),
        'frame': frame,
        'meshObject': weapon.name,
        'meshVerts': len(gun.data.vertices),
        'meshPolys': len(gun.data.polygons),
        'sourceTextureReference': 'Avatar_AventurineW_00_Weapon_Color.png (FBX material #30)',
        'textureUsed': os.path.relpath(texture_path, root),
        'note': '全场景 FBX 由 Windows 侧 3ds Max 从 .max 导出；武器网格在源场景中未绑定到手骨（需运行时挂点）',
    },
    'normalization': {
        'bodyHeightSceneUnits': round(body_height_scene, 6),
        'targetBodyHeightMeters': target_height,
        'scaleToMeters': round(scale, 4),
        'gltfYUp': True,
    },
    'bounds': {
        'dimensionsMeters': {'x': round(dims.x, 5), 'y': round(dims.y, 5), 'z': round(dims.z, 5)},
        'longestMeters': round(max(dims), 5),
        'centerMeters': {'x': round(center.x, 5), 'y': round(center.y, 5), 'z': round(center.z, 5)},
    },
    'runtimeHints': {
        'attachBone': 'rightHand (raw humanoid bone)',
        'recommendedChain': 'three-vrm > getRawBoneNode("rightHand").add(gun)',
        'scaleSanity': 'bbox longest ≈ 0.45–0.75 m（角色身高 1.70 m）',
        'styleHint': '运行时可将 GLB 的 PBR 材质替换为 MeshToonMaterial（复用 assets/model/optimized/toon3.png）× 水枪.png',
    },
}

with open(os.path.join(out_dir, 'meta.json'), 'w', encoding='utf-8') as handle:
    json.dump(meta, handle, ensure_ascii=False, indent=2)

glb_size = os.path.getsize(glb_path)
print(f'[extract] wrote {glb_path} ({glb_size} bytes)')
print(f'[extract] wrote {os.path.join(out_dir, "meta.json")}')
print('[extract] DONE')
