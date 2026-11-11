"""合成 3ds Max Biped FBX 夹具（Blender 4.2 headless，dev-only）

用途：在真实 3ds Max Biped FBX（每个 .max 一个 FBX，Bip2FBX 骨名）到位前，
生成一个"仿 Biped"骨架 + 蒙皮网格 + 两段已知动作的夹具，交给
`extract-biped-anims.py` 端到端验证采样结果。

生成物（默认 work/adv-biped/fixture/）：
  biped-anim-skel.fbx       30fps，2 个 take，无网格（= 真实全量导出 skel 场景）
  biped-anim-full.fbx       30fps，2 个 take，带简易蒙皮网格（= pilot full 场景）
  biped-anim-60fps.fbx      60fps，2 个 take，无网格（验证帧率自动识别/降采样/末尾补帧）
  biped-tpose.fbx           30fps，无任何动画（验证 Tpose 兼容：clips 为空不报错）
  biped-anim-multi.fbx      30fps，2 个 take，但场景里多一个 armature（验证多 armature 降级）
  biped-anim-generic.fbx    30fps，2 个 take，骨名去掉 Bip001 前缀（验证非 BipXXX 根骨降级）
  fixture.json              夹具说明：骨名/层级/rest（导出后重导入实测）、动作帧范围、
                            设计常量、各 take 的期望采样数与已知帧期望值（供验证脚本断言）

骨架（Y-up 数据空间，物体 rotX=90°，与真实 Biped FBX 经 Blender 导入后的空间约定一致；
66 根骨 + 1 个 "Bip001 Footsteps" 空物体 = 与真实 .max 的 67 个 Bip001* 节点一致）：
  Bip001
  └ Bip001 Pelvis
    ├ Bip001 Spine → Spine1 → Spine2 → Neck → Head → HeadNub
    │                              └ (L/R) Clavicle → UpperArm → Forearm → Hand
    │                                                          └ Finger0/01/02/0Nub, Finger1/11/12/1Nub, ... Finger4/41/42/4Nub
    └ (L/R) Thigh → Calf → Foot → Toe0 → Toe0Nub
动作（设计常量，验证脚本按 ≤0.5° 断言）：
  take A "Adv_Ani_TestArmRaise"（1.0s，loop）：
    0.0s T-pose → 0.5s 双臂上举 90°（数据空间绕 Z 轴）+ 十指中/末节弯曲 60°/40° → 1.0s 回 T-pose
  take B "Adv_Ani_TestHipsTurn"（2.0s，非 loop）：
    0.0s 基准 → 1.0s Pelvis 水平位移 |(0,0.10,0.05)|=0.1118m + 绕竖直轴转身 90°、
    Spine1 局部扭转 15°、Head 局部转 30°、Bip001 根骨前移 0.2m → 保持到末帧
  60fps 版本 B 的末帧取 2.0167s（奇数跨度），用于验证非 loop clip 的"采样末帧补齐"分支。

用法：
  BLENDER=/Volumes/4TB外置盘/deepseek-harness/tools/blender/Blender.app/Contents/MacOS/Blender
  "$BLENDER" -b --factory-startup --python scripts/vrm/motion/build-biped-fixture.py -- \
    --out work/adv-biped/fixture
"""
import bpy
import json
import math
import os
import sys
import datetime
from mathutils import Matrix, Quaternion, Vector

BLENDER_VERSION = bpy.app.version_string
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

# 骨架设计：Y-up 数据空间（up=+Y，角色面朝 +Z，左侧=+X），物体 rotX=90° 后在世界中站立。
# 命名/层级对齐真实 3ds Max Biped（见 docs/research/max-windows-routes.md §1.2：67 个 Bip001* 节点）。
def quat_list(quat, digits=9):
    """Mathutils Quaternion 的迭代顺序是 (w,x,y,z)；samples.json 约定 (x,y,z,w)。"""
    return [round(quat.x, digits), round(quat.y, digits), round(quat.z, digits), round(quat.w, digits)]


ROOT_BONE = "Bip001"
SIDES = (("L", 1.0), ("R", -1.0))


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    out = {"out": os.path.join(REPO_ROOT, "work", "adv-biped", "fixture")}
    i = 0
    while i < len(argv):
        if argv[i] == "--out" and i + 1 < len(argv):
            out["out"] = argv[i + 1]
            i += 2
        else:
            i += 1
    return out


# --------------------------------------------------------------------------
# 骨架定义
# --------------------------------------------------------------------------

