#!/usr/bin/env python3
"""Headless Blender 4.2 + MMD Tools render/pose/VPD pipeline for the aventurine-pet PMX.

Usage (from repo root; BLENDER is the executable inside Blender.app):

    "$BLENDER" -b --factory-startup --python scripts/anim-pipeline/blender/render_views.py -- \
        --pmx "assets/model/optimized/星穹铁道—砂金·戏浪.pmx" \
        --out tests/tmp/blender-probe \
        --views front,side,three-quarter,back \
        --pose scripts/anim-pipeline/blender/poses/example-pose.json \
        --pose-views front,three-quarter \
        --vpd-out tests/tmp/blender-probe/pose-test.vpd \
        --dump tests/tmp/blender-probe/pose-dump.json \
        --report tests/tmp/blender-probe/report.json

What it does:
  1. enables the MMD Tools extension (bl_ext.user_default.mmd_tools, falls back to mmd_tools),
  2. imports the PMX (armature + mesh + morphs; physics optional via --with-physics),
  3. builds an orthographic camera and renders the requested views with Workbench
     (or Cycles CPU via --engine cycles),
  4. optionally applies a pose JSON (bone rotations/translation + morph weights) and renders
     the same views with a "posed-" prefix for before/after comparison,
  5. optionally exports the current pose as .vpd (MMD Tools export_vpd) and dumps a JSON
     describing every posed bone so an external checker can verify VPD semantics.

All output paths are given explicitly; nothing outside --out / the file paths passed in is written.
Model/motion binaries are never copied into tracked paths (repo .gitignore also excludes tests/tmp/).
"""

import argparse
import json
import math
import os
import sys
import time

import bpy
import mathutils

VIEW_DIRECTIONS = {
    # name: unit vector FROM the model center TOWARDS the camera (model faces -Y)
    "front": (0.0, -1.0, 0.0),
    "side": (1.0, 0.0, 0.0),  # character's left side (+X); camera looks along -X
    "side-right": (-1.0, 0.0, 0.0),
    "three-quarter": (math.sin(math.radians(45)), -math.cos(math.radians(45)), 0.0),
    "back": (0.0, 1.0, 0.0),
}

ADDON_MODULES = ("bl_ext.user_default.mmd_tools", "mmd_tools")


def log(msg):
    print("[render_views] %s" % msg, flush=True)


def parse_args():
    argv = sys.argv
    argv = argv[argv.index("--") + 1:] if "--" in argv else []
    p = argparse.ArgumentParser(description="Headless PMX four-view / pose / VPD pipeline")
    p.add_argument("--pmx", required=True, help="absolute path to .pmx")
    p.add_argument("--out", required=True, help="output directory for PNGs")
    p.add_argument("--views", default="front,side,three-quarter,back")
    p.add_argument("--pose", default=None, help="JSON pose file ({'bones': {...}, 'morphs': {...}})")
    p.add_argument("--pose-views", default="front,three-quarter",
                   help="views rendered again after posing (before/after comparison)")
    p.add_argument("--vpd-out", default=None, help="export current pose to this .vpd path")
    p.add_argument("--vpd-scale", type=float, default=None,
                   help="VPD export scale, default 1/import-scale (12.5 for 0.08)")
    p.add_argument("--vpd-strip-morphs", action="store_true",
                   help="also write <name>-boneonly.vpd without Morph blocks "
                        "(three.js r171 parseVpd throws on Morph blocks)")
    p.add_argument("--no-vpd-roundtrip", action="store_true",
                   help="skip re-importing the exported VPD to verify pose roundtrip")
    p.add_argument("--dump", default=None, help="dump pose bone data to this JSON path")
    p.add_argument("--report", default=None, help="write a run report JSON here")
    p.add_argument("--engine", default="workbench", choices=("workbench", "cycles"))
    p.add_argument("--cycles-samples", type=int, default=32)
    p.add_argument("--width", type=int, default=768)
    p.add_argument("--height", type=int, default=1024)
    p.add_argument("--import-scale", type=float, default=0.08,
                   help="MMD Tools import scale (default 0.08; VPD scale is its inverse)")
    p.add_argument("--with-physics", action="store_true",
                   help="also import rigid bodies/joints (slower; not needed for stills)")
    p.add_argument("--rename-bones", action="store_true",
                   help="import with Blender L/R bone renaming (default off: keep PMX Japanese names)")
    return p.parse_args(argv)


