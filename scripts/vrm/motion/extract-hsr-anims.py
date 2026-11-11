"""HSR 官方 FBX 全骨动画采样（Blender 4.x headless，dev-only）

用途：把 `Avatar_Aventurine_00.fbx`（HSR 官方角色，135 个 60fps take）里选定的
take 按 30fps 采样为 JSON，供 `retarget-hsr.mjs` 重定向到 VRM humanoid + 次级骨。

背景：
- 该 FBX 带 Maya 式 in-between shape keys，Blender 4.2 的 FBX importer 会直接
  `RuntimeError("FBX in-between Shapes are not currently supported")` 中止整个导入。
  本脚本在导入前 monkey-patch `blen_read_shapes` 跳过 in-between 通道（形态键丢失，
  骨架与动画完整）——这是纯动画采样的可接受代价。
- HSR 骨名（Root_M/Hip_L/Spine1_M/Scapula_L/Shoulder_L/Elbow_L/Wrist_L/...) 与
  VRM humanoid 的映射在 `retarget-hsr.mjs` 的 `HSR_TO_VRM_HUMANOID` 中维护。
- 全部 236 根骨都采样（含手指/头发/衣摆/脸骨），只有被映射的骨会进入 clip。

用法：
  BLENDER=/Volumes/4TB外置盘/deepseek-harness/tools/blender/Blender.app/Contents/MacOS/Blender
  "$BLENDER" -b --factory-startup --python scripts/vrm/motion/extract-hsr-anims.py -- \\
    --fbx "/path/to/Avatar_Aventurine_00.fbx" \\
    --config scripts/vrm/motion/clips.hsr.json \\
    --out tests/tmp/hsr-motion/samples.json

输出 JSON 结构：
  { schemaVersion, sourceFps:60, fps:30, sourceHeightMeters, sourceHipsHeightMeters,
    rest: { <hsrBone>: { quat:[x,y,z,w], head:[x,y,z], parent } },
    children: { <hsrBone>: [ ... ] },
    clips: { <id>: { action, takeMatch, srcFrames:[start,end], frames, data: [
      { f: srcFrame, q: { <bone>: [x,y,z,w] }, h: { <bone>: [x,y,z] } } ] } } }
"""
import bpy
import json
import math
import sys


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    out = {"fps": 30, "source_fps": 60}
    i = 0
    while i < len(argv):
        key = argv[i]
        if key in ("--fbx", "--config", "--out") and i + 1 < len(argv):
            out[key[2:]] = argv[i + 1]
            i += 2
        else:
            i += 1
    if not all(k in out for k in ("fbx", "config", "out")):
        raise SystemExit("用法: -- --fbx <path> --config <clips.hsr.json> --out <samples.json>")
    return out


def patch_inbetween_shapes():
    import io_scene_fbx.import_fbx as imp_fbx

    original = imp_fbx.blen_read_shapes

    def patched(fbx_tmpl, fbx_data, objects, me, scene):
        if fbx_data:
            fbx_data = [entry for entry in fbx_data if len(entry[3]) <= 1]
            if not fbx_data:
                return {}
        return original(fbx_tmpl, fbx_data, objects, me, scene)

    imp_fbx.blen_read_shapes = patched


def pick_action(actions, clip):
    """按 takeMatch + 期望帧数挑 action（Blender action 名会被截断到 63 字符）。"""
    take = clip["takeMatch"]
    expected = clip["srcFrames"]
    candidates = [a for a in actions if take in a.name and len(a.fcurves) >= 2000]
    if not candidates:
        return None
    candidates.sort(key=lambda a: abs((a.frame_range[1] - a.frame_range[0] + 1) - expected))
    chosen = candidates[0]
    got = int(round(chosen.frame_range[1] - chosen.frame_range[0] + 1))
    if abs(got - expected) > 2:
        raise SystemExit(
            "take %r: 无匹配 action（期望 %d 帧，最近 %r 为 %d 帧；候选 %s）"
            % (take, expected, chosen.name, got, [c.name for c in candidates[:5]])
        )
    return chosen


