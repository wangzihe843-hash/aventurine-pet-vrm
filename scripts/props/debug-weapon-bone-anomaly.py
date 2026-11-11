"""定向排查：某个 _skel.fbx 里武器骨异常大幅度（如 Skill41 的 55 单位）原因。

打印：帧、Gun_b/prop_JNT/右手的 pose matrix 平移+缩放+四元数、骨骼父链、action 里
prop_JNT/Gun_b 的 location/scale 关键帧值范围。
"""
import bpy
import json
import sys

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
path = argv[0]
frames = [int(x) for x in argv[1].split(',')] if len(argv) > 1 else [1, 50, 100, 150, 200]

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=path, use_anim=True, ignore_leaf_bones=False,
                         automatic_bone_orientation=False, global_scale=1.0)
arms = [o for o in bpy.data.objects if o.type == 'ARMATURE']
arm = max(arms, key=lambda o: len(o.data.bones))
action = arm.animation_data.action if (arm.animation_data and arm.animation_data.action) else None
print('ARM', arm.name, 'bones', len(arm.data.bones), 'action', action.name if action else None)

for name in ('Gun_b_01_JNT', 'prop_JNT', 'proptwo_JNT', 'Bip001 R Hand'):
    bone = arm.data.bones.get(name)
    if not bone:
        print('NO BONE', name); continue
    chain = []
    p = bone.parent
    while p is not None:
        chain.append(p.name)
        p = p.parent
    print('CHAIN', name, '->', ' <- '.join(chain[:8]))
    print('REST', name, list(bone.matrix_local.translation), [round(v, 4) for v in bone.matrix_local.to_quaternion()])

# scale 关键帧范围
if action:
    for fc in action.fcurves:
        dp = fc.data_path
        if not dp.startswith('pose.bones['):
            continue
        bname = dp.split('"')[1] if '"' in dp else ''
        if bname in ('Gun_b_01_JNT', 'prop_JNT', 'proptwo_JNT', 'Bip001 R Hand') and 'scale' in dp:
            vals = [kp.co[1] for kp in fc.keyframe_points]
            if vals and (max(vals) - min(vals) > 0.01 or abs(max(vals) - 1) > 0.01):
                print('SCALECURVE', bname, dp.split('.')[-1], 'min', round(min(vals), 4), 'max', round(max(vals), 4))
        if bname == 'prop_JNT' and 'location' in dp:
            vals = [kp.co[1] for kp in fc.keyframe_points]
            print('LOCCURVE prop_JNT', dp.split('.')[-1], 'min', round(min(vals), 4), 'max', round(max(vals), 4))

for f in frames:
    bpy.context.scene.frame_set(f)
    bpy.context.view_layer.update()
    row = {'f': f}
    for name in ('Gun_b_01_JNT', 'prop_JNT', 'proptwo_JNT', 'Bip001 R Hand'):
        pb = arm.pose.bones.get(name)
        if pb is None:
            continue
        m = pb.matrix
        loc, quat, scale = m.decompose()
        row[name] = {
            'pos': [round(v, 4) for v in loc],
            'quat': [round(v, 4) for v in quat],
            'scale': [round(v, 4) for v in scale],
        }
    print('FRAME', json.dumps(row, ensure_ascii=False))