def bone_specs():
    """返回 [(name, head, tail, parent, deform)]，坐标在 Y-up 数据空间。"""
    specs = []

    def add(name, head, tail, parent, deform=True):
        specs.append((name, tuple(head), tuple(tail), parent, deform))

    add("Bip001", (0, 0, 0), (0, 0.20, 0), None)
    add("Bip001 Pelvis", (0, 0.95, 0), (0, 1.05, 0), "Bip001")
    add("Bip001 Spine", (0, 1.05, 0), (0, 1.17, 0), "Bip001 Pelvis")
    add("Bip001 Spine1", (0, 1.17, 0), (0, 1.29, 0), "Bip001 Spine")
    add("Bip001 Spine2", (0, 1.29, 0), (0, 1.42, 0), "Bip001 Spine1")
    add("Bip001 Neck", (0, 1.42, 0), (0, 1.52, 0), "Bip001 Spine2")
    add("Bip001 Head", (0, 1.52, 0), (0, 1.70, 0), "Bip001 Neck")
    add("Bip001 HeadNub", (0, 1.70, 0), (0, 1.78, 0), "Bip001 Head", deform=False)
    for side, sign in SIDES:
        add("Bip001 %s Clavicle" % side, (sign * 0.04, 1.40, 0), (sign * 0.15, 1.40, 0), "Bip001 Spine2")
        add("Bip001 %s UpperArm" % side, (sign * 0.15, 1.40, 0), (sign * 0.42, 1.40, 0), "Bip001 %s Clavicle" % side)
        add("Bip001 %s Forearm" % side, (sign * 0.42, 1.40, 0), (sign * 0.66, 1.40, 0), "Bip001 %s UpperArm" % side)
        add("Bip001 %s Hand" % side, (sign * 0.66, 1.40, 0), (sign * 0.74, 1.40, 0), "Bip001 %s Forearm" % side)
        add("Bip001 %s Thigh" % side, (sign * 0.10, 0.92, 0), (sign * 0.10, 0.50, 0), "Bip001 Pelvis")
        add("Bip001 %s Calf" % side, (sign * 0.10, 0.50, 0), (sign * 0.10, 0.08, 0), "Bip001 %s Thigh" % side)
        add("Bip001 %s Foot" % side, (sign * 0.10, 0.08, 0), (sign * 0.10, 0.03, 0.12), "Bip001 %s Calf" % side)
        add("Bip001 %s Toe0" % side, (sign * 0.10, 0.03, 0.12), (sign * 0.10, 0.02, 0.17), "Bip001 %s Foot" % side)
        add("Bip001 %s Toe0Nub" % side, (sign * 0.10, 0.02, 0.17), (sign * 0.10, 0.02, 0.20),
            "Bip001 %s Toe0" % side, deform=False)
        # 5 指 × 3 节 + Nub；官方命名：Finger0/Finger01/Finger02/Finger0Nub（Autodesk Biped Node Hierarchy）
        for finger in range(5):
            seg_lengths = (0.030, 0.022, 0.018) if finger == 0 else (0.052, 0.038, 0.026)
            z = (finger - 2.0) * 0.025
            x = sign * (0.735 + 0.003 * finger)
            parent = "Bip001 %s Hand" % side
            acc = 0.0
            for seg, length in enumerate(seg_lengths):
                name = "Bip001 %s Finger%d%s" % (side, finger, "" if seg == 0 else str(seg))
                head = (sign * (0.735 + 0.003 * finger + acc), 1.40, z)
                tail = (sign * (0.735 + 0.003 * finger + acc + length), 1.40, z)
                add(name, head, tail, parent)
                parent = name
                acc += length
            add("Bip001 %s Finger%dNub" % (side, finger),
                (sign * (0.735 + 0.003 * finger + acc), 1.40, z),
                (sign * (0.735 + 0.003 * finger + acc + 0.012), 1.40, z),
                parent, deform=False)
    return specs


def generic_name(name):
    """去掉 Bip001 前缀（-generic 变体，验证非 BipXXX 根骨）。"""
    if name == "Bip001":
        return "Root"
    if name.startswith("Bip001 "):
        return name[len("Bip001 "):]
    return name


def yup_to_zup(point):
    """Y-up 数据坐标 -> Z-up 数据坐标（世界下落方向保持一致；仅用于 -zup 变体）。"""
    return (point[0], -point[2], point[1])


