#!/usr/bin/env python3
"""源 FBX 动作可视化渲染（Blender 4.2 headless，dev-only）

用途（两级验收的「源保真」层，见 docs/adv-acceptance-plan.md）：
把 3ds Max Biped / HSR 等导出的 FBX 动作在 Blender 里按固定机位渲染成 PNG 接触表，
作为「转换前源动作」的视觉基准。两种源都支持：
  a) 带蒙皮网格的全场景 FBX（pilot 6 文件）→ 直接渲染网格动画；
  b) 纯骨架 FBX（全量 138 skel 文件）→ 渲染骨架（关节球 + 骨段），关节清晰可见。

用法：
  BLENDER=/Volumes/4TB外置盘/deepseek-harness/tools/blender/Blender.app/Contents/MacOS/Blender
  "$BLENDER" -b --factory-startup --python scripts/vrm/motion/render-source-fbx.py -- \\
    --fbx /path/to/foo.fbx --take "Ani_StandBy|Base" --expect-frames 121 \\
    --clip-id idle --frames 0,0.2,0.4,0.6,0.8 --frame-mode fraction \\
    --views front,side,threeQuarter --res 512x768 \\
    --out work/adv-biped/qa/render/idle

输出（--out 目录）：
  <clip-id>-<view>-<label>.png   每帧每视图一张 PNG（label=百分比/帧号/秒）
  render-meta.json              armature/骨数/action/帧范围/fps/每帧包围盒/图像清单
  <clip-id>-<view>-sheet.jpg    每个 view 的横向接触表（调用 build-compare-sheet.py 用 PIL 拼）
  <clip-id>-sheet.jpg           views×frames 总接触表

关键设计：
- 相机在导入后按「骨骼 + 网格 rest(T-pose) 包围盒」一次性算好并固定（同一动作不同帧可比）；
  正交相机，三个视图 front/side/threeQuarter 与 preview-hsr.mjs 的 VRM 预览同向（模型面向 f 时，
  front 在 +f 侧、side 在 f 旋转 -90° 侧、threeQuarter 在 -45° 侧），保证源/VRM 两列可直接并排。
- 朝向自动识别：优先用脚趾骨（toe/ball，toe.head - 父骨.head 的水平方向 = 前方），
  其次眼骨相对头骨的方向，最后回退 -Y；也可用 --facing 显式指定。
- 渲染默认 Workbench（headless 稳定、快、无需贴图）：studio 光 + cavity + 阴影 + 纯色背景板；
  EEVEE/Cycles 可选（材质会被替换成纯色，仅保证姿态可读）。
- 纯骨架模式用 bmesh/from_pydata 手搓关节球 + 骨段，每帧按 pose 重建几何；
  身体骨过滤（--skeleton-filter body）剔除脸/头发/衣摆等噪声骨，只保留躯干四肢手指。

已知限制（写进 work/adv-biped/qa/REPORT.md）：
- 与官方视频参考的机位/焦距/角色着装不可能严格重合，视觉对拍只能判「姿态形状/节奏」；
- FBX 单位差异用世界包围盒自适应，不做物理单位假设；
- 多 armature 场景只保证主 armature（骨最多）的 take 正确，其余 armature 尽量按名字绑定；
- EEVEE/Cycles 下材质被替换为纯色，不用于贴图验收。
"""
import bpy
import bmesh  # noqa: F401  (保留：旧版几何辅助可能需要；当前几何用 from_pydata 手搓以稳定跨版本)
import datetime
import json
import math
import os
import re
import shutil
import subprocess
import sys
import time

from mathutils import Matrix, Vector

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, "..", "..", ".."))

VIEW_NAMES = ("front", "side", "threeQuarter", "back", "hand", "feet")

DEFAULTS = {
    "frames": "0,0.2,0.4,0.6,0.8",
    "frame-mode": "fraction",
    "views": "front,side,threeQuarter",
    "res": "512x768",
    "mode": "auto",
    "engine": "auto",
    "facing": "auto",
    "skeleton-filter": "body",
    "margin": 1.15,
    "floor-z": "auto",
    "ground-z": 0.0,
}

# 身体骨过滤：剔除 HSR 这类游戏骨架里大量脸/头发/衣摆/挂件骨，避免骨架图糊成一团。
# 纯 Biped 骨架（Bip01 ...）不受影响。
SKELETON_EXCLUDE_RE = re.compile(
    r"(?i)(eye|brow|face|cheek|mouth|lip|tongue|tooth|nose|ear|hair|coat|collar|eardrop|glass|"
    r"bag_|pocket|prop_|prop$|weapon|jnt|cloth|skirt|ribbon|bell|chain|accessor|jewel|pendant)"
)


def log(message):
    print("[render-source] %s" % message, flush=True)


USAGE = """用法：
  Blender -b --factory-startup --python scripts/vrm/motion/render-source-fbx.py -- \\
    --fbx <file.fbx> [--take <name|re:regex>] [--expect-frames N] \\
    --out <dir> [--clip-id <id>] [--frames 0,0.2,0.4] [--frame-mode fraction|frame|second] \\
    [--views front,side,threeQuarter,hand,feet] [--res 512x768] \\
    [--mode auto|mesh|skeleton] [--engine auto|workbench|eevee|cycles] \\
    [--facing auto|-Y|+Y|-X|+X] [--armature NAME] [--skeleton-filter body|all] \\
    [--margin 1.15] [--floor-z auto|<z>] [--ground-z 0] [--scene-fps N] \\
    [--list-actions] [--list-bones] [--no-sheet] [--no-floor] [--no-grid]

常用：
  # 先盘点 take/骨架/fps（真实数据到位第一步）
  Blender ... -- --fbx x.fbx --list-actions
  # 渲染 5 帧三视图（网格/纯骨架自动识别）
  Blender ... -- --fbx x.fbx --take MyTake --frames 0,0.2,0.4,0.6,0.8 --out work/adv-biped/qa/render/mytake
  # 纯骨架强制可视化
  Blender ... -- --fbx skel.fbx --take MyTake --mode skeleton --out <dir>
"""


def fail(message, code=2):
    print("[render-source] ERROR: %s" % message, flush=True)
    sys.exit(code)


