"""定向排查：武器骨「绝对位置轨迹 / 父级层级 / 局部动画曲线值」——解释 skill 类 clip 的异常幅度。

背景问题（Lead 提出）：
  - Skill02/03/41/MazeSkill01/Skill01toSkill02 里 Gun_b 距双手 1.8~55 m（armature 空间）；
  - held_l 类（attackStandby/idle2/stun/hit/die/revive）枪稳定在「左手」0.084~0.112 m，疑似假阳性。
需要回答：这是飞行 FX 轨迹？坐标系/父级/缩放问题？还是源里真的这样。

Run:
  BLENDER -b --factory-startup --python scripts/props/probe-weapon-hierarchy.py -- --dir tests/tmp/adv-full-v3/fbx \
     --files Skill01,Skill02,Skill03,Skill41,MazeSkill01,Skill01toSkill02,AttackStandBy,TeamStandBy,State_Stun,Hit_L,Die,Tpose,StandBy
每文件输出一行 `HIER <json>`；同时写 <out>/<file>.json。
"""
import bpy
import json
import math
import os
import sys

GUN_BONES = ['Gun_b_01_JNT', 'Gun_c_01_JNT', 'Gun_d_01_JNT', 'Gun_e_01_JNT', 'prop_JNT', 'proptwo_JNT']
TRACE_BONES = GUN_BONES + ['Bip001 R Hand', 'Bip001 L Hand', 'Bip001 Pelvis', 'Bip001 Spine2', 'Bip001 Head']


def parse_args():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    out = {'files': [], 'dir': None, 'out': 'tests/tmp/props/watergun/data-probe/hierarchy', 'maxSamples': 13}
    i = 0
    while i < len(argv):
        key = argv[i]
        if key == '--files' and i + 1 < len(argv):
            out['files'] = [x for x in argv[i + 1].split(',') if x]
            i += 2
        elif key in ('--dir', '--out') and i + 1 < len(argv):
            out[key[2:]] = argv[i + 1]
            i += 2
        elif key == '--max-samples' and i + 1 < len(argv):
            out['maxSamples'] = int(argv[i + 1])
            i += 2
        else:
            i += 1
    return out


def finite(v):
    return v if isinstance(v, (int, str)) or (isinstance(v, float) and math.isfinite(v)) else None


def vec(v):
    return [round(float(x), 4) if math.isfinite(float(x)) else None for x in v]


