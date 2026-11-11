"""3ds Max Biped FBX 全骨动画采样器（Blender 4.x headless，dev-only）

用途：把用户 Windows 上 3ds Max 2027 批量导出的 Biped FBX（每个 .max 一个 FBX，
Bip2FBX 后骨名 `Bip001 Pelvis / Spine / Spine1 / Spine2 / Neck / Head /
Bip001 L|R Clavicle / UpperArm / Forearm / Hand / Thigh / Calf / Foot / Toe0 /
Finger0..4(各 3 节) / *Nub / Bip001 Footsteps`）按 config 采样为 `samples.json`，
结构与 `scripts/vrm/motion/extract-hsr-anims.py` 的输出**完全一致**，供下游
`retarget-*` 直接消费（rest/children/clips 字段逐项对齐 HSR 管线）。

要点：
- 自动识别源帧率：导入后读 `scene.render.fps/fps_base` 写进 `sourceFps`（支持 30/60），
  输出帧率取 config.fps（默认 30），`step = round(sourceFps/fps)` 降采样；
- 采样**全部**骨骼（不预过滤，含 Nub / 次级骨），rest 用 bind/rest 矩阵（armature 数据空间）；
- `sourceHeightMeters` / `sourceHipsHeightMeters`：先用 armature 物体世界矩阵把世界 +Z
  映回数据空间得到竖直轴（真实 Biped FBX 导入后是 Y-up 数据空间 + 物体 rotX=90°；
  Blender 生成的夹具是 Z-up 数据空间），再取 (head+tail) 跨度 / hips 骨 head 高度；
  hips 骨优先 `*Pelvis`，退化到 `*Hip*` / `*Root*` / 根骨并记 warning；
- 兼容 Tpose（无动画）FBX：`clips` 为空、仍输出 rest，不报错；
- 多 armature / 多对象 / 非 BipXXX 根骨：降级选择 + warnings（stdout + `--report` sidecar）；
- **链接骨归一化**：Blender FBX importer 会在子骨 head 与父骨 tail 重合时标记
  `use_connect=True`，而 connected bone 的 pose location 会被忽略 -> 位置动画丢失
  （夹具实测 Pelvis 位移曲线被吞）。采样前在 edit mode 全部 `use_connect=False` 恢复
  location 曲线的应用；不改变 rest head/矩阵，仅记录数量到报告；
- **对象级动画并集（根运动，方案 A，2026-11-09 rootfix）**：v3 的 3ds Max Biped FBX 把
  「根运动」写进 armature 对象（`Bip001`）自身的 9 条 OBJ 级通道（location/rotation/scale），
  旧采样器只采 `pose_bone.matrix`（armature 数据空间）会全部丢掉。现在逐帧计算
  `D(f) = A0^-1·A(f)`（`A(f)=arm.matrix_world(f)`；**A0 = 该 clip 采样起始帧的对象矩阵**，
  不用 Tpose 基准——各 FBX 首帧对象朝向与 Tpose 有 7–92° 常量差，见 work/adv-biped/rootfix/REPORT.md），
  只取 T/R 丢弃 scale，采样 `B'(f) = D(f)·pose_bone.matrix(f)`。无对象动画 / 对象曲线恒定 /
  父级对象无动画时 D≡I，**完全不施加乘法**，与原行为逐位一致（idle 类微动除外，那是源数据）。
  采样报告里记录每个 clip 的 objectRestDelta / 根旋转/水平/竖直位移幅度，便于回归；
- **Biped 帧范围限定**：Idle_Show_01/02 这类文件的次级骨（*_JNT/面部）曲线长到 365/410 帧，
  而 Biped 骨曲线只有 167 帧；Biped 源（骨架含 `^Bip\\d+` 骨）改用 Biped fcurve keyframe
  范围采样（保留浮点/旧 ceil 语义），避免把动作采成 365/410 帧且 Biped 后段冻结；
  非 Biped 源保持旧行为（action.frame_range）；
- 两种模式：
  `--fbx <file>`    单文件（CLI 主形态）：`--fbx X.fbx --config clips.adv.json --out samples.json`
  `--fbx-dir <dir>` 目录批量（真实 138 文件场景，推荐）：一次 Blender 会话内依次 import
                    每个 FBX，共用一份 rest（校验一致性），每个文件出 1 个（或 config 指定
                    的多个）clip；目录内 `X.fbx` 与 `X_skel.fbx` 成对时默认优先 `_skel`
                    （采样不需要网格，导入更快）。
  `--minimal`：只采 config 列出的 take（加速批量）；默认：config 列出的 take + 其余 take 全采。
  `--take <substr>`：强制 take 匹配串（真实 FBX take 名多半是 `Take 001`，config 的
                    takeMatch=文件名 会匹配不到；此时单 take 文件会自动回退并记 warning）。
  `--report <json>`：写诊断 sidecar（armature 选择/链接骨/帧率/take 映射/warnings）。

用法：
  BLENDER=/Volumes/4TB外置盘/deepseek-harness/tools/blender/Blender.app/Contents/MacOS/Blender
  # 单文件
  "$BLENDER" -b --factory-startup --python scripts/vrm/motion/extract-biped-anims.py -- \\
    --fbx /path/tpose.fbx --config scripts/vrm/motion/clips.adv.json --out tests/tmp/adv-motion/samples.json
  # 目录批量
  "$BLENDER" -b --factory-startup --python scripts/vrm/motion/extract-biped-anims.py -- \\
    --fbx-dir /path/fbx --config scripts/vrm/motion/clips.adv.json \\
    --out tests/tmp/adv-motion/samples.json --minimal --report tests/tmp/adv-motion/samples-report.json

输出 JSON（与 extract-hsr-anims.py 相同；唯一扩展：clip 内 per-clip `sourceFps`，已与 Lead 对齐）：
  { schemaVersion:1, generatedAt, fbx, sourceFps, fps, sourceHeightMeters, sourceHipsHeightMeters,
    rest: { <bone>: { quat:[x,y,z,w], head:[x,y,z], parent } },
    children: { <bone>: [ ... ] },
    clips: { <id>: { action, takeMatch, srcFrames:[start,end], frames, sourceFps, data: [
      { f: srcFrame, q: { <bone>: [x,y,z,w] }, h: { <bone>: [x,y,z] } } ] } } }
  顶层 sourceFps：单文件=检测值；目录批量=各文件检测帧率的最常见值（并列取处理顺序先出现者）。
  per-clip sourceFps：该 clip 源文件实际检测帧率（目录批量混 30/60fps 时下游按 clip 读；
  老 HSR 消费者忽略该字段即可）。目录批量的 rest/children/height 基准优先取 Tpose 文件。
"""
import bpy
import json
import math
from mathutils import Matrix, Vector
import os
import re
import sys
import datetime


# --------------------------------------------------------------------------
# 参数
# --------------------------------------------------------------------------

def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    out = {"fps": None, "minimal": False, "report": None, "take": None, "clip_id": None,
           "source_fps": None, "single_take_fallback": True, "dirs": [], "bone_filter": "auto"}
    i = 0
    while i < len(argv):
        key = argv[i]
        if key in ("--fbx", "--fbx-dir", "--config", "--out", "--report", "--take", "--clip-id") and i + 1 < len(argv):
            slot = key[2:].replace("-", "_")
            if slot == "fbx_dir":
                out["dirs"].append(argv[i + 1])
            else:
                out[slot] = argv[i + 1]
            i += 2
        elif key == "--fps" and i + 1 < len(argv):
            out["fps"] = float(argv[i + 1])
            i += 2
        elif key == "--source-fps" and i + 1 < len(argv):
            out["source_fps"] = float(argv[i + 1])
            i += 2
        elif key == "--bone-filter" and i + 1 < len(argv):
            value = argv[i + 1].strip().lower()
            if value not in ("auto", "biped", "all"):
                raise SystemExit("--bone-filter 只能是 auto|biped|all")
            out["bone_filter"] = value
            i += 2
        elif key == "--minimal":
            out["minimal"] = True
            i += 1
        elif key == "--no-single-take-fallback":
            out["single_take_fallback"] = False
            i += 1
        elif key == "--help" or key == "-h":
            print(__doc__)
            raise SystemExit(0)
        else:
            raise SystemExit("未知参数：%r（--help 查看用法）" % key)
    if "fbx" not in out and not out["dirs"]:
        raise SystemExit("用法：-- --fbx <path> 或 --fbx-dir <dir> [--config ...] --out <samples.json>")
    if "fbx" not in out and out["dirs"]:
        if len(out["dirs"]) > 1:
            raise SystemExit("目录模式只接受一个 --fbx-dir")
        out["fbx_dir"] = out["dirs"][0]
    del out["dirs"]
    if "out" not in out:
        raise SystemExit("缺少 --out <samples.json>")
    return out


