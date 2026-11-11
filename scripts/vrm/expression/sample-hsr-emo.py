"""HSR 官方 FBX —— 脸部表情 take（Emo_*）脸骨采样（Blender 4.x headless，dev-only）

V6 表情层 · HSR Emo_ 数据管线第 1 步：把 HSR 官方模型 FBX 里 17 条 `Emo_*` take 的
**73 根脸骨**采样为 JSON，供 `decode-hsr-emo.mjs` 解码成 VRM 1.0 preset 表情权重。

为什么不用 Unity：Emo_ take 是**脸骨动画**（不是 blendshape），Blender 能无头导入并逐帧
读取 `pose_bone.matrix_basis`；采样产物是纯数据（私有，gitignore）。

输出（`--out <dir>/emo-face-samples.json`）：
```
{
  schemaVersion: 1,
  blender, fbx, sourceFps: 60, fps: 30,
  rest: { bone: { parent, head, tail, length, quatArmature, quatParentRelative } },
  takes: {
    <takeId>: {
      action, pattern, srcFrames, sourceFrames, frames, durationSeconds,
      bones: [name...],
      data: [ { f, root(16 矩阵), q{骨: [x,y,z,w]}, l{骨:[x,y,z]}, s{骨:[x,y,z]},
               h{骨:[x,y,z]}, t{骨:[x,y,z]} } ... ]
    }
  },
  missing: [...]
}
```
- `q` = pose bone 的 `matrix_basis` 旋转（相对 rest 的 local 旋转；解码器用「相对中性帧的
  四元数增量 → armature 空间旋转向量」做表情特征）。
- `h`/`t` = pose 状态 head/tail 的 armature 空间位置（几何校验用）。
- `rest.quatArmature` = 骨骼 rest 在 armature 空间的朝向（用于把 local 增量换到 armature 轴）。

已知坑（沿用 Wave 1.5/V3 管线结论，详见 `docs/vrm-motion-hsr.md`）：
1. FBX 内嵌 Maya in-between shapes 会让 Blender 4.2 importer 直接 raise → 导入前
   monkey-patch `blen_read_shapes` 跳过形态键（本脚本只需骨架动画）。
2. take 名在 Blender 里可能被截断到 63 字符 → 用子串 pattern 匹配。
3. Blender `mathutils.Quaternion` 迭代顺序是 (w,x,y,z)，JSON 统一为 (x,y,z,w)。

用法：
  BLENDER=/Volumes/4TB外置盘/deepseek-harness/tools/blender/Blender.app/Contents/MacOS/Blender
  "$BLENDER" -b --factory-startup --python scripts/vrm/expression/sample-hsr-emo.py -- \
    --fbx "/path/Avatar_Aventurine_00.fbx" \
    --config scripts/vrm/expression/config/hsr-emo.json \
    --out assets/expressions/_samples   # 私有数据（gitignore）
"""
import bpy
import json
import os
import sys
import time
from mathutils import Matrix


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    out = {"fps": 30, "source_fps": 60, "config": None, "fbx": None, "out": None}
    i = 0
    while i < len(argv):
        key = argv[i]
        if key.startswith("--") and i + 1 < len(argv):
            out[key[2:].replace("-", "_")] = argv[i + 1]
            i += 2
        else:
            i += 1
    if not out.get("fbx") or not out.get("config") or not out.get("out"):
        raise SystemExit("用法: -- --fbx <fbx> --config <json> --out <dir>")
    out["fps"] = int(out["fps"])
    out["source_fps"] = int(out["source_fps"])
    return out


def patch_inbetween_shapes():
    """跳过 Maya in-between shape 通道（Blender 4.2 legacy FBX importer 不支持）。"""
    import io_scene_fbx.import_fbx as imp_fbx

    original = imp_fbx.blen_read_shapes

    def patched(fbx_tmpl, fbx_data, objects, me, scene):
        if fbx_data:
            fbx_data = [entry for entry in fbx_data if len(entry[3]) <= 1]
            if not fbx_data:
                return {}
        return original(fbx_tmpl, fbx_data, objects, me, scene)

    imp_fbx.blen_read_shapes = patched


def collect_face_bones(arm):
    """joint_face 及其全部后代（本 FBX 为 73 根：眉 13 / 眼 19 / 口 30 / 注视 10 / 根 1）。"""
    root = arm.data.bones.get("joint_face")
    if root is None:
        raise SystemExit("找不到 joint_face 骨（模型结构变化？）")
    order, stack = [], [root]
    while stack:
        bone = stack.pop()
        order.append(bone)
        stack.extend(sorted(bone.children, key=lambda item: item.name, reverse=True))
    return order