# --------------------------------------------------------------------------------------
# 参数
# --------------------------------------------------------------------------------------
def _parse_floor_z(value):
    """地板高度：auto=按 rest/各帧最低点自动贴地；数字=世界 Z。"""
    if value is None or str(value).strip().lower() == "auto" or str(value).strip() == "":
        return "auto"
    try:
        return float(value)
    except (TypeError, ValueError):
        fail("--floor-z 需要 auto 或数字，收到 %r" % (value,))


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    opts = dict(DEFAULTS)
    flags = set()
    i = 0
    while i < len(argv):
        token = argv[i]
        if not token.startswith("--"):
            fail("无法解析参数 %r（参数需以 -- 开头）" % token)
        key = token[2:]
        if "=" in key:
            key, value = key.split("=", 1)
            opts[key] = value
            i += 1
            continue
        # 下一个 token 不是 --flag 就当作值（允许 --facing -Y 这类负值/短横值）
        if i + 1 < len(argv) and not argv[i + 1].startswith("--"):
            opts[key] = argv[i + 1]
            i += 2
        else:
            flags.add(key)
            i += 1

    def as_int(key, default=None):
        value = opts.get(key)
        if value is None or value == "":
            return default
        try:
            return int(value)
        except (TypeError, ValueError):
            fail("--%s 需要整数，收到 %r" % (key, value))

    def as_float(key, default=None):
        value = opts.get(key)
        if value is None or value == "":
            return default
        try:
            return float(value)
        except (TypeError, ValueError):
            fail("--%s 需要数字，收到 %r" % (key, value))

    args = {
        "fbx": opts.get("fbx"),
        "take": opts.get("take") or "",
        "out": opts.get("out"),
        "clip_id": opts.get("clip-id") or "",
        "frames": opts.get("frames") or DEFAULTS["frames"],
        "frame_mode": opts.get("frame-mode") or "fraction",
        "views": [v.strip() for v in (opts.get("views") or DEFAULTS["views"]).split(",") if v.strip()],
        "res": opts.get("res") or DEFAULTS["res"],
        "mode": opts.get("mode") or "auto",
        "engine": opts.get("engine") or "auto",
        "facing": opts.get("facing") or "auto",
        "skeleton_filter": opts.get("skeleton-filter") or "body",
        "margin": as_float("margin", 1.15),
        "floor_z": _parse_floor_z(opts.get("floor-z", DEFAULTS["floor-z"])),
        "ground_z": as_float("ground-z", 0.0),
        "armature": opts.get("armature") or "",
        "expect_frames": as_int("expect-frames"),
        "scene_fps": as_float("scene-fps"),
        "sheet_python": opts.get("sheet-python") or "",
        "ffmpeg": opts.get("ffmpeg") or "",
        "title": opts.get("title") or "",
        "list_actions": "list-actions" in flags,
        "list_bones": "list-bones" in flags,
        "no_sheet": "no-sheet" in flags,
        "no_floor": "no-floor" in flags,
        "no_grid": "no-grid" in flags,
        "debug": "debug" in flags,
    }
    if "help" in flags:
        print(USAGE)
        sys.exit(0)
    if not args["fbx"]:
        fail("缺少 --fbx（--help 查看用法）")
    if args["fbx"] in ("help", "-h"):
        print(USAGE)
        sys.exit(0)
    if not os.path.isfile(args["fbx"]):
        fail("--fbx 不存在：%s" % args["fbx"])
    if args["frame_mode"] not in ("fraction", "frame", "second"):
        fail("--frame-mode 必须是 fraction|frame|second")
    if args["mode"] not in ("auto", "mesh", "skeleton"):
        fail("--mode 必须是 auto|mesh|skeleton")
    if args["engine"] not in ("auto", "workbench", "eevee", "cycles"):
        fail("--engine 必须是 auto|workbench|eevee|cycles")
    if args["skeleton_filter"] not in ("body", "all"):
        fail("--skeleton-filter 必须是 body|all")
    bad_views = [v for v in args["views"] if v not in VIEW_NAMES]
    if bad_views:
        fail("未知 view %r（可选 %s）" % (bad_views, ",".join(VIEW_NAMES)))
    if not args["list_actions"] and not args["list_bones"]:
        if not args["out"]:
            fail("缺少 --out（渲染输出目录）")
    try:
        width, height = args["res"].lower().split("x")
        args["res_x"] = int(width)
        args["res_y"] = int(height)
        if args["res_x"] <= 0 or args["res_y"] <= 0:
            raise ValueError
    except (ValueError, AttributeError):
        fail("--res 需要 WIDTHxHEIGHT，例如 512x768")
    return args


# --------------------------------------------------------------------------------------
# 导入（FBX in-between shape keys patch，同 extract-hsr-anims.py）
# --------------------------------------------------------------------------------------
def patch_inbetween_shapes():
    """跳过 FBX in-between shape keys（Blender 4.2 importer 不支持会整体中止）。"""
    try:
        import io_scene_fbx.import_fbx as imp_fbx
    except Exception as error:  # pragma: no cover - 不同 blender 版本
        log("WARN 无法 patch in-between shapes（%s），继续尝试导入" % error)
        return
    original = imp_fbx.blen_read_shapes

    def patched(fbx_tmpl, fbx_data, objects, me, scene):
        if fbx_data:
            fbx_data = [entry for entry in fbx_data if len(entry[3]) <= 1]
            if not fbx_data:
                return {}
        return original(fbx_tmpl, fbx_data, objects, me, scene)

    imp_fbx.blen_read_shapes = patched


def import_fbx(path, scene_fps=None):
    patch_inbetween_shapes()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    t0 = time.time()
    bpy.ops.import_scene.fbx(
        filepath=path,
        use_anim=True,
        ignore_leaf_bones=False,
        automatic_bone_orientation=False,
        use_custom_props=True,
    )
    elapsed = time.time() - t0
    scene = bpy.context.scene
    if scene_fps:
        scene.render.fps = int(round(scene_fps))
        scene.render.fps_base = 1.0
    log("import done in %.1fs" % elapsed)
    return elapsed


# --------------------------------------------------------------------------------------
# 场景盘点 / action 选择
# --------------------------------------------------------------------------------------
def scene_inventory():
    objs = list(bpy.data.objects)
    armatures = [o for o in objs if o.type == "ARMATURE"]
    meshes = [o for o in objs if o.type == "MESH"]
    return armatures, meshes, objs


def choose_armature(armatures, hint):
    if not armatures:
        fail("FBX 里没有 ARMATURE 对象（纯网格/空场景无法作为动作源）")
    if hint:
        exact = [a for a in armatures if a.name == hint]
        if exact:
            return exact[0]
        fuzzy = [a for a in armatures if hint.lower() in a.name.lower()]
        if len(fuzzy) == 1:
            return fuzzy[0]
        if len(fuzzy) > 1:
            return max(fuzzy, key=lambda a: len(a.data.bones))
        fail("--armature %r 未匹配到（候选：%s）" % (hint, ", ".join(a.name for a in armatures)))
    return max(armatures, key=lambda a: len(a.data.bones))


def norm_name(value):
    return re.sub(r"\s+", " ", value or "").strip()


def action_frames(action):
    start, end = action.frame_range
    return float(start), float(end), int(round(end - start + 1))


def take_matcher(take):
    take = norm_name(take)
    if not take:
        return lambda name: True
    if take.startswith("re:"):
        pattern = re.compile(take[3:])
        return lambda name: bool(pattern.search(name))
    lowered = take.lower()
    return lambda name: lowered in (name or "").lower()


def action_score(action, take, expect_frames):
    """take 匹配打分：精确 > 包含；再用 expect-frames 消除同名 take 的变体（.001/不同长度）。"""
    score = 0
    name = norm_name(action.name)
    wanted = norm_name(take)
    if wanted and not take.startswith("re:"):
        if name == wanted:
            score += 200
        elif name.endswith(wanted):
            score += 40
        if wanted.lower() in name.lower():
            score += 60
    frames = action_frames(action)[2]
    if expect_frames:
        if abs(frames - expect_frames) <= 2:
            score += 100
        else:
            score -= 30
    # 同分时优先 fcurve 多的（信息更全，通常是基础层而不是 object 级动画）
    score += min(len(action.fcurves), 3000) / 3000.0
    return score


def pick_action(candidates, take, expect_frames):
    if not candidates:
        return None
    if not take:
        return max(candidates, key=lambda a: len(a.fcurves))
    matcher = take_matcher(take)
    matched = [a for a in candidates if matcher(a.name)]
    if not matched:
        return None
    matched.sort(key=lambda a: (-action_score(a, take, expect_frames), a.name))
    return matched[0]


def bind_actions(objs, actions, take, expect_frames, primary_armature):
    """把 take 对应的 action 绑到每个对象上（armature 用 <obj>|<take> 命名，空物体承载 root motion）。

    返回 {objectName: actionName}；未匹配到的对象保持导入器给的 action（记录在 meta 里）。
    """
    assigned = {}
    for obj in objs:
        prefix = obj.name + "|"
        candidates = [a for a in actions if a.name.startswith(prefix)]
        if not candidates and obj is primary_armature:
            # 有些导出器 action 不带对象前缀，主 armature 兜底用全部 action
            candidates = [a for a in actions if not re.match(r"^[^|]+\|", a.name)] or list(actions)
        if not candidates:
            continue
        chosen = pick_action(candidates, take, expect_frames)
        if chosen is None:
            continue
        obj.animation_data_create()
        obj.animation_data.action = chosen
        assigned[obj.name] = chosen.name
    return assigned