def build_scene(fps, with_anim, with_mesh, extra_armature=False, generic_names=False, single_take=False,
                data_space="yup"):
    """构建骨架（+网格 +动作），返回 dict(arm=..., mesh=..., name_fn=...)。"""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.fps = fps
    scene.render.fps_base = 1.0
    scene.frame_start = 0
    scene.frame_end = 100

    name_fn = generic_name if generic_names else (lambda n: n)
    data_space = "zup" if data_space == "zup" else "yup"

    arm_data = bpy.data.armatures.new("BipedFixtureArmature")
    arm = bpy.data.objects.new("GenericRig" if generic_names else "Bip001", arm_data)
    scene.collection.objects.link(arm)
    # 默认：数据空间 Y-up + 物体 rotX=90°（与真实 Biped FBX 经 Blender 导入的约定一致）。
    # -zup 变体：数据空间 Z-up + 物体恒等（Blender 自产 FBX 重导入的约定，用于覆盖竖直轴探测）。
    arm.rotation_euler = (0.0, 0.0, 0.0) if data_space == "zup" else (math.radians(90.0), 0.0, 0.0)
    bpy.context.view_layer.objects.active = arm
    arm.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    edit_bones = arm_data.edit_bones
    specs = bone_specs()
    if data_space == "zup":
        specs = [(name, yup_to_zup(head), yup_to_zup(tail), parent, deform)
                 for name, head, tail, parent, deform in specs]
    for name, head, tail, parent, deform in specs:
        eb = edit_bones.new(name_fn(name))
        eb.head = head
        eb.tail = tail
        eb.use_deform = deform
        if parent:
            eb.parent = edit_bones[name_fn(parent)]
            eb.use_connect = False
    bpy.ops.object.mode_set(mode="OBJECT")
    bone_rest = {}
    for bone in arm_data.bones:
        bone_rest[bone.name] = {
            "head": [round(v, 8) for v in bone.head_local],
            "tail": [round(v, 8) for v in bone.tail_local],
            "parent": name_fn(bone.parent.name) if bone.parent else None,
            "quat": quat_list(bone.matrix_local.to_quaternion()),
            "deform": bone.use_deform,
        }
    if len(specs) != len(arm_data.bones):
        raise SystemExit("骨骼创建数量不符：期望 %d，实际 %d" % (len(specs), len(arm_data.bones)))

    # ---- 简易蒙皮网格（每根 deform 骨一个细长盒，整盒 100% 绑到该骨）----
    mesh_obj = None
    if with_mesh:
        mesh_obj = build_skin_mesh(arm, specs, name_fn)

    # ---- "Bip001 Footsteps" 辅助空物体（真实 Biped 场景必带；采样器应忽略）----
    footsteps = bpy.data.objects.new(name_fn("Bip001 Footsteps"), None)
    footsteps.empty_display_type = "PLAIN_AXES"
    footsteps.empty_display_size = 0.05
    scene.collection.objects.link(footsteps)

    if extra_armature:
        extra_data = bpy.data.armatures.new("PropRigArmature")
        extra = bpy.data.objects.new("PropRig", extra_data)
        scene.collection.objects.link(extra)
        bpy.context.view_layer.objects.active = extra
        extra.select_set(True)
        bpy.ops.object.mode_set(mode="EDIT")
        pb0 = extra_data.edit_bones.new("prop_root")
        pb0.head = (0.4, 0.0, 0.0)
        pb0.tail = (0.4, 0.0, 0.2)
        pb1 = extra_data.edit_bones.new("prop_tip")
        pb1.head = (0.4, 0.0, 0.2)
        pb1.tail = (0.4, 0.0, 0.3)
        pb1.parent = pb0
        bpy.ops.object.mode_set(mode="OBJECT")
        extra.select_set(False)

    if with_anim:
        build_actions(arm, fps, name_fn)
        if single_take:
            # 真实 3ds Max 每文件通常只有 1 个 take（名多为 Take 001）：留单 take 变体验证回退逻辑
            action_b = bpy.data.actions.get(TAKE_B)
            if action_b is not None:
                bpy.data.actions.remove(action_b)

    bpy.context.view_layer.objects.active = arm
    return {
        "arm": arm,
        "arm_data": arm_data,
        "mesh": mesh_obj,
        "name_fn": name_fn,
        "rest": bone_rest,
        "fps": fps,
        "data_space": data_space,
        "specs": specs,
        "extra_armature": extra_armature,
    }


def build_skin_mesh(arm, specs, name_fn):
    """每根 deform 骨生成一个细盒并合成单网格；顶点在数据空间，网格物体世界变换 = armature 物体变换。"""
    verts = []
    faces = []
    group_ranges = {}
    radius = 0.012
    rot_world = arm.matrix_world.copy()
    for name, head, tail, parent, deform in specs:
        if not deform:
            continue
        h = Vector(head)
        t = Vector(tail)
        d = (t - h)
        length = d.length
        if length < 1e-6:
            continue
        d.normalize()
        up = Vector((0.0, 0.0, 1.0)) if abs(d.z) < 0.9 else Vector((0.0, 1.0, 0.0))
        u = (up.cross(d)).normalized() * radius
        v = (d.cross(u)).normalized() * radius
        base = len(verts)
        for tf in (0.05, 0.95):
            center = h + d * (length * tf)
            for su, sv in ((-1, -1), (-1, 1), (1, 1), (1, -1)):
                p_data = center + u * su + v * sv
                p_world = rot_world @ p_data
                verts.append((p_world.x, p_world.y, p_world.z))
        faces.extend([
            (base + 0, base + 1, base + 2, base + 3),
            (base + 4, base + 5, base + 6, base + 7),
            (base + 0, base + 1, base + 5, base + 4),
            (base + 1, base + 2, base + 6, base + 5),
            (base + 2, base + 3, base + 7, base + 6),
            (base + 3, base + 0, base + 4, base + 7),
        ])
        group_ranges[name_fn(name)] = list(range(base, base + 8))

    mesh = bpy.data.meshes.new("AventurineW_BodyMesh")
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    mesh_obj = bpy.data.objects.new("GenericBody" if name_fn("Bip001") == "Root" else "AventurineW_Body", mesh)
    bpy.context.scene.collection.objects.link(mesh_obj)
    for group_name, indices in group_ranges.items():
        vg = mesh_obj.vertex_groups.new(name=group_name)
        vg.add(indices, 1.0, "REPLACE")
    modifier = mesh_obj.modifiers.new("Armature", "ARMATURE")
    modifier.object = arm
    mesh_obj.parent = arm
    # arm 物体带 rotX=90°；用 parent inverse 抵消，使网格物体世界变换保持单位矩阵（顶点已是世界坐标）
    mesh_obj.matrix_parent_inverse = arm.matrix_world.inverted()
    return mesh_obj