def main():
    args = parse_args()
    config = json.load(open(args["config"], "r", encoding="utf-8"))
    clip_defs = config["clips"]

    patch_inbetween_shapes()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(
        filepath=args["fbx"],
        use_anim=True,
        ignore_leaf_bones=False,
        automatic_bone_orientation=False,
        use_custom_props=True,
    )

    armatures = [o for o in bpy.data.objects if o.type == "ARMATURE"]
    if len(armatures) != 1:
        raise SystemExit("期望 1 个 armature，实际 %d" % len(armatures))
    arm = armatures[0]
    scene = bpy.context.scene
    bones = list(arm.data.bones)

    # 骨骼 rest（armature space；quat 统一为 three/glTF 的 (x,y,z,w)）
    rest = {}
    children = {b.name: [] for b in bones}
    for bone in bones:
        mat = bone.matrix_local
        quat = mat.to_quaternion()
        rest[bone.name] = {
            "quat": [round(quat.x, 9), round(quat.y, 9), round(quat.z, 9), round(quat.w, 9)],
            "head": [round(v, 8) for v in mat.translation],
            "parent": bone.parent.name if bone.parent else None,
        }
        if bone.parent:
            children[bone.parent.name].append(bone.name)

    all_y = [b.head_local.y for b in bones] + [b.tail_local.y for b in bones]
    source_height = round(max(all_y) - min(all_y), 6)
    source_hips_height = round(rest["Root_M"]["head"][1], 6)

    output = {
        "schemaVersion": 1,
        "generatedAt": __import__("datetime").datetime.now().astimezone().isoformat(),
        "fbx": args["fbx"],
        "sourceFps": config.get("sourceFps", 60),
        "fps": config.get("fps", 30),
        "sourceHeightMeters": source_height,
        "sourceHipsHeightMeters": source_hips_height,
        "rest": rest,
        "children": children,
        "clips": {},
    }

    step = int(round(config.get("sourceFps", 60) / config.get("fps", 30)))
    actions = list(bpy.data.actions)
    for clip in clip_defs:
        action = pick_action(actions, clip)
        if action is None:
            print("SKIP %s: take %r 未找到" % (clip["id"], clip["takeMatch"]))
            continue
        arm.animation_data_create()
        arm.animation_data.action = action
        start, end = action.frame_range
        span = end - start
        base_count = int(math.floor(span / step)) + 1
        frame_numbers = [start + i * step for i in range(base_count)]
        # 非 loop clip 需要包含末帧（Wave 1.5 约定 frames = round(duration*fps)+1）
        loop = bool(clip.get("loop", True))
        if not loop and frame_numbers[-1] < end - 1e-6:
            frame_numbers.append(end)
        frames = []
        for src_frame in frame_numbers:
            scene.frame_set(int(round(src_frame)))
            bpy.context.view_layer.update()
            quats = {}
            heads = {}
            for bone in bones:
                pose_bone = arm.pose.bones[bone.name]
                mat = pose_bone.matrix
                quat = mat.to_quaternion()
                quats[bone.name] = [
                    round(quat.x, 9),
                    round(quat.y, 9),
                    round(quat.z, 9),
                    round(quat.w, 9),
                ]
                heads[bone.name] = [round(v, 7) for v in mat.translation]
            frames.append({"f": float(src_frame), "q": quats, "h": heads})
        count = len(frames)
        output["clips"][clip["id"]] = {
            "action": action.name,
            "takeMatch": clip["takeMatch"],
            "srcFrames": [float(start), float(end)],
            "frames": count,
            "data": frames,
        }
        print("SAMPLED %-14s action=%r src=%d-%d frames=%d" % (clip["id"], action.name, start, end, count))

    with open(args["out"], "w", encoding="utf-8") as handle:
        json.dump(output, handle, ensure_ascii=False)
    print(
        "EXTRACT_DONE clips=%d sourceHeight=%.3f sourceHipsHeight=%.3f"
        % (len(output["clips"]), source_height, source_hips_height)
    )


main()