def sanitize(obj):
    if isinstance(obj, float):
        return obj if math.isfinite(obj) else None
    if isinstance(obj, dict):
        return {k: sanitize(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [sanitize(v) for v in obj]
    return obj


def quat_list(q):
    return [round(q.x, 4), round(q.y, 4), round(q.z, 4), round(q.w, 4)]


def bone_chain(arm, name):
    b = arm.data.bones.get(name)
    if b is None:
        return None
    chain = []
    p = b.parent
    while p is not None:
        chain.append(p.name)
        p = p.parent
    return chain


def pose_matrix(arm, name):
    pb = arm.pose.bones.get(name)
    if pb is None:
        return None
    return pb.matrix


def dump_file(path, max_samples):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=path, use_anim=True, ignore_leaf_bones=False,
                             automatic_bone_orientation=False, global_scale=1.0)
    arms = [o for o in bpy.data.objects if o.type == 'ARMATURE']
    arm = max(arms, key=lambda o: len(o.data.bones))
    actions = [a.name for a in bpy.data.actions]
    action = arm.animation_data.action if (arm.animation_data and arm.animation_data.action) else None
    scene = bpy.context.scene
    info = {
        'file': os.path.basename(path),
        'armatures': [{'name': o.name, 'bones': len(o.data.bones)} for o in arms],
        'actions': actions,
        'activeAction': action.name if action else None,
        'bipedRange': None,
        'chains': {},
        'restRelative': {},
        'localCurves': {},
        'armatureObjectAnim': {},
        'traceFrames': [],
    }
    if action is not None:
        frames = [kp.co[0] for fc in action.fcurves if fc.data_path.startswith('pose.bones[') and fc.bl_rna is not None
                  for kp in fc.keyframe_points]
        bip = [kp.co[0] for fc in action.fcurves if fc.data_path.startswith('pose.bones[') and '"' in fc.data_path
               and fc.data_path.split('"')[1].startswith('Bip') for kp in fc.keyframe_points]
        used = bip or frames
        if used:
            info['bipedRange'] = [min(used), max(used)]
        # 每根武器骨的局部曲线（location / rotation / scale）值域
        for bname in GUN_BONES:
            curves = {}
            for fc in action.fcurves:
                dp = fc.data_path
                if not dp.startswith('pose.bones[') or '"' not in dp:
                    continue
                if dp.split('"')[1] != bname:
                    continue
                vals = [kp.co[1] for kp in fc.keyframe_points]
                if not vals:
                    continue
                props = dp.split('].')[-1] if '].' in dp else dp
                curves[props] = {
                    'n': len(vals),
                    'min': round(min(vals), 4),
                    'max': round(max(vals), 4),
                    'first': round(vals[0], 4),
                    'last': round(vals[-1], 4),
                }
            info['localCurves'][bname] = curves
        # 对象级动画（Bip001 / Root / 其他）：找 object-level fcurve
        obj_curves = {}
        for fc in action.fcurves:
            dp = fc.data_path
            if dp.startswith('pose.bones[') or dp.startswith('["'):
                continue
            vals = [kp.co[1] for kp in fc.keyframe_points]
            if not vals:
                continue
            obj_curves.setdefault(dp.split('.')[0], {})[dp.split('.')[-1]] = {
                'min': round(min(vals), 4), 'max': round(max(vals), 4)}
        info['armatureObjectAnim'] = obj_curves
        # 骨骼 rest 相对父
    for bname in GUN_BONES:
        info['chains'][bname] = bone_chain(arm, bname)
        b = arm.data.bones.get(bname)
        if b is not None:
            rel = b.matrix_local
            if b.parent is not None:
                rel = b.parent.matrix_local.inverted() @ b.matrix_local
            loc, quat, scale = rel.decompose()
            info['restRelative'][bname] = {
                'restWorldPos': vec(b.matrix_local.translation),
                'parentRelPos': vec(loc),
                'parentRelQuat': quat_list(quat),
                'parentRelScale': vec(scale),
            }
    # 帧范围
    fr = info['bipedRange']
    if not fr or fr[1] <= fr[0]:
        fr = fr or [1.0, 1.0]
    if fr[1] > fr[0]:
        step = max(1, int(math.ceil((fr[1] - fr[0]) / max(1, max_samples - 1))))
        frames = list(range(int(round(fr[0])), int(round(fr[1])) + 1, step))
        if frames[-1] != int(round(fr[1])):
            frames.append(int(round(fr[1])))
    else:
        frames = [int(round(fr[0]))]
    info['traceFrames'] = frames
    trace = []
    for f in frames:
        scene.frame_set(f)
        bpy.context.view_layer.update()
        row = {'f': f}
        am = arm.matrix_world.copy()
        aloc, aquat, ascale = am.decompose()
        row['_armatureObject'] = {
            'worldPos': vec(aloc),
            'worldQuat': quat_list(aquat),
            'worldScale': vec(ascale),
        }
        for bname in TRACE_BONES:
            m = pose_matrix(arm, bname)
            if m is None:
                continue
            loc, quat, scale = m.decompose()
            wm = am @ m
            wloc, wquat, wscale = wm.decompose()
            row[bname] = {
                'pos': vec(loc),                 # armature 空间
                'quat': quat_list(quat),
                'scale': vec(scale),
                'worldPos': vec(wloc),           # 含 Bip001 根运动的世界坐标
            }
            row[bname + '|worldQuat'] = quat_list(wquat)
        trace.append(row)
    info['trace'] = trace
    return info


def main():
    args = parse_args()
    files = []
    for stem in args['files']:
        p = os.path.join(args['dir'] or '', stem + '_skel.fbx')
        if os.path.exists(p):
            files.append(p)
        elif os.path.exists(stem):
            files.append(stem)
        else:
            print('MISSING', p)
    os.makedirs(args['out'], exist_ok=True)
    for path in files:
        try:
            info = dump_file(path, args['maxSamples'])
        except Exception as exc:  # noqa: BLE001
            info = {'file': os.path.basename(path), 'error': repr(exc)}
        info = sanitize(info)
        out_path = os.path.join(args['out'], os.path.basename(path).replace('.fbx', '.json'))
        with open(out_path, 'w', encoding='utf-8') as fh:
            json.dump(info, fh, ensure_ascii=False)
        # stdout 精简摘要：只看 Gun_b 首/中/末帧绝对位置与到双手距离
        t = info.get('trace') or []
        gun = 'Gun_b_01_JNT'
        summ = {'file': info['file'], 'frames': [r['f'] for r in t]}
        if t and gun in t[0]:
            picks = [t[0], t[len(t) // 2], t[-1]]
            summ['gunPos'] = [r[gun]['pos'] for r in picks]
            summ['gunScale'] = [r[gun]['scale'] for r in picks]
            for side, hb in (('R', 'Bip001 R Hand'), ('L', 'Bip001 L Hand')):
                ds, dws = [], []
                for r in t:
                    if gun in r and hb in r:
                        g = r[gun]['pos']
                        h = r[hb]['pos']
                        ds.append(round(math.dist(g, h), 3))
                        dws.append(round(math.dist(r[gun]['worldPos'], r[hb]['worldPos']), 3))
                summ['dist' + side] = [min(ds), max(ds)] if ds else None
                summ['worldDist' + side] = [min(dws), max(dws)] if dws else None
            summ['objectPos'] = [r['_armatureObject']['worldPos'] for r in picks]
        print('HIER ' + json.dumps(summ, ensure_ascii=False))
    print('HIER_DONE', len(files))


if __name__ == '__main__':
    main()