# --------------------------------------------------------------------------
# HSR FBX 的 in-between shape keys 补丁（真实数据带模型网格时也复用；对 Biped 无害）
# --------------------------------------------------------------------------

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


# --------------------------------------------------------------------------
# 导入 / armature 选择 / 归一化
# --------------------------------------------------------------------------

def import_fbx(fbx_path):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    try:
        bpy.ops.import_scene.fbx(
            filepath=fbx_path,
            use_anim=True,
            ignore_leaf_bones=False,
            automatic_bone_orientation=False,
            use_custom_props=True,
        )
    except Exception as error:  # noqa: BLE001 - 需要把 import 失败变成可读错误
        raise SystemExit("FBX 导入失败：%s\n  %s: %s" % (fbx_path, type(error).__name__, error))


def unconnect_all(arm):
    """断开所有 use_connect（不改变 rest head/矩阵），返回被断开的骨数。"""
    bpy.context.view_layer.objects.active = arm
    arm.select_set(True)
    if arm.mode != "EDIT":
        bpy.ops.object.mode_set(mode="EDIT")
    changed = 0
    for edit_bone in arm.data.edit_bones:
        if edit_bone.use_connect:
            edit_bone.use_connect = False
            changed += 1
    bpy.ops.object.mode_set(mode="OBJECT")
    return changed


BONE_PATH_RE = re.compile(r'^pose\.bones\["([^"]+)"\]')


def action_belongs_to(action, arm):
    """actions 里也可能混有 mesh/shape-key 的 action：按 fcurve data_path 判断是否属于该 armature。"""
    bone_names = set(arm.data.bones.keys())
    for fcurve in action.fcurves:
        match = BONE_PATH_RE.match(fcurve.data_path)
        if match:
            if match.group(1) not in bone_names:
                return False
            continue
        head = fcurve.data_path.split("[")[0].split(".")[0]
        if head in {
            "location", "rotation_quaternion", "rotation_euler", "rotation_axis_angle",
            "scale", "delta_location", "delta_rotation_euler", "delta_rotation_quaternion",
            "delta_scale",
        }:
            continue
        return False
    return True


def choose_armature(warnings):
    arms = [o for o in bpy.data.objects if o.type == "ARMATURE"]
    if not arms:
        raise SystemExit("FBX 里没有 armature（无法采样）：请确认导出时勾选了骨架/动画。")
    if len(arms) == 1:
        return arms[0]
    scored = []
    for arm in arms:
        action_count = sum(1 for action in bpy.data.actions if action_belongs_to(action, arm))
        scored.append((action_count, len(arm.data.bones), arm.name, arm))
    scored.sort(key=lambda item: (item[0], item[1], item[2]), reverse=True)
    chosen = scored[0][3]
    warnings.append(
        "场景内有 %d 个 armature，已选 %r（骨数 %d，有效 action %d）；其余：%s" % (
            len(arms), chosen.name, len(chosen.data.bones), scored[0][0],
            ", ".join("%s(%d骨)" % (item[3].name, len(item[3].data.bones)) for item in scored[1:])
        ))
    return chosen


# --------------------------------------------------------------------------
# 竖直轴 / 高度
# --------------------------------------------------------------------------

def detect_up_axis(arm, bones, warnings):
    """数据空间竖直轴索引。

    真实 3ds Max Biped 场景的 armature 常常把 Pelvis 放在局部原点（脚下沉到 -0.85），
    因此「hips 局部坐标为正」的旧判据会失败。新判据：
      1) 用 armature 物体世界矩阵把世界 +Z 映回数据空间，按分量绝对值排序候选轴；
      2) 候选轴需满足：骨骼跨度 0.8~3.0，且（脚骨平均位置明显低于 hips，或 hips 本身在 0.2~2.5）；
      3) 都不满足时取跨度最大的轴并记 warning。
    """
    bone_by_name = {bone.name: bone for bone in bones}
    hips_name = find_hips_bone(bones)
    hips = bone_by_name.get(hips_name) if hips_name else None
    up_local = arm.matrix_world.inverted().to_3x3() @ Vector((0.0, 0.0, 1.0))
    order = sorted(range(3), key=lambda index: abs(up_local[index]), reverse=True)
    spans = {}
    for index in range(3):
        values = []
        for bone in bones:
            values.append(bone.head_local[index])
            values.append(bone.tail_local[index])
        spans[index] = max(values) - min(values) if values else 0.0
    foot_names = [b.name for b in bones if re.search(r"foot|toe|ankle", b.name, re.I)]
    for axis in order:
        hips_value = hips.head_local[axis] if hips is not None else 0.0
        foot_avg = None
        if foot_names:
            foot_vals = [bone_by_name[n].head_local[axis] for n in foot_names if n in bone_by_name]
            if foot_vals:
                foot_avg = sum(foot_vals) / len(foot_vals)
        feet_below = foot_avg is not None and foot_avg < hips_value - 0.05
        span_ok = 0.8 <= spans[axis] <= 3.5
        hips_ok = 0.2 <= abs(hips_value) <= 2.5
        if span_ok and (feet_below or hips_ok):
            if not (feet_below or hips_ok):
                pass
            return axis
    axis = max(range(3), key=lambda index: spans[index])
    warnings.append(
        "竖直轴探测不确定（spans=%s），已用最大跨度轴 %s" % (
            {name: round(value, 3) for name, value in spans.items()}, "XYZ"[axis]))
    return axis


def find_hips_bone(bones):
    patterns = (r"pelvis", r"hip", r"root")
    for pattern in patterns:
        for bone in bones:
            if re.search(pattern, bone.name, re.IGNORECASE):
                return bone.name
    roots = [bone.name for bone in bones if bone.parent is None]
    return roots[0] if roots else (bones[0].name if bones else None)


def compute_heights(arm, bones, warnings):
    """返回 (up_axis, hips_name, source_height, source_hips_height)。

    - 地面 = 脚/脚趾/踝骨的最低点（无脚骨时退回全部骨骼最低点）；
    - hips 高度 = hips.head_local 到地面的竖直距离（真实 Biped 场景 Pelvis 常在 0，
      地面在 -0.85，绝不能直接用 hips 坐标当高度）；
    - 角色高度 = 全部采样骨最高点到地面。
    """
    up_axis = detect_up_axis(arm, bones, warnings)
    ground_values = []
    for bone in bones:
        if re.search(r"foot|toe|ankle", bone.name, re.I):
            ground_values.append(bone.head_local[up_axis])
            ground_values.append(bone.tail_local[up_axis])
    ground = min(ground_values) if ground_values else None
    all_values = []
    for bone in bones:
        all_values.append(bone.head_local[up_axis])
        all_values.append(bone.tail_local[up_axis])
    if ground is None:
        ground = min(all_values)
    height = round(max(all_values) - ground, 6)
    hips_name = find_hips_bone(bones)
    bone_by_name = {bone.name: bone for bone in bones}
    hips_height = 0.0
    if hips_name and hips_name in bone_by_name:
        hips_height = round(bone_by_name[hips_name].head_local[up_axis] - ground, 6)
        if hips_height < 0:
            warnings.append(
                "hips 高度为负（%.4f）：Pelvis 低于脚骨？请核对骨架" % hips_height)
    else:
        warnings.append("未找到 hips 骨，hips 高度按 0 处理")
    return up_axis, hips_name, height, hips_height


def select_source_bones(all_bones, mode, warnings):
    """选择要采样的源骨。

    auto（默认）：若存在 >=20 根 `Bip<数字>*` 骨（3ds Max Biped 命名），只采这些骨
    （+ 它们的 Nub），把 267 根头发/衣摆 `_JNT` 次级骨排除——目标 VRM 用 SpringBone
    物理驱动次级链，采样它们只会让 samples.json 膨胀 ~5 倍且对重定向无用；
    非 Biped 命名骨架（HSR 原始 FBX 等）自动退回全骨采样，保持旧行为。
    """
    if mode == "all":
        return list(all_bones)
    biped = [bone for bone in all_bones if re.match(r"^Bip\d+", bone.name)]
    if mode == "biped" or (mode == "auto" and len(biped) >= 20):
        if not biped:
            warnings.append("--bone-filter=biped 但骨架没有 Bip<N> 命名骨，退回全骨采样")
            return list(all_bones)
        return biped
    return list(all_bones)


# --------------------------------------------------------------------------
# 对象级动画（3ds Max Biped 根运动写在 armature 对象 Bip001 上）/ Biped 帧范围
# --------------------------------------------------------------------------

