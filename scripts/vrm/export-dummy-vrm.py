#!/usr/bin/env python3
"""W0-2 smoke test: 用 Blender 无头创建一个 cube + armature, 并导出 VRM 1.0。

直接运行（在仓库根目录执行）:
    BL="/Volumes/4TB外置盘/deepseek-harness/tools/blender/Blender.app/Contents/MacOS/Blender"
    "$BL" --background --factory-startup --python scripts/vrm/export-dummy-vrm.py

  提示: 脚本内已把未捕获异常统一转成 SystemExit(1), 因此上命令失败时退出码为 1。
  更严格地可再加 `--python-exit-code 1`（Blender 默认会吞掉 Python 异常并仍退出 0）。

说明:
  * 需要先运行 scripts/vrm/install-vrm-addon.sh 安装 / 启用 VRM Add-on for Blender。
  * 脚本自身会 enable addon module（extension 名 bl_ext.user_default.vrm，legacy 名
    io_scene_vrm 兜底），因此 --factory-startup 也能跑。
  * 产物默认:
        tests/tmp/w0-2/dummy.vrm             导出的 VRM 1.0 (GLB 容器)
        tests/tmp/w0-2/dummy-vrm-check.json  内嵌 GLB JSON 校验报告
    可用环境变量覆盖: DUMMY_VRM_OUT_DIR / DUMMY_VRM_OUT / DUMMY_VRM_CHECK
  * 骨架为简化 T-pose humanoid（15 根骨, 含 hips/spine/head/左右上臂/左右上腿），
    cube 通过 Armature modifier + 顶点组(weight=1) 蒙皮到 spine 骨。
  * 导出后立即解析 GLB JSON 校验: magic=glTF、extensionsUsed 含 VRMC_vrm、
    specVersion == "1.0"、humanBones 数量 >= 5；失败时以非 0 退出码结束。
    注意: 必须带 `--python-exit-code 1` 才能让 Blender 把脚本异常映射为退出码 1。
"""

import json
import os
import struct
import sys
from pathlib import Path

import bpy

REPO_ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = Path(os.environ.get("DUMMY_VRM_OUT_DIR", REPO_ROOT / "tests" / "tmp" / "w0-2"))
OUT_VRM = Path(os.environ.get("DUMMY_VRM_OUT", OUT_DIR / "dummy.vrm"))
CHECK_JSON = Path(os.environ.get("DUMMY_VRM_CHECK", OUT_DIR / "dummy-vrm-check.json"))

# (Blender 骨名, head, tail, parent) —— 简化 T-pose, 面朝 -Y (Blender 前视图)
# 命名沿用 VRM 常用约定, 便于 humanoid 映射与后续 V2 PMX 管线复用。
BONES = [
    ("hips", (0.0, 0.0, 0.50), (0.0, 0.0, 0.58), None),
    ("spine", (0.0, 0.0, 0.58), (0.0, 0.0, 0.80), "hips"),
    ("head", (0.0, 0.0, 0.80), (0.0, 0.0, 1.00), "spine"),
    ("upper_arm.L", (0.15, 0.0, 0.78), (0.35, 0.0, 0.78), "spine"),
    ("lower_arm.L", (0.35, 0.0, 0.78), (0.55, 0.0, 0.78), "upper_arm.L"),
    ("hand.L", (0.55, 0.0, 0.78), (0.62, 0.0, 0.78), "lower_arm.L"),
    ("upper_arm.R", (-0.15, 0.0, 0.78), (-0.35, 0.0, 0.78), "spine"),
    ("lower_arm.R", (-0.35, 0.0, 0.78), (-0.55, 0.0, 0.78), "upper_arm.R"),
    ("hand.R", (-0.55, 0.0, 0.78), (-0.62, 0.0, 0.78), "lower_arm.R"),
    ("upper_leg.L", (0.09, 0.0, 0.50), (0.09, 0.0, 0.28), "hips"),
    ("lower_leg.L", (0.09, 0.0, 0.28), (0.09, 0.0, 0.06), "upper_leg.L"),
    ("foot.L", (0.09, 0.0, 0.06), (0.09, -0.12, 0.01), "lower_leg.L"),
    ("upper_leg.R", (-0.09, 0.0, 0.50), (-0.09, 0.0, 0.28), "hips"),
    ("lower_leg.R", (-0.09, 0.0, 0.28), (-0.09, 0.0, 0.06), "upper_leg.R"),
    ("foot.R", (-0.09, 0.0, 0.06), (-0.09, -0.12, 0.01), "lower_leg.R"),
]

# VRM 1.0 humanoid 属性名 -> Blender 骨名（属性名为 addon 里的 snake_case 字段）
HUMAN_BONES = {
    "hips": "hips",
    "spine": "spine",
    "head": "head",
    "left_upper_arm": "upper_arm.L",
    "left_lower_arm": "lower_arm.L",
    "left_hand": "hand.L",
    "right_upper_arm": "upper_arm.R",
    "right_lower_arm": "lower_arm.R",
    "right_hand": "hand.R",
    "left_upper_leg": "upper_leg.L",
    "left_lower_leg": "lower_leg.L",
    "left_foot": "foot.L",
    "right_upper_leg": "upper_leg.R",
    "right_lower_leg": "lower_leg.R",
    "right_foot": "foot.R",
}