# --------------------------------------------------------------------------
# 动作设计（帧计划 / 设计常量）
# --------------------------------------------------------------------------
# 30fps: A 0-30（1s, loop），B 0-60（2s, 非 loop）
# 60fps: A 0-60（1s, loop），B 0-121（2.0167s, 非 loop，奇数跨度以验证"末尾补帧"）
FRAME_PLANS = {
    30: {"A": (0, 15, 30), "B": (0, 30, 60)},
    60: {"A": (0, 30, 60), "B": (0, 60, 121)},
}
TAKE_A = "Adv_Ani_TestArmRaise"
TAKE_B = "Adv_Ani_TestHipsTurn"
TAKE_NAMES = (TAKE_A, TAKE_B)

DESIGN = {
    "armRaiseDeg": 90.0,
    "fingerCurlDeg": {"Finger01": 60.0, "Finger02": 40.0},
    "hipsTurnDeg": 90.0,
    "spineTwistDeg": 15.0,
    "headTurnDeg": 30.0,
    "hipsShiftMeters": 0.1118033989,  # |(0, 0.10, 0.05)|
    "rootShiftMeters": 0.2,
    "pelvisWorldShiftMeters": 0.2692582404,  # |(0, 0.10, 0.25)|
}


def basis_rot(bone, axis, degrees):
    """返回让骨骼在 armature 空间绕 axis 转 degrees 的 pose basis 四元数（父骨静止时成立）。"""
    rest = bone.matrix_local.to_quaternion()
    delta = Quaternion(Vector(axis).normalized(), math.radians(degrees))
    return rest.inverted() @ delta @ rest


def basis_loc(bone, delta_data):
    """返回让骨骼在 armature 空间产生 delta_data 位移的 pose location（父骨静止时成立）。"""
    rest = bone.matrix_local.to_quaternion()
    return rest.inverted() @ Vector(delta_data)


def animated_bone_names(name_fn):
    names = [name_fn("Bip001")]
    for side, _sign in SIDES:
        names.append(name_fn("Bip001 %s UpperArm" % side))
        for finger in range(5):
            names.append(name_fn("Bip001 %s Finger%d1" % (side, finger)))
            names.append(name_fn("Bip001 %s Finger%d2" % (side, finger)))
    names += [name_fn("Bip001 Pelvis"), name_fn("Bip001 Spine1"), name_fn("Bip001 Head")]
    # 去重保序
    seen = set()
    uniq = []
    for n in names:
        if n not in seen:
            seen.add(n)
            uniq.append(n)
    return uniq


def pose_values_for_take(take, progress, arm, name_fn):
    """返回 {bone_name: (quat_basis, location_or_None)}。progress∈[0,1] 为动作进度（0=起手,1=中段峰值）。"""
    values = {}
    for bone in arm.data.bones:
        values[bone.name] = (Quaternion((1.0, 0.0, 0.0, 0.0)), None)

    def set_rot(bone_name, axis, degrees):
        bone = arm.data.bones[bone_name]
        values[bone_name] = (basis_rot(bone, axis, degrees), values[bone_name][1])

    if take is None:
        return values

    if take == TAKE_A:
        deg = DESIGN["armRaiseDeg"] * progress
        set_rot(name_fn("Bip001 L UpperArm"), (0, 0, 1), deg)
        set_rot(name_fn("Bip001 R UpperArm"), (0, 0, 1), -deg)
        for side, sign in SIDES:
            for finger in range(5):
                set_rot(name_fn("Bip001 %s Finger%d1" % (side, finger)), (0, 0, 1),
                        -sign * DESIGN["fingerCurlDeg"]["Finger01"] * progress)
                set_rot(name_fn("Bip001 %s Finger%d2" % (side, finger)), (0, 0, 1),
                        -sign * DESIGN["fingerCurlDeg"]["Finger02"] * progress)
    elif take == TAKE_B:
        pelvis = arm.data.bones[name_fn("Bip001 Pelvis")]
        values[pelvis.name] = (
            basis_rot(pelvis, (0, 1, 0), DESIGN["hipsTurnDeg"] * progress),
            basis_loc(pelvis, (0, 0.10 * progress, 0.05 * progress)),
        )
        set_rot(name_fn("Bip001 Spine1"), (0, 1, 0), DESIGN["spineTwistDeg"] * progress)
        set_rot(name_fn("Bip001 Head"), (0, 1, 0), DESIGN["headTurnDeg"] * progress)
        root = arm.data.bones[name_fn("Bip001")]
        values[root.name] = (
            values[root.name][0],
            basis_loc(root, (0, 0, DESIGN["rootShiftMeters"] * progress)),
        )
    return values