def enable_mmd_tools():
    for module in ADDON_MODULES:
        try:
            bpy.ops.preferences.addon_enable(module=module)
            if hasattr(bpy.ops.mmd_tools, "import_model"):
                log("MMD Tools enabled via module=%s" % module)
                return module
        except Exception as exc:  # noqa: BLE001 - probe every candidate
            log("addon_enable(%s) failed: %r" % (module, exc))
    raise RuntimeError(
        "MMD Tools is not installed. Install it as an extension:\n"
        "  Blender --command extension install-file -r user_default -e mmd_tools-v*-bl4.2.zip"
    )


def import_model(args):
    types = {"MESH", "ARMATURE", "MORPHS", "DISPLAY"}
    if args.with_physics:
        types.add("PHYSICS")
    t0 = time.time()
    bpy.ops.mmd_tools.import_model(
        filepath=args.pmx,
        types=types,
        scale=args.import_scale,
        rename_bones=args.rename_bones,
        clean_model=True,
        log_level="WARNING",
    )
    elapsed = time.time() - t0
    arms = [o for o in bpy.data.objects if o.type == "ARMATURE"]
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    if len(arms) != 1 or len(meshes) != 1:
        raise RuntimeError("unexpected import result: arms=%d meshes=%d" % (len(arms), len(meshes)))
    log("imported in %.2fs: %d bones, %d verts, %d materials, %d morphs"
        % (elapsed, len(arms[0].data.bones), len(meshes[0].data.vertices),
           len(meshes[0].data.materials),
           len(meshes[0].data.shape_keys.key_blocks) if meshes[0].data.shape_keys else 0))
    return arms[0], meshes[0]


def world_bbox(meshes):
    mn = mathutils.Vector((1e18, 1e18, 1e18))
    mx = mathutils.Vector((-1e18, -1e18, -1e18))
    for obj in meshes:
        for corner in obj.bound_box:
            w = obj.matrix_world @ mathutils.Vector(corner)
            for i in range(3):
                mn[i] = min(mn[i], w[i])
                mx[i] = max(mx[i], w[i])
    return mn, mx


def convert_materials_for_cycles(mesh):
    """MMD Toon shaders render near-black in Cycles until converted (MMD Tools helper)."""
    for obj in bpy.context.view_layer.objects:
        obj.select_set(False)
    mesh.select_set(True)
    bpy.context.view_layer.objects.active = mesh
    try:
        bpy.ops.mmd_tools.convert_materials_for_cycles(use_principled=True, clean_nodes=True)
        log("converted %d MMD materials for Cycles" % len(mesh.data.materials))
    except Exception as exc:  # noqa: BLE001 - fallback path should not hard-fail
        log("WARNING: convert_materials_for_cycles failed: %r" % exc)


def setup_scene(args, mesh):
    scene = bpy.context.scene
    scene.render.resolution_x = args.width
    scene.render.resolution_y = args.height
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = False
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"

    if args.engine == "workbench":
        scene.render.engine = "BLENDER_WORKBENCH"
        shading = scene.display.shading
        shading.light = "STUDIO"
        shading.color_type = "TEXTURE"       # show MMD diffuse textures
        shading.show_shadows = True
        shading.show_cavity = True
        shading.cavity_type = "BOTH"
        shading.show_object_outline = False
        shading.background_type = "VIEWPORT"
        shading.background_color = (0.22, 0.23, 0.26)
        # Workbench final renders fall back to the world color for the backdrop
        world = scene.world or bpy.data.worlds.new("World")
        scene.world = world
        world.use_nodes = False
        world.color = (0.22, 0.23, 0.26)
    else:
        scene.render.engine = "CYCLES"
        scene.cycles.device = "CPU"
        scene.cycles.samples = args.cycles_samples
        scene.cycles.use_denoising = True
        convert_materials_for_cycles(mesh)
        world = scene.world or bpy.data.worlds.new("World")
        scene.world = world
        world.use_nodes = True
        world.node_tree.nodes["Background"].inputs[0].default_value = (0.22, 0.23, 0.26, 1.0)
        world.node_tree.nodes["Background"].inputs[1].default_value = 1.0
        add_light_rig(scene)


