"""水枪持枪数据探针（Blender headless）—— 遍历 `_skel.fbx`，测每个动作里武器骨是否跟手。

背景：全场景 FBX 里水枪网格只蒙皮到武器骨（Gun_b/c/d/e_01_JNT、prop_JNT、proptwo_JNT）；
`*_skel.fbx` 删了网格但保留了 332 根骨骼与全部动画通道，因此可以直接从骨骼动画判定：
  - 武器骨是否完全不动（= 源动作里没给武器做动画，等价于「没拿枪」，如 Tpose/StandBy）；
  - 武器骨是否随动作运动、且「相对右手/左手」的变换跨帧近似恒定（= 跟手 = 持枪）；
  - 或是武器自身独立动画（不跟手）/ 松手状态。

只输出**原始指标**，判定与阈值在 `analyze-watergun-hold.mjs` 里做（方便调阈值不必重跑 Blender）。

Run:
  BLENDER -b --factory-startup --python scripts/props/probe-watergun-hold.py -- \
      --dir tests/tmp/adv-full-v3/fbx --out tests/tmp/props/watergun/data-probe/per-file

  BLENDER -b --factory-startup --python scripts/props/probe-watergun-hold.py -- \
      --fbx a.fbx --fbx b.fbx --out <dir>

每文件输出 <out>/<basename>.json；stdout 每文件一行 `PROBE <json 摘要>` 便于后台进度观察。
"""
import bpy
import json
import math
import os
import sys
import time

GUN_BONES = ['Gun_b_01_JNT', 'Gun_c_01_JNT', 'Gun_d_01_JNT', 'Gun_e_01_JNT', 'prop_JNT', 'proptwo_JNT']
# 用于「相对某只手」稳定性判定的挂点骨（Biped 骨名带空格，见探索结果）
HAND_BONES = {'R': 'Bip001 R Hand', 'L': 'Bip001 L Hand'}
# 详细逐帧序列只导出这两根（枪根骨 + 武器控制骨）；其余骨只出聚合指标
SERIES_BONES = ['Gun_b_01_JNT', 'prop_JNT']


def parse_args():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    out = {'fbx': [], 'dir': None, 'out': None, 'maxSamples': 90}
    i = 0
    while i < len(argv):
        key = argv[i]
        if key == '--fbx' and i + 1 < len(argv):
            out['fbx'].append(argv[i + 1]); i += 2
        elif key in ('--dir', '--out') and i + 1 < len(argv):
            out[key[2:]] = argv[i + 1]; i += 2
        elif key == '--max-samples' and i + 1 < len(argv):
            out['maxSamples'] = int(argv[i + 1]); i += 2
        else:
            i += 1
    if out['out'] is None:
        out['out'] = 'tests/tmp/props/watergun/data-probe/per-file'
    return out


def is_gun(name):
    return name in GUN_BONES