# --------------------------------------------------------------------------------------
# 帧 / 时间
# --------------------------------------------------------------------------------------
def resolve_frames(spec, mode, start, end, fps):
    raw = [item.strip() for item in str(spec).split(",") if item.strip()]
    if not raw:
        fail("--frames 为空")
    out = []
    for item in raw:
        try:
            value = float(item)
        except ValueError:
            fail("--frames 里 %r 不是数字" % item)
        if mode == "fraction":
            if value < -1e-6 or value > 1 + 1e-6:
                fail("--frame-mode fraction 时 --frames 取值需在 [0,1]，收到 %r" % item)
            value = min(max(value, 0.0), 1.0)
            frame = start + value * (end - start)
            label = "%03d" % int(round(value * 100))
        elif mode == "frame":
            frame = value
            label = "f%04d" % int(round(value))
        else:  # second
            frame = start + value * fps
            label = "t%08s" % ("%.3f" % value).replace(".", "p")
        whole = int(math.floor(frame + 1e-6))
        sub = max(0.0, frame - whole)
        out.append(
            {
                "label": label,
                "frame": round(frame, 4),
                "frameWhole": whole,
                "subframe": round(sub, 4),
                "timeSec": round((frame - start) / fps, 4) if fps else None,
            }
        )
    # 去重（同标签冲突时加后缀）
    seen = {}
    for entry in out:
        label = entry["label"]
        if label in seen:
            seen[label] += 1
            entry["label"] = "%s_%d" % (label, seen[label])
        else:
            seen[label] = 1
    return out


# --------------------------------------------------------------------------------------
# 几何/包围盒
# --------------------------------------------------------------------------------------
def world_bbox_of_points(points):
    if not points:
        return None
    xs = [p.x for p in points]
    ys = [p.y for p in points]
    zs = [p.z for p in points]
    mn = Vector((min(xs), min(ys), min(zs)))
    mx = Vector((max(xs), max(ys), max(zs)))
    return {"min": vec_round(mn), "max": vec_round(mx), "size": vec_round(mx - mn), "center": vec_round((mn + mx) / 2)}


def vec_round(vec, digits=6):
    return [round(float(v), digits) for v in vec]


def bone_world_points(arm, bone_names=None):
    matrix = arm.matrix_world
    points = []
    for bone in arm.data.bones:
        if bone_names is not None and bone.name not in bone_names:
            continue
        points.append(matrix @ bone.head_local)
        points.append(matrix @ bone.tail_local)
    return points


def pose_bone_world_points(arm, bone_names=None):
    matrix = arm.matrix_world
    points = []
    for pose_bone in arm.pose.bones:
        if bone_names is not None and pose_bone.name not in bone_names:
            continue
        points.append(matrix @ pose_bone.head)
        points.append(matrix @ pose_bone.tail)
    return points


_nonfinite_mesh_warned = set()


def evaluated_mesh_world_points(meshes):
    """当前帧 evaluated 网格的顶点世界坐标（用于包围盒/贴地判定）。"""
    import numpy as np

    depsgraph = bpy.context.evaluated_depsgraph_get()
    points = []
    for mesh_obj in meshes:
        evaluated = mesh_obj.evaluated_get(depsgraph)
        matrix = np.array(evaluated.matrix_world, dtype=np.float64)
        if not np.isfinite(matrix).all():
            if mesh_obj.name not in _nonfinite_mesh_warned:
                _nonfinite_mesh_warned.add(mesh_obj.name)
                log("WARN mesh %r 的 matrix_world 含非有限值，跳过其包围盒贡献" % mesh_obj.name)
            continue
        mesh = evaluated.to_mesh()
        try:
            count = len(mesh.vertices)
            if count == 0:
                continue
            coords = np.empty(count * 3, dtype=np.float64)
            mesh.vertices.foreach_get("co", coords)
            coords = coords.reshape(-1, 3)
            finite_rows = np.isfinite(coords).all(axis=1)
            if not finite_rows.all():
                if mesh_obj.name not in _nonfinite_mesh_warned:
                    _nonfinite_mesh_warned.add(mesh_obj.name)
                    log("WARN mesh %r 含 %d 个非有限顶点，已剔除"
                        % (mesh_obj.name, int((~finite_rows).sum())))
                coords = coords[finite_rows]
                if count == 0:
                    continue
            world = coords @ matrix[:3, :3].T + matrix[:3, 3]
            points.append(world)
        finally:
            evaluated.to_mesh_clear()
    if not points:
        return None

    all_points = np.concatenate(points, axis=0)
    mn = Vector(tuple(all_points.min(axis=0).tolist()))
    mx = Vector(tuple(all_points.max(axis=0).tolist()))
    return {"min": vec_round(mn), "max": vec_round(mx), "size": vec_round(mx - mn),
            "center": vec_round((mn + mx) / 2), "vertices": int(all_points.shape[0])}


def bbox_union(*boxes):
    valid = [b for b in boxes if b]
    if not valid:
        return None
    mn = Vector((min(b["min"][0] for b in valid), min(b["min"][1] for b in valid), min(b["min"][2] for b in valid)))
    mx = Vector((max(b["max"][0] for b in valid), max(b["max"][1] for b in valid), max(b["max"][2] for b in valid)))
    return {"min": vec_round(mn), "max": vec_round(mx), "size": vec_round(mx - mn), "center": vec_round((mn + mx) / 2)}


# --------------------------------------------------------------------------------------
# armature 尺度 / 朝向 / 关键骨
# --------------------------------------------------------------------------------------
def unit_scale(arm, rest_bone_bbox_world):
    """world 单位 / armature 局部单位（HSR 导入后 root 有 0.01 缩放）。"""
    local_points = []
    for bone in arm.data.bones:
        local_points.append(bone.head_local)
        local_points.append(bone.tail_local)
    local = local_height(local_points)
    world = rest_bone_bbox_world["size"][2] if rest_bone_bbox_world else 0
    if local and world:
        return world / local
    return 1.0


def local_height(points):
    """armature 局部空间里的身高方向：取三轴中跨度最大的一轴（兼容 Y-up/Z-up 两种导入）。"""
    if not points:
        return 0
    ranges = []
    for axis in ("x", "y", "z"):
        values = [getattr(point, axis) for point in points]
        ranges.append(max(values) - min(values))
    return max(ranges)


def find_bone(bones, patterns, prefer=None):
    for pattern in patterns:
        regex = re.compile(pattern)
        hits = [b for b in bones if regex.search(b.name)]
        if not hits:
            continue
        if prefer:
            preferred = [b for b in hits if re.search(prefer, b.name)]
            if preferred:
                hits = preferred
        hits.sort(key=lambda b: (len(b.name), b.name))
        return hits[0]
    return None


def find_side_bone(bones, patterns, side="L"):
    side_re = re.compile(r"(?i)(%s)" % side)
    for pattern in patterns:
        regex = re.compile(pattern)
        hits = [b for b in bones if regex.search(b.name) and side_re.search(b.name)]
        if hits:
            hits.sort(key=lambda b: (len(b.name), b.name))
            return hits[0]
    return None


def detect_facing(arm):
    """返回 (facing Vector 水平单位向量, source 说明)。"""
    bones = list(arm.data.bones)
    matrix = arm.matrix_world

    def world_head(bone):
        return matrix @ bone.head_local

    # 1) 脚趾相对脚踝/脚掌的方向 = 前方
    toe_candidates = []
    for bone in bones:
        if not re.search(r"(?i)toe|ball", bone.name):
            continue
        base = None
        parent = bone.parent
        for _ in range(4):
            if parent is None:
                break
            if re.search(r"(?i)ankle|foot|heel|toe", parent.name):
                base = parent
                break
            parent = parent.parent
        if base is None:
            base = bone.parent
        if base is None:
            continue
        delta = world_head(bone) - world_head(base)
        delta.z = 0.0
        if delta.length > 1e-9:
            toe_candidates.append(delta.normalized())
    if toe_candidates:
        reference = toe_candidates[0]
        aligned = [v for v in toe_candidates if v.dot(reference) > 0.5]
        acc = Vector((0.0, 0.0, 0.0))
        for vector in aligned:
            acc += vector
        if acc.length > 1e-6:
            return acc.normalized(), "toe-vs-foot(%d bones)" % len(aligned)

    # 2) 眼骨相对头骨的方向 = 前方
    head_bone = find_bone(bones, [r"(?i)^Head_M$", r"(?i)^head$", r"(?i)^bip01 head$", r"(?i)head"])
    eye_bones = [b for b in bones if re.search(r"(?i)^eye(_all)?_?(L|R)$|^eye_All_", b.name)]
    if not eye_bones:
        eye_bones = [b for b in bones if re.search(r"(?i)eye", b.name) and not re.search(r"(?i)(brow|conner|up|dn)", b.name)]
    if head_bone and eye_bones:
        eyes_center = Vector((0.0, 0.0, 0.0))
        for bone in eye_bones:
            eyes_center += world_head(bone)
        eyes_center /= len(eye_bones)
        delta = eyes_center - world_head(head_bone)
        delta.z = 0.0
        if delta.length > 1e-9:
            return delta.normalized(), "eyes-vs-head(%d bones)" % len(eye_bones)

    return Vector((0.0, -1.0, 0.0)), "default(-Y)"