def build_actions(arm, fps, name_fn):
    plan = FRAME_PLANS[fps]
    anim = arm.animation_data_create()
    animated = animated_bone_names(name_fn)
    actions = {}
    for take, frames in ((TAKE_A, plan["A"]), (TAKE_B, plan["B"])):
        f0, f_mid, f1 = frames
        action = bpy.data.actions.new(take)
        action.use_fake_user = True
        action.use_frame_range = True
        action.frame_start = f0
        action.frame_end = f1
        anim.action = action
        for frame, progress in ((f0, 0.0), (f_mid, 1.0), (f1, 1.0 if take == TAKE_B else 0.0)):
            values = pose_values_for_take(take, progress, arm, name_fn)
            for bone_name in animated:
                pose_bone = arm.pose.bones[bone_name]
                quat, loc = values.get(bone_name, (Quaternion((1.0, 0.0, 0.0, 0.0)), None))
                pose_bone.rotation_mode = "QUATERNION"
                pose_bone.rotation_quaternion = quat
                pose_bone.keyframe_insert("rotation_quaternion", frame=frame)
                if loc is not None or bone_name in (name_fn("Bip001"), name_fn("Bip001 Pelvis")):
                    pose_bone.location = loc if loc is not None else Vector((0.0, 0.0, 0.0))
                    pose_bone.keyframe_insert("location", frame=frame)
        actions[take] = action
    anim.action = None
    # 清空 pose，避免残值
    for pose_bone in arm.pose.bones:
        pose_bone.rotation_quaternion = Quaternion((1.0, 0.0, 0.0, 0.0))
        pose_bone.location = Vector((0.0, 0.0, 0.0))
    return actions


# --------------------------------------------------------------------------
# 采样 / 探针（设计验证 + 导出后实测记录）
# --------------------------------------------------------------------------

def q_angle_deg(qa, qb):
    dot = abs(qa.normalized().dot(qb.normalized()))
    dot = max(-1.0, min(1.0, dot))
    return math.degrees(2.0 * math.acos(dot))


def unconnect_all(arm):
    """断开所有 use_connect（Blender FBX importer 会在骨 head 与父骨 tail 重合时标记 connected，
    而 connected bone 的 pose location 会被忽略 -> 位置动画丢失；真实 Biped FBX 也可能触发）。
    断开不改变 rest head/矩阵，只让 location 曲线生效。"""
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


def snapshot_local_quat(snapshot, bone_name):
    item = snapshot[bone_name]
    parent = item["parent"]
    if parent is None:
        return item["quat"]
    return snapshot[parent]["quat"].inverted() @ item["quat"]


def evaluate_pose(arm, action, frame):
    """返回该帧所有骨的快照 {name: {quat, trans, parent}}（不能存 PoseBone 引用，会随 frame_set 变化）。"""
    anim = arm.animation_data or arm.animation_data_create()
    anim.action = action
    bpy.context.scene.frame_set(int(frame))
    bpy.context.view_layer.update()
    snapshot = {}
    for pose_bone in arm.pose.bones:
        matrix = pose_bone.matrix.copy()
        snapshot[pose_bone.name] = {
            "quat": matrix.to_quaternion(),
            "trans": matrix.translation.copy(),
            "parent": pose_bone.parent.name if pose_bone.parent else None,
        }
    return snapshot


def probe_specs():
    """设计探针（from/to 以秒表示；toEnd=True 表示动作末帧）。"""
    probes = []
    for side in ("L", "R"):
        probes.append({"id": "%s_upperArm_raise" % side, "take": TAKE_A, "kind": "localRelAngleDeg",
                       "bone": "Bip001 %s UpperArm" % side, "fromSec": 0.0, "toSec": 0.5,
                       "designDeg": DESIGN["armRaiseDeg"]})
    for side in ("L", "R"):
        for finger_name, deg in (("Finger01", 60.0), ("Finger02", 40.0)):
            probes.append({"id": "%s_%s_curl" % (side, finger_name), "take": TAKE_A, "kind": "localRelAngleDeg",
                           "bone": "Bip001 %s %s" % (side, finger_name), "fromSec": 0.0, "toSec": 0.5,
                           "designDeg": deg})
    probes.append({"id": "A_loop_first_last", "take": TAKE_A, "kind": "loopMaxAngleDeg", "designMaxDeg": 0.01})
    probes += [
        {"id": "B_pelvis_turn", "take": TAKE_B, "kind": "localRelAngleDeg", "bone": "Bip001 Pelvis",
         "fromSec": 0.0, "toSec": 1.0, "designDeg": DESIGN["hipsTurnDeg"]},
        {"id": "B_spine1_twist", "take": TAKE_B, "kind": "localRelAngleDeg", "bone": "Bip001 Spine1",
         "fromSec": 0.0, "toSec": 1.0, "designDeg": DESIGN["spineTwistDeg"]},
        {"id": "B_head_turn", "take": TAKE_B, "kind": "localRelAngleDeg", "bone": "Bip001 Head",
         "fromSec": 0.0, "toSec": 1.0, "designDeg": DESIGN["headTurnDeg"]},
        {"id": "B_pelvis_head_offset", "take": TAKE_B, "kind": "headOffsetDeltaMeters", "bone": "Bip001 Pelvis",
         "refBone": "Bip001", "fromSec": 0.0, "toSec": 1.0, "designMeters": DESIGN["hipsShiftMeters"]},
        {"id": "B_pelvis_world_shift", "take": TAKE_B, "kind": "headDeltaMeters", "bone": "Bip001 Pelvis",
         "fromSec": 0.0, "toSec": 1.0, "designMeters": DESIGN["pelvisWorldShiftMeters"]},
        {"id": "B_root_shift", "take": TAKE_B, "kind": "headDeltaMeters", "bone": "Bip001",
         "fromSec": 0.0, "toSec": 1.0, "designMeters": DESIGN["rootShiftMeters"]},
        {"id": "B_pelvis_turn_hold", "take": TAKE_B, "kind": "localRelAngleDeg", "bone": "Bip001 Pelvis",
         "fromSec": 0.0, "toEnd": True, "designDeg": DESIGN["hipsTurnDeg"]},
    ]
    return probes