# 验收阈值: humanBones 数量下限
MIN_HUMAN_BONES = 5


def log(message: str) -> None:
    print(f"[dummy-vrm] {message}", flush=True)


def fail(message: str) -> None:
    log(f"FAIL: {message}")
    raise SystemExit(1)


def enable_vrm_addon() -> str:
    """启用 VRM addon, 返回模块名。extension 优先, legacy 兜底。"""
    for module in ("bl_ext.user_default.vrm", "io_scene_vrm"):
        try:
            bpy.ops.preferences.addon_enable(module=module)
            log(f"addon_enable({module}) OK")
            return module
        except Exception as exc:  # noqa: BLE001 - 依次尝试候选模块名
            log(f"addon_enable({module}) failed: {exc}")
    fail(
        "VRM add-on 未安装或无法启用。先运行: scripts/vrm/install-vrm-addon.sh"
    )


def clear_scene() -> None:
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for mesh in list(bpy.data.meshes):
        bpy.data.meshes.remove(mesh)
    for armature in list(bpy.data.armatures):
        bpy.data.armatures.remove(armature)


def build_armature() -> bpy.types.Object:
    armature_data = bpy.data.armatures.new("DummyArmature")
    armature_object = bpy.data.objects.new("DummyArmature", armature_data)
    bpy.context.scene.collection.objects.link(armature_object)
    bpy.context.view_layer.objects.active = armature_object
    armature_object.select_set(True)

    bpy.ops.object.mode_set(mode="EDIT")
    edit_bones = armature_data.edit_bones
    for name, head, tail, parent_name in BONES:
        bone = edit_bones.new(name)
        bone.head = head
        bone.tail = tail
        if parent_name:
            bone.parent = edit_bones[parent_name]
    bpy.ops.object.mode_set(mode="OBJECT")
    log(f"armature: {len(armature_data.bones)} bones")
    return armature_object


def assign_vrm1_humanoid(armature_object: bpy.types.Object) -> int:
    armature_data = armature_object.data
    ext = armature_data.vrm_addon_extension
    ext.spec_version = "1.0"  # 关键: VRM 1.0 导出由 armature 的 spec_version 决定

    human_bones = ext.vrm1.humanoid.human_bones
    assigned = 0
    for attr_name, bone_name in HUMAN_BONES.items():
        if bone_name not in armature_data.bones:
            fail(f"humanoid 映射失败: 骨骼不存在 {bone_name!r}")
        getattr(human_bones, attr_name).node.bone_name = bone_name
        assigned += 1
    log(f"humanoid: 已映射 {assigned} 根骨 (spec_version=1.0)")

    # VRM 1.0 元数据（必填项之外给出一组最小合法值）
    meta = ext.vrm1.meta
    meta.vrm_name = "Dummy VRM (W0-2 smoke)"
    meta.version = "0.0.1"
    meta.authors.clear()
    meta.authors.add().value = "aventurine-pet-vrm W0-2"
    meta.copyright_information = "W0-2 dummy"
    meta.contact_information = "local-only"
    meta.third_party_licenses = "none"
    meta.avatar_permission = "onlyAuthor"
    meta.allow_excessively_violent_usage = False
    meta.allow_excessively_sexual_usage = False
    meta.commercial_usage = "personalNonProfit"
    meta.allow_political_or_religious_usage = False
    meta.allow_antisocial_or_hate_usage = False
    meta.credit_notation = "unnecessary"
    meta.allow_redistribution = False
    meta.modification = "prohibited"
    meta.other_license_url = ""
    log("meta: vrm_name/version/authors/permission 已设置")
    return assigned


def build_skinned_cube(armature_object: bpy.types.Object) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cube_add(size=0.3, location=(0.0, 0.0, 0.68))
    cube = bpy.context.active_object
    cube.name = "DummyCube"

    material = bpy.data.materials.new("DummyBody")
    material.use_nodes = True
    principled = material.node_tree.nodes.get("Principled BSDF")
    if principled is not None:
        principled.inputs["Base Color"].default_value = (0.55, 0.35, 0.2, 1.0)
        principled.inputs["Roughness"].default_value = 0.6
    cube.data.materials.append(material)

    # 简单蒙皮: 顶点组 spine 权重 1.0 + Armature modifier
    vertex_group = cube.vertex_groups.new(name="spine")
    vertex_group.add(range(len(cube.data.vertices)), 1.0, "REPLACE")
    modifier = cube.modifiers.new(name="Armature", type="ARMATURE")
    modifier.object = armature_object

    # glTF/VRM 导出要求被蒙皮网格是骨架的子物体, 否则会 warning 并靠名字猜骨架
    world_matrix = cube.matrix_world.copy()
    cube.parent = armature_object
    cube.matrix_world = world_matrix
    log("cube: 已蒙皮到 spine 骨 (Armature modifier + 顶点组 weight=1, parent=armature)")
    return cube