OBJECT_TRANSFORM_HEADS = {
    "location", "rotation_quaternion", "rotation_euler", "rotation_axis_angle",
    "scale", "delta_location", "delta_rotation_euler", "delta_rotation_quaternion",
    "delta_scale",
}
# 对象曲线数值变化小于该阈值 -> 视为「没有对象动画」（例如 Tpose 的恒定 9 通道），
# 此时采样完全不施加 D，保证与原 baseline 逐位一致。
OBJECT_ANIM_EPSILON = 1e-9


def object_animation_fcurves(action):
    """action 里作用于 armature 对象本身（非 pose bone）的 fcurve 列表。"""
    curves = []
    for fcurve in action.fcurves:
        path = fcurve.data_path
        if path.startswith("pose.bones["):
            continue
        head = path.split("[")[0].split(".")[0]
        if head in OBJECT_TRANSFORM_HEADS:
            curves.append(fcurve)
    return curves


def fcurve_value_span(fcurve):
    points = fcurve.keyframe_points
    if not points:
        return 0.0
    values = [point.co[1] for point in points]
    return max(values) - min(values)


def varying_object_curves(action):
    return [
        fcurve for fcurve in object_animation_fcurves(action)
        if fcurve_value_span(fcurve) > OBJECT_ANIM_EPSILON
    ]


def action_object_animation_curves(action, arm):
    """该 action 中「属于当前 armature 对象」的对象级动画曲线。

    FBX importer 的 action 名形如 `<object>|Take 001|BaseLayer`。pilot 文件的 actions 里还会
    混有 `Bip001 Footsteps|...` / `Root|...` 这类属于其它对象的空壳 take，它们的对象级曲线
    不是本 armature 的根运动；smoke 实测若误并入会给这些空壳 clip 注入假根运动。
    """
    owner = action.name.split("|")[0].strip()
    if owner and owner != arm.name and owner in bpy.data.objects:
        return []
    return object_animation_fcurves(action)


def parent_object_has_varying_animation(arm):
    """armature 的父级对象链（3ds Max 导出常见 Root 空物体）是否带变化对象动画。

    pilot 实测 Root 空物体的 9 条曲线是常量（maxValueRange=0），这里做通用兜底：
    若父级对象动画有变化，arm.matrix_world 已包含它，方案 A 会自然并入根运动。
    """
    parent = arm.parent
    while parent is not None:
        animation = parent.animation_data
        if animation is not None and animation.action is not None:
            for fcurve in animation.action.fcurves:
                head = fcurve.data_path.split("[")[0].split(".")[0]
                if head in OBJECT_TRANSFORM_HEADS and fcurve_value_span(fcurve) > OBJECT_ANIM_EPSILON:
                    return True
        parent = parent.parent
    return False


def biped_fcurve_frame_range(action):
    """Biped 骨（^Bip\\d+）fcurve 的关键帧范围；没有 Biped 骨曲线时返回 None。

    Idle_Show_01/02 的次级骨（*_JNT/面部）曲线到 565/655 keys（365/410 帧），而 Biped 骨
    曲线只有 167 keys（1..167）；直接用 action.frame_range 会把 clip 采成 365/410 帧且
    Biped 后段冻结。范围保留浮点（与 action.frame_range 同语义，不额外 ceil/floor）。
    """
    start = None
    end = None
    for fcurve in action.fcurves:
        path = fcurve.data_path
        if not path.startswith("pose.bones["):
            continue
        bone = path.split('"')[1] if '"' in path else ""
        if not re.match(r"^Bip\d+", bone):
            continue
        for point in fcurve.keyframe_points:
            frame = point.co[0]
            if start is None or frame < start:
                start = frame
            if end is None or frame > end:
                end = frame
    if start is None or end is None:
        return None
    return start, end


def capture_object_rest(arm):
    """armature 对象的导入时变换快照（每 clip 前恢复，避免上一 clip 的对象动画残留）。"""
    return {
        "location": list(arm.location),
        "rotation_mode": arm.rotation_mode,
        "rotation_euler": list(arm.rotation_euler),
        "rotation_quaternion": list(arm.rotation_quaternion),
        "scale": list(arm.scale),
        "matrix_world": [list(row) for row in arm.matrix_world],
    }


def matrix_rotation_angle_deg(matrix):
    """矩阵旋转部分的角度（度，0..180）。"""
    quat = matrix.to_quaternion()
    return 2.0 * math.degrees(math.acos(min(1.0, abs(quat.w))))


def object_delta_rigid(rest_matrix, current_matrix):
    """方案 A 的对象动画增量 D = A_rest^-1·A(f)，只保留旋转+平移（丢弃 scale）。

    保持 armature 数据空间单位：A_rest 的 Root 0.01 缩放会被求逆抵消，D 的平移直接是
    数据空间位移（与骨骼 head 同单位），左乘 pose_bone.matrix 即可并入根运动。
    """
    delta = rest_matrix.inverted() @ current_matrix
    rotation = delta.to_quaternion().to_matrix().to_4x4()
    return Matrix.Translation(delta.to_translation()) @ rotation


# --------------------------------------------------------------------------
# 多帧尖峰净化（源 FBX 烘焙/quaternion 异常；全量首跑 2026-11-09 暴露）
# --------------------------------------------------------------------------
# 保守判据（阈值即设计常量）：
#   基线帧 i 之后出现 1–3 帧窗口，窗口内每帧相对 i 帧偏离 > SPIKE_DEPART_DEG，
#   且窗口结束后的回归帧与 i 帧差 < SPIKE_RETURN_DEG（离开又原样回来）。
# 真实快动作不会在 1–3 帧内回到原值，因此不会误伤；pilot 5 clip 实测零触发。
# 只在「对象级根运动并入之前」的骨骼绝对姿态轨迹上判定，避免大根旋转 clip
# （如 FastRun_TurnRight_L，root 旋转 167°）把根旋转误当尖峰/掩盖真实尖峰。
SPIKE_DEPART_DEG = 40.0
SPIKE_RETURN_DEG = 15.0
SPIKE_MAX_WINDOW = 3


def quat_angle_deg(quat_a, quat_b):
    dot = min(1.0, abs(quat_a.dot(quat_b)))
    return 2.0 * math.degrees(math.acos(dot))


def sanitize_bone_spikes(clip_id, bones, frame_numbers, quats_by_bone, heads_by_bone):
    """就地净化每根骨的多帧尖峰；返回修正明细（clip/bone/帧/偏离角/回归角）。

    窗口内旋转用 slerp(基线帧, 回归帧) 重建、head 用线性插值重建；基线帧/回归帧不动。
    """
    corrections = []
    for bone in bones:
        name = bone.name
        quats = quats_by_bone.get(name)
        heads = heads_by_bone.get(name)
        if not quats or not heads:
            continue
        count = len(quats)
        index = 0
        while index < count:
            matched = None
            for window in range(1, SPIKE_MAX_WINDOW + 1):
                return_index = index + window + 1
                if return_index >= count:
                    break
                return_deg = quat_angle_deg(quats[index], quats[return_index])
                if return_deg >= SPIKE_RETURN_DEG:
                    continue
                deviation_deg = 0.0
                window_ok = True
                for offset in range(index + 1, index + window + 1):
                    deviation = quat_angle_deg(quats[offset], quats[index])
                    deviation_deg = max(deviation_deg, deviation)
                    if deviation <= SPIKE_DEPART_DEG:
                        window_ok = False
                        break
                if window_ok:
                    matched = (window, return_index, return_deg, deviation_deg)
                    break
            if matched is None:
                index += 1
                continue
            window, return_index, return_deg, deviation_deg = matched
            start_quat = quats[index].copy()
            end_quat = quats[return_index].copy()
            if start_quat.dot(end_quat) < 0.0:
                end_quat.negate()
            start_head = heads[index].copy()
            end_head = heads[return_index].copy()
            window_frames = []
            span = float(return_index - index)
            for offset in range(index + 1, return_index):
                factor = float(offset - index) / span
                quat = start_quat.copy()
                quat.slerp(end_quat, factor)
                quat.normalize()
                quats[offset] = quat
                heads[offset] = start_head + (end_head - start_head) * factor
                window_frames.append(float(frame_numbers[offset]))
            corrections.append({
                "bone": name,
                "startFrame": float(frame_numbers[index]),
                "windowFrames": window_frames,
                "windowFrameIndices": list(range(index + 1, return_index)),
                "returnFrame": float(frame_numbers[return_index]),
                "windowLen": window,
                "deviationDeg": round(deviation_deg, 2),
                "returnDeg": round(return_deg, 2),
            })
            index = return_index
    return corrections


# --------------------------------------------------------------------------
# 采样
# --------------------------------------------------------------------------