def add_light_rig(scene):
    """Soft three-point rig for the Cycles fallback."""
    specs = [
        ("Key", (2.5, -3.5, 3.5), 400.0, 2.5),
        ("Fill", (-3.0, -2.0, 2.0), 150.0, 3.0),
        ("Rim", (0.0, 3.5, 3.0), 250.0, 2.0),
    ]
    for name, loc, power, size in specs:
        data = bpy.data.lights.new(name, "AREA")
        data.energy = power
        data.size = size
        obj = bpy.data.objects.new(name, data)
        obj.location = loc
        obj.rotation_euler = (mathutils.Vector((0.0, 0.0, 1.0)) - mathutils.Vector(loc)).to_track_quat("-Z", "Y").to_euler()
        scene.collection.objects.link(obj)


def make_camera(mn, mx, margin=1.18):
    center = (mn + mx) * 0.5
    size = max((mx - mn)[i] for i in range(3))
    data = bpy.data.cameras.new("ProbeCam")
    data.type = "ORTHO"
    data.ortho_scale = size * margin
    cam = bpy.data.objects.new("ProbeCam", data)
    bpy.context.scene.collection.objects.link(cam)
    data.clip_start = 0.01
    data.clip_end = size * 20.0
    return cam, center, size


def aim_camera(cam, center, direction, size):
    dist = size * 4.0
    cam.location = center + mathutils.Vector(direction) * dist
    to_center = center - cam.location
    cam.rotation_euler = to_center.to_track_quat("-Z", "Y").to_euler()


def render_view(args, cam, center, size, view, prefix=""):
    direction = VIEW_DIRECTIONS[view]
    aim_camera(cam, center, direction, size)
    scene = bpy.context.scene
    scene.camera = cam
    filename = "%s%s.png" % (prefix, view)
    filepath = os.path.join(args.out, filename)
    scene.render.filepath = filepath
    t0 = time.time()
    bpy.ops.render.render(write_still=True)
    elapsed = time.time() - t0
    log("rendered %s in %.2fs -> %s" % (view, elapsed, filepath))
    return {"view": view, "file": filepath, "seconds": round(elapsed, 2)}


def pose_bone_names(arm):
    return [b.name for b in arm.data.bones]


def apply_pose(arm, mesh, pose):
    """Apply {'bones': {name: {'rot': [x,y,z] deg, 'loc': [x,y,z]}}, 'morphs': {name: weight}}."""
    missing = []
    for bone_name, spec in (pose.get("bones") or {}).items():
        pbone = arm.pose.bones.get(bone_name)
        if pbone is None:
            missing.append(bone_name)
            continue
        pbone.rotation_mode = "XYZ"
        rot_deg = spec.get("rot", [0.0, 0.0, 0.0])
        pbone.rotation_euler = tuple(math.radians(float(v)) for v in rot_deg)
        if "loc" in spec:
            pbone.location = tuple(float(v) for v in spec["loc"])
        log("pose bone %r rot=%s loc=%s" % (bone_name, rot_deg, spec.get("loc")))
    morph_missing = []
    if mesh.data.shape_keys:
        blocks = mesh.data.shape_keys.key_blocks
        for morph_name, weight in (pose.get("morphs") or {}).items():
            block = blocks.get(morph_name)
            if block is None:
                morph_missing.append(morph_name)
                continue
            block.value = float(weight)
            log("morph %r = %s" % (morph_name, weight))
    bpy.context.view_layer.update()
    return {"missing_bones": missing, "morphs_missing": morph_missing}