def export_vrm(armature_object: bpy.types.Object) -> None:
    OUT_VRM.parent.mkdir(parents=True, exist_ok=True)
    if OUT_VRM.exists():
        OUT_VRM.unlink()
    log(f"export -> {OUT_VRM}")
    result = bpy.ops.export_scene.vrm(
        filepath=str(OUT_VRM),
        armature_object_name=armature_object.name,
    )
    if result != {"FINISHED"}:
        fail(f"export_scene.vrm 返回 {result}, 期望 {{'FINISHED'}}")
    if not OUT_VRM.is_file() or OUT_VRM.stat().st_size == 0:
        fail(f"导出文件不存在或为空: {OUT_VRM}")
    log(f"export OK size={OUT_VRM.stat().st_size} bytes")


def read_glb_json(path: Path) -> tuple[dict, dict]:
    """解析 GLB 头 + JSON chunk, 返回 (json, header 信息)。"""
    raw = path.read_bytes()
    if len(raw) < 20:
        fail(f"GLB 太短: {len(raw)} bytes")
    magic, glb_version, total_length = struct.unpack_from("<4sII", raw, 0)
    header = {
        "magic": magic.decode("ascii", "replace"),
        "glb_version": glb_version,
        "total_length": total_length,
        "actual_length": len(raw),
    }
    offset = 12
    while offset + 8 <= len(raw):
        chunk_length, chunk_type = struct.unpack_from("<II", raw, offset)
        chunk_data = raw[offset + 8 : offset + 8 + chunk_length]
        if chunk_type == 0x4E4F534A:  # "JSON"
            return json.loads(chunk_data.decode("utf-8")), header
        offset += 8 + chunk_length + ((4 - chunk_length % 4) % 4)
    fail("GLB 中找不到 JSON chunk")


def validate_dummy_vrm() -> dict:
    gltf, header = read_glb_json(OUT_VRM)
    extensions_used = gltf.get("extensionsUsed", [])
    vrm_ext = (gltf.get("extensions") or {}).get("VRMC_vrm") or {}
    human_bones = (vrm_ext.get("humanoid") or {}).get("humanBones") or {}
    spec_version = vrm_ext.get("specVersion")

    checks = {
        "magic_is_gltf": header["magic"] == "glTF",
        "glb_version_2": header["glb_version"] == 2,
        "length_consistent": header["total_length"] == header["actual_length"],
        "extensions_used_has_vrmc_vrm": "VRMC_vrm" in extensions_used,
        "extension_object_has_vrmc_vrm": bool(vrm_ext),
        "spec_version_is_1_0": spec_version == "1.0",
        "human_bones_ge_min": len(human_bones) >= MIN_HUMAN_BONES,
    }
    report = {
        "path": str(OUT_VRM),
        "size_bytes": OUT_VRM.stat().st_size,
        "glb_header": header,
        "extensionsUsed": extensions_used,
        "specVersion": spec_version,
        "human_bones_count": len(human_bones),
        "human_bones": sorted(human_bones.keys()),
        "nodes": len(gltf.get("nodes", [])),
        "meshes": len(gltf.get("meshes", [])),
        "skins": len(gltf.get("skins", [])),
        "materials": len(gltf.get("materials", [])),
        "animations": len(gltf.get("animations", [])),
        "checks": checks,
        "passed": all(checks.values()),
    }
    CHECK_JSON.parent.mkdir(parents=True, exist_ok=True)
    CHECK_JSON.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    for name, ok in checks.items():
        log(f"check {name}: {'OK' if ok else 'FAIL'}")
    if not report["passed"]:
        fail("dummy VRM 校验失败，详见 " + str(CHECK_JSON))
    return report


def main() -> None:
    log(f"blender: {bpy.app.version_string}")
    module = enable_vrm_addon()
    log(f"vrm addon module: {module}")
    if not hasattr(bpy.ops.export_scene, "vrm"):
        fail("export_scene.vrm 运算符不存在 (addon 未正确注册)")

    clear_scene()
    armature_object = build_armature()
    assign_vrm1_humanoid(armature_object)
    build_skinned_cube(armature_object)
    export_vrm(armature_object)

    report = validate_dummy_vrm()
    log(f"humanBones: {report['human_bones_count']} -> {report['human_bones']}")
    log(f"report: {CHECK_JSON}")
    log("DUMMY_VRM_CHECK=OK")


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except BaseException:  # noqa: BLE001 - 任何 Blender API 异常都要映射为非 0 退出码
        import traceback

        traceback.print_exc()
        log("FAIL: 未捕获异常, 详见上方 traceback")
        raise SystemExit(1) from None