def sample_action(arm, action, bones, clip_id, take_match, loop, source_fps, out_fps,
                  object_rest=None, up_axis=None, up_direction=None, biped_source=False,
                  basis_reference=None, source_root_motion=None):
    """采样一个 action，返回 (clip, analysis)。

    对象级动画（方案 A，docs/pilot-v3-comparison-2026-11-09 §5.3）：每 clip 以采样起始帧的
    对象矩阵 A0 为基准（不用 Tpose 基准——各 FBX 首帧对象朝向与 Tpose 有 7–92° 常量差），
    D(f) = A0^-1·A(f) 只取 T/R（丢弃 scale），B'(f) = D(f)·pose_bone.matrix(f)。
    没有对象动画（曲线恒定/无曲线/父级无动画）时 D 完全不施加，与旧行为逐位一致。

    source_root_motion="ignore"（config clip.sourceRootMotion）：该 clip 不施加对象级根运动
    （D≡I），只把实测幅度记录到 objectAnimation.ignoredRootMotion；用于影视化 staging 技能
    （切镜跳变）的源，不做全局启发式自动忽略。
    """
    step = int(round(source_fps / out_fps))
    if step < 1:
        step = 1
    scene = bpy.context.scene
    arm.animation_data_create()
    arm.animation_data.action = None
    # 恢复 armature 对象 rest 变换（避免上一 clip 的对象动画残留），再清 pose 残值
    if object_rest:
        arm.location = object_rest["location"]
        arm.rotation_mode = object_rest["rotation_mode"]
        arm.rotation_euler = object_rest["rotation_euler"]
        arm.rotation_quaternion = object_rest["rotation_quaternion"]
        arm.scale = object_rest["scale"]
    for pose_bone in arm.pose.bones:
        pose_bone.rotation_mode = "QUATERNION"
        pose_bone.rotation_quaternion = (1.0, 0.0, 0.0, 0.0)
        pose_bone.location = (0.0, 0.0, 0.0)
        pose_bone.scale = (1.0, 1.0, 1.0)
    arm.animation_data.action = action

    # ---- 帧范围：Biped 源按 Biped 骨 fcurve 关键帧范围裁剪（Idle_Show_01/02 修正）----
    action_start, action_end = action.frame_range
    start, end = action_start, action_end
    range_source = "action"
    if biped_source:
        biped_range = biped_fcurve_frame_range(action)
        if biped_range is not None:
            start, end = biped_range
            range_source = "biped-curves"
    span = end - start
    base_count = int(math.floor(span / step)) + 1
    frame_numbers = [start + i * step for i in range(base_count)]
    if not loop and frame_numbers[-1] < end - 1e-6:
        frame_numbers.append(end)

    # ---- 对象级动画检测（根运动）----
    object_curves = action_object_animation_curves(action, arm)
    varying_curves = [
        fcurve for fcurve in object_curves
        if fcurve_value_span(fcurve) > OBJECT_ANIM_EPSILON
    ]
    parent_animated = parent_object_has_varying_animation(arm)
    object_anim_active = bool(varying_curves) or parent_animated
    ignore_root_motion = str(source_root_motion or "").strip().lower() == "ignore"
    apply_root_motion = object_anim_active and not ignore_root_motion
    if object_anim_active:
        # 让 Blender 按实际烘焙的属性类型求值（Biped 是 euler，保险兼容 quaternion）
        paths = {fcurve.data_path for fcurve in object_curves}
        if "rotation_quaternion" in paths:
            arm.rotation_mode = "QUATERNION"
        elif "rotation_euler" in paths and arm.rotation_mode == "QUATERNION":
            arm.rotation_mode = "XYZ"
    A_start = None
    if object_anim_active:
        scene.frame_set(int(round(start)))
        bpy.context.view_layer.update()
        A_start = arm.matrix_world.copy()

    up_vector = None
    if up_direction is not None:
        up_vector = Vector(up_direction)
        if up_vector.length > 1e-9:
            up_vector.normalize()
    measured_motion = {
        "rotationDegMax": 0.0,
        "translationMaxMeters": 0.0,
        "horizontalMaxMeters": 0.0,
        "verticalMinMeters": 0.0,
        "verticalMaxMeters": 0.0,
        "verticalRangeMeters": 0.0,
        "endRotationDeg": 0.0,
        "endTranslationMeters": 0.0,
    }
    vertical_values = []

    # ---- 逐帧采集「根运动并入前」的骨骼绝对姿态（尖峰净化在这一层做）----
    # raw_matrices 保留原始 pose_bone.matrix：无修正的 clip/骨走与 task-2 完全相同的计算路径，
    # 保证「无尖峰 / 无 ignore」时逐字节复现（浮点运算顺序不变）。
    raw_matrices = {bone.name: [] for bone in bones}
    raw_quats = {bone.name: [] for bone in bones}
    raw_heads = {bone.name: [] for bone in bones}
    deltas = []
    for src_frame in frame_numbers:
        scene.frame_set(int(round(src_frame)))
        bpy.context.view_layer.update()
        delta = None
        if object_anim_active:
            delta = object_delta_rigid(A_start, arm.matrix_world)
            translation = delta.to_translation()
            measured_motion["rotationDegMax"] = max(
                measured_motion["rotationDegMax"], matrix_rotation_angle_deg(delta))
            measured_motion["translationMaxMeters"] = max(
                measured_motion["translationMaxMeters"], translation.length)
            if up_vector is not None:
                vertical = translation.dot(up_vector)
                horizontal = math.sqrt(max(0.0, translation.length ** 2 - vertical * vertical))
            elif up_axis is not None:
                vertical = translation[up_axis]
                horizontal = math.sqrt(sum(
                    translation[index] ** 2 for index in range(3) if index != up_axis))
            else:
                vertical = 0.0
                horizontal = translation.length
            measured_motion["horizontalMaxMeters"] = max(
                measured_motion["horizontalMaxMeters"], horizontal)
            vertical_values.append(vertical)
        deltas.append(delta if apply_root_motion else None)
        for bone in bones:
            matrix = arm.pose.bones[bone.name].matrix
            raw_matrices[bone.name].append(matrix.copy())
            raw_quats[bone.name].append(matrix.to_quaternion().copy())
            raw_heads[bone.name].append(matrix.translation.copy())

    # ---- 多帧尖峰净化（在根运动并入之前；见 sanitize_bone_spikes 注释）----
    spike_corrections = sanitize_bone_spikes(
        clip_id, bones, frame_numbers, raw_quats, raw_heads)

    corrected_cells = {
        (item["bone"], index)
        for item in spike_corrections
        for index in item["windowFrameIndices"]
    }
    frames = []
    for index, src_frame in enumerate(frame_numbers):
        delta = deltas[index]
        quats = {}
        heads = {}
        for bone in bones:
            name = bone.name
            if (name, index) in corrected_cells:
                quat = raw_quats[name][index]
                head = raw_heads[name][index]
                matrix = Matrix.Translation(head) @ quat.to_matrix().to_4x4()
            else:
                # 保持与 task-2 完全相同的路径/浮点顺序（逐字节回归一致）
                matrix = raw_matrices[name][index]
            if delta is not None:
                matrix = delta @ matrix
            quat = matrix.to_quaternion()
            quats[name] = [round(quat.x, 9), round(quat.y, 9), round(quat.z, 9), round(quat.w, 9)]
            heads[name] = [round(value, 7) for value in matrix.translation]
        frames.append({"f": float(src_frame), "q": quats, "h": heads})

    # ---- 根运动报告：ignored clip 的 rootMotion 报 0（未施加），实测值单独留痕 ----
    if object_anim_active:
        end_delta = object_delta_rigid(A_start, arm.matrix_world)
        measured_motion["endRotationDeg"] = round(matrix_rotation_angle_deg(end_delta), 4)
        measured_motion["endTranslationMeters"] = round(end_delta.to_translation().length, 6)
        if vertical_values:
            measured_motion["verticalMinMeters"] = round(min(vertical_values), 6)
            measured_motion["verticalMaxMeters"] = round(max(vertical_values), 6)
            measured_motion["verticalRangeMeters"] = round(
                max(vertical_values) - min(vertical_values), 6)
        for key in ("rotationDegMax", "translationMaxMeters", "horizontalMaxMeters"):
            measured_motion[key] = round(measured_motion[key], 6)
    ignored_motion = measured_motion if (ignore_root_motion and object_anim_active) else None
    if ignore_root_motion:
        # 契约：ignore clip 的 rootMotion（施加值）全 0；实测值在 ignoredRootMotion。
        root_motion = {key: 0.0 for key in measured_motion}
    elif object_anim_active:
        root_motion = measured_motion
    else:
        root_motion = None

    tpose_basis = None
    import_residual = None
    if object_anim_active:
        if basis_reference is not None:
            basis_delta = basis_reference.inverted() @ A_start
            tpose_basis = {
                "rotationDeg": round(matrix_rotation_angle_deg(basis_delta), 4),
                "translationMeters": round(basis_delta.to_translation().length, 6),
            }
        if object_rest:
            import_delta = Matrix(object_rest["matrix_world"]).inverted() @ A_start
            import_residual = {
                "rotationDeg": round(matrix_rotation_angle_deg(import_delta), 6),
                "translationMeters": round(import_delta.to_translation().length, 8),
            }

    spike_cleanup = {
        "applied": bool(spike_corrections),
        "constants": {
            "departDeg": SPIKE_DEPART_DEG,
            "returnDeg": SPIKE_RETURN_DEG,
            "maxWindowFrames": SPIKE_MAX_WINDOW,
            "phase": "pre-root-motion（骨骼绝对姿态，根运动并入前）",
        },
        "correctedFrameCount": len(spike_corrections),
        "correctedBoneCount": len({item["bone"] for item in spike_corrections}),
        "corrections": spike_corrections,
    }
    analysis = {
        "clip": clip_id,
        "rangeSource": range_source,
        "actionFrameRange": [round(action_start, 4), round(action_end, 4)],
        "frameRange": [round(start, 4), round(end, 4)],
        "sampledFrames": len(frames),
        "objectAnimation": {
            "active": object_anim_active,
            "basis": "clip-start-frame",
            "scaleStripped": True,
            "rootMotionMode": (
                "ignore" if ignore_root_motion else ("merge" if object_anim_active else "none")),
            "ignored": ignore_root_motion,
            "ignoreReason": (
                'config.sourceRootMotion="ignore"' if ignore_root_motion else None),
            "ignoredRootMotion": ignored_motion,
            "curveCount": len(object_curves),
            "varyingCurveCount": len(varying_curves),
            "curvePaths": sorted({
                "%s[%d]" % (fcurve.data_path, fcurve.array_index) for fcurve in object_curves
            }),
            "parentObjectAnimated": parent_animated,
            "importBasisResidual": import_residual,
            "tposeBasisDelta": tpose_basis,
        },
        "rootMotion": root_motion,
        "spikeCleanup": spike_cleanup,
    }
    clip = {
        "action": action.name,
        "takeMatch": take_match,
        "srcFrames": [float(start), float(end)],
        "frames": len(frames),
        # per-clip 源帧率（Lead 指示扩展；目录批量混 30/60fps 时下游按 clip 读）。
        # 顶层 samples.sourceFps 仍保留单值（目录模式取最常见值），HSR 老消费者可忽略本字段。
        "sourceFps": source_fps,
        "data": frames,
    }
    return clip, analysis