def resolve_probe_frames(probe, action, fps):
    start, end = action.frame_range
    from_frame = start + int(round(probe["fromSec"] * fps))
    if probe.get("toEnd"):
        to_frame = end
    else:
        to_frame = start + int(round(probe["toSec"] * fps))
    return from_frame, to_frame


def evaluate_probes(arm, action, probes, fps, name_fn=lambda n: n):
    """在给定 action 上计算探针实测值（= 期望值）。"""
    start, end = action.frame_range
    results = []
    cache = {}
    for probe in probes:
        kind = probe["kind"]
        if kind == "loopMaxAngleDeg":
            from_frame, to_frame = action.frame_range
            first = {name: item["quat"].copy() for name, item in evaluate_pose(arm, action, start).items()}
            last = {name: item["quat"].copy() for name, item in evaluate_pose(arm, action, end).items()}
            max_deg = max(q_angle_deg(first[name], last[name]) for name in first)
            expected = max_deg
        elif kind == "localRelAngleDeg":
            from_frame, to_frame = resolve_probe_frames(probe, action, fps)
            bone_name = name_fn(probe["bone"])
            cache[str(from_frame)] = cache.get(str(from_frame)) or evaluate_pose(arm, action, from_frame)
            cache[str(to_frame)] = cache.get(str(to_frame)) or evaluate_pose(arm, action, to_frame)
            q0 = snapshot_local_quat(cache[str(from_frame)], bone_name)
            q1 = snapshot_local_quat(cache[str(to_frame)], bone_name)
            expected = q_angle_deg(q0, q1)
        elif kind in ("headDeltaMeters", "headOffsetDeltaMeters"):
            from_frame, to_frame = resolve_probe_frames(probe, action, fps)
            bone_name = name_fn(probe["bone"])
            cache[str(from_frame)] = cache.get(str(from_frame)) or evaluate_pose(arm, action, from_frame)
            cache[str(to_frame)] = cache.get(str(to_frame)) or evaluate_pose(arm, action, to_frame)
            p0 = cache[str(from_frame)][bone_name]["trans"].copy()
            p1 = cache[str(to_frame)][bone_name]["trans"].copy()
            if kind == "headOffsetDeltaMeters":
                ref_name = name_fn(probe["refBone"])
                p0 = p0 - cache[str(from_frame)][ref_name]["trans"]
                p1 = p1 - cache[str(to_frame)][ref_name]["trans"]
            expected = (p1 - p0).length
        else:
            raise SystemExit("未知探针类型 %r" % kind)
        results.append({
            "id": probe["id"],
            "take": probe.get("take"),
            "kind": kind,
            "bone": probe.get("bone"),
            "refBone": probe.get("refBone"),
            "fromFrame": float(from_frame),
            "toFrame": float(to_frame),
            "design": probe.get("designDeg") if probe.get("designDeg") is not None else probe.get("designMeters"),
            "designMaxDeg": probe.get("designMaxDeg"),
            "expected": round(expected, 6),
        })
    return results


def verify_design(scene_ctx):
    """导出前：在设计动作上验证探针实测值 == 设计常量（容差：角度 0.05°，位移 1e-4 m）。"""
    arm = scene_ctx["arm"]
    fps = scene_ctx["fps"]
    name_fn = scene_ctx["name_fn"]
    report = {"checks": [], "maxAngleDeviationDeg": 0.0, "maxMetersDeviation": 0.0}
    for take in TAKE_NAMES:
        action = bpy.data.actions[take]
        probes = [p for p in probe_specs() if p.get("take") == take]
        for row in evaluate_probes(arm, action, probes, fps, name_fn):
            if row["kind"] == "loopMaxAngleDeg":
                ok = row["expected"] <= 0.05
                report["maxAngleDeviationDeg"] = round(max(report["maxAngleDeviationDeg"], row["expected"]), 6)
            elif row["kind"] == "localRelAngleDeg":
                dev = abs(row["expected"] - row["design"])
                report["maxAngleDeviationDeg"] = round(max(report["maxAngleDeviationDeg"], dev), 6)
                ok = dev <= 0.05
            else:
                dev = abs(row["expected"] - row["design"])
                report["maxMetersDeviation"] = round(max(report["maxMetersDeviation"], dev), 8)
                ok = dev <= 1e-4
            report["checks"].append({"id": row["id"], "expected": row["expected"],
                                     "design": row["design"], "ok": bool(ok)})
            if not ok:
                raise SystemExit("设计验证失败：%s 实测 %.6f vs 设计 %r" % (row["id"], row["expected"], row["design"]))
    report["ok"] = True
    return report


# --------------------------------------------------------------------------
# 导出 / 重导入录制
# --------------------------------------------------------------------------