def parse_facing(value, detected, notes):
    value = (value or "auto").strip()
    if value in ("", "auto"):
        return detected
    mapping = {
        "-y": Vector((0.0, -1.0, 0.0)),
        "+y": Vector((0.0, 1.0, 0.0)),
        "-x": Vector((-1.0, 0.0, 0.0)),
        "+x": Vector((1.0, 0.0, 0.0)),
    }
    key = value.lower()
    if key not in mapping:
        fail("--facing 只支持 auto|-Y|+Y|-X|+X（收到 %r）" % value)
    notes.append("朝向使用显式 --facing %s（自动识别为 %s）" % (value, facing_name(detected)))
    return mapping[key]


def facing_name(vector):
    if vector is None:
        return "?"
    axes = {"-Y": Vector((0, -1, 0)), "+Y": Vector((0, 1, 0)), "-X": Vector((-1, 0, 0)), "+X": Vector((1, 0, 0))}
    best = max(axes.items(), key=lambda item: vector.dot(item[1]))
    return best[0]


# --------------------------------------------------------------------------------------
# 渲染场景搭建
# --------------------------------------------------------------------------------------
def make_mesh_object(name, verts, faces, color, material_color=None):
    mesh = bpy.data.meshes.new(name + "-mesh")
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    obj.color = color
    if material_color is not None:
        material = bpy.data.materials.new(name + "-mat")
        material.use_nodes = True
        material.diffuse_color = material_color
        bsdf = material.node_tree.nodes.get("Principled BSDF")
        if bsdf:
            bsdf.inputs["Base Color"].default_value = material_color
            bsdf.inputs["Roughness"].default_value = 0.85
            if "Emission Color" in bsdf.inputs:
                bsdf.inputs["Emission Color"].default_value = material_color
                bsdf.inputs["Emission Strength"].default_value = 0.15
        mesh.materials.append(material)
    return obj


def build_floor_and_grid(center, height, floor_z, no_floor=False, no_grid=False):
    objects = []
    half = max(height * 2.0, 1e-6)
    cx, cy = center.x, center.y
    if not no_floor:
        verts = [
            (cx - half, cy - half, floor_z), (cx + half, cy - half, floor_z),
            (cx + half, cy + half, floor_z), (cx - half, cy + half, floor_z),
        ]
        objects.append(make_mesh_object("qa-floor", verts, [(0, 1, 2, 3)],
                                        (0.10, 0.11, 0.13, 1.0), (0.10, 0.11, 0.13, 1.0)))
    if not no_grid:
        spacing = height / 4.0
        width = max(height / 300.0, 1e-6)
        z = floor_z + max(height / 4000.0, 1e-7)
        verts, faces = [], []
        steps = int(math.ceil(half / spacing))
        line_count = 0
        for index in range(-steps, steps + 1):
            offset = index * spacing
            # 平行 Y 轴的线
            x = cx + offset
            verts.extend([(x - width, cy - half, z), (x + width, cy - half, z),
                          (x + width, cy + half, z), (x - width, cy + half, z)])
            faces.append((line_count * 4, line_count * 4 + 1, line_count * 4 + 2, line_count * 4 + 3))
            line_count += 1
            # 平行 X 轴的线
            y = cy + offset
            verts.extend([(cx - half, y - width, z), (cx + half, y - width, z),
                          (cx + half, y + width, z), (cx - half, y + width, z)])
            faces.append((line_count * 4, line_count * 4 + 1, line_count * 4 + 2, line_count * 4 + 3))
            line_count += 1
        objects.append(make_mesh_object("qa-grid", verts, faces,
                                        (0.34, 0.36, 0.40, 1.0), (0.34, 0.36, 0.40, 1.0)))
    return objects


def create_backdrop(center, height):
    size = height * 10.0
    verts = [(-size, -size, 0), (size, -size, 0), (size, size, 0), (-size, size, 0)]
    obj = make_mesh_object("qa-backdrop", verts, [(0, 1, 2, 3)],
                           (0.055, 0.06, 0.075, 1.0), (0.055, 0.06, 0.075, 1.0))
    return obj


def setup_engine(engine, res_x, res_y):
    scene = bpy.context.scene
    scene.render.resolution_x = res_x
    scene.render.resolution_y = res_y
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    scene.render.image_settings.color_depth = "8"
    scene.render.film_transparent = False
    scene.render.fps_base = scene.render.fps_base or 1.0
    if engine == "workbench":
        scene.render.engine = "BLENDER_WORKBENCH"
        shading = scene.display.shading
        shading.light = "STUDIO"
        shading.color_type = "OBJECT"
        shading.show_cavity = True
        shading.cavity_type = "BOTH"
        shading.show_shadows = True
        shading.shadow_intensity = 0.35
        shading.show_object_outline = True
        shading.object_outline_color = (0.05, 0.05, 0.06)
        shading.show_specular_highlight = False
        shading.background_type = "VIEWPORT"
        shading.background_color = (0.055, 0.06, 0.075)
    else:
        scene.render.engine = "BLENDER_EEVEE_NEXT" if engine == "eevee" else "CYCLES"
        if engine == "cycles":
            scene.cycles.device = "CPU"
            scene.cycles.samples = 24
            scene.cycles.use_denoising = False
        # 世界
        world = bpy.data.worlds.new("qa-world")
        world.use_nodes = True
        background = world.node_tree.nodes.get("Background")
        if background:
            background.inputs[0].default_value = (0.03, 0.035, 0.045, 1.0)
            background.inputs[1].default_value = 1.0
        scene.world = world
        # 灯光
        key_light = bpy.data.objects.new("qa-key-light", bpy.data.lights.new("qa-key-light-data", "SUN"))
        key_light.data.energy = 4.0
        key_light.rotation_euler = (math.radians(55), 0.0, math.radians(25))
        scene.collection.objects.link(key_light)
        fill_light = bpy.data.objects.new("qa-fill-light", bpy.data.lights.new("qa-fill-light-data", "AREA"))
        fill_light.data.energy = 200.0
        fill_light.data.size = 5.0
        fill_light.location = (2.0, -2.0, 2.0)
        scene.collection.objects.link(fill_light)
        # 所有网格换成纯色材质，避免 FBX 缺贴图导致的粉/黑
        default_material = bpy.data.materials.new("qa-gray")
        default_material.use_nodes = True
        bsdf = default_material.node_tree.nodes.get("Principled BSDF")
        if bsdf:
            bsdf.inputs["Base Color"].default_value = (0.72, 0.68, 0.62, 1.0)
            bsdf.inputs["Roughness"].default_value = 0.8
        default_material.diffuse_color = (0.72, 0.68, 0.62, 1.0)
        for mesh_obj in [o for o in bpy.data.objects if o.type == "MESH"]:
            mesh_obj.data.materials.clear()
            mesh_obj.data.materials.append(default_material)
    log("engine=%s res=%dx%d" % (engine, res_x, res_y))