# --------------------------------------------------------------------------
# config / take 选择
# --------------------------------------------------------------------------

def short_action_name(action_name):
    """FBX importer 会给 action 加 "Object|" 前缀；取最后一段。"""
    return action_name.split("|")[-1].strip()


def sanitize_id(name):
    cleaned = re.sub(r"[^0-9A-Za-z_.\-]+", "_", short_action_name(name)).strip("_")
    return cleaned or "clip"


def action_frame_count(action):
    start, end = action.frame_range
    return int(round(end - start)) + 1


def match_action(actions, token, expected_frames=None, match_mode="substring"):
    token = token.strip()
    if not token:
        return []
    if match_mode == "exact":
        # clips.adv.json 的 matchMode=exact：action 短名或全名精确相等，不做子串匹配
        candidates = [
            action for action in actions
            if short_action_name(action.name).lower() == token.lower()
        ]
        if not candidates:
            return []
    else:
        candidates = [action for action in actions if token in action.name]
        if not candidates:
            # 大小写不敏感兜底（真实 take 名/文件名大小写混用）
            lowered = token.lower()
            candidates = [action for action in actions if lowered in action.name.lower()]
    if expected_frames:
        candidates.sort(key=lambda action: abs(action_frame_count(action) - int(expected_frames)))
    else:
        candidates.sort(key=lambda action: (len(action.name), action.name))
    return candidates


class ClipPlan(object):
    def __init__(self, clip_id, take_match, loop, take_override=None, expected_frames=None,
                 match_mode="substring", source_root_motion=None):
        self.id = clip_id
        self.take_match = take_match
        self.loop = loop
        self.take_override = take_override
        self.expected_frames = expected_frames
        self.match_mode = match_mode
        # 可选 per-clip 根运动策略：目前只有 "ignore"（影视化 staging 技能，完全忽略对象级根运动）
        self.source_root_motion = source_root_motion


def resolve_clip_plan(actions, plan, warnings, allow_single_fallback, expected_frames=None):
    token = plan.take_override or plan.take_match or ""
    candidates = match_action(actions, token, expected_frames, plan.match_mode)
    if candidates:
        chosen = candidates[0]
        if len(candidates) > 1:
            warnings.append("clip %r: takeMatch %r 命中 %d 个 action，已选 %r（%d 帧）；其余：%s" % (
                plan.id, token, len(candidates), chosen.name, action_frame_count(chosen),
                [action.name for action in candidates[1:4]]))
        return chosen
    if len(actions) == 1 and allow_single_fallback:
        chosen = actions[0]
        warnings.append(
            "clip %r: takeMatch %r 未命中（FBX 只有 1 个 take），已回退到 %r —— 真实 FBX take 名"
            "通常是 Take 001，可用 config takeMatch=文件名 或 --take 显式指定。" % (
                plan.id, token, chosen.name))
        return chosen
    if not actions:
        warnings.append("clip %r: FBX 中没有任何可用 action（Tpose/纯骨架 FBX）" % plan.id)
        return None
    # 真实 3ds Max（BakeAnimation + Bip2FBX）导出的 FBX 里，主骨架 take 往往伴随一个
    # 极小的 "Root|Take 001"（9 fcurves）之类的次级 take。把这类空壳 take 当噪声过滤：
    # 若过滤后只剩 1 个「实质 action」，直接回退并记录 warning（take 名通常是 Take 001）。
    if allow_single_fallback:
        substantive = [action for action in actions if len(action.fcurves) >= 100]
        if len(substantive) == 1:
            chosen = substantive[0]
            noise = [action for action in actions if action is not chosen]
            warnings.append(
                "clip %r: takeMatch %r 未命中；已过滤 %d 个空/次级 take（%s），回退到唯一实质 action %r"
                "（%d fcurves, %d 帧）" % (
                    plan.id, token, len(noise), [action.name for action in noise[:4]],
                    chosen.name, len(chosen.fcurves), action_frame_count(chosen)))
            return chosen
    raise SystemExit("clip %r: takeMatch %r 未命中，且 FBX 有 %d 个 take：%s（用 --take 或单 take 文件）" % (
        plan.id, token, len(actions),
        [(action.name, len(action.fcurves)) for action in actions[:10]]))


# --------------------------------------------------------------------------
# 单文件 / 目录批量
# --------------------------------------------------------------------------

def list_dir_fbx(dir_path):
    names = sorted(
        name for name in os.listdir(dir_path)
        if name.lower().endswith(".fbx") and not name.startswith(".")
    )
    if not names:
        raise SystemExit("目录内没有 .fbx：%s" % dir_path)
    # X.fbx / X_skel.fbx 成对时优先 _skel（采样不需要网格，小文件导入快）
    groups = {}
    for name in names:
        stem = os.path.splitext(name)[0]
        base = re.sub(r"_skel$", "", stem, flags=re.IGNORECASE)
        groups.setdefault(base, []).append(name)
    selected = []
    skipped = []
    for base, group in sorted(groups.items()):
        if len(group) == 1:
            selected.append(group[0])
            continue
        skel = [name for name in group if re.search(r"_skel$", os.path.splitext(name)[0], re.IGNORECASE)]
        if skel:
            selected.append(skel[0])
            skipped.extend([name for name in group if name != skel[0]])
        else:
            selected.append(group[0])
            skipped.extend(group[1:])
    return selected, skipped


def derive_dir_plans(config_clips, filename, take_override, default_loop, match_mode="substring"):
    """目录模式：按 clip.file / clip.takeMatch 匹配文件名，生成该文件的 clip 计划。"""
    stem = os.path.splitext(filename)[0]
    base = re.sub(r"_skel$", "", stem, flags=re.IGNORECASE).lower()
    plans = []
    for clip in config_clips:
        file_field = clip.get("file")
        if file_field:
            # 有 file 字段时**只按精确 basename 匹配**（避免 StandBy (2).fbx 类复本被
            # StandBy 的 takeMatch 子串误命中，导致白采一份且时长可能不同）
            file_base = re.sub(r"_skel$", "", os.path.splitext(os.path.basename(file_field))[0],
                               flags=re.IGNORECASE).lower()
            matched = file_base == base
            if not matched:
                continue
        else:
            token = clip.get("takeMatch") or clip.get("take") or ""
            matched = bool(token) and token.lower() in base
            if not matched:
                continue
        plans.append(ClipPlan(
            clip_id=clip["id"],
            take_match=clip.get("takeMatch") or clip.get("take") or "",
            loop=bool(clip.get("loop", default_loop)),
            take_override=take_override,
            expected_frames=clip.get("srcFrames"),
            match_mode=match_mode,
            source_root_motion=clip.get("sourceRootMotion"),
        ))
    return plans