def action_bones(action):
    names = set()
    for fcurve in action.fcurves:
        if 'pose.bones["' in fcurve.data_path:
            names.add(fcurve.data_path.split('"')[1])
    return names


def pick_action(actions, pattern):
    """按子串匹配动画 action（Emo_* 集合）；多个候选时优先 fcurve 多者。"""
    candidates = [
        action
        for action in actions
        if "Emo_Aventurine_00_" in action.name and pattern in action.name and len(action.fcurves) >= 100
    ]
    if not candidates:
        return None, []
    candidates.sort(key=lambda action: -len(action.fcurves))
    return candidates[0], candidates


def reset_pose(arm):
    for pose_bone in arm.pose.bones:
        pose_bone.matrix_basis = Matrix.Identity(4)


def frame_list(action, source_fps, fps):
    """源 60fps → 目标 30fps：按步长抽帧，末帧始终包含。"""
    start, end = float(action.frame_range[0]), float(action.frame_range[1])
    step = max(1, int(round(source_fps / fps)))
    frames = []
    frame = start
    while frame < end - 1e-4:
        frames.append(frame)
        frame += step
    if not frames or abs(frames[-1] - end) > 1e-4:
        frames.append(end)
    return [int(round(value)) if abs(value - round(value)) < 0.01 else value for value in frames]


def round_list(values, digits=9):
    return [round(float(value), digits) for value in values]


def round_quat_xyzw(quat, digits=9):
    """mathutils.Quaternion 迭代顺序 (w,x,y,z) → JSON (x,y,z,w)。"""
    return [
        round(float(quat.x), digits),
        round(float(quat.y), digits),
        round(float(quat.z), digits),
        round(float(quat.w), digits),
    ]


def sample_action(arm, action, face_bones, source_fps, fps):
    reset_pose(arm)
    arm.animation_data_create()
    arm.animation_data.action = action
    animated = action_bones(action)
    bones = [bone.name for bone in face_bones if bone.name in animated]
    scene = bpy.context.scene
    frames = frame_list(action, source_fps, fps)
    face_root = arm.pose.bones["joint_face"]
    data = []
    prev_q = {}
    for source_frame in frames:
        scene.frame_set(int(round(source_frame)))
        bpy.context.view_layer.update()
        rec_q, rec_l, rec_s, rec_h, rec_t = {}, {}, {}, {}, {}
        root_matrix = [round(float(value), 8) for row in face_root.matrix for value in row]
        for name in bones:
            pose_bone = arm.pose.bones[name]
            basis = pose_bone.matrix_basis
            quat = basis.to_quaternion()
            q = [float(quat.x), float(quat.y), float(quat.z), float(quat.w)]
            # 半球连续化（q 与 -q 等价；避免跨帧符号翻转破坏角度序列分析）
            if name in prev_q and sum(a * b for a, b in zip(q, prev_q[name])) < 0:
                q = [-value for value in q]
            prev_q[name] = q
            rec_q[name] = round_list(q)
            rec_l[name] = round_list(basis.to_translation(), 8)
            rec_s[name] = round_list(basis.to_scale(), 8)
            rec_h[name] = round_list(pose_bone.head, 8)
            rec_t[name] = round_list(pose_bone.tail, 8)
        data.append({"f": source_frame, "root": root_matrix, "q": rec_q, "l": rec_l, "s": rec_s, "h": rec_h, "t": rec_t})
    start, end = float(action.frame_range[0]), float(action.frame_range[1])
    return {
        "action": action.name,
        "srcFrames": [start, end],
        "sourceFrames": [frames[0], frames[-1]],
        "sourceFrameCount": int(round(end - start)) + 1,
        "frames": len(data),
        "durationSeconds": round((frames[-1] - frames[0]) / float(source_fps), 6),
        "bones": bones,
        "data": data,
    }


def build_rest(arm, face_bones):
    rest = {}
    for bone in face_bones:
        parent = bone.parent
        local = parent.matrix_local.inverted() @ bone.matrix_local if parent is not None else bone.matrix_local
        rest[bone.name] = {
            "parent": parent.name if parent else None,
            "head": round_list(bone.head_local, 8),
            "tail": round_list(bone.tail_local, 8),
            "length": round(float(bone.length), 8),
            "quatArmature": round_quat_xyzw(bone.matrix_local.to_quaternion()),
            "quatParentRelative": round_quat_xyzw(local.to_quaternion()),
        }
    return rest