def strip_morph_blocks(vpd_path):
    """Write <name>-boneonly.vpd containing only the bone section.

    MMD Tools writes MikuMikuMoving 'Morph' blocks after the bones when morph
    weights are non-zero. three.js r171's MMDParser.parseVpd does not understand
    Morph blocks and throws on the closing brace, so this copy is the safe input
    for MMDLoader.loadVPD.
    """
    with open(vpd_path, encoding="cp932", errors="replace", newline="") as fh:
        lines = fh.read().splitlines()
    kept = []
    for line in lines:
        if line.startswith("Morph"):
            break
        kept.append(line)
    out_path = vpd_path[:-4] + "-boneonly.vpd" if vpd_path.lower().endswith(".vpd") else vpd_path + "-boneonly.vpd"
    text = "\r\n".join(kept).rstrip("\r\n") + "\r\n"
    with open(out_path, "w", encoding="cp932", errors="replace", newline="") as fh:
        fh.write(text)
    log("wrote bone-only VPD (%d lines, morphs stripped) -> %s" % (len(kept), out_path))
    return out_path


def snapshot_pose(arm):
    snap = {}
    identity = mathutils.Matrix.Identity(4)
    for pbone in arm.pose.bones:
        if pbone.matrix_basis != identity:
            snap[pbone.name] = pbone.matrix_basis.copy()
    return snap


def clear_pose(arm):
    identity = mathutils.Matrix.Identity(4)
    for pbone in arm.pose.bones:
        pbone.matrix_basis = identity
    bpy.context.view_layer.update()


def roundtrip_check(args, root_obj, arm, before):
    """Clear the pose, import the just-exported VPD, compare matrix_basis to `before`."""
    clear_pose(arm)
    for obj in bpy.context.view_layer.objects:
        obj.select_set(False)
    root_obj.select_set(True)
    arm.select_set(True)
    bpy.context.view_layer.objects.active = root_obj
    result = bpy.ops.mmd_tools.import_vpd(
        filepath=args.vpd_out,
        directory=os.path.dirname(os.path.abspath(args.vpd_out)) or ".",
        files=[{"name": os.path.basename(args.vpd_out)}],
        scale=args.import_scale,
        bone_mapper="PMX",
        use_pose_mode=False,
    )
    bpy.context.view_layer.update()
    max_angle = 0.0
    max_loc = 0.0
    compared = 0
    for name, old_basis in before.items():
        pbone = arm.pose.bones.get(name)
        if pbone is None:
            continue
        compared += 1
        new_basis = pbone.matrix_basis
        old_q = old_basis.to_quaternion()
        new_q = new_basis.to_quaternion()
        dot = abs(max(-1.0, min(1.0, old_q.dot(new_q))))
        angle = math.degrees(2.0 * math.acos(dot))
        max_angle = max(max_angle, angle)
        max_loc = max(max_loc, (old_basis.to_translation() - new_basis.to_translation()).length)
    log("VPD roundtrip: %d bones compared, max_angle_error=%.6f deg, max_loc_error=%.3e m"
        % (compared, max_angle, max_loc))
    return {
        "operator_result": list(result),
        "bones_compared": compared,
        "max_rotation_error_deg": round(max_angle, 6),
        "max_translation_error_m": round(max_loc, 9),
        "pass": max_angle < 1e-3 and max_loc < 1e-6,
    }


def export_vpd(args, root_obj):
    if args.vpd_scale is not None:
        scale = args.vpd_scale
    else:
        scale = 1.0 / args.import_scale
    os.makedirs(os.path.dirname(os.path.abspath(args.vpd_out)) or ".", exist_ok=True)
    for obj in bpy.context.view_layer.objects:
        obj.select_set(False)
    root_obj.select_set(True)
    bpy.context.view_layer.objects.active = root_obj
    result = bpy.ops.mmd_tools.export_vpd(
        filepath=args.vpd_out,
        scale=scale,
        pose_type="CURRENT",
        use_pose_mode=False,
    )
    log("export_vpd result=%s scale=%s -> %s" % (result, scale, args.vpd_out))
    info = {"filepath": args.vpd_out, "scale": scale, "operator_result": list(result)}
    if args.vpd_strip_morphs:
        info["boneonly_filepath"] = strip_morph_blocks(args.vpd_out)
    return info