def load_config(config_path):
    if not config_path:
        return {}
    with open(config_path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def collect_scene_facts(arm, warnings, bones=None):
    """rest/children/高度/源帧率/nm 的公共采集。bones 可按 --bone-filter 过滤。"""
    bones = list(bones) if bones is not None else list(arm.data.bones)
    rest = {}
    children = {bone.name: [] for bone in bones}
    hips_name = find_hips_bone(bones)
    for bone in bones:
        matrix = bone.matrix_local
        quat = matrix.to_quaternion()
        rest[bone.name] = {
            "quat": [round(quat.x, 9), round(quat.y, 9), round(quat.z, 9), round(quat.w, 9)],
            "head": [round(value, 8) for value in matrix.translation],
            "parent": bone.parent.name if bone.parent else None,
        }
        if bone.parent:
            children[bone.parent.name].append(bone.name)
    up_axis, hips_name, height, hips_height = compute_heights(arm, bones, warnings)
    # 对象动画（根运动）竖直分解用的「世界 +Z 在 armature 数据空间中的方向」；
    # 各文件 armature 对象的常量朝向不同（与 Tpose 差 7–92°），但数据空间中的物理竖直
    # 方向由该文件对象矩阵唯一确定，所以必须逐文件算。
    up_direction = arm.matrix_world.inverted().to_3x3() @ Vector((0.0, 0.0, 1.0))
    if up_direction.length > 1e-9:
        up_direction.normalize()
    else:
        up_direction = Vector((0.0, 0.0, 1.0))
    return {
        "bones": bones,
        "rest": rest,
        "children": children,
        "hips_name": hips_name,
        "up_axis": up_axis,
        "up_direction": [round(value, 9) for value in up_direction],
        "source_height": height,
        "source_hips_height": hips_height,
    }


def rest_diff_max(rest_a, rest_b):
    """两份 rest 的最大绝对差（quat/head），用于校验目录批量里各 FBX 的骨架一致性。"""
    if list(rest_a.keys()) != list(rest_b.keys()):
        return float("inf")
    max_diff = 0.0
    for name in rest_a:
        for key in ("quat", "head"):
            for value_a, value_b in zip(rest_a[name][key], rest_b[name][key]):
                max_diff = max(max_diff, abs(value_a - value_b))
    return max_diff


def _print_object_anim(clip_id, analysis):
    """打印单个 clip 的根运动 / 忽略 / 尖峰净化状态（回归看这几行）。"""
    info = analysis["objectAnimation"]
    motion = analysis["rootMotion"]
    spike = analysis.get("spikeCleanup") or {}
    if info.get("ignored"):
        ignored = info.get("ignoredRootMotion") or {}
        print("  ROOT_IGNORE %-20s config.sourceRootMotion=ignore（D≡I，rootMotion 报 0；"
              "实测 rot=%.2f° trans=%.4fm 仅留痕）" % (
                  clip_id, ignored.get("rotationDegMax", 0.0),
                  ignored.get("translationMaxMeters", 0.0)))
    elif not info["active"] or motion is None:
        print("  OBJECT_ANIM %-20s inactive（无变化对象动画；D≡I，与旧采样一致）" % clip_id)
    else:
        basis = info.get("tposeBasisDelta")
        print("  OBJECT_ANIM %-20s rot=%7.2f° trans=%7.4fm horiz=%7.4fm "
              "vert=%+7.4f..%+7.4f (range %.4fm) curves=%d/varying=%d%s" % (
                  clip_id, motion["rotationDegMax"], motion["translationMaxMeters"],
                  motion["horizontalMaxMeters"], motion["verticalMinMeters"],
                  motion["verticalMaxMeters"], motion["verticalRangeMeters"],
                  info["curveCount"], info["varyingCurveCount"],
                  ("" if basis is None else " | D0_vs_tpose=%.2f°/%.4fm" % (
                      basis["rotationDeg"], basis["translationMeters"]))))
    if spike.get("applied"):
        examples = ", ".join(
            "%s@%s" % (item["bone"], "/".join("%g" % frame for frame in item["windowFrames"]))
            for item in spike["corrections"][:3])
        print("  SPIKE_CLEAN %-20s 修正 %d 帧 / %d 骨（%s%s）" % (
            clip_id, spike["correctedFrameCount"], spike["correctedBoneCount"], examples,
            "…" if spike["correctedFrameCount"] > 3 else ""))


def summarize_object_animation(files):
    """把每文件 facts 里的对象动画/根运动信息汇总进采样报告（不影响 samples schema）。"""
    source = {}
    clips = {}
    for facts in files:
        info = facts.get("objectAnimation") or {}
        file_clips = info.get("clips") or {}
        if file_clips:
            source[facts.get("file")] = {
                "bipedSource": info.get("bipedSource"),
                "objectRestDelta": facts.get("objectRestDelta"),
            }
        for clip_id, analysis in file_clips.items():
            clips[clip_id] = {
                "file": facts.get("file"),
                "rangeSource": analysis.get("rangeSource"),
                "actionFrameRange": analysis.get("actionFrameRange"),
                "frameRange": analysis.get("frameRange"),
                "sampledFrames": analysis.get("sampledFrames"),
                "objectAnimation": analysis.get("objectAnimation"),
                "rootMotion": analysis.get("rootMotion"),
                "spikeCleanup": analysis.get("spikeCleanup"),
            }
    return {
        "basis": "clip-start-frame",
        "note": ("方案 A 根运动并集（docs/pilot-v3-comparison-2026-11-09 §5.3）："
                 "A(f)=arm.matrix_world(f)，D(f)=A0^-1·A(f) 只取旋转+平移，采样 "
                 "B'(f)=D(f)·pose_bone.matrix(f)。A0=该 clip 采样起始帧的对象矩阵，"
                 "不用 Tpose（各文件首帧对象朝向与 Tpose 有 7–92° 常量差）。"),
        "files": source,
        "clips": clips,
    }


def process_file(fbx_path, config, args, plans=None, basis_reference=None):
    """导入单个 FBX，返回 {facts, clips, warnings}。plans 为 None 时用 config 生成（单文件模式）。

    basis_reference: 目录模式下 Tpose 文件的 armature 对象矩阵（Matrix），只用于在报告里
    记录「各 clip 首帧对象矩阵与 Tpose 基准的常量差」，**不参与采样**（方案 A 用 clip 首帧基准）。
    """
    warnings = []
    import_fbx(fbx_path)
    arm = choose_armature(warnings)
    unconnected = unconnect_all(arm)
    object_rest = capture_object_rest(arm)
    if unconnected:
        warnings.append("链接骨归一化：断开 %d 根 use_connect（否则 location 动画会被 Blender 忽略）" % unconnected)
    all_bones = list(arm.data.bones)
    has_biped = any(re.match(r"^Bip\d+", bone.name) for bone in all_bones)
    # Biped 源：帧范围按 Biped 骨 fcurve 裁剪（Idle_Show 次级骨曲线更长）+ 对象动画并集
    biped_source = has_biped
    source_bones = select_source_bones(all_bones, args.get("bone_filter", "auto"), warnings)
    if len(source_bones) < len(all_bones):
        warnings.append("骨过滤：共 %d 骨，按 %s 只采 %d 根 Biped 骨（次级 *_JNT 由目标 SpringBone 驱动，不采）" % (
            len(all_bones), args.get("bone_filter", "auto"), len(source_bones)))
    facts = collect_scene_facts(arm, warnings, source_bones)
    facts["unconnected"] = unconnected
    facts["armature"] = arm
    facts["upAxis"] = "XYZ"[facts["up_axis"]]
    facts["bonesAll"] = len(all_bones)
    facts["boneFilter"] = args.get("bone_filter", "auto")
    facts["bipedSource"] = biped_source
    # 对象 rest 矩阵（导入时、未施加 action 的对象矩阵）：目录模式下 Tpose 文件的这份值
    # 作为报告里的「Tpose 基准」；采样本身用每个 clip 起始帧的对象矩阵作 A0。
    facts["objectRestMatrix"] = object_rest["matrix_world"]
    facts["nonArmatureObjects"] = [
        {"name": obj.name, "type": obj.type} for obj in bpy.data.objects if obj.type != "ARMATURE"
    ]
    if not has_biped:
        warnings.append("骨骼名不是 BipXXX 命名（如 %r），按通用骨架采样；下游映射需按实际骨名适配" % (
            [bone.name for bone in all_bones[:4]]))

    scene = bpy.context.scene
    detected_fps = round(scene.render.fps / scene.render.fps_base, 6)
    if args["source_fps"] is not None:
        source_fps = args["source_fps"]
        warnings.append("使用 --source-fps=%.3f 覆盖检测到的 FBX 帧率 %.3f" % (source_fps, detected_fps))
    else:
        source_fps = detected_fps
        configured_fps = config.get("sourceFps")
        if configured_fps is not None and abs(float(configured_fps) - detected_fps) > 1e-6:
            warnings.append("config.sourceFps=%r 与 FBX 实际检测帧率 %.3f 不一致，已用检测值" % (
                configured_fps, detected_fps))
    facts["detected_source_fps"] = source_fps
    facts["detected_scene_fps_raw"] = detected_fps

    actions = [action for action in bpy.data.actions if action_belongs_to(action, arm)]
    facts["candidate_actions"] = [{"name": action.name, "frames": action_frame_count(action)} for action in actions]

    out_fps = args["fps"] if args["fps"] is not None else float(config.get("fps", 30))
    config_clips = config.get("clips") or []
    default_loop = bool(config.get("defaultLoop", True))

    plans_from_config = plans is None
    if plans is None:
        plans = []
        for clip in config_clips:
            plans.append(ClipPlan(
                clip_id=clip["id"],
                take_match=clip.get("takeMatch") or clip.get("take") or "",
                loop=bool(clip.get("loop", default_loop)),
                take_override=args["take"],
                expected_frames=clip.get("srcFrames"),
                match_mode=str(config.get("matchMode") or "substring"),
                source_root_motion=clip.get("sourceRootMotion"),
            ))
    if args["clip_id"]:
        if len(plans) > 1:
            raise SystemExit("--clip-id 只能配合 0/1 个 config clip 使用")
        if plans:
            plans[0].id = args["clip_id"]
        else:
            plans = [ClipPlan(args["clip_id"], args["take"] or "", True, args["take"])]

    if args["minimal"] and not plans and not config_clips:
        raise SystemExit("--minimal 需要 --config（列出要采的 take）")
    if args["minimal"] and not plans and config_clips and not plans_from_config:
        warnings.append("config 没有匹配本文件的 clip（minimal 模式只采集 rest，不采样动画）")

    clips = {}
    clip_analyses = {}
    mapped_actions = set()
    for plan in plans:
        action = resolve_clip_plan(
            actions, plan, warnings, args["single_take_fallback"],
            expected_frames=plan.expected_frames)
        if action is None:
            continue
        clip, analysis = sample_action(
            arm, action, facts["bones"], plan.id, plan.take_match, plan.loop,
            source_fps, out_fps, object_rest=object_rest, up_axis=facts["up_axis"],
            up_direction=facts["up_direction"], biped_source=biped_source,
            basis_reference=basis_reference, source_root_motion=plan.source_root_motion)
        clips[plan.id] = clip
        clip_analyses[plan.id] = analysis
        mapped_actions.add(action.name)
        print("SAMPLED %-24s action=%r src=%s frames=%d fps=%s->%s range=%s" % (
            plan.id, action.name, [int(value) for value in clip["srcFrames"]], clip["frames"],
            source_fps, out_fps, analysis["rangeSource"]))
        _print_object_anim(plan.id, analysis)

    if not args["minimal"]:
        for action in actions:
            if action.name in mapped_actions:
                continue
            clip_id = sanitize_id(action.name)
            suffix = 2
            while clip_id in clips:
                clip_id = "%s_%d" % (sanitize_id(action.name), suffix)
                suffix += 1
            clip, analysis = sample_action(
                arm, action, facts["bones"], clip_id, short_action_name(action.name),
                default_loop, source_fps, out_fps, object_rest=object_rest,
                up_axis=facts["up_axis"], up_direction=facts["up_direction"],
                biped_source=biped_source, basis_reference=basis_reference)
            clips[clip_id] = clip
            clip_analyses[clip_id] = analysis
            print("SAMPLED %-24s action=%r src=%s frames=%d (full mode) range=%s" % (
                clip_id, action.name, [int(value) for value in clip["srcFrames"]], clip["frames"],
                analysis["rangeSource"]))
            _print_object_anim(clip_id, analysis)

    tpose_deltas = {
        clip_id: info["objectAnimation"]["tposeBasisDelta"]
        for clip_id, info in clip_analyses.items()
        if info["objectAnimation"]["tposeBasisDelta"] is not None
    }
    facts["objectAnimation"] = {
        "basis": "clip-start-frame",
        "bipedSource": biped_source,
        "note": ("方案 A：D(f)=A0^-1·A(f)，A0=该 clip 采样起始帧的对象矩阵；只取旋转+平移；"
                 "对象动画不活跃时 D≡I 不施加。rootMotion 为相对 A0 的幅度（数据空间单位，"
                 "与 rest 骨长同单位），供回归核对。"),
        "clips": clip_analyses,
    }
    facts["objectRestDelta"] = {
        "basis": "clip-start-frame",
        "vsTpose": tpose_deltas or None,
        "note": ("每 clip 首帧对象矩阵与 Tpose 对象矩阵的常量差（旋转/平移）。pilot 实测 "
                 "7.4–91.6°、最大 3cm，因此 A_rest 必须用各自 clip 首帧，不能用 Tpose——"
                 "否则会把常量朝向差当根旋转注入，全量动作整体偏转。"),
    }
    facts.pop("armature", None)
    facts["boneCount"] = len(facts.pop("bones"))
    return {"facts": facts, "clips": clips, "warnings": warnings,
            "source_fps": source_fps, "actions": actions}


def main():
    args = parse_args()
    config = load_config(args.get("config"))
    out_fps = args["fps"] if args["fps"] is not None else float(config.get("fps", 30))
    if out_fps <= 0:
        raise SystemExit("--fps 必须 > 0")
    patch_inbetween_shapes()

    report = {
        "schemaVersion": 1,
        "generatedAt": datetime.datetime.now().astimezone().isoformat(),
        "mode": "dir" if args.get("fbx_dir") else "single",
        "config": args.get("config"),
        "fps": out_fps,
        "files": [],
        "warnings": [],
    }

    if args.get("fbx_dir"):
        dir_path = os.path.abspath(args["fbx_dir"])
        selected, skipped = list_dir_fbx(dir_path)
        if skipped:
            report["warnings"].append("同目录成对 FBX 已跳过（优先 _skel）：%s" % ", ".join(skipped))

        def dir_base_stem(value):
            return re.sub(r"_skel$", "", os.path.splitext(os.path.basename(value))[0],
                          flags=re.IGNORECASE).lower()

        # rest 优先取 Tpose 文件的 bind/rest（真实 138 目录里 Tpose.fbx 与其它动画 FBX 共用同一骨架；
        # 注意：rest 本来就取 armature 的 bind/rest 矩阵，不是动画第一帧；这里只是把 Tpose 作为 rest 基准）。
        tpose_files = [name for name in selected if dir_base_stem(name).endswith("tpose")]
        processing_order = tpose_files + [name for name in selected if name not in tpose_files]
        report["fbx"] = dir_path
        report["selectedFiles"] = selected
        report["processingOrder"] = processing_order
        report["restSource"] = {
            "file": processing_order[0],
            "reason": "tpose-prefer" if tpose_files and processing_order[0] in tpose_files else "first-file",
            "note": "rest=armature bind/rest 矩阵（非动画首帧）；目录批量的 rest/children/高度基准文件",
        }
        samples = None
        fps_by_file = {}
        clip_source_fps = {}
        # Tpose 文件的 armature 对象矩阵：仅作为报告里的「Tpose 基准」记录常量差，
        # 不参与采样（方案 A 用每个 clip 自身首帧的对象矩阵 A0）。
        tpose_object_matrix = None
        config_clips_all = config.get("clips") or []
        default_loop = bool(config.get("defaultLoop", True))
        for name in processing_order:
            path = os.path.join(dir_path, name)
            file_plans = derive_dir_plans(config_clips_all, name, args["take"], default_loop,
                                          match_mode=str(config.get("matchMode") or "substring"))
            result = process_file(path, config, args, plans=file_plans,
                                  basis_reference=tpose_object_matrix)
            facts = result["facts"]
            if tpose_object_matrix is None and facts.get("objectRestMatrix"):
                tpose_object_matrix = Matrix(facts["objectRestMatrix"])
            fps_by_file[name] = facts["detected_source_fps"]
            for clip_id, clip in result["clips"].items():
                clip_source_fps[clip_id] = clip["sourceFps"]
            facts["file"] = name
            report["files"].append(facts)
            report["warnings"].extend(result["warnings"])
            current = {
                "rest": facts["rest"],
                "children": facts["children"],
                "source_height": facts["source_height"],
                "source_hips_height": facts["source_hips_height"],
            }
            if samples is None:
                samples = current
                samples["clips"] = dict(result["clips"])
                samples["source_fps"] = result["source_fps"]
            else:
                diff = rest_diff_max(samples["rest"], facts["rest"])
                if diff > 1e-4:
                    report["warnings"].append("%s: 骨架 rest 与首文件不一致（max diff %.6f），沿用首文件 rest" % (name, diff))
                if abs(facts["source_height"] - samples["source_height"]) > 1e-3:
                    report["warnings"].append("%s: sourceHeight %.4f 与首文件 %.4f 不一致" % (
                        name, facts["source_height"], samples["source_height"]))
                if abs(facts["detected_source_fps"] - samples["source_fps"]) > 1e-3:
                    report["warnings"].append(
                        "%s: 帧率 %.3f 与 rest 基准文件 %.3f 不一致（已写 per-clip "
                        "samples.clips[id].sourceFps；顶层 samples.sourceFps 取最常见值）" % (
                            name, facts["detected_source_fps"], samples["source_fps"]))
                for clip_id, clip in result["clips"].items():
                    final_id = clip_id
                    suffix = 2
                    while final_id in samples["clips"]:
                        final_id = "%s_%s" % (clip_id, re.sub(r"[^0-9A-Za-z]+", "_", os.path.splitext(name)[0]))
                        if suffix > 2:
                            final_id += "_%d" % suffix
                        suffix += 1
                    if final_id != clip_id:
                        report["warnings"].append("%s: clip id %r 重复，改写为 %r" % (name, clip_id, final_id))
                    samples["clips"][final_id] = clip
        # ---- 顶层 sourceFps：各文件检测帧率取最常见值（并列时取处理顺序中先出现者）----
        from collections import Counter
        fps_counts = Counter(round(value, 6) for value in fps_by_file.values())
        top_source_fps = fps_counts.most_common(1)[0][0] if fps_counts else samples["source_fps"]
        samples["source_fps"] = top_source_fps
        report["sourceFpsByFile"] = fps_by_file
        report["sourceFpsTopLevel"] = top_source_fps
        report["clipSourceFps"] = clip_source_fps
        if len(fps_counts) > 1:
            detail = ", ".join("%s=%.3f" % (name, value) for name, value in fps_by_file.items())
            report["warnings"].append(
                "目录内 FBX 帧率不一致：%s；已为每个 clip 写 samples.clips[id].sourceFps，"
                "顶层 samples.sourceFps 取最常见值 %.3f（per-clip: %s）" % (
                    detail, top_source_fps,
                    ", ".join("%s=%.3f" % (clip_id, value)
                              for clip_id, value in sorted(clip_source_fps.items()))))
        if report.get("restSource"):
            report["warnings"].append("rest 基准文件：%s（%s）" % (
                report["restSource"]["file"], report["restSource"]["reason"]))

        configured_files = [clip.get("file") for clip in config_clips_all if clip.get("file")]
        for configured_file in configured_files:
            base = re.sub(r"_skel$", "", os.path.splitext(os.path.basename(configured_file))[0],
                          flags=re.IGNORECASE).lower()
            if not any(re.sub(r"_skel$", "", os.path.splitext(name)[0], flags=re.IGNORECASE).lower() == base
                       for name in selected):
                report["warnings"].append("config clip 引用的文件在目录中不存在：%s" % configured_file)
        if samples is None:
            raise SystemExit("目录模式没有采样到任何文件")
        output = {
            "schemaVersion": 1,
            "generatedAt": datetime.datetime.now().astimezone().isoformat(),
            "fbx": dir_path,
            "sourceFps": samples["source_fps"],
            "fps": out_fps,
            "sourceHeightMeters": samples["source_height"],
            "sourceHipsHeightMeters": samples["source_hips_height"],
            "rest": samples["rest"],
            "children": samples["children"],
            "clips": samples["clips"],
        }
        print("EXTRACT_DONE mode=dir files=%d clips=%d sourceHeight=%.3f sourceHipsHeight=%.3f" % (
            len(selected), len(output["clips"]), output["sourceHeightMeters"],
            output["sourceHipsHeightMeters"]))
    else:
        fbx_path = os.path.abspath(args["fbx"])
        if not os.path.exists(fbx_path):
            raise SystemExit("FBX 不存在：%s" % fbx_path)
        result = process_file(fbx_path, config, args, None)
        facts = result["facts"]
        facts["file"] = os.path.basename(fbx_path)
        report["files"].append(facts)
        report["warnings"].extend(result["warnings"])
        report["fbx"] = fbx_path
        output = {
            "schemaVersion": 1,
            "generatedAt": datetime.datetime.now().astimezone().isoformat(),
            "fbx": fbx_path,
            "sourceFps": result["source_fps"],
            "fps": out_fps,
            "sourceHeightMeters": facts["source_height"],
            "sourceHipsHeightMeters": facts["source_hips_height"],
            "rest": facts["rest"],
            "children": facts["children"],
            "clips": result["clips"],
        }
        print("EXTRACT_DONE mode=single clips=%d sourceFps=%s sourceHeight=%.3f sourceHipsHeight=%.3f" % (
            len(output["clips"]), output["sourceFps"], output["sourceHeightMeters"],
            output["sourceHipsHeightMeters"]))
        if not output["clips"]:
            print("WARN 没有采样到任何动画（Tpose/无动画 FBX）；仍输出 rest。")

    report["objectAnimation"] = summarize_object_animation(report["files"])
    object_anim_clips = report["objectAnimation"].get("clips") or {}
    active_clips = [
        clip_id for clip_id, info in object_anim_clips.items()
        if (info.get("objectAnimation") or {}).get("active")
    ]
    if object_anim_clips:
        report["warnings"].append(
            "对象动画（根运动）并集：%d/%d 个 clip 检测到变化的对象级动画；基准=各 clip 首帧对象矩阵"
            "（方案 A，见 report.objectAnimation）" % (len(active_clips), len(object_anim_clips)))
    spike_clips = {
        clip_id: info for clip_id, info in object_anim_clips.items()
        if (info.get("spikeCleanup") or {}).get("applied")
    }
    if spike_clips:
        total_corrected = sum(
            info["spikeCleanup"]["correctedFrameCount"] for info in spike_clips.values())
        report["warnings"].append(
            "多帧尖峰净化：%d 个 clip / %d 帧被修正（明细见 "
            "report.objectAnimation.clips[*].spikeCleanup）" % (
                len(spike_clips), total_corrected))
    ignored_clips = [
        clip_id for clip_id, info in object_anim_clips.items()
        if (info.get("objectAnimation") or {}).get("ignored")
    ]
    if ignored_clips:
        report["warnings"].append(
            "sourceRootMotion=ignore：%d 个 clip 不施加对象级根运动（D≡I）：%s" % (
                len(ignored_clips), ", ".join(sorted(ignored_clips))))
    tpose_deltas = [
        info["objectAnimation"]["tposeBasisDelta"]
        for info in object_anim_clips.values()
        if (info.get("objectAnimation") or {}).get("tposeBasisDelta")
    ]
    if tpose_deltas:
        max_rot = max(item["rotationDeg"] for item in tpose_deltas)
        max_trans = max(item["translationMeters"] for item in tpose_deltas)
        report["warnings"].append(
            "Tpose 基准 vs clip 首帧对象矩阵常量差最大 %.2f° / %.4fm：已改用「clip 首帧」作 A0，"
            "不可用 Tpose 作 A_rest（否则全量动作朝向/位置整体偏置）" % (max_rot, max_trans))

    out_path = os.path.abspath(args["out"])
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as handle:
        json.dump(output, handle, ensure_ascii=False)
    print("WROTE %s (%.1f MB)" % (out_path, os.path.getsize(out_path) / 1048576.0))

    for warning in report["warnings"]:
        print("WARN %s" % warning)
    if args.get("report"):
        report_path = os.path.abspath(args["report"])
        os.makedirs(os.path.dirname(report_path) or ".", exist_ok=True)
        with open(report_path, "w", encoding="utf-8") as handle:
            json.dump(report, handle, ensure_ascii=False, indent=1)
        print("REPORT %s" % report_path)
    else:
        # 未指定 --report 时把关键诊断打印出来即可
        for facts in report["files"]:
            print("INFO %s bones=%d sourceFps=%s actions=%d unconnected=%d" % (
                facts.get("file"), len(facts.get("rest", {})), facts.get("detected_source_fps"),
                len(facts.get("candidate_actions", [])), facts.get("unconnected", 0)))


main()