def export_fbx(path, scene_ctx, with_anim):
    scene = bpy.context.scene
    scene.render.fps = scene_ctx["fps"]
    scene.render.fps_base = 1.0
    arm = scene_ctx["arm"]
    if arm.animation_data:
        arm.animation_data.action = None
    for pose_bone in arm.pose.bones:
        pose_bone.rotation_quaternion = Quaternion((1.0, 0.0, 0.0, 0.0))
        pose_bone.location = Vector((0.0, 0.0, 0.0))
    bpy.context.view_layer.objects.active = arm
    bpy.ops.export_scene.fbx(
        filepath=path,
        use_selection=False,
        bake_anim=with_anim,
        bake_anim_use_all_actions=True,
        bake_anim_use_nla_strips=False,
        bake_anim_use_all_bones=True,
        bake_anim_force_startend_keying=True,
        bake_anim_simplify_factor=0.0,
        bake_anim_step=1.0,
        add_leaf_bones=False,
        use_armature_deform_only=False,
        primary_bone_axis="Y",
        secondary_bone_axis="X",
        axis_forward="-Z",
        axis_up="Y",
    )
    if not os.path.exists(path):
        raise SystemExit("导出失败：%s" % path)


def detect_up_axis(arm):
    """用 armature 物体世界矩阵把世界 +Z 映到数据空间，得到数据空间竖直轴索引。"""
    up_local = arm.matrix_world.inverted().to_3x3() @ Vector((0.0, 0.0, 1.0))
    candidates = sorted(range(3), key=lambda i: -abs(up_local[i]))
    return candidates[0], [round(v, 6) for v in up_local]


def find_hips_bone(bones):
    import re
    for bone in bones:
        if re.search(r"pelvis", bone.name, re.IGNORECASE):
            return bone.name
    for bone in bones:
        if re.search(r"hip", bone.name, re.IGNORECASE):
            return bone.name
    for bone in bones:
        if re.search(r"root", bone.name, re.IGNORECASE):
            return bone.name
    roots = [b.name for b in bones if b.parent is None]
    return roots[0] if roots else None


def record_import(path, design_ctx):
    """重导入导出后的 FBX，记录采样器会看到的事实（rest/动作/探针期望值）。"""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(
        filepath=path,
        use_anim=True,
        ignore_leaf_bones=False,
        automatic_bone_orientation=False,
        use_custom_props=True,
    )
    scene = bpy.context.scene
    fps = scene.render.fps / scene.render.fps_base
    arms = [o for o in bpy.data.objects if o.type == "ARMATURE"]
    if not arms:
        raise SystemExit("重导入后没有 armature：%s" % path)
    arm = max(arms, key=lambda a: len(a.data.bones))
    unconnected = unconnect_all(arm)
    bones = list(arm.data.bones)
    up_axis, up_vec = detect_up_axis(arm)
    rest = {}
    children = {b.name: [] for b in bones}
    for bone in bones:
        mat = bone.matrix_local
        quat = mat.to_quaternion()
        rest[bone.name] = {
            "quat": quat_list(quat),
            "head": [round(v, 8) for v in mat.translation],
            "parent": bone.parent.name if bone.parent else None,
        }
        if bone.parent:
            children[bone.parent.name].append(bone.name)
    coords = []
    for bone in bones:
        coords.append(bone.head_local)
        coords.append(bone.tail_local)
    axis_values = [c[up_axis] for c in coords]
    source_height = round(max(axis_values) - min(axis_values), 6)
    hips_name = find_hips_bone(bones)
    source_hips_height = round(rest[hips_name]["head"][up_axis], 6) if hips_name else 0.0

    non_armature = [
        {"name": o.name, "type": o.type}
        for o in bpy.data.objects
        if o.type != "ARMATURE"
    ]
    result = {
        "sceneFps": fps,
        "armatureCount": len(arms),
        "armatures": [{"name": a.name, "bones": len(a.data.bones)} for a in arms],
        "armatureObjectEulerDeg": [round(math.degrees(v), 4) for v in arm.matrix_world.to_euler()],
        "upAxis": ["X", "Y", "Z"][up_axis],
        "upWorldInData": up_vec,
        "hipsBone": hips_name,
        "sourceHeightMeters": source_height,
        "sourceHipsHeightMeters": source_hips_height,
        "unconnectedBones": unconnected,
        "nonArmatureObjects": non_armature,
        "rest": rest,
        "children": children,
        "takes": {},
        "warnings": [],
    }
    if design_ctx["with_anim"]:
        actions = list(bpy.data.actions)
        if arm.animation_data:
            arm.animation_data.action = None
        for take_name in TAKE_NAMES:
            candidates = [a for a in actions if take_name in a.name]
            if not candidates:
                if len(actions) == 1 and take_name == TAKE_A:
                    result["warnings"].append("单 take 变体：%r 未找到，唯一 take=%r 记录在 %r 下" % (
                        take_name, actions[0].name, TAKE_A))
                    candidates = actions
                elif len(actions) == 1:
                    continue
                else:
                    raise SystemExit("重导入后找不到 take %r（%s）" % (take_name, [a.name for a in actions]))
            action = sorted(candidates, key=lambda a: len(a.fcurves), reverse=True)[0]
            start, end = action.frame_range
            loop = take_name == TAKE_A
            probes_for_take = [p for p in probe_specs() if p.get("take") == take_name]
            probe_rows = evaluate_probes(arm, action, probes_for_take, fps, design_ctx["name_fn"])
            # 采样数（输出 30fps）：按 extract-hsr-anims.py 的公式记录
            step = int(round(fps / 30.0))
            span = end - start
            count = int(math.floor(span / step)) + 1
            last = start + (count - 1) * step
            if not loop and last < end - 1e-6:
                count += 1
            result["takes"][take_name] = {
                "action": action.name,
                "srcFrames": [float(start), float(end)],
                "spanFrames": float(span),
                "frames": int(round(span)) + 1,
                "loop": loop,
                "expectedSamplesAt30fps": count,
                "probes": probe_rows,
            }
    return result