# --------------------------------------------------------------------------------------
# 骨架可视化
# --------------------------------------------------------------------------------------
def split_bones(arm, skeleton_filter):
    bones = list(arm.data.bones)
    if skeleton_filter == "all":
        return bones
    body = [b for b in bones if not SKELETON_EXCLUDE_RE.search(b.name)]
    return body if len(body) >= 8 else bones


def _add_octahedron(verts, faces, center, radius):
    base = len(verts)
    verts.extend([
        center + Vector((radius, 0, 0)), center + Vector((-radius, 0, 0)),
        center + Vector((0, radius, 0)), center + Vector((0, -radius, 0)),
        center + Vector((0, 0, radius)), center + Vector((0, 0, -radius)),
    ])
    faces.extend([
        (base + 0, base + 4, base + 2), (base + 2, base + 4, base + 1),
        (base + 1, base + 4, base + 3), (base + 3, base + 4, base + 0),
        (base + 2, base + 5, base + 0), (base + 1, base + 5, base + 2),
        (base + 3, base + 5, base + 1), (base + 0, base + 5, base + 3),
    ])


def _add_prism(verts, faces, head, tail, radius):
    direction = tail - head
    length = direction.length
    if length < 1e-12:
        return
    axis = direction.normalized()
    helper = Vector((0, 0, 1)) if abs(axis.z) < 0.95 else Vector((0, 1, 0))
    side = axis.cross(helper).normalized() * radius
    up = axis.cross(side).normalized() * radius
    base = len(verts)
    for index in range(6):
        angle = math.pi / 3.0 * index
        offset = side * math.cos(angle) + up * math.sin(angle)
        verts.append(head + offset)
        verts.append(tail + offset)
    for index in range(6):
        nxt = (index + 1) % 6
        faces.append((base + 2 * index, base + 2 * nxt, base + 2 * nxt + 1, base + 2 * index + 1))
    faces.append(tuple(base + 2 * index for index in range(6)))
    faces.append(tuple(base + 2 * index + 1 for index in range(5, -1, -1)))


def create_skeleton_objects(arm, bone_names, height):
    # 关节/骨段粗细按身高比例给足可见度（纯骨架渲染的主要可读性来源）
    radius_joint = height / 70.0
    radius_bone = height / 190.0
    joint_obj = make_mesh_object("qa-skel-joints", [], [], (0.96, 0.55, 0.16, 1.0), (0.96, 0.55, 0.16, 1.0))
    bone_obj = make_mesh_object("qa-skel-bones", [], [], (0.30, 0.68, 0.92, 1.0), (0.30, 0.68, 0.92, 1.0))
    return joint_obj, bone_obj, radius_joint, radius_bone


def update_skeleton_geometry(arm, bone_names, joint_obj, bone_obj, radius_joint, radius_bone):
    matrix = arm.matrix_world
    joint_verts, joint_faces, bone_verts, bone_faces = [], [], [], []
    for name in bone_names:
        pose_bone = arm.pose.bones.get(name)
        if pose_bone is None:
            continue
        head = matrix @ pose_bone.head
        tail = matrix @ pose_bone.tail
        _add_octahedron(joint_verts, joint_faces, head, radius_joint)
        _add_prism(bone_verts, bone_faces, head, tail, radius_bone)
    _replace_mesh(joint_obj, joint_verts, joint_faces)
    _replace_mesh(bone_obj, bone_verts, bone_faces)


def _replace_mesh(obj, verts, faces):
    mesh = obj.data
    mesh.clear_geometry()
    if not verts:
        return
    mesh.from_pydata(verts, [], faces)
    mesh.update()


# --------------------------------------------------------------------------------------
# 相机
# --------------------------------------------------------------------------------------
def rotate_about_z(vector, degrees):
    return Matrix.Rotation(math.radians(degrees), 3, "Z") @ vector


def view_direction_map(facing):
    """相机方位（从角色指向相机的单位向量），与 preview-hsr.mjs 的 VRM 预览同语义：

    VRM 预览里角色面向 +Z（three.js Y-up），front 相机在 +Z、side 相机在 +X（角色左手侧）、
    threeQuarter 在 (+X,+Z)。换算到 Blender Z-up 世界：角色面向 f 时
      front = f、back = -f、side = up × f（角色左手侧）、threeQuarter = normalize(f + up×f)。
    """
    facing = Vector((facing.x, facing.y, 0.0))
    if facing.length < 1e-9:
        facing = Vector((0.0, -1.0, 0.0))
    facing.normalize()
    up = Vector((0.0, 0.0, 1.0))
    left = up.cross(facing)
    if left.length < 1e-9:
        left = Vector((1.0, 0.0, 0.0))
    left.normalize()
    three_quarter = (facing + left).normalized()
    return {
        "front": facing,
        "back": -facing,
        "side": left,
        "threeQuarter": three_quarter,
    }


def projected_width(bbox, direction):
    """包围盒在「垂直视线方向」上的投影宽度（用水平右向量）。"""
    right = direction.cross(Vector((0, 0, 1)))
    if right.length < 1e-9:
        right = Vector((1, 0, 0))
    right.normalize()
    corners = bbox_corners(bbox)
    values = [(corner - Vector(bbox["center"])).dot(right) for corner in corners]
    return max(values) - min(values)


def bbox_corners(bbox):
    mn = bbox["min"]
    mx = bbox["max"]
    return [
        Vector((x, y, z))
        for x in (mn[0], mx[0])
        for y in (mn[1], mx[1])
        for z in (mn[2], mx[2])
    ]


def closeup_views(arm, view_dirs, height, floor_z, views):
    """hand/feet 特写（对齐 preview-hsr 的 hand/feet 语义：小范围正交、正前方视角）。"""
    bones = list(arm.data.bones)
    matrix = arm.matrix_world
    specs = {}
    if "hand" in views:
        hand = find_side_bone(bones, [r"(?i)wrist", r"(?i)hand", r"(?i)palm"], "L")
        if hand is None:
            hand = find_side_bone(bones, [r"(?i)wrist", r"(?i)hand", r"(?i)palm"], "R")
        if hand is not None:
            specs["hand"] = {
                "center": matrix @ hand.head_local,
                "ortho": height * 0.16,
                "direction": view_dirs["front"],
                "bone": hand.name,
                "trackBone": hand.name,
            }
    if "feet" in views:
        foot = find_side_bone(bones, [r"(?i)ankle", r"(?i)foot", r"(?i)toe"], "L")
        if foot is None:
            foot = find_side_bone(bones, [r"(?i)ankle", r"(?i)foot", r"(?i)toe"], "R")
        if foot is not None:
            head = matrix @ foot.head_local
            specs["feet"] = {
                "center": Vector((head.x, head.y, floor_z + height * 0.07)),
                "ortho": height * 0.16,
                "direction": view_dirs["front"],
                "bone": foot.name,
                "trackBone": foot.name,
            }
    return specs


# --------------------------------------------------------------------------------------
# 接触表（调用 build-compare-sheet.py --contact-only，用 Pillow 拼图）
# --------------------------------------------------------------------------------------
def find_pillow_python(explicit):
    candidates = []
    if explicit:
        candidates.append(explicit)
    for name in ("python3", "python"):
        found = shutil.which(name)
        if found:
            candidates.append(found)
    candidates.extend(["/opt/homebrew/bin/python3", "/usr/local/bin/python3", sys.executable])
    seen = set()
    for candidate in candidates:
        if not candidate or candidate in seen:
            continue
        seen.add(candidate)
        if not os.path.isfile(candidate) and not shutil.which(candidate):
            continue
        try:
            check = subprocess.run(
                [candidate, "-c", "import PIL; print(PIL.__version__)"],
                capture_output=True, text=True, timeout=30,
            )
        except (OSError, subprocess.SubprocessError):
            continue
        if check.returncode == 0:
            return candidate
    return None