def dump_pose(args, arm, mesh, pose):
    """Dump bone data needed by the external three.js/mmd-parser VPD checker."""
    data = {
        "pmx": os.path.abspath(args.pmx),
        "import_scale": args.import_scale,
        "pose_input": pose,
        "bones": {},
        "morphs": {},
        "armature_world_matrix": [list(row) for row in arm.matrix_world],
    }
    if mesh.data.shape_keys:
        for block in mesh.data.shape_keys.key_blocks:
            if block.value != 0.0:
                data["morphs"][block.name] = round(float(block.value), 6)
    for pbone in arm.pose.bones:
        basis = pbone.matrix_basis
        identity = mathutils.Matrix.Identity(4)
        is_identity = all(abs(basis[i][j] - identity[i][j]) < 1e-9 for i in range(4) for j in range(4))
        if is_identity:
            continue
        quat = basis.to_quaternion()
        head_world = arm.matrix_world @ pbone.head
        rest_matrix_local = pbone.bone.matrix_local
        data["bones"][pbone.name] = {
            "mode": "IDENTITY" if is_identity else "CHANGED",
            "matrix_basis": [list(row) for row in basis],
            "quaternion_xyzw": [round(v, 9) for v in (quat.x, quat.y, quat.z, quat.w)],
            "location": [round(v, 9) for v in pbone.location],
            "head_world": [round(v, 9) for v in head_world],
            "rest_matrix_local": [list(row) for row in rest_matrix_local],
        }
    with open(args.dump, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=1)
    log("dumped %d changed bones -> %s" % (len(data["bones"]), args.dump))
    return {"dump": args.dump, "changed_bone_count": len(data["bones"])}


def main():
    args = parse_args()
    os.makedirs(args.out, exist_ok=True)
    report = {"started_at": time.strftime("%Y-%m-%dT%H:%M:%S"), "args": vars(args), "renders": []}
    t_start = time.time()

    bpy.ops.wm.read_factory_settings(use_empty=True)
    addon_module = enable_mmd_tools()
    report["addon_module"] = addon_module
    arm, mesh = import_model(args)
    root_obj = next(o for o in bpy.data.objects if getattr(o, "mmd_type", None) == "ROOT")

    mn, mx = world_bbox([mesh])
    report["bbox"] = {"min": [round(v, 5) for v in mn], "max": [round(v, 5) for v in mx],
                      "size": [round(v, 5) for v in (mx - mn)]}
    report["model"] = {
        "name": mesh.name,
        "bones": len(arm.data.bones),
        "vertices": len(mesh.data.vertices),
        "polygons": len(mesh.data.polygons),
        "materials": len(mesh.data.materials),
        "morphs": len(mesh.data.shape_keys.key_blocks) if mesh.data.shape_keys else 0,
        "images": len([i for i in bpy.data.images if i.name != "Render Result"]),
        "images_missing": len([i for i in bpy.data.images if i.name != "Render Result" and i.size[0] == 0]),
    }
    setup_scene(args, mesh)
    cam, center, size = make_camera(mn, mx)
    report["views"] = {}
    for view in (v.strip() for v in args.views.split(",") if v.strip()):
        report["renders"].append(render_view(args, cam, center, size, view))
        report["views"][view] = os.path.join(args.out, "%s.png" % view)

    pose = None
    if args.pose:
        with open(args.pose, encoding="utf-8") as fh:
            pose = json.load(fh)
        apply_info = apply_pose(arm, mesh, pose)
        report["pose_apply"] = apply_info
        for view in (v.strip() for v in args.pose_views.split(",") if v.strip()):
            report["renders"].append(render_view(args, cam, center, size, view, prefix="posed-"))
            report["views"]["posed-" + view] = os.path.join(args.out, "posed-%s.png" % view)

    if args.dump:
        report["dump"] = dump_pose(args, arm, mesh, pose or {})
    if args.vpd_out:
        before = snapshot_pose(arm)
        report["vpd"] = export_vpd(args, root_obj)
        if not args.no_vpd_roundtrip:
            report["vpd"]["roundtrip"] = roundtrip_check(args, root_obj, arm, before)

    report["elapsed_seconds"] = round(time.time() - t_start, 2)
    report["status"] = "OK"
    if args.report:
        with open(args.report, "w", encoding="utf-8") as fh:
            json.dump(report, fh, ensure_ascii=False, indent=1)
        log("report -> %s" % args.report)
    log("REPORT_JSON %s" % json.dumps({k: report[k] for k in ("status", "model", "bbox", "elapsed_seconds")},
                                     ensure_ascii=False))
    log("DONE")


if __name__ == "__main__":
    main()
