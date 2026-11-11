#!/usr/bin/env python3
"""glTF (.glb/.gltf) → 每动画一个 FBX（供 reze-rig 转 VMD）。

用途：three.js 官方示例模型（如 r171 `examples/models/gltf/Soldier.glb`，Mixamo 骨架）
只提供 glTF，而 reze-rig 只吃 FBX。本脚本用 Blender 4.2 无头导入 glTF，再把每个
AnimationClip 单独导出成一个 FBX（保留 Mixamo 骨名 `mixamorig:*` / 任意原骨名）。

用法（仓库根目录）：
  BLENDER=/Volumes/4TB外置盘/deepseek-harness/tools/blender/Blender.app/Contents/MacOS/Blender
  "$BLENDER" --background --python scripts/anim-pipeline/reze/glb2fbx.py -- \
    --glb /tmp/Soldier.glb \
    --out tests/tmp/motions/free/fbx \
    --actions Idle,Walk,Run

参数：
  --glb <path>          输入 glb/gltf（必填）
  --out <dir>           输出目录（每个动画一个 <动画名>.fbx；必填）
  --actions a,b,c       只导出这些动画（大小写不敏感；默认全部）
  --fps <n>             导入关键帧所用场景帧率（默认 30，与 VMD/reze 一致）

说明：
  - 导出前把 scene fps 设为 --fps，避免 Blender 默认 24fps 把 Mixamo 30fps 素材
    重采样到 24fps 网格（reze-rig 固定 30fps 输出）；
  - 必须同时导出「骨架 + 蒙皮网格」：只导 armature 时 Blender 写出的 FBX 会丢失
    skin bind/Deformer 数据，reze-rig 读到的 rest pose 会错（实测骨骼朝向乱掉，
    重定向结果：腿常开、手臂外张、idle 也在踏步）；带网格导出则 rest/bind 与 glTF 一致；
  - 每个动画用「active action + bake_anim」导出为独立 FBX，reze-rig 一次扫一个 clip。
"""

import argparse
import os
import sys

import bpy


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser(description="glTF -> per-animation FBX (Blender headless)")
    p.add_argument("--glb", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--actions", default="")
    p.add_argument("--fps", type=int, default=30)
    return p.parse_args(argv)


def action_bone_names(action):
    """action 里 fcurve 路径指向的 pose bone 名（判断该 action 属于哪条 armature）。"""
    names = set()
    for fc in action.fcurves:
        path = fc.data_path
        if not path.startswith('pose.bones["'):
            continue
        try:
            names.add(path.split('"')[1])
        except IndexError:
            pass
    return names


def main():
    args = parse_args()
    glb = os.path.abspath(args.glb)
    out_dir = os.path.abspath(args.out)
    os.makedirs(out_dir, exist_ok=True)

    # 空场景 + 30fps（在 import 之前设，glTF importer 用 scene.render.fps 把秒转帧）
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.render.fps = args.fps
    bpy.context.scene.render.fps_base = 1.0

    bpy.ops.import_scene.gltf(filepath=glb)

    arms = [o for o in bpy.data.objects if o.type == "ARMATURE"]
    if not arms:
        raise SystemExit(f"[glb2fbx] FAIL: no armature imported from {glb}")

    # glTF importer 会为每条 animation 生成若干 action：<Anim>_<对象名>。
    # 骨架（armature）那条带全部 pose.bones 轨道（fcurve 最多），其余是末端 EMPTY 的
    # 独立 loc/rot/scale action（导出 armature 时可以忽略）。
    def pose_actions():
        return [a for a in bpy.data.actions if any(fc.data_path.startswith('pose.bones[') for fc in a.fcurves)]

    wanted = [s.strip() for s in args.actions.split(",") if s.strip()]
    if wanted:
        picked = []
        for w in wanted:
            cands = [a for a in pose_actions()
                     if a.name.lower() == w.lower() or a.name.lower().startswith(w.lower() + "_")]
            if not cands:
                print(f"[glb2fbx] WARN: action '{w}' not found; have: {[a.name for a in bpy.data.actions]}")
                continue
            picked.append(max(cands, key=lambda a: len(a.fcurves)))
        actions = picked
    else:
        actions = pose_actions()
    if not actions:
        raise SystemExit("[glb2fbx] FAIL: no actions to export")

    print(f"[glb2fbx] armatures: {[o.name for o in arms]}")
    print(f"[glb2fbx] actions: {[a.name for a in actions]}")

    for act in actions:
        targets = action_bone_names(act)
        # 找包含这些骨的 armature（混合场景里可能有多条骨架）
        arm = next((o for o in arms if targets & {b.name for b in o.data.bones}), arms[0])
        # 清掉其它骨架的 animation_data，避免导出选中骨架时带入别的东西
        for o in arms:
            if o is not arm and o.animation_data:
                o.animation_data.action = None
        arm.animation_data_create()
        arm.animation_data.action = act

        f0, f1 = act.frame_range
        scene = bpy.context.scene
        scene.frame_start = int(round(f0))
        scene.frame_end = max(int(round(f1)), scene.frame_start + 1)

        # 必须带蒙皮网格一起导出（见文件头说明）：FBX 的 skin bind 来自 mesh 的
        # Deformer/Cluster，只导 armature 会让 reze-rig 用到错误的 rest pose。
        bpy.ops.object.select_all(action="DESELECT")
        arm.select_set(True)
        for o in bpy.data.objects:
            if o.type == "MESH":
                o.select_set(True)
        bpy.context.view_layer.objects.active = arm

        # 输出名尽量用动画名本身（Idle/Walk/Run）：
        #  - reze-rig CLI 默认会把输入里 basename 恰为 `Idle.fbx` 的文件当 bind reference；
        #  - 输出 VMD 名 = FBX basename，动画名即最终 `motion-<id>.vmd` 的来源。
        clip_name = act.name
        if clip_name.lower().endswith("_" + arm.name.lower()):
            clip_name = clip_name[: -(len(arm.name) + 1)]
        safe = "".join(c if (c.isalnum() or c in "-_.") else "_" for c in clip_name)
        path = os.path.join(out_dir, safe + ".fbx")
        bpy.ops.export_scene.fbx(
            filepath=path,
            use_selection=True,
            object_types={"ARMATURE", "MESH"},
            apply_scale_options="FBX_SCALE_NONE",
            bake_anim=True,
            bake_anim_use_all_actions=False,
            bake_anim_use_nla_strips=False,
            bake_anim_force_startend_keying=True,
            bake_anim_step=1.0,
            bake_anim_simplify_factor=0.0,
            add_leaf_bones=False,
            mesh_smooth_type="FACE",
            use_mesh_modifiers=False,
            path_mode="AUTO",
        )
        print(f"[glb2fbx] {act.name} frames={scene.frame_start}..{scene.frame_end} -> {path} ({os.path.getsize(path)} B)")

    print("[glb2fbx] DONE")


if __name__ == "__main__":
    main()