def build_contact_sheets(meta_path, out_dir, python, ffmpeg):
    script = os.path.join(SCRIPT_DIR, "build-compare-sheet.py")
    if not os.path.isfile(script):
        log("WARN 找不到 %s，跳过接触表（PNG 与 meta 仍可用）" % script)
        return {}
    if not python:
        log("WARN 未找到带 Pillow 的 python3，跳过接触表（可用 build-compare-sheet.py 后补）")
        return {}
    command = [python, script, "--contact-only", "--meta", meta_path, "--out", out_dir]
    if ffmpeg:
        command.extend(["--ffmpeg", ffmpeg])
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=600)
    except (OSError, subprocess.SubprocessError) as error:
        log("WARN 接触表生成失败：%s" % error)
        return {}
    for line in (result.stdout or "").strip().splitlines():
        log("  sheet| " + line)
    if result.returncode != 0:
        tail = (result.stderr or "").strip().splitlines()[-6:]
        log("WARN 接触表生成失败（exit %d）：%s" % (result.returncode, " / ".join(tail)))
        return {}
    sheets = {}
    with open(meta_path, "r", encoding="utf-8") as handle:
        meta = json.load(handle)
    for view in meta.get("views", []) or list(meta.get("images", {}).keys()):
        path = os.path.join(out_dir, "%s-%s-sheet.jpg" % (meta.get("clipId"), view))
        if os.path.isfile(path):
            sheets[view] = path
    all_sheet = os.path.join(out_dir, "%s-sheet.jpg" % meta.get("clipId"))
    if os.path.isfile(all_sheet):
        sheets["all"] = all_sheet
    return sheets