def main():
    args = parse_args()
    out_dir = os.path.abspath(args["out"])
    os.makedirs(out_dir, exist_ok=True)
    print("FIXTURE_OUT", out_dir)
    print("FIXTURE_BLENDER", BLENDER_VERSION)

    variants = [
        {"file": "biped-anim-skel.fbx", "fps": 30, "with_anim": True, "with_mesh": False},
        {"file": "biped-anim-full.fbx", "fps": 30, "with_anim": True, "with_mesh": True},
        {"file": "biped-anim-60fps.fbx", "fps": 60, "with_anim": True, "with_mesh": False},
        {"file": "biped-tpose.fbx", "fps": 30, "with_anim": False, "with_mesh": False},
        {"file": "biped-anim-multi.fbx", "fps": 30, "with_anim": True, "with_mesh": False,
         "extra_armature": True},
        {"file": "biped-anim-generic.fbx", "fps": 30, "with_anim": True, "with_mesh": False,
         "generic_names": True},
        {"file": "biped-anim-single.fbx", "fps": 30, "with_anim": True, "with_mesh": False,
         "single_take": True},
        {"file": "biped-anim-zup.fbx", "fps": 30, "with_anim": True, "with_mesh": False,
         "data_space": "zup"},
    ]

    fixture = {
        "schemaVersion": 1,
        "generatedAt": datetime.datetime.now().astimezone().isoformat(),
        "blenderVersion": BLENDER_VERSION,
        "description": "Synthetic 3ds Max Biped fixture (66 bones + Footsteps empty) for extract-biped-anims.py E2E validation.",
        "dataSpace": {
            "up": "+Y",
            "forward": "+Z",
            "armatureObjectRotXDeg": 90.0,
            "note": "与真实 3ds Max Biped FBX 经 Blender importer 导入后的空间约定一致（armature 物体 rotX=90°，骨骼数据 Y-up）。",
        },
        "boneCount": len(bone_specs()),
        "bones": {},
        "design": DESIGN,
        "framePlans": {str(k): {"A": list(v["A"]), "B": list(v["B"])} for k, v in FRAME_PLANS.items()},
        "designVerification": None,
        "files": {},
    }
    first_rest = None
    for index, variant in enumerate(variants):
        scene_ctx = build_scene(
            fps=variant["fps"],
            with_anim=variant["with_anim"],
            with_mesh=variant["with_mesh"],
            extra_armature=variant.get("extra_armature", False),
            generic_names=variant.get("generic_names", False),
            single_take=variant.get("single_take", False),
            data_space=variant.get("data_space", "yup"),
        )
        if index == 0:
            fixture["bones"] = scene_ctx["rest"]
            fixture["designVerification"] = verify_design(scene_ctx)
            print("FIXTURE_DESIGN_VERIFY ok maxAngleDev=%.6f° maxMetersDev=%.8f" % (
                fixture["designVerification"]["maxAngleDeviationDeg"],
                fixture["designVerification"]["maxMetersDeviation"]))
        path = os.path.join(out_dir, variant["file"])
        export_fbx(path, scene_ctx, with_anim=variant["with_anim"])
        size = os.path.getsize(path)
        print("FIXTURE_EXPORT %-24s fps=%d anim=%-5s mesh=%-5s bytes=%d" % (
            variant["file"], variant["fps"], variant["with_anim"], variant["with_mesh"], size))
        recorded = record_import(path, {
            "with_anim": variant["with_anim"],
            "name_fn": generic_name if variant.get("generic_names") else (lambda n: n),
        })
        recorded["bytes"] = size
        recorded["variant"] = dict(variant)
        fixture["files"][variant["file"]] = recorded
        if first_rest is None:
            first_rest = recorded["rest"]
        else:
            if list(recorded["rest"].keys()) != list(first_rest.keys()):
                fixture["warnings"] = fixture.get("warnings", []) + [
                    "%s: 骨骼集合与首文件不同" % variant["file"]]
        take_summary = ", ".join(
            "%s src=%s frames=%d expectedSamples30=%d" % (
                take, [int(v) for v in spec["srcFrames"]], spec["frames"], spec["expectedSamplesAt30fps"])
            for take, spec in recorded["takes"].items())
        print("FIXTURE_RECORD %-24s fps=%s up=%s bones=%d takes=[%s]" % (
            variant["file"], recorded["sceneFps"], recorded["upAxis"],
            len(recorded["rest"]), take_summary))

    with open(os.path.join(out_dir, "fixture.json"), "w", encoding="utf-8") as handle:
        json.dump(fixture, handle, ensure_ascii=False, indent=1)
    print("FIXTURE_DONE bones=%d files=%d fixture=%s" % (
        len(fixture["bones"]), len(fixture["files"]), os.path.join(out_dir, "fixture.json")))


if __name__ == "__main__":
    main()