def bone_layers(face_bones):
    """按 HSR 游戏脸部层级分组（由 Emo take 的 fcurve 覆盖 + 骨名语义推得）。"""
    names = [bone.name for bone in face_bones]
    brow = sorted(name for name in names if name.startswith(("brow_", "eyebrow_")))
    gaze = sorted(
        name
        for name in names
        if name in ("eye_All_L", "eye_All_R", "eye_L", "eye_R", "eyeEnd_L", "eyeEnd_R", "eyeEnd_01_L", "eyeEnd_01_R", "orbit_L", "orbit_R")
    )
    eye = sorted(
        name
        for name in names
        if name not in gaze
        and name.startswith(("eye", "eyedn", "eyeup", "eyeconner", "socketUpper", "nosemid"))
    )
    mouth = sorted(
        name
        for name in names
        if name
        in (
            "DownTeeth",
            "UpTeeth",
            "JawdnEnd_M",
            "JawupeerEnd_M",
            "chhek_L",
            "chhek_R",
            "lipConner_L",
            "lipConner_R",
            "lipLower_00_L",
            "lipLower_00_R",
            "lipLower_01_L",
            "lipLower_01_R",
            "lipLower_M",
            "lipUpper_00_L",
            "lipUpper_00_R",
            "lipUpper_01_L",
            "lipUpper_01_R",
            "lipUpper_M",
            "mouthLower_M",
            "mouthUpper_01_L",
            "mouthUpper_01_R",
            "mouthUpper_02_L",
            "mouthUpper_02_R",
            "mouthUpper_03_L",
            "mouthUpper_03_R",
            "nosetip_M",
            "tongue_01",
            "tongue_02",
            "tongue_03",
            "tongue_04",
        )
    )
    return {"brow": brow, "eye": eye, "mouth": mouth, "gaze": gaze}


def main():
    args = parse_args()
    started = time.time()
    with open(args["config"], "r", encoding="utf-8") as fh:
        config = json.load(fh)
    sampling = config.get("sampling") or {}
    takes_spec = sampling.get("takes") or []
    if not takes_spec:
        raise SystemExit("config.sampling.takes 为空")
    patch_inbetween_shapes()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(
        filepath=args["fbx"],
        use_anim=True,
        ignore_leaf_bones=False,
        automatic_bone_orientation=False,
        use_custom_props=True,
    )
    import_seconds = time.time() - started
    armatures = [obj for obj in bpy.data.objects if obj.type == "ARMATURE"]
    if len(armatures) != 1:
        raise SystemExit("期望 1 个 armature，实际 %d" % len(armatures))
    arm = armatures[0]
    face_bones = collect_face_bones(arm)
    actions = list(bpy.data.actions)
    os.makedirs(args["out"], exist_ok=True)
    meta = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "blender": bpy.app.version_string,
        "fbx": args["fbx"],
        "importSeconds": round(import_seconds, 2),
        "sourceFps": args["source_fps"],
        "fps": args["fps"],
        "faceBoneCount": len(face_bones),
        "layers": bone_layers(face_bones),
        "rest": build_rest(arm, face_bones),
    }
    takes = {}
    missing = []
    summary = []
    for spec in takes_spec:
        take_id = spec.get("id")
        pattern = spec.get("pattern")
        if not take_id or not pattern:
            raise SystemExit("sampling.takes 条目需要 id/pattern：%r" % (spec,))
        action, candidates = pick_action(actions, pattern)
        if action is None:
            missing.append({"take": take_id, "pattern": pattern})
            print("MISS %-26s pattern=%r" % (take_id, pattern))
            continue
        clip = sample_action(arm, action, face_bones, args["source_fps"], args["fps"])
        clip["take"] = take_id
        clip["pattern"] = pattern
        takes[take_id] = clip
        summary.append(
            {
                "take": take_id,
                "pattern": pattern,
                "action": action.name,
                "sourceFrameSpan": clip["srcFrames"],
                "frames30": clip["frames"],
                "durationSeconds": clip["durationSeconds"],
                "bones": len(clip["bones"]),
                "candidates": [item.name for item in candidates[:5]],
            }
        )
        print(
            "SAMPLED %-26s action=%r src=%s frames30=%d dur=%.3fs bones=%d"
            % (take_id, action.name, clip["srcFrames"], clip["frames"], clip["durationSeconds"], len(clip["bones"]))
        )
    payload = dict(meta)
    payload.update({"schemaVersion": 1, "takes": takes, "missing": missing})
    output_path = os.path.join(args["out"], "emo-face-samples.json")
    with open(output_path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False)
    summary_path = os.path.join(args["out"], "sampling-summary.json")
    with open(summary_path, "w", encoding="utf-8") as fh:
        json.dump({"meta": {key: value for key, value in meta.items() if key != "rest"}, "takes": summary}, fh, ensure_ascii=False, indent=1)
    print("SAMPLE_DONE import=%.1fs takes=%d missing=%d out=%s" % (import_seconds, len(takes), len(missing), output_path))
    if missing:
        raise SystemExit("有 take 未采样到：%r" % (missing,))


main()