# --------------------------------------------------------------------------------------
# 主流程
# --------------------------------------------------------------------------------------
def main():
    args = parse_args()
    notes = []
    clips_root = os.path.abspath(args["out"]) if args["out"] else os.getcwd()
    if args["out"]:
        os.makedirs(args["out"], exist_ok=True)

    import_fbx(args["fbx"], args["scene_fps"])
    armatures, meshes, objs = scene_inventory()
    log("scene: armatures=%d meshes=%d objects=%d actions=%d"
        % (len(armatures), len(meshes), len(objs), len(bpy.data.actions)))
    scene = bpy.context.scene
    fps = float(scene.render.fps) / float(scene.render.fps_base or 1.0)

    if args["debug"] or args["list_bones"]:
        for armature in armatures:
            log("armature %r bones=%d names=%s" % (armature.name, len(armature.data.bones),
                                                   ", ".join(b.name for b in armature.data.bones)))

    actions = list(bpy.data.actions)

    # ---- --list-actions：只盘点不渲染（真实数据到位后先跑这个确认 take 名/帧数/fps） ----
    if args["list_actions"] or args["list_bones"]:
        payload = {
            "fbx": os.path.abspath(args["fbx"]),
            "blender": bpy.app.version_string,
            "sceneFps": round(fps, 4),
            "armatures": [
                {
                    "name": armature.name,
                    "bones": len(armature.data.bones),
                    "objectScale": vec_round(armature.scale),
                    "parent": armature.parent.name if armature.parent else None,
                }
                for armature in armatures
            ],
            "meshes": [
                {"name": mesh.name, "vertices": len(mesh.data.vertices),
                 "parent": mesh.parent.name if mesh.parent else None,
                 "modifiers": [mod.type for mod in mesh.modifiers]}
                for mesh in meshes
            ],
            "actions": [
                {"name": action.name, "fcurves": len(action.fcurves),
                 "frameStart": round(action.frame_range[0], 3),
                 "frameEnd": round(action.frame_range[1], 3),
                 "frames": action_frames(action)[2]}
                for action in sorted(actions, key=lambda item: item.name)
            ],
        }
        if args["take"]:
            matcher = take_matcher(args["take"])
            payload["takeQuery"] = args["take"]
            payload["matches"] = [
                entry for entry in payload["actions"]
                if matcher(entry["name"])
            ]
        if args["list_bones"]:
            payload["bones"] = {
                armature.name: [bone.name for bone in armature.data.bones] for armature in armatures
            }
        print("LIST_ACTIONS_JSON " + json.dumps(payload, ensure_ascii=False), flush=True)
        for entry in payload["actions"]:
            marker = ""
            if args["take"] and take_matcher(args["take"])(entry["name"]):
                marker = "  <== take"
            log("  action %-70r fcurves=%-5d frames=%d..%d (%d)%s"
                % (entry["name"], entry["fcurves"], entry["frameStart"], entry["frameEnd"],
                   entry["frames"], marker))
        sys.exit(0)

    # ---- armature / action ----
    primary_arm = choose_armature(armatures, args["armature"])
    if len(armatures) > 1:
        notes.append("多 armature 场景：主 armature=%r（骨最多），其余 %s"
                     % (primary_arm.name, [a.name for a in armatures if a is not primary_arm]))
    assigned = bind_actions(objs, actions, args["take"], args["expect_frames"], primary_arm)
    primary_action_name = assigned.get(primary_arm.name)
    primary_action = bpy.data.actions.get(primary_action_name) if primary_action_name else None
    if primary_action is None:
        if not actions:
            if args["take"]:
                fail("FBX 里没有任何 action，--take %r 无意义（无动画文件请省略 --take）" % args["take"])
            notes.append("FBX 没有任何 animation action：按 rest/T-pose 静态渲染")
            primary_arm.animation_data_create()
            primary_arm.animation_data.action = None
        else:
            matcher = take_matcher(args["take"])
            candidates = [a for a in actions if matcher(a.name)] if args["take"] else list(actions)
            if not candidates:
                fail("没有 action 匹配 --take %r；先用 --list-actions 确认 action 名" % args["take"])
            primary_action = pick_action(candidates, args["take"], args["expect_frames"])
            if primary_action is None:
                fail("没有 action 匹配 --take %r" % args["take"])
            primary_arm.animation_data_create()
            primary_arm.animation_data.action = primary_action
            assigned[primary_arm.name] = primary_action.name
            notes.append("主 armature 的 action 由全局候选兜底匹配（无对象名前缀）")
    if primary_action is not None:
        start, end, frames_total = action_frames(primary_action)
        log("take=%r -> action=%r frames=%.1f..%.1f (%d) fps=%s"
            % (args["take"], primary_action.name, start, end, frames_total, fps))
        if args["expect_frames"] and abs(frames_total - args["expect_frames"]) > 2:
            notes.append("action 帧数 %d 与 --expect-frames %d 相差 >2" % (frames_total, args["expect_frames"]))
    else:
        start = end = float(scene.frame_start)
        frames_total = 1
        log("take=None -> 无 action（rest/T-pose 静态渲染）fps=%s" % fps)

    # ---- 模式 ----
    skinned = [m for m in meshes if any(mod.type == "ARMATURE" for mod in m.modifiers)]
    mode = args["mode"]
    if mode == "auto":
        mode = "mesh" if skinned else "skeleton"
    if mode == "mesh" and not meshes:
        fail("--mode mesh 但 FBX 里没有网格对象（纯骨架文件请用 --mode skeleton/auto）")
    log("mode=%s (skinned_meshes=%d / meshes=%d)" % (mode, len(skinned), len(meshes)))

    # ---- rest(T-pose) 包围盒 + 朝向（相机取景固定用） ----
    primary_arm.data.pose_position = "REST"
    bpy.context.view_layer.update()
    rest_bone_bbox = world_bbox_of_points(bone_world_points(primary_arm))
    rest_bone_bbox_body = world_bbox_of_points(bone_world_points(primary_arm, {b.name for b in split_bones(primary_arm, args["skeleton_filter"])}))
    rest_mesh_bbox = evaluated_mesh_world_points(meshes) if (mode == "mesh" and meshes) else None
    facing_detected, facing_source = detect_facing(primary_arm)
    primary_arm.data.pose_position = "POSE"
    bpy.context.view_layer.update()

    scale = unit_scale(primary_arm, rest_bone_bbox)
    body_bone_names = [b.name for b in split_bones(primary_arm, args["skeleton_filter"])]
    if mode == "mesh" and rest_mesh_bbox:
        # 与 VRM 预览一致：用（rest 姿态）网格包围盒取景，角色在画面里的占比可比
        framing_bbox = rest_mesh_bbox
    else:
        framing_bbox = rest_bone_bbox_body or rest_bone_bbox
    if framing_bbox is None:
        fail("无法计算 rest 包围盒")
    height = framing_bbox["size"][2]
    if height <= 1e-9:
        fail("rest 包围盒高度为 0（模型朝向/单位异常？）")
    center = Vector(framing_bbox["center"])
    log("rest height(world)=%.6f unitScale(world/local)=%.6f center=%s facing=%s(%s)"
        % (height, scale, vec_round(center), facing_name(facing_detected), facing_source))

    facing = parse_facing(args["facing"], facing_detected, notes)
    facing_used_name = facing_name(facing)

    # hips 高度（grounding/比例核对）
    hip_bones = list(primary_arm.data.bones)
    hip_bone = find_bone(hip_bones, [r"^Root_M$", r"(?i)^(hips?|pelvis)$", r"(?i)^bip0*1 pelvis$",
                                     r"(?i)pelvis$", r"(?i)hips"])
    hips_height = None
    if hip_bone is not None:
        hips_height = round(float((primary_arm.matrix_world @ hip_bone.head_local).z), 6)

    # ---- 帧计划 ----
    frame_specs = resolve_frames(args["frames"], args["frame_mode"], start, end, fps)

    # ---- 渲染环境 ----
    scene.render.fps = int(round(fps))
    scene.render.fps_base = 1.0
    engine_used = None
    for engine in (["workbench", "eevee", "cycles"] if args["engine"] == "auto" else [args["engine"]]):
        setup_engine(engine, args["res_x"], args["res_y"])
        engine_used = engine
        break
    if engine_used is None:
        fail("没有可用渲染引擎")

    # ---- 预采样每帧包围盒（决定 auto 地板高度 + 写 meta；渲染循环复用避免重复求值） ----
    frame_pre = []
    for spec in frame_specs:
        scene.frame_set(spec["frameWhole"], subframe=spec["subframe"])
        bpy.context.view_layer.update()
        bones_bbox = world_bbox_of_points(pose_bone_world_points(primary_arm))
        body_bones_bbox = world_bbox_of_points(pose_bone_world_points(primary_arm, set(body_bone_names)))
        mesh_bbox = evaluated_mesh_world_points(meshes) if (mode == "mesh" and meshes) else None
        frame_pre.append({"bones": bones_bbox, "bodyBones": body_bones_bbox, "mesh": mesh_bbox})

    # ---- 地板高度（默认 auto：落在各帧最低点，保证不穿地、贴地残差可读） ----
    if isinstance(args["floor_z"], str) and args["floor_z"] == "auto":
        if mode == "mesh" and rest_mesh_bbox:
            candidates = [rest_mesh_bbox["min"][2]]
            candidates.extend(pre["mesh"]["min"][2] for pre in frame_pre if pre["mesh"])
        else:
            candidates = [rest_bone_bbox_body["min"][2]] if rest_bone_bbox_body else []
            candidates.extend(pre["bodyBones"]["min"][2] for pre in frame_pre if pre["bodyBones"])
        floor_z = min(candidates) if candidates else 0.0
        notes.append("绘制地板 auto，取 rest/各帧最低点 floorZ=%.6f（world；仅为可视化基准，"
                     "grounding 残差仍按地面 groundZ=%.6f 计）" % (floor_z, args["ground_z"]))
    else:
        floor_z = float(args["floor_z"])
    log("floorZ=%.6f (requested=%r)" % (floor_z, args["floor_z"]))

    ground_objects = build_floor_and_grid(center, height, floor_z,
                                          no_floor=args["no_floor"], no_grid=args["no_grid"])
    backdrop = create_backdrop(center, height)
    view_dirs = view_direction_map(facing)
    closeups = closeup_views(primary_arm, view_dirs, height, floor_z, args["views"])
    for view in args["views"]:
        if view in ("hand", "feet"):
            if view not in closeups:
                notes.append("view %r 未找到对应骨（wrist/hand/palm 或 ankle/foot），已跳过" % view)

    # ---- 相机 ----
    camera_data = bpy.data.cameras.new("qa-camera-data")
    camera = bpy.data.objects.new("qa-camera", camera_data)
    scene.collection.objects.link(camera)
    scene.camera = camera
    camera_data.type = "ORTHO"
    aspect = float(args["res_x"]) / float(args["res_y"])
    main_scale = max(
        height * args["margin"],
        max(
            projected_width(framing_bbox, view_dirs[view]) * args["margin"] / max(aspect, 1e-6)
            for view in args["views"] if view in view_dirs
        ) if any(view in view_dirs for view in args["views"]) else 0.0,
    )
    distance = max(height * 8.0, 1e-6)
    camera_data.clip_start = max(height * 0.001, 1e-9)
    camera_data.clip_end = distance * 40.0
    view_camera = {}
    for view in args["views"]:
        if view in view_dirs:
            direction = view_dirs[view]
            view_camera[view] = {"direction": vec_round(direction), "ortho": main_scale}
        elif view in closeups:
            view_camera[view] = {
                "direction": vec_round(closeups[view]["direction"]),
                "ortho": closeups[view]["ortho"],
            }
        else:
            continue
        position = center + (view_dirs.get(view) or closeups[view]["direction"]) * distance
        if view in closeups:
            position = closeups[view]["center"] + closeups[view]["direction"] * distance
            view_camera[view]["center"] = vec_round(closeups[view]["center"])
            if closeups[view].get("trackBone"):
                view_camera[view]["trackBone"] = closeups[view]["trackBone"]
                view_camera[view]["bone"] = closeups[view]["bone"]
        else:
            view_camera[view]["center"] = vec_round(center)
        view_camera[view]["location"] = vec_round(position)
    if not view_camera:
        fail("没有可渲染的 view")

    # ---- 骨架可视化对象 ----
    skeleton_objects = None
    skeleton_bone_names = []
    if mode == "skeleton":
        skeleton_bone_names = [b.name for b in split_bones(primary_arm, args["skeleton_filter"])]
        joint_obj, bone_obj, radius_joint, radius_bone = create_skeleton_objects(primary_arm, skeleton_bone_names, height)
        skeleton_objects = (joint_obj, bone_obj, radius_joint, radius_bone)
        for mesh in meshes:
            mesh.hide_render = True
        for obj in objs:
            if obj.type in ("MESH",) and obj not in (joint_obj, bone_obj):
                obj.hide_render = True
    elif mode == "mesh":
        for mesh in meshes:
            mesh.hide_render = False

    # ---- 逐帧渲染 ----
    clip_id = args["clip_id"] or re.sub(r"[^0-9A-Za-z._-]+", "-", args["take"] or "clip").strip("-") or "clip"
    out_dir = os.path.abspath(args["out"])
    images = {view: [] for view in view_camera}
    frame_meta = []
    started = time.time()
    for spec, pre in zip(frame_specs, frame_pre):
        scene.frame_set(spec["frameWhole"], subframe=spec["subframe"])
        bpy.context.view_layer.update()
        bones_bbox = pre["bones"]
        mesh_bbox = pre["mesh"]
        frame_boxes = bbox_union(bones_bbox, mesh_bbox)
        if skeleton_objects:
            update_skeleton_geometry(primary_arm, skeleton_bone_names, *skeleton_objects)
            bpy.context.view_layer.update()
        key_bones = {}
        for label, patterns in (
            ("hips", [r"^Root_M$", r"(?i)^(hips?|pelvis)$", r"(?i)^bip0*1 pelvis$", r"(?i)pelvis$", r"(?i)hips"]),
            ("head", [r"(?i)^Head_M$", r"(?i)^bip0*1 head$", r"(?i)^head$", r"(?i)head"]),
            ("handL", [r"(?i)^Wrist_L$", r"(?i)^Palm_L$", r"(?i)^bip0*1 l hand$", r"(?i)^l hand$",
                       r"(?i)hand.*_L$", r"(?i)wrist.*_L$"]),
            ("handR", [r"(?i)^Wrist_R$", r"(?i)^Palm_R$", r"(?i)^bip0*1 r hand$", r"(?i)^r hand$",
                       r"(?i)hand.*_R$", r"(?i)wrist.*_R$"]),
            ("footL", [r"(?i)^Ankle_L$", r"(?i)^Foot_L$", r"(?i)^bip0*1 l foot$", r"(?i)^l foot$",
                       r"(?i)foot.*_L$", r"(?i)ankle.*_L$"]),
            ("footR", [r"(?i)^Ankle_R$", r"(?i)^Foot_R$", r"(?i)^bip0*1 r foot$", r"(?i)^r foot$",
                       r"(?i)foot.*_R$", r"(?i)ankle.*_R$"]),
        ):
            bone = find_bone(list(primary_arm.data.bones), patterns)
            if bone is not None:
                pose_bone = primary_arm.pose.bones.get(bone.name)
                if pose_bone is not None:
                    key_bones[label] = vec_round(primary_arm.matrix_world @ pose_bone.head)
        frame_meta.append({
            "label": spec["label"],
            "frame": spec["frame"],
            "timeSec": spec["timeSec"],
            "bboxBones": bones_bbox,
            "bboxMesh": mesh_bbox,
            "bbox": frame_boxes,
            "height": frame_boxes["size"][2] if frame_boxes else None,
            "minZ": frame_boxes["min"][2] if frame_boxes else None,
            "minZMesh": mesh_bbox["min"][2] if mesh_bbox else None,
            "minZBones": bones_bbox["min"][2] if bones_bbox else None,
            # grounding 残差口径 = 最低点 - 地面世界 Z（默认 0，即源数据的落地基准；--ground-z 可改）
            "groundingResidual": round(
                (mesh_bbox["min"][2] if mesh_bbox else bones_bbox["min"][2]) - args["ground_z"], 6
            ) if (mesh_bbox or bones_bbox) else None,
            "visualFloorResidual": round(
                (mesh_bbox["min"][2] if mesh_bbox else bones_bbox["min"][2]) - floor_z, 6
            ) if (mesh_bbox or bones_bbox) else None,
            "keyBones": key_bones,
        })
        for view in view_camera:
            info = view_camera[view]
            direction = Vector(info["direction"])
            cam_center = Vector(info["center"])
            # hand/feet 特写：相机跟随当前帧的手/脚骨（主视图保持 rest 固定机位）
            if info.get("trackBone"):
                track = primary_arm.pose.bones.get(info["trackBone"])
                if track is not None:
                    cam_center = primary_arm.matrix_world @ track.head
                    if view == "feet":
                        cam_center = Vector((cam_center.x, cam_center.y, floor_z + height * 0.07))
            camera.location = cam_center + direction * distance
            camera.rotation_euler = (-direction).normalized().to_track_quat("-Z", "Y").to_euler()
            camera_data.ortho_scale = info["ortho"]
            camera_data.clip_start = max(height * 0.001, 1e-9)
            camera_data.clip_end = distance * 40.0
            # 背景板放到角色背后
            backdrop.location = cam_center - direction * (distance * 0.5)
            backdrop.rotation_euler = direction.to_track_quat("Z", "Y").to_euler()
            filepath = os.path.join(out_dir, "%s-%s-%s.png" % (clip_id, view, spec["label"]))
            scene.render.filepath = filepath
            bpy.ops.render.render(write_still=True)
            images[view].append({
                "label": spec["label"],
                "frame": spec["frame"],
                "timeSec": spec["timeSec"],
                "path": filepath,
            })
        log("rendered %-8s frame=%-10s time=%ss -> %d views"
            % (spec["label"], spec["frame"], spec["timeSec"], len(view_camera)))
    elapsed = time.time() - started
    log("render done %.1fs (%d frames x %d views)" % (elapsed, len(frame_specs), len(view_camera)))

    # ---- meta ----
    meta = {
        "schemaVersion": 1,
        "generatedAt": datetime.datetime.now().astimezone().isoformat(),
        "blender": bpy.app.version_string,
        "fbx": os.path.abspath(args["fbx"]),
        "clipId": clip_id,
        "mode": mode,
        "engine": engine_used,
        "views": list(view_camera),
        "sceneFps": round(fps, 4),
        "armature": {
            "name": primary_arm.name,
            "bones": len(primary_arm.data.bones),
            "objectScale": vec_round(primary_arm.scale),
            "worldMatrix": [[round(float(v), 6) for v in row] for row in primary_arm.matrix_world],
        },
        "armatures": [
            {"name": armature.name, "bones": len(armature.data.bones),
             "objectScale": vec_round(armature.scale),
             "assignedAction": assigned.get(armature.name)}
            for armature in armatures
        ],
        "meshes": [
            {"name": mesh.name, "vertices": len(mesh.data.vertices),
             "parent": mesh.parent.name if mesh.parent else None,
             "modifiers": [mod.type for mod in mesh.modifiers]}
            for mesh in meshes
        ],
        "action": {
            "name": primary_action.name if primary_action is not None else None,
            "frameStart": round(start, 4),
            "frameEnd": round(end, 4),
            "frames": frames_total,
            "fcurves": len(primary_action.fcurves) if primary_action is not None else 0,
            "takeQuery": args["take"],
            "expectFrames": args["expect_frames"],
        },
        "assignedActions": assigned,
        "unitScaleWorldPerLocal": round(scale, 9),
        "facing": {
            "detected": facing_name(facing_detected),
            "source": facing_source,
            "used": facing_used_name,
            "vector": vec_round(facing),
        },
        "rest": {
            "boneBboxAll": rest_bone_bbox,
            "boneBboxBody": rest_bone_bbox_body,
            "meshBbox": rest_mesh_bbox,
            "framingBbox": framing_bbox,
            "heightWorld": round(height, 9),
            "heightLocalApprox": round(height / scale, 6) if scale else None,
            "hipsHeightWorld": hips_height,
            "floorZ": floor_z,
            "groundZ": args["ground_z"],
        },
        "camera": {
            "type": "ortho",
            "aspect": round(aspect, 6),
            "orthoScale": round(main_scale, 9),
            "distance": round(distance, 9),
            "views": view_camera,
        },
        "frames": frame_meta,
        "images": images,
        "notes": notes,
        "renderSeconds": round(elapsed, 2),
    }
    meta_path = os.path.join(out_dir, "render-meta.json")
    with open(meta_path, "w", encoding="utf-8") as handle:
        json.dump(meta, handle, ensure_ascii=False, indent=2)
    log("meta -> %s" % meta_path)

    # ---- 接触表 ----
    if not args["no_sheet"]:
        python = find_pillow_python(args["sheet_python"])
        sheets = build_contact_sheets(meta_path, out_dir, python, args["ffmpeg"])
        if sheets:
            meta["sheets"] = sheets
            with open(meta_path, "w", encoding="utf-8") as handle:
                json.dump(meta, handle, ensure_ascii=False, indent=2)
            for view, path in sheets.items():
                log("sheet %-13s -> %s" % (view, path))
    if not args["no_sheet"] and "sheets" not in meta:
        log("WARN 没有生成接触表（缺 Pillow 或 build-compare-sheet.py 失败）")

    summary = {
        "ok": True,
        "clipId": clip_id,
        "action": primary_action.name if primary_action is not None else None,
        "frames": len(frame_specs),
        "views": list(view_camera),
        "engine": engine_used,
        "mode": mode,
        "out": out_dir,
        "metaPath": meta_path,
        "sheets": meta.get("sheets", {}),
        "restHeightWorld": round(height, 9),
        "fps": round(fps, 4),
    }
    print("RENDER_META " + json.dumps(summary, ensure_ascii=False), flush=True)
    log("OK %s frames=%d views=%d out=%s" % (clip_id, len(frame_specs), len(view_camera), out_dir))


main()