def sanitize(obj):
    """json 不允许 NaN/Inf：统一转 None（Idle_Show_01 的武器骨 scale=0 → 矩阵 NaN）。"""
    if isinstance(obj, float):
        return obj if math.isfinite(obj) else None
    if isinstance(obj, dict):
        return {k: sanitize(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [sanitize(v) for v in obj]
    return obj


def quat_angle_deg(a, b):
    dot = abs(sum(x * y for x, y in zip(a, b)))
    return 2.0 * math.degrees(math.acos(max(-1.0, min(1.0, dot))))


def q_of_matrix(m):
    q = m.to_quaternion()
    return [q.x, q.y, q.z, q.w]


def pos_of_matrix(m):
    t = m.translation
    return [t.x, t.y, t.z]


def rel_matrix(hand_m, gun_m):
    return hand_m.inverted() @ gun_m


def dist(a, b):
    return math.sqrt(sum((x - y) ** 2 for x, y in zip(a, b)))


def median(values):
    if not values:
        return 0.0
    s = sorted(values)
    n = len(s)
    if n % 2:
        return s[n // 2]
    return 0.5 * (s[n // 2 - 1] + s[n // 2])


def percentile(values, p):
    if not values:
        return 0.0
    s = sorted(values)
    k = (len(s) - 1) * p
    f = math.floor(k)
    c = math.ceil(k)
    if f == c:
        return s[int(k)]
    return s[f] * (c - k) + s[c] * (k - f)


def pairwise_stats(vecs, quats=None):
    """O(n^2) 成对差：位置距离 + 四元数夹角；返回 p50/p90/max 与「稳定对占比」。"""
    n = len(vecs)
    if n < 2:
        return {'posP50': 0.0, 'posP90': 0.0, 'posMax': 0.0,
                'rotP50Deg': 0.0, 'rotP90Deg': 0.0, 'rotMaxDeg': 0.0,
                'stablePairFrac': 1.0 if n == 1 else 0.0}
    pd, rd = [], []
    for i in range(n):
        for j in range(i + 1, n):
            pd.append(dist(vecs[i], vecs[j]))
            if quats is not None:
                rd.append(quat_angle_deg(quats[i], quats[j]))
    stable = sum(1 for i in range(n) for j in range(i + 1, n)
                 if dist(vecs[i], vecs[j]) <= 0.03 and
                 (quats is None or quat_angle_deg(quats[i], quats[j]) <= 10.0))
    total = n * (n - 1) / 2
    return {
        'posP50': round(percentile(pd, 0.5), 5),
        'posP90': round(percentile(pd, 0.9), 5),
        'posMax': round(max(pd), 5),
        'rotP50Deg': round(percentile(rd, 0.5), 3) if rd else None,
        'rotP90Deg': round(percentile(rd, 0.9), 3) if rd else None,
        'rotMaxDeg': round(max(rd), 3) if rd else None,
        'stablePairFrac': round(stable / total, 4),
    }


def mode_cluster(vecs, quats, posTol=0.03, rotTolDeg=10.0):
    """找最大「互相接近」帧簇（代表持枪稳定段）；返回帧索引列表。"""
    n = len(vecs)
    best = []
    for i in range(n):
        members = [j for j in range(n)
                   if dist(vecs[i], vecs[j]) <= posTol and
                   (quats is None or quat_angle_deg(quats[i], quats[j]) <= rotTolDeg)]
        if len(members) > len(best):
            best = members
    return best


def explore_frames(arm, action):
    """返回 (fps, 采样帧列表, biped 帧范围, 全 action 帧范围)。"""
    scene = bpy.context.scene
    fps = scene.render.fps / scene.render.fps_base if scene.render.fps_base else scene.render.fps
    all_frames, bip_frames = [], []
    if action is not None:
        for fc in action.fcurves:
            dp = fc.data_path
            if dp.startswith('pose.bones[') and '"' in dp:
                bone = dp.split('"')[1]
                for kp in fc.keyframe_points:
                    all_frames.append(kp.co[0])
                if bone.startswith('Bip'):
                    for kp in fc.keyframe_points:
                        bip_frames.append(kp.co[0])
    if bip_frames:
        start, end = min(bip_frames), max(bip_frames)
    elif all_frames:
        start, end = min(all_frames), max(all_frames)
    else:
        start, end = 1.0, 1.0
    return fps, (float(start), float(end)), (float(min(all_frames)), float(max(all_frames))) if all_frames else None


def build_samples(arm, start, end, max_samples):
    span = end - start
    if span <= 0:
        return [int(round(start))]
    step = max(1, int(math.ceil(span / max_samples)))
    frames = list(range(int(round(start)), int(round(end)) + 1, step))
    last = int(round(end))
    if frames[-1] != last:
        frames.append(last)
    return frames


def probe_file(path):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    t0 = time.time()
    bpy.ops.import_scene.fbx(filepath=path, use_anim=True, ignore_leaf_bones=False,
                             automatic_bone_orientation=False, global_scale=1.0)
    arms = [o for o in bpy.data.objects if o.type == 'ARMATURE']
    if not arms:
        raise RuntimeError('no armature imported')
    arm = max(arms, key=lambda o: len(o.data.bones))
    action = arm.animation_data.action if (arm.animation_data and arm.animation_data.action) else None
    fps, biped_range, action_range = explore_frames(arm, action)
    frames = build_samples(arm, biped_range[0], biped_range[1], PROBE_MAX_SAMPLES)

    gun_names = [b.name for b in arm.data.bones if is_gun(b.name)]
    result = {
        'file': os.path.basename(path),
        'armature': arm.name,
        'bones': len(arm.data.bones),
        'fps': fps,
        'action': action.name if action else None,
        'bipedFrameRange': list(biped_range),
        'actionFrameRange': list(action_range) if action_range else None,
        'sampleFrames': frames,
        'gunBonesPresent': gun_names,
        'gunBonesMissing': [g for g in GUN_BONES if g not in gun_names],
        'handBones': {k: (v in arm.data.bones) for k, v in HAND_BONES.items()},
        'armatureObjectScale': [round(v, 6) for v in arm.matrix_world.to_scale()],
        'sceneFps': fps,
        'importSeconds': None,
    }

    # ---- rest 参考（armature space 的 rest 矩阵；判断「武器骨是否真的被动画」）----
    rest = {}
    for name in gun_names + list(HAND_BONES.values()):
        bone = arm.data.bones.get(name)
        if bone is not None:
            rest[name] = {
                'pos': [round(v, 6) for v in bone.matrix_local.translation],
                'quat': [round(v, 6) for v in q_of_matrix(bone.matrix_local)],
            }
    result['rest'] = rest

    # ---- 逐帧采样 ----
    series = {name: {'pos': [], 'relR_pos': [], 'relR_quat': [], 'relL_pos': [],
                     'distR': [], 'distL': [],
                     'restDevPos': [], 'restDevRotDeg': [], 'basisPos': [], 'basisRotDeg': []}
              for name in SERIES_BONES if name in gun_names}
    hand_pos = {'R': [], 'L': []}
    per_bone = {name: {'pos': [], 'quat': [], 'relR_pos': [], 'relR_quat': [],
                       'relL_pos': [], 'relL_quat': [], 'scales': []} for name in gun_names}
    arm_basis_identity = None

    for f in frames:
        bpy.context.scene.frame_set(f)
        bpy.context.view_layer.update()
        hand_mat = {}
        for side, hname in HAND_BONES.items():
            pb = arm.pose.bones.get(hname)
            if pb is None:
                continue
            hand_mat[side] = pb.matrix.copy()
            hand_pos[side].append(pos_of_matrix(pb.matrix))
        for gname in gun_names:
            pb = arm.pose.bones.get(gname)
            if pb is None or pb.bone is None:
                continue
            gm = pb.matrix.copy()
            rec = per_bone[gname]
            try:
                rec['scales'].append([abs(v) for v in gm.decompose()[2]])
            except Exception:  # noqa: BLE001
                rec['scales'].append([float('nan')] * 3)
            rec['pos'].append(pos_of_matrix(gm))
            rec['quat'].append(q_of_matrix(gm))
            for side in ('R', 'L'):
                if side in hand_mat:
                    rel = rel_matrix(hand_mat[side], gm)
                    rec[f'rel{side}_pos'].append(pos_of_matrix(rel))
                    rec[f'rel{side}_quat'].append(q_of_matrix(rel))
            if gname in series:
                s = series[gname]
                s['pos'].append(pos_of_matrix(gm))
                if 'R' in hand_mat:
                    rel = rel_matrix(hand_mat['R'], gm)
                    s['relR_pos'].append(pos_of_matrix(rel))
                    s['relR_quat'].append(q_of_matrix(rel))
                    s.setdefault('distR', []).append(round(dist(pos_of_matrix(rel), [0, 0, 0]), 5))
                if 'L' in hand_mat:
                    rel = rel_matrix(hand_mat['L'], gm)
                    s['relL_pos'].append(pos_of_matrix(rel))
                    s.setdefault('distL', []).append(round(dist(pos_of_matrix(rel), [0, 0, 0]), 5))
                rest_m = arm.data.bones[gname].matrix_local
                dv = dist(pos_of_matrix(gm), pos_of_matrix(rest_m))
                dr = quat_angle_deg(q_of_matrix(gm), q_of_matrix(rest_m))
                s['restDevPos'].append(round(dv, 6))
                s['restDevRotDeg'].append(round(dr, 3))
                basis = pb.matrix_basis
                s['basisPos'].append(pos_of_matrix(basis))
                s['basisRotDeg'].append(round(quat_angle_deg(
                    q_of_matrix(basis), [0.0, 0.0, 0.0, 1.0]), 3))

    # ---- 聚合指标 ----
    for gname in gun_names:
        rec = per_bone[gname]
        n = len(rec['pos'])
        finite_scales = [v for sc in rec['scales'] for v in sc if math.isfinite(v)]
        agg = {'samples': n,
               'fcurves': 0,
               'scaleRange': [round(min(finite_scales), 5), round(max(finite_scales), 5)] if finite_scales else None,
               'motion': pairwise_stats(rec['pos'], rec['quat']) if n else None,
               'relHand': {}}
        # 该骨的 fcurve 数（有曲线不代表有运动，仅记录）
        if action is not None:
            for fc in action.fcurves:
                if fc.data_path.startswith('pose.bones[') and '"' in fc.data_path:
                    if fc.data_path.split('"')[1] == gname:
                        agg['fcurves'] += 1
        for side in ('R', 'L'):
            rel_pos = rec[f'rel{side}_pos']
            rel_quat = rec[f'rel{side}_quat']
            if not rel_pos:
                continue
            cluster = mode_cluster(rel_pos, rel_quat)
            dists = [dist(p, [0.0, 0.0, 0.0]) for p in rel_pos]
            st = {
                'pairwise': pairwise_stats(rel_pos, rel_quat),
                'medianOffset': [round(median([v[k] for v in rel_pos]), 5) for k in range(3)],
                'medianOffsetDist': round(dist([median([v[k] for v in rel_pos]) for k in range(3)], [0, 0, 0]), 5),
                'distToHand': {
                    'median': round(median(dists), 5),
                    'min': round(min(dists), 5),
                    'p10': round(percentile(dists, 0.1), 5),
                    'p90': round(percentile(dists, 0.9), 5),
                    'max': round(max(dists), 5),
                    'nearFrac': round(sum(1 for d in dists if d <= 0.30) / n, 4) if n else 0.0,
                },
                'stableClusterSize': len(cluster),
                'stableFrac': round(len(cluster) / n, 4) if n else 0.0,
            }
            # 稳定簇内的 offset 精修（持枪段真实握持偏移）
            if cluster:
                st['clusterMedianOffset'] = [round(median([rel_pos[i][k] for i in cluster]), 5) for k in range(3)]
                st['clusterMedianOffsetDist'] = round(dist(st['clusterMedianOffset'], [0, 0, 0]), 5)
                st['clusterPosP90'] = round(percentile(
                    [dist(rel_pos[i], st['clusterMedianOffset']) for i in cluster], 0.9), 5)
                st['clusterRotP90Deg'] = round(percentile(
                    [quat_angle_deg(rel_quat[i], rel_quat[cluster[0]]) for i in cluster], 0.9), 3)
            agg['relHand'][side] = st
        if gname in series:
            s = series[gname]
            rest_dev = s['restDevPos']
            basis_pos = s['basisPos']
            agg['restDev'] = {
                'posMax': round(max(rest_dev), 5) if rest_dev else 0.0,
                'posP50': round(percentile(rest_dev, 0.5), 5),
                'rotMaxDeg': round(max(s['restDevRotDeg']), 3) if s['restDevRotDeg'] else 0.0,
                'movedFrac': round(sum(1 for v in rest_dev if v > 0.02) / n, 4) if n else 0.0,
            }
            agg['ownLocalAnim'] = {
                'posSpan': round(max(dist(v, basis_pos[0]) for v in basis_pos), 5) if basis_pos else 0.0,
                'rotMaxDeg': round(max(s['basisRotDeg']), 3) if s['basisRotDeg'] else 0.0,
            }
        result.setdefault('weaponBones', {})[gname] = agg

    # 手骨自身的运动幅度（判断身体动作是否真的动；用于识别「静止 clip」）
    for side in ('R', 'L'):
        pts = hand_pos[side]
        if len(pts) >= 2:
            result.setdefault('handMotion', {})[side] = pairwise_stats(pts)
    if 'R' in hand_pos and 'L' in hand_pos and len(hand_pos['R']) >= 1:
        result['handSeparationMedian'] = round(median(
            [dist(hand_pos['R'][i], hand_pos['L'][i]) for i in range(len(hand_pos['R']))]), 5)

    # ---- 压缩逐帧序列（保留 3 位小数/0.1°；仅 SERIES_BONES）----
    result['series'] = {}
    for gname, s in series.items():
        result['series'][gname] = {
            'pos': [[round(v, 4) for v in p] for p in s['pos']],
            'relR_pos': [[round(v, 4) for v in p] for p in s['relR_pos']],
            'relR_quat': [[round(v, 4) for v in q] for q in s['relR_quat']],
            'relL_pos': [[round(v, 4) for v in p] for p in s['relL_pos']],
            'distR': s['distR'],
            'distL': s['distL'],
            'restDevPos': [round(v, 4) for v in s['restDevPos']],
            'basisRotDeg': [round(v, 2) for v in s['basisRotDeg']],
        }

    result['importSeconds'] = round(time.time() - t0, 2)
    return result


PROBE_MAX_SAMPLES = 90


def main():
    args = parse_args()
    global PROBE_MAX_SAMPLES
    PROBE_MAX_SAMPLES = args['maxSamples']
    files = list(args['fbx'])
    if args['dir']:
        for name in sorted(os.listdir(args['dir'])):
            if name.endswith('_skel.fbx'):
                files.append(os.path.join(args['dir'], name))
    os.makedirs(args['out'], exist_ok=True)
    total = len(files)
    t_start = time.time()
    for idx, path in enumerate(files, 1):
        name = os.path.basename(path)
        try:
            result = probe_file(path)
            verdict_bits = {'file': name, 'ok': True}
        except Exception as exc:  # noqa: BLE001
            result = {'file': name, 'error': repr(exc)}
            verdict_bits = {'file': name, 'ok': False, 'error': repr(exc)}
        out_path = os.path.join(args['out'], name.replace('.fbx', '.json'))
        result = sanitize(result)
        with open(out_path, 'w', encoding='utf-8') as fh:
            json.dump(result, fh, ensure_ascii=False)
        gun = result.get('weaponBones', {}).get('Gun_b_01_JNT', {})
        if 'R' in gun.get('relHand', {}):
            r = gun['relHand']['R']
            verdict_bits.update({
                'stableFrac': r['stableFrac'],
                'distR': r['distToHand']['median'],
                'nearFrac': r['distToHand']['nearFrac'],
                'posP90': r['pairwise']['posP90'],
                'movedFrac': gun.get('restDev', {}).get('movedFrac'),
                'handMoveP90': result.get('handMotion', {}).get('R', {}).get('posP90'),
            })
        print('PROBE %d/%d %s' % (idx, total, json.dumps(sanitize(verdict_bits), ensure_ascii=False)), flush=True)
    elapsed = time.time() - t_start
    print('PROBE_DONE files=%d elapsed=%.1fs out=%s' % (total, elapsed, args['out']), flush=True)


if __name__ == '__main__':
    main()
