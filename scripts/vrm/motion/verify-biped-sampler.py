"""Biped FBX 采样器端到端验证（macOS dev-only，一次命令跑完 build → sample → 断言）

流程：
  1) 用 Blender 重新生成合成 Biped 夹具（scripts/vrm/motion/build-biped-fixture.py）
     → work/adv-biped/fixture/*.fbx + fixture.json
  2) 对夹具 FBX 跑采样器（scripts/vrm/motion/extract-biped-anims.py）：
     skel(30fps) / full(带网格) / 60fps / tpose / 多 armature / 非 BipXXX 骨名 / 目录批量
  3) 可选用旧 HSR 官方 FBX（非 Biped）跑冒烟回归：`--hsr-fbx <path>`（默认探测
     /tmp/fbxprobe/... 是否存在）；与 tests/tmp/hsr-motion/samples.json 对齐 rest/高度/单 clip 数据
  4) 断言（全部逐条记录，任一 FAIL → exit 1）：
     JSON schema 与 extract-hsr-anims.py 输出逐字段一致；骨数/骨名/父子层级；
     rest quat/head；sourceFps/sourceHeight/sourceHipsHeight；
     take 帧范围/采样帧数/首末帧；已知帧姿态（相对旋转角、hips/root 位移）与夹具设计
     常量一致（角度 ≤0.5°、位移 ≤2mm）；四元数单位化/连续性；loop 首末一致；
     多 armature / 非 BipXXX / Tpose / 目录批量 / 60fps 降采样等降级路径。

用法：
  python3 scripts/vrm/motion/verify-biped-sampler.py            # 全量（含 HSR 冒烟，如 FBX 在）
  python3 scripts/vrm/motion/verify-biped-sampler.py --skip-hsr # 只跑夹具链路（~1 分钟）
  python3 scripts/vrm/motion/verify-biped-sampler.py --skip-build --keep   # 复用上次产物
产物（私有，gitignore）：
  work/adv-biped/fixture/**           夹具 FBX + fixture.json
  work/adv-biped/verify/**            各 samples.json / report / VERIFY-REPORT.json
"""
import argparse
import json
import math
import os
import shutil
import subprocess
import sys
import time

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
DEFAULT_BLENDER = "/Volumes/4TB外置盘/deepseek-harness/tools/blender/Blender.app/Contents/MacOS/Blender"
BLENDER = DEFAULT_BLENDER
BUILD_SCRIPT = os.path.join(REPO_ROOT, "scripts", "vrm", "motion", "build-biped-fixture.py")
SAMPLER_SCRIPT = os.path.join(REPO_ROOT, "scripts", "vrm", "motion", "extract-biped-anims.py")
FIXTURE_DIR = os.path.join(REPO_ROOT, "work", "adv-biped", "fixture")
VERIFY_DIR = os.path.join(REPO_ROOT, "work", "adv-biped", "verify")
HSR_FBX_DEFAULT = "/tmp/fbxprobe/砂金/Animator/Avatar_Aventurine_00/Avatar_Aventurine_00.fbx"
HSR_SAMPLES_DEFAULT = os.path.join(REPO_ROOT, "tests", "tmp", "hsr-motion", "samples.json")

CHECKS = []


# --------------------------------------------------------------------------
# 基础工具
# --------------------------------------------------------------------------

def record(group, check_id, ok, detail="", expected=None, actual=None):
    CHECKS.append({
        "group": group,
        "id": check_id,
        "ok": bool(ok),
        "detail": detail,
        "expected": expected,
        "actual": actual,
    })
    if not ok:
        print("FAIL [%s] %s: %s" % (group, check_id, detail))
    return bool(ok)


def approx(actual, expected, tol):
    return actual is not None and expected is not None and abs(actual - expected) <= tol


def load_json(path):
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def run_blender(script, script_args, timeout=1800):
    command = [BLENDER, "-b", "--factory-startup", "--python", script, "--"] + script_args
    started = time.time()
    completed = subprocess.run(command, capture_output=True, text=True, timeout=timeout)
    duration = time.time() - started
    output = (completed.stdout or "") + (completed.stderr or "")
    return {
        "command": " ".join(command),
        "returncode": completed.returncode,
        "durationSec": round(duration, 2),
        "tail": "\n".join(output.strip().splitlines()[-20:]),
        "stdout": output,
    }


def blender_ok(result, label):
    if result["returncode"] != 0:
        record("run", label, False, "exit=%d\n%s" % (result["returncode"], result["tail"]))
        return False
    return True


# --------------------------------------------------------------------------
# 四元数工具（[x,y,z,w]）
# --------------------------------------------------------------------------

def q_mul(a, b):
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return [
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
    ]


def q_conj(q):
    return [-q[0], -q[1], -q[2], q[3]]


def q_dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def q_angle_deg(a, b):
    """两个旋转之间的夹角（度，0..180；对 q 与 -q 同解）。"""
    na = math.sqrt(q_dot(a, a))
    nb = math.sqrt(q_dot(b, b))
    if na == 0 or nb == 0:
        return float("nan")
    dot = abs(q_dot(a, b) / (na * nb))
    dot = max(-1.0, min(1.0, dot))
    return math.degrees(2.0 * math.acos(dot))


def q_local(samples, q_map, bone):
    """q_local = world(parent)^-1 * world(bone)（与 build-biped-fixture.py 的 local 探针同口径）。"""
    rest_entry = samples["rest"].get(bone)
    if rest_entry is None:
        return None
    parent = rest_entry.get("parent")
    if not parent:
        return q_map[bone]
    return q_mul(q_conj(q_map[parent]), q_map[bone])


def find_data(clip, frame):
    for entry in clip["data"]:
        if abs(entry["f"] - frame) <= 1e-6:
            return entry
    return None


def measure_probe_from_samples(samples, clip, probe):
    kind = probe["kind"]
    if kind == "loopMaxAngleDeg":
        first = clip["data"][0]
        last = clip["data"][-1]
        max_deg = 0.0
        for bone in samples["rest"]:
            if bone in first["q"] and bone in last["q"]:
                max_deg = max(max_deg, q_angle_deg(first["q"][bone], last["q"][bone]))
        return max_deg
    from_entry = find_data(clip, probe["fromFrame"])
    to_entry = find_data(clip, probe["toFrame"])
    if from_entry is None or to_entry is None:
        return None
    if kind == "localRelAngleDeg":
        bone = probe["bone"]
        q0 = q_local(samples, from_entry["q"], bone)
        q1 = q_local(samples, to_entry["q"], bone)
        if q0 is None or q1 is None:
            return None
        return q_angle_deg(q0, q1)
    if kind == "headDeltaMeters":
        bone = probe["bone"]
        p0 = from_entry["h"][bone]
        p1 = to_entry["h"][bone]
        return math.dist(p1, p0)
    if kind == "headOffsetDeltaMeters":
        bone = probe["bone"]
        ref = probe["refBone"]
        d0 = [a - b for a, b in zip(from_entry["h"][bone], from_entry["h"][ref])]
        d1 = [a - b for a, b in zip(to_entry["h"][bone], to_entry["h"][ref])]
        return math.dist(d1, d0)
    return None


# --------------------------------------------------------------------------
# schema 断言（与 HSR samples.json 对齐）
# --------------------------------------------------------------------------

HSR_TOP_KEYS = {
    "schemaVersion", "generatedAt", "fbx", "sourceFps", "fps", "sourceHeightMeters",
    "sourceHipsHeightMeters", "rest", "children", "clips",
}
CLIP_KEYS = {"action", "takeMatch", "srcFrames", "frames", "data"}
DATA_KEYS = {"f", "q", "h"}
REST_KEYS = {"quat", "head", "parent"}


def check_schema(group, label, samples, expected_fps, expected_source_fps=None, hsr_top_keys=None):
    top_keys = set(samples.keys())
    if hsr_top_keys:
        record(group, label + ".topKeys", top_keys == hsr_top_keys,
               "top-level keys 与 HSR samples.json 不一致：多 %s 少 %s" % (
                   sorted(top_keys - hsr_top_keys), sorted(hsr_top_keys - top_keys)))
    else:
        record(group, label + ".topKeys", top_keys == HSR_TOP_KEYS,
               "top-level keys 不符合 schema：多 %s 少 %s" % (
                   sorted(top_keys - HSR_TOP_KEYS), sorted(HSR_TOP_KEYS - top_keys)))
    record(group, label + ".schemaVersion", samples.get("schemaVersion") == 1,
           "schemaVersion=%r" % samples.get("schemaVersion"))
    record(group, label + ".fps", samples.get("fps") == expected_fps,
           "fps=%r 期望 %r" % (samples.get("fps"), expected_fps))
    if expected_source_fps is not None:
        record(group, label + ".sourceFps", approx(samples.get("sourceFps"), expected_source_fps, 1e-6),
               "sourceFps=%r 期望 %r" % (samples.get("sourceFps"), expected_source_fps))
    record(group, label + ".heightFinite",
           isinstance(samples.get("sourceHeightMeters"), (int, float)) and samples["sourceHeightMeters"] > 0,
           "sourceHeightMeters=%r" % samples.get("sourceHeightMeters"))
    record(group, label + ".hipsHeightFinite",
           isinstance(samples.get("sourceHipsHeightMeters"), (int, float)) and samples["sourceHipsHeightMeters"] > 0,
           "sourceHipsHeightMeters=%r" % samples.get("sourceHipsHeightMeters"))
    rest = samples.get("rest") or {}
    children = samples.get("children") or {}
    clips = samples.get("clips") or {}
    rest_shape_ok = all(set(entry.keys()) == REST_KEYS and len(entry["quat"]) == 4 and len(entry["head"]) == 3
                        for entry in rest.values())
    record(group, label + ".restShape", bool(rest) and rest_shape_ok,
           "rest 条目字段应为 %s（实际 %d 骨）" % (sorted(REST_KEYS), len(rest)))
    children_ok = set(children.keys()) == set(rest.keys()) and all(
        isinstance(names, list) for names in children.values())
    record(group, label + ".childrenShape", children_ok, "children 键集合应等于 rest 键集合")
    if clips:
        clip_shape_ok = all(set(clip.keys()) - {"sourceFps"} == CLIP_KEYS for clip in clips.values())
        record(group, label + ".clipShape", clip_shape_ok,
               "clip 字段应恰为 %s（+ 可选扩展 sourceFps），实际 %s" % (
                   sorted(CLIP_KEYS), sorted({tuple(sorted(c.keys())) for c in clips.values()})))
        per_clip_fps_ok = all(
            isinstance(clip.get("sourceFps"), (int, float)) and clip["sourceFps"] > 0
            for clip in clips.values())
        record(group, label + ".clipSourceFps", per_clip_fps_ok,
               "每个 clip 应带 per-clip sourceFps（Lead 指示扩展；实际 %s）" % (
                   {clip_id: clip.get("sourceFps") for clip_id, clip in clips.items()}))
        data_shape_ok = True
        bone_count = len(rest)
        for clip in clips.values():
            for entry in clip["data"]:
                if set(entry.keys()) != DATA_KEYS:
                    data_shape_ok = False
                elif len(entry["q"]) != bone_count or len(entry["h"]) != bone_count:
                    data_shape_ok = False
                else:
                    for quat in entry["q"].values():
                        if len(quat) != 4:
                            data_shape_ok = False
                            break
                    for head in entry["h"].values():
                        if len(head) != 3:
                            data_shape_ok = False
                            break
        record(group, label + ".dataShape", data_shape_ok,
               "data 条目应含 {f,q,h} 且 q/h 覆盖全部 %d 骨（HSR schema）" % bone_count)
    quat_ok = True
    for entry in rest.values():
        norm = math.sqrt(sum(value * value for value in entry["quat"]))
        if abs(norm - 1.0) > 1e-5:
            quat_ok = False
    record(group, label + ".restQuatNormalized", quat_ok, "rest 四元数应为单位四元数")


# --------------------------------------------------------------------------
# 夹具结构 / 数据断言
# --------------------------------------------------------------------------

def check_fixture_structure(group, label, samples, fixture, fixture_file):
    fixture_rec = fixture["files"][fixture_file]
    record(group, label + ".boneCount", len(samples["rest"]) == fixture["boneCount"],
           "骨数 %d 期望 %d" % (len(samples["rest"]), fixture["boneCount"]))
    expected_names = list(fixture_rec["rest"].keys())
    actual_names = list(samples["rest"].keys())
    record(group, label + ".boneNames", actual_names == expected_names,
           "骨名/顺序不一致（缺 %s 多 %s）" % (sorted(set(expected_names) - set(actual_names)),
                                        sorted(set(actual_names) - set(expected_names))))
    expected_children = fixture_rec["children"]
    actual_children = samples["children"]
    children_ok = True
    mismatch = []
    for name in expected_children:
        if sorted(expected_children[name]) != sorted(actual_children.get(name, [])):
            children_ok = False
            mismatch.append(name)
    record(group, label + ".children", children_ok, "父子层级不一致：%s" % mismatch[:5])
    # rest quat/head（quat 用旋转夹角比较，避免 q 与 -q 表示差异）
    max_angle = 0.0
    max_head = 0.0
    for name in expected_names:
        if name not in samples["rest"]:
            continue
        max_angle = max(max_angle, q_angle_deg(samples["rest"][name]["quat"],
                                               fixture_rec["rest"][name]["quat"]))
        for index in range(3):
            max_head = max(max_head, abs(samples["rest"][name]["head"][index]
                                         - fixture_rec["rest"][name]["head"][index]))
    record(group, label + ".restQuat", max_angle <= 0.01,
           "rest quat 最大旋转差 %.4f°（期望 ≤0.01°）" % max_angle, expected=0, actual=max_angle)
    record(group, label + ".restHead", max_head <= 1e-5, "rest head 最大差 %.2e（期望 ≤1e-5）" % max_head,
           expected=0, actual=max_head)
    record(group, label + ".height", approx(samples["sourceHeightMeters"],
                                           fixture_rec["sourceHeightMeters"], 2e-3),
           "sourceHeightMeters=%r 夹具=%r" % (samples["sourceHeightMeters"],
                                              fixture_rec["sourceHeightMeters"]))
    record(group, label + ".hipsHeight", approx(samples["sourceHipsHeightMeters"],
                                               fixture_rec["sourceHipsHeightMeters"], 2e-3),
           "sourceHipsHeightMeters=%r 夹具=%r" % (samples["sourceHipsHeightMeters"],
                                                  fixture_rec["sourceHipsHeightMeters"]))
    record(group, label + ".footstepsNotBone", "Bip001 Footsteps" not in samples["rest"]
           and "Footsteps" not in samples["rest"],
           "辅助对象 Bip001 Footsteps 不应进入 rest")
    return fixture_rec


def check_clip_against_fixture(group, label, samples, fixture_take, clip_id, expected_take_name):
    clips = samples.get("clips") or {}
    if clip_id not in clips:
        record(group, label + "." + clip_id + ".present", False, "缺少 clip %r（实际 %s）" % (
            clip_id, list(clips.keys())))
        return None
    clip = clips[clip_id]
    record(group, label + "." + clip_id + ".action", expected_take_name in clip["action"],
           "action=%r 应包含 %r" % (clip["action"], expected_take_name))
    expected_src = [float(value) for value in fixture_take["srcFrames"]]
    record(group, label + "." + clip_id + ".srcFrames", clip["srcFrames"] == expected_src,
           "srcFrames=%r 期望 %r" % (clip["srcFrames"], expected_src))
    record(group, label + "." + clip_id + ".frames", clip["frames"] == fixture_take["expectedSamplesAt30fps"],
           "frames=%d 期望 %d" % (clip["frames"], fixture_take["expectedSamplesAt30fps"]))
    data = clip["data"]
    record(group, label + "." + clip_id + ".firstFrame", abs(data[0]["f"] - expected_src[0]) <= 1e-6,
           "data[0].f=%r 期望 %r" % (data[0]["f"], expected_src[0]))
    record(group, label + "." + clip_id + ".lastFrame", abs(data[-1]["f"] - expected_src[1]) <= 1e-6,
           "data[-1].f=%r 期望 %r" % (data[-1]["f"], expected_src[1]))
    # 已知帧姿态探针（夹具设计常量 ≤0.5° / ≤2mm）
    for probe in fixture_take["probes"]:
        measured = measure_probe_from_samples(samples, clip, probe)
        if measured is None:
            record(group, label + "." + clip_id + "." + probe["id"], False, "探针帧不在采样结果中")
            continue
        if probe["kind"] == "loopMaxAngleDeg":
            ok = measured <= 0.5 and (probe["designMaxDeg"] is None or measured <= probe["designMaxDeg"] + 0.5)
            record(group, label + "." + clip_id + "." + probe["id"], ok,
                   "loop 首末最大差 %.4f°（期望 ≤0.5°）" % measured, expected=0.0, actual=measured)
        elif probe["kind"] == "localRelAngleDeg":
            record(group, label + "." + clip_id + "." + probe["id"],
                   approx(measured, probe["expected"], 0.5) and approx(measured, probe["design"], 0.5),
                   "relative angle %.4f° 期望(夹具实测) %.4f° / 设计 %.1f°（容差 0.5°）" % (
                       measured, probe["expected"], probe["design"]),
                   expected=probe["design"], actual=measured)
        else:
            record(group, label + "." + clip_id + "." + probe["id"],
                   approx(measured, probe["expected"], 2e-3) and approx(measured, probe["design"], 2e-3),
                   "displacement %.6f m 期望(夹具实测) %.6f m / 设计 %.6f m（容差 2mm）" % (
                       measured, probe["expected"], probe["design"]),
                   expected=probe["design"], actual=measured)
    # 四元数连续性 / 单位化 / 无 NaN
    max_step = 0.0
    max_norm = 0.0
    for index in range(len(data) - 1):
        for bone in samples["rest"]:
            qa = data[index]["q"].get(bone)
            qb = data[index + 1]["q"].get(bone)
            if not qa or not qb:
                continue
            max_step = max(max_step, q_angle_deg(qa, qb))
    for entry in data:
        for quat in entry["q"].values():
            max_norm = max(max_norm, abs(math.sqrt(sum(value * value for value in quat)) - 1.0))
    record(group, label + "." + clip_id + ".quaternionContinuity", max_step <= 60.0 and max_norm <= 1e-5,
           "帧间最大旋转 %.3f°（期望 ≤60），|q| 最大偏差 %.2e" % (max_step, max_norm))
    if fixture_take["loop"]:
        first = data[0]["q"]
        last = data[-1]["q"]
        max_loop = max(q_angle_deg(first[bone], last[bone]) for bone in samples["rest"]
                       if bone in first and bone in last)
        record(group, label + "." + clip_id + ".loopFirstLast", max_loop <= 0.5,
               "loop clip 首末最大差 %.4f°（期望 ≤0.5°）" % max_loop)
    return clip


def check_clip_source_fps(group, label, samples, expected_fps):
    clips = samples.get("clips") or {}
    if not clips:
        record(group, label + ".clipSourceFpsValue", False, "没有 clips 可检查 sourceFps")
        return
    bad = {clip_id: clip.get("sourceFps") for clip_id, clip in clips.items()
           if not approx(clip.get("sourceFps"), expected_fps, 1e-6)}
    record(group, label + ".clipSourceFpsValue", not bad,
           "clips[*].sourceFps 应为 %r，实际 %s" % (
               expected_fps, {clip_id: clip.get("sourceFps") for clip_id, clip in clips.items()}))


def check_tpose_rest_pose(group, label, samples):
    """A clip 首帧应为 T-pose：所有骨 local(world) 相对 rest 的偏差 ≈0。"""
    clip = (samples.get("clips") or {}).get("armRaise")
    if not clip:
        record(group, label + ".firstFrameRest", False, "缺少 armRaise clip")
        return
    entry = clip["data"][0]
    max_deg = 0.0
    for bone in samples["rest"]:
        parent = samples["rest"][bone].get("parent")
        if parent:
            local_pose = q_mul(q_conj(entry["q"][parent]), entry["q"][bone])
            local_rest = q_mul(q_conj(samples["rest"][parent]["quat"]), samples["rest"][bone]["quat"])
        else:
            local_pose = entry["q"][bone]
            local_rest = samples["rest"][bone]["quat"]
        max_deg = max(max_deg, q_angle_deg(local_pose, local_rest))
    record(group, label + ".firstFrameRest", max_deg <= 0.5,
           "首帧相对 rest 最大偏差 %.4f°（期望 ≤0.5°）" % max_deg)


# --------------------------------------------------------------------------
# 主流程
# --------------------------------------------------------------------------

def sampler_args(fbx, config, out, report, minimal=True, extra=None):
    args = ["--fbx", fbx, "--config", config, "--out", out, "--report", report]
    if minimal:
        args.append("--minimal")
    return args + (extra or [])


def main():
    parser = argparse.ArgumentParser(description="Biped FBX sampler E2E verification")
    parser.add_argument("--blender", default=DEFAULT_BLENDER)
    parser.add_argument("--skip-build", action="store_true", help="复用已有 fixture")
    parser.add_argument("--skip-hsr", action="store_true", help="跳过 HSR 冒烟")
    parser.add_argument("--hsr-fbx", default=HSR_FBX_DEFAULT)
    parser.add_argument("--hsr-samples", default=HSR_SAMPLES_DEFAULT)
    parser.add_argument("--skip-dir", action="store_true", help="跳过目录批量验证")
    parser.add_argument("--keep", action="store_true", help="保留旧产物（默认会清理 verify/）")
    args = parser.parse_args()

    global BLENDER
    BLENDER = args.blender
    if not os.path.exists(BLENDER):
        raise SystemExit("Blender 不存在：%s" % BLENDER)
    if not args.keep and os.path.isdir(VERIFY_DIR):
        shutil.rmtree(VERIFY_DIR)
    os.makedirs(VERIFY_DIR, exist_ok=True)
    os.makedirs(FIXTURE_DIR, exist_ok=True)
    timings = {}
    artifacts = {}

    hsr_samples = load_json(args.hsr_samples) if os.path.exists(args.hsr_samples) else None
    hsr_top_keys = set(hsr_samples.keys()) if hsr_samples else None

    # ---------- 1. 生成夹具 ----------
    if not args.skip_build:
        result = run_blender(BUILD_SCRIPT, ["--out", FIXTURE_DIR])
        timings["build"] = result["durationSec"]
        if not blender_ok(result, "build-biped-fixture.py"):
            return finish(timings, artifacts)
        artifacts["fixture"] = os.path.join(FIXTURE_DIR, "fixture.json")
    fixture_path = os.path.join(FIXTURE_DIR, "fixture.json")
    if not os.path.exists(fixture_path):
        record("run", "fixture.json", False, "缺少 %s（先跑 build）" % fixture_path)
        return finish(timings, artifacts)
    fixture = load_json(fixture_path)
    artifacts["fixture"] = fixture_path
    record("fixture", "designVerification", fixture.get("designVerification", {}).get("ok") is True,
           "夹具设计自检失败：%r" % (fixture.get("designVerification"),))
    record("fixture", "designAngleDeviation",
           fixture.get("designVerification", {}).get("maxAngleDeviationDeg", 999) <= 0.05,
           "设计角偏差 %.6f°（期望 ≤0.05°）" % fixture.get("designVerification", {}).get("maxAngleDeviationDeg"))
    record("fixture", "designMetersDeviation",
           fixture.get("designVerification", {}).get("maxMetersDeviation", 999) <= 1e-4,
           "设计位移偏差 %.2e m" % fixture.get("designVerification", {}).get("maxMetersDeviation"))
    record("fixture", "boneCount", fixture.get("boneCount") == 66,
           "夹具骨数 %r 期望 66（Biped 标准骨架）" % fixture.get("boneCount"))

    # ---------- 配置 ----------
    clips_config = {
        "schemaVersion": 1,
        "fps": 30,
        "sourceFps": 30,
        "clips": [
            {"id": "armRaise", "takeMatch": "Adv_Ani_TestArmRaise", "loop": True},
            {"id": "hipsTurn", "takeMatch": "Adv_Ani_TestHipsTurn", "loop": False},
        ],
    }
    config_path = os.path.join(VERIFY_DIR, "clips.fixture.json")
    with open(config_path, "w", encoding="utf-8") as handle:
        json.dump(clips_config, handle, ensure_ascii=False, indent=1)
    artifacts["clipsConfig"] = config_path

    # ---------- 2. 单文件采样 ----------
    runs = {
        "skel30": ("biped-anim-skel.fbx", "samples-30.json", "report-30.json", []),
        "full30": ("biped-anim-full.fbx", "samples-full.json", "report-full.json", []),
        "fps60": ("biped-anim-60fps.fbx", "samples-60.json", "report-60.json", []),
        "tpose": ("biped-tpose.fbx", "samples-tpose.json", "report-tpose.json", []),
        "multi": ("biped-anim-multi.fbx", "samples-multi.json", "report-multi.json", []),
        "generic": ("biped-anim-generic.fbx", "samples-generic.json", "report-generic.json", []),
        "zup": ("biped-anim-zup.fbx", "samples-zup.json", "report-zup.json", []),
    }
    sampled = {}
    reports = {}
    for key, (fbx_name, out_name, report_name, extra) in runs.items():
        fbx_path = os.path.join(FIXTURE_DIR, fbx_name)
        out_path = os.path.join(VERIFY_DIR, out_name)
        report_path = os.path.join(VERIFY_DIR, report_name)
        result = run_blender(
            SAMPLER_SCRIPT,
            sampler_args(fbx_path, config_path, out_path, report_path, minimal=True, extra=extra),
            timeout=900,
        )
        timings["sample-" + key] = result["durationSec"]
        if not blender_ok(result, "extract-biped-anims.py " + fbx_name):
            continue
        sampled[key] = load_json(out_path)
        reports[key] = load_json(report_path)
        artifacts["samples-" + key] = out_path
        artifacts["report-" + key] = report_path

    # ---------- 2.5 单 take 回退（真实 3ds Max 每文件 1 个 take，take 名通常不匹配 config） ----------
    single_fbx = os.path.join(FIXTURE_DIR, "biped-anim-single.fbx")
    if os.path.exists(single_fbx):
        fallback_config = {
            "schemaVersion": 1,
            "fps": 30,
            "matchMode": "exact",
            "clips": [{"id": "standbyLike", "takeMatch": "Take 001", "loop": True}],
        }
        fallback_config_path = os.path.join(VERIFY_DIR, "clips.fallback.json")
        with open(fallback_config_path, "w", encoding="utf-8") as handle:
            json.dump(fallback_config, handle, ensure_ascii=False, indent=1)
        out_path = os.path.join(VERIFY_DIR, "samples-single.json")
        report_path = os.path.join(VERIFY_DIR, "report-single.json")
        result = run_blender(
            SAMPLER_SCRIPT,
            sampler_args(single_fbx, fallback_config_path, out_path, report_path, minimal=True),
            timeout=900,
        )
        timings["sample-single"] = result["durationSec"]
        artifacts["samples-single"] = out_path
        artifacts["report-single"] = report_path
        if blender_ok(result, "extract-biped-anims.py single-take"):
            samples = load_json(out_path)
            report = load_json(report_path)
            check_schema("single", "single", samples, 30, 30, hsr_top_keys)
            record("single", "single.clipCount", len(samples["clips"]) == 1,
                   "单 take FBX 应出 1 个 clip（实际 %d）" % len(samples["clips"]))
            clip = (samples["clips"] or {}).get("standbyLike")
            record("single", "single.clipId", clip is not None,
                   "单 take 回退应使用 config clip id 'standbyLike'（实际 %s）" % list(samples["clips"].keys()))
            if clip:
                record("single", "single.action", "Adv_Ani_TestArmRaise" in clip["action"],
                       "回退选中的 action=%r 期望包含 Adv_Ani_TestArmRaise" % clip["action"])
                record("single", "single.frames", clip["frames"] == 31,
                       "单 take 采样帧数 %d 期望 31" % clip["frames"])
            warnings_text = "\n".join(report.get("warnings") or [])
            record("single", "single.warning", "回退" in warnings_text,
                   "takeMatch 未命中且单 take 时应记录回退 warning，实际：%r" % (report.get("warnings"),))
        # 关闭回退时应明确报错（非 0 退出）
        result = run_blender(
            SAMPLER_SCRIPT,
            sampler_args(single_fbx, fallback_config_path,
                         os.path.join(VERIFY_DIR, "samples-single-nofallback.json"),
                         os.path.join(VERIFY_DIR, "report-single-nofallback.json"),
                         minimal=True, extra=["--no-single-take-fallback"]),
            timeout=900,
        )
        record("single", "single.noFallbackErrors", result["returncode"] != 0,
               "--no-single-take-fallback 时 takeMatch 未命中应报错退出（exit=%d）" % result["returncode"])

    # ---------- 2.6 默认全采模式（不传 --config / --minimal：采所有 take，clip id 由 action 名派生） ----------
    fullmode_fbx = os.path.join(FIXTURE_DIR, "biped-anim-skel.fbx")
    if os.path.exists(fullmode_fbx):
        out_path = os.path.join(VERIFY_DIR, "samples-fullmode.json")
        report_path = os.path.join(VERIFY_DIR, "report-fullmode.json")
        result = run_blender(
            SAMPLER_SCRIPT,
            ["--fbx", fullmode_fbx, "--out", out_path, "--report", report_path],
            timeout=900,
        )
        timings["sample-fullmode"] = result["durationSec"]
        artifacts["samples-fullmode"] = out_path
        if blender_ok(result, "extract-biped-anims.py full-mode"):
            samples = load_json(out_path)
            check_schema("fullmode", "fullmode", samples, 30, 30, hsr_top_keys)
            clipped = set(samples["clips"].keys())
            record("fullmode", "fullmode.clipCount", len(clipped) == 2,
                   "默认全采应采到 2 个 take（实际 %s）" % sorted(clipped))
            record("fullmode", "fullmode.derivedIds",
                   any("Adv_Ani_TestArmRaise" in cid for cid in clipped)
                   and any("Adv_Ani_TestHipsTurn" in cid for cid in clipped),
                   "默认全采 clip id 应由 action 短名派生：%s" % sorted(clipped))
            record("fullmode", "fullmode.frames",
                   all(clip["frames"] in (31, 61) for clip in samples["clips"].values()),
                   "默认全采帧数应继承各 take 的帧范围")
            check_clip_source_fps("fullmode", "fullmode", samples, 30)

    # ---------- 3. 结构 / schema / 姿态断言 ----------
    if "skel30" in sampled:
        samples = sampled["skel30"]
        fixture_rec = check_fixture_structure("skel30", "skel30", samples, fixture, "biped-anim-skel.fbx")
        check_schema("skel30", "skel30", samples, 30, 30, hsr_top_keys)
        fixture_takes = fixture_rec["takes"]
        check_clip_against_fixture("skel30", "skel30", samples, fixture_takes["Adv_Ani_TestArmRaise"],
                                   "armRaise", "Adv_Ani_TestArmRaise")
        check_clip_against_fixture("skel30", "skel30", samples, fixture_takes["Adv_Ani_TestHipsTurn"],
                                   "hipsTurn", "Adv_Ani_TestHipsTurn")
        check_tpose_rest_pose("skel30", "skel30", samples)
        check_clip_source_fps("skel30", "skel30", samples, 30)
        report = reports["skel30"]
        record("skel30", "skel30.report.bones", report["files"][0]["boneCount"] == 66,
               "report boneCount=%r" % report["files"][0]["boneCount"])
        non_arm_names = [item["name"] for item in report["files"][0]["nonArmatureObjects"]]
        record("skel30", "skel30.report.ignoredEmpty", "Bip001 Footsteps" in non_arm_names,
               "report 未记录被忽略的辅助对象：%s" % non_arm_names)

    if "full30" in sampled:
        samples = sampled["full30"]
        fixture_rec = fixture["files"]["biped-anim-full.fbx"]
        check_schema("full30", "full30", samples, 30, 30, hsr_top_keys)
        record("full30", "full30.boneCount", len(samples["rest"]) == 66,
               "带网格 FBX 骨数 %d 期望 66" % len(samples["rest"]))
        skel_rest = sampled["skel30"]["rest"] if "skel30" in sampled else None
        if skel_rest:
            max_angle = 0.0
            max_head = 0.0
            for name, entry in skel_rest.items():
                max_angle = max(max_angle, q_angle_deg(entry["quat"], samples["rest"][name]["quat"]))
                for index in range(3):
                    max_head = max(max_head, abs(entry["head"][index] - samples["rest"][name]["head"][index]))
            record("full30", "full30.restEqualsSkel", max_angle <= 0.01 and max_head <= 1e-5,
                   "带网格/无网格 rest 最大旋转差 %.4f° / 位置差 %.2e" % (max_angle, max_head))
        check_clip_against_fixture("full30", "full30", samples, fixture_rec["takes"]["Adv_Ani_TestHipsTurn"],
                                   "hipsTurn", "Adv_Ani_TestHipsTurn")
        check_clip_source_fps("full30", "full30", samples, 30)
        report = reports["full30"]
        non_arm = [item for item in report["files"][0]["nonArmatureObjects"] if item["type"] == "MESH"]
        record("full30", "full30.report.meshIgnored", len(non_arm) >= 1,
               "带网格 FBX 的 mesh 未被识别为可忽略对象")

    if "fps60" in sampled:
        samples = sampled["fps60"]
        fixture_rec = fixture["files"]["biped-anim-60fps.fbx"]
        check_schema("fps60", "fps60", samples, 30, 60, hsr_top_keys)
        check_fixture_structure("fps60", "fps60", samples, fixture, "biped-anim-60fps.fbx")
        takes = fixture_rec["takes"]
        clip = check_clip_against_fixture("fps60", "fps60", samples, takes["Adv_Ani_TestArmRaise"],
                                          "armRaise", "Adv_Ani_TestArmRaise")
        record("fps60", "fps60.A.srcFrames", clip and clip["srcFrames"] == [1.0, 61.0],
               "A srcFrames=%r 期望 [1,61]" % (clip and clip["srcFrames"]))
        record("fps60", "fps60.A.step", clip and abs((clip["data"][1]["f"] - clip["data"][0]["f"]) - 2.0) <= 1e-6,
               "60fps 源 → 30fps 输出应 step=2（实际 f0=%r f1=%r）" % (
                   clip and clip["data"][0]["f"], clip and clip["data"][1]["f"]))
        check_clip_source_fps("fps60", "fps60", samples, 60)
        clip_b = check_clip_against_fixture("fps60", "fps60", samples, takes["Adv_Ani_TestHipsTurn"],
                                            "hipsTurn", "Adv_Ani_TestHipsTurn")
        record("fps60", "fps60.B.srcFrames", clip_b and clip_b["srcFrames"] == [1.0, 122.0],
               "B srcFrames=%r 期望 [1,122]" % (clip_b and clip_b["srcFrames"]))
        record("fps60", "fps60.B.endFrameAppended",
               clip_b and clip_b["frames"] == 62 and abs(clip_b["data"][-1]["f"] - 122.0) <= 1e-6,
               "非 loop 奇数跨度应补末帧：frames=%r lastF=%r（期望 62 / 122）" % (
                   clip_b and clip_b["frames"], clip_b and clip_b["data"][-1]["f"]))

    if "tpose" in sampled:
        samples = sampled["tpose"]
        check_schema("tpose", "tpose", samples, 30, 30, hsr_top_keys)
        record("tpose", "tpose.emptyClips", samples["clips"] == {},
               "Tpose FBX 应输出空 clips（实际 %d 个）" % len(samples["clips"]))
        record("tpose", "tpose.rest", len(samples["rest"]) == 66,
               "Tpose FBX rest 骨数 %d 期望 66" % len(samples["rest"]))

    if "multi" in sampled:
        samples = sampled["multi"]
        report = reports["multi"]
        check_schema("multi", "multi", samples, 30, 30, hsr_top_keys)
        record("multi", "multi.boneCount", len(samples["rest"]) == 66,
               "多 armature 场景应选主骨架（66 骨），实际 %d" % len(samples["rest"]))
        warnings_text = "\n".join(report.get("warnings") or [])
        record("multi", "multi.warning", "armature" in warnings_text and "2 个" in warnings_text,
               "多 armature 降级应记录 warning，实际：%r" % (report.get("warnings"),))
        record("multi", "multi.clips", len(samples["clips"]) == 2,
               "多 armature 场景应采到 2 个 take，实际 %d" % len(samples["clips"]))

    if "generic" in sampled:
        samples = sampled["generic"]
        report = reports["generic"]
        fixture_rec = fixture["files"]["biped-anim-generic.fbx"]
        check_schema("generic", "generic", samples, 30, 30, hsr_top_keys)
        record("generic", "generic.boneNames",
               list(samples["rest"].keys()) == list(fixture_rec["rest"].keys()),
               "非 BipXXX 命名场景骨名应与夹具一致")
        record("generic", "generic.hips", samples.get("sourceHipsHeightMeters") is not None
               and approx(samples["sourceHipsHeightMeters"], fixture_rec["sourceHipsHeightMeters"], 2e-3),
               "非 BipXXX 命名场景 hips 高度=%r 夹具=%r" % (
                   samples.get("sourceHipsHeightMeters"), fixture_rec["sourceHipsHeightMeters"]))
        warnings_text = "\n".join(report.get("warnings") or [])
        record("generic", "generic.warning", "不是 BipXXX" in warnings_text,
               "非 BipXXX 根骨应记录 warning，实际：%r" % (report.get("warnings"),))

    if "zup" in sampled:
        samples = sampled["zup"]
        fixture_rec = fixture["files"]["biped-anim-zup.fbx"]
        check_schema("zup", "zup", samples, 30, 30, hsr_top_keys)
        check_fixture_structure("zup", "zup", samples, fixture, "biped-anim-zup.fbx")
        takes = fixture_rec["takes"]
        check_clip_against_fixture("zup", "zup", samples, takes["Adv_Ani_TestArmRaise"],
                                   "armRaise", "Adv_Ani_TestArmRaise")
        check_clip_against_fixture("zup", "zup", samples, takes["Adv_Ani_TestHipsTurn"],
                                   "hipsTurn", "Adv_Ani_TestHipsTurn")
        check_clip_source_fps("zup", "zup", samples, 30)
        report = reports["zup"]
        record("zup", "zup.upAxisDetectedZ", report["files"][0].get("upAxis") == "Z",
               "Z-up 数据空间应探测到竖直轴 Z（实际 %r）" % (report["files"][0].get("upAxis"),))
        record("zup", "zup.height", approx(samples["sourceHeightMeters"],
                                          fixture_rec["sourceHeightMeters"], 2e-3),
               "Z-up 变体 sourceHeightMeters=%r 夹具=%r" % (
                   samples["sourceHeightMeters"], fixture_rec["sourceHeightMeters"]))

    # ---------- 4. 目录批量模式 ----------
    if not args.skip_dir and "skel30" in sampled:
        dir_path = os.path.join(VERIFY_DIR, "dir-input")
        os.makedirs(dir_path, exist_ok=True)
        for name in ("biped-anim-skel.fbx", "biped-anim-60fps.fbx", "biped-tpose.fbx"):
            source = os.path.join(FIXTURE_DIR, name)
            target = os.path.join(dir_path, name)
            shutil.copyfile(source, target)
        dir_config = {
            "schemaVersion": 1,
            "fps": 30,
            "matchMode": "exact",
            "clips": [
                {"id": "armRaise", "file": "biped-anim-skel.fbx",
                 "takeMatch": "Adv_Ani_TestArmRaise", "loop": True},
                {"id": "hipsTurn", "file": "biped-anim-skel.fbx",
                 "takeMatch": "Adv_Ani_TestHipsTurn", "loop": False},
                {"id": "armRaise60", "file": "biped-anim-60fps.fbx",
                 "takeMatch": "Adv_Ani_TestArmRaise", "loop": True},
                {"id": "hipsTurn60", "file": "biped-anim-60fps.fbx",
                 "takeMatch": "Adv_Ani_TestHipsTurn", "loop": False},
                # clip.file 存在时不得 fallback 到 takeMatch 子串（否则会误采 biped-anim-skel）
                {"id": "staleDup", "file": "biped-anim-missing.fbx",
                 "takeMatch": "skel", "loop": True},
            ],
        }
        dir_config_path = os.path.join(VERIFY_DIR, "clips.dir.json")
        with open(dir_config_path, "w", encoding="utf-8") as handle:
            json.dump(dir_config, handle, ensure_ascii=False, indent=1)
        out_path = os.path.join(VERIFY_DIR, "samples-dir.json")
        report_path = os.path.join(VERIFY_DIR, "report-dir.json")
        result = run_blender(
            SAMPLER_SCRIPT,
            ["--fbx-dir", dir_path, "--config", dir_config_path, "--out", out_path,
             "--report", report_path, "--minimal"],
            timeout=900,
        )
        timings["sample-dir"] = result["durationSec"]
        artifacts["samples-dir"] = out_path
        artifacts["report-dir"] = report_path
        if blender_ok(result, "extract-biped-anims.py dir-mode"):
            samples = load_json(out_path)
            report = load_json(report_path)
            check_schema("dir", "dir", samples, 30, None, hsr_top_keys)
            from collections import Counter as _Counter
            fps_values = list((report.get("sourceFpsByFile") or {}).values())
            expected_top = _Counter(fps_values).most_common(1)[0][0] if fps_values else None
            record("dir", "dir.sourceFpsMostCommon",
                   expected_top is not None and approx(samples["sourceFps"], expected_top, 1e-6),
                   "目录模式顶层 sourceFps=%r 应为各文件检测帧率最常见值 %r（byFile=%s）" % (
                       samples["sourceFps"], expected_top, report.get("sourceFpsByFile")))
            expected_clip_fps = {"armRaise": 30, "hipsTurn": 30, "armRaise60": 60, "hipsTurn60": 60}
            actual_clip_fps = {clip_id: samples["clips"][clip_id].get("sourceFps")
                               for clip_id in expected_clip_fps if clip_id in samples["clips"]}
            record("dir", "dir.clipSourceFpsByFile",
                   len(actual_clip_fps) == len(expected_clip_fps) and all(
                       approx(actual_clip_fps.get(clip_id), expected, 1e-6)
                       for clip_id, expected in expected_clip_fps.items()),
                   "目录批量每 clip sourceFps 应跟随各自源文件：%s（期望 %s）" % (
                       actual_clip_fps, expected_clip_fps))
            rest_source = report.get("restSource") or {}
            record("dir", "dir.restSourceTpose",
                   rest_source.get("file") == "biped-tpose.fbx"
                   and rest_source.get("reason") == "tpose-prefer",
                   "目录批量 rest 应优先取 Tpose 文件（实际 %r）" % (rest_source,))
            tpose_fixture_rest = fixture["files"]["biped-tpose.fbx"]["rest"]
            max_angle = 0.0
            max_head = 0.0
            for name in tpose_fixture_rest:
                max_angle = max(max_angle, q_angle_deg(samples["rest"][name]["quat"],
                                                       tpose_fixture_rest[name]["quat"]))
                for index in range(3):
                    max_head = max(max_head, abs(samples["rest"][name]["head"][index]
                                                 - tpose_fixture_rest[name]["head"][index]))
            record("dir", "dir.restFromTposeBind", max_angle <= 0.01 and max_head <= 1e-5,
                   "目录批量 rest 与 Tpose.fbx bind rest 的差：旋转 %.4f° / 位置 %.2e" % (max_angle, max_head))
            record("dir", "dir.restWarningLogged",
                   "rest 基准文件" in "\n".join(report.get("warnings") or []),
                   "report 应记录 rest 基准文件行，实际 warnings=%r" % (report.get("warnings"),))
            record("dir", "dir.boneCount", len(samples["rest"]) == 66,
                   "目录批量 rest 骨数 %d 期望 66" % len(samples["rest"]))
            expected_clips = {"armRaise", "hipsTurn", "armRaise60", "hipsTurn60"}
            record("dir", "dir.clips", set(samples["clips"].keys()) == expected_clips,
                   "目录批量 clip 集合=%s 期望 %s" % (sorted(samples["clips"].keys()), sorted(expected_clips)))
            fixture_30 = fixture["files"]["biped-anim-skel.fbx"]["takes"]
            check_clip_against_fixture("dir", "dir", samples, fixture_30["Adv_Ani_TestArmRaise"],
                                       "armRaise", "Adv_Ani_TestArmRaise")
            fixture_60 = fixture["files"]["biped-anim-60fps.fbx"]["takes"]
            check_clip_against_fixture("dir", "dir", samples, fixture_60["Adv_Ani_TestHipsTurn"],
                                       "hipsTurn60", "Adv_Ani_TestHipsTurn")
            record("dir", "dir.tposeNoClips", not any("tpose" in name for name in samples["clips"]),
                   "Tpose 文件不应产生 clip")
            warnings_text = "\n".join(report.get("warnings") or [])
            record("dir", "dir.fpsMismatchWarning", "帧率" in warnings_text,
                   "混 30/60fps 目录应提示 sourceFps 单值限制，实际 warnings=%r" % (report.get("warnings"),))
            record("dir", "dir.minimalSkip", not any("tpose" in name for name in samples["clips"]),
                   "minimal 模式下未匹配 config 的文件应跳过")
            record("dir", "dir.fileNoTakeMatchFallback", "staleDup" not in samples["clips"],
                   "clip.file 存在时不应 fallback 到 takeMatch 子串（staleDup 不应被采样）")
            record("dir", "dir.missingFileWarning", "不存在" in warnings_text,
                   "config 引用不存在的 FBX 应 warning，实际 warnings=%r" % (report.get("warnings"),))

    # ---------- 5. HSR 旧数据冒烟回归 ----------
    hsr_skip_reason = None
    if args.skip_hsr:
        hsr_skip_reason = "--skip-hsr"
    elif not os.path.exists(args.hsr_fbx):
        hsr_skip_reason = "HSR FBX 不存在：%s" % args.hsr_fbx
    if hsr_skip_reason:
        record("hsr", "hsr.skipped", True, "SKIP：" + hsr_skip_reason)
    else:
        hsr_config = {
            "schemaVersion": 1,
            "fps": 30,
            "sourceFps": 60,
            "clips": [
                {"id": "hitL", "takeMatch": "Ani_Hit_L|", "srcFrames": 96, "loop": False},
            ],
        }
        hsr_config_path = os.path.join(VERIFY_DIR, "clips.hsr-smoke.json")
        with open(hsr_config_path, "w", encoding="utf-8") as handle:
            json.dump(hsr_config, handle, ensure_ascii=False, indent=1)
        out_path = os.path.join(VERIFY_DIR, "samples-hsr-smoke.json")
        report_path = os.path.join(VERIFY_DIR, "report-hsr-smoke.json")
        result = run_blender(
            SAMPLER_SCRIPT,
            ["--fbx", args.hsr_fbx, "--config", hsr_config_path, "--out", out_path,
             "--report", report_path, "--minimal"],
            timeout=1800,
        )
        timings["sample-hsr"] = result["durationSec"]
        artifacts["samples-hsr"] = out_path
        artifacts["report-hsr"] = report_path
        if blender_ok(result, "extract-biped-anims.py HSR smoke"):
            samples = load_json(out_path)
            check_schema("hsr", "hsr", samples, 30, 60, hsr_top_keys)
            record("hsr", "hsr.runOk", True, "HSR FBX 导入/采样未崩溃")
            record("hsr", "hsr.boneCount", len(samples["rest"]) == 236,
                   "HSR 骨数 %d 期望 236（回归对照 extract-hsr-anims.py）" % len(samples["rest"]))
            if hsr_samples:
                record("hsr", "hsr.boneNames",
                       list(samples["rest"].keys()) == list(hsr_samples["rest"].keys()),
                       "HSR 骨名/顺序与 extract-hsr-anims.py 产物一致（%d 骨）" % len(samples["rest"]))
                max_angle = 0.0
                max_head = 0.0
                for name, entry in hsr_samples["rest"].items():
                    if name not in samples["rest"]:
                        continue
                    max_angle = max(max_angle, q_angle_deg(samples["rest"][name]["quat"], entry["quat"]))
                    for index in range(3):
                        max_head = max(max_head, abs(samples["rest"][name]["head"][index] - entry["head"][index]))
                record("hsr", "hsr.restQuat", max_angle <= 0.05,
                       "HSR rest quat 最大旋转差 %.4f°（期望 ≤0.05°）" % max_angle)
                record("hsr", "hsr.restHead", max_head <= 1e-5,
                       "HSR rest head 最大差 %.2e（期望 ≤1e-5）" % max_head)
                record("hsr", "hsr.height", approx(samples["sourceHeightMeters"],
                                                  hsr_samples["sourceHeightMeters"], 1e-3),
                       "sourceHeightMeters=%r 期望 %r" % (
                           samples["sourceHeightMeters"], hsr_samples["sourceHeightMeters"]))
                record("hsr", "hsr.hipsHeight", approx(samples["sourceHipsHeightMeters"],
                                                      hsr_samples["sourceHipsHeightMeters"], 1e-3),
                       "sourceHipsHeightMeters=%r 期望 %r" % (
                           samples["sourceHipsHeightMeters"], hsr_samples["sourceHipsHeightMeters"]))
                if "hitL" in hsr_samples.get("clips", {}) and "hitL" in samples["clips"]:
                    ref_clip = hsr_samples["clips"]["hitL"]
                    our_clip = samples["clips"]["hitL"]
                    record("hsr", "hsr.hitL.frames", our_clip["frames"] == ref_clip["frames"],
                           "hitL frames=%r 期望 %r" % (our_clip["frames"], ref_clip["frames"]))
                    max_f = 0.0
                    max_q = 0.0
                    max_h = 0.0
                    for our_entry, ref_entry in zip(our_clip["data"], ref_clip["data"]):
                        max_f = max(max_f, abs(our_entry["f"] - ref_entry["f"]))
                        for bone in ref_entry["q"]:
                            if bone not in our_entry["q"]:
                                continue
                            max_q = max(max_q, q_angle_deg(our_entry["q"][bone], ref_entry["q"][bone]))
                        for bone in ref_entry["h"]:
                            if bone not in our_entry["h"]:
                                continue
                            for index in range(3):
                                max_h = max(max_h, abs(our_entry["h"][bone][index]
                                                       - ref_entry["h"][bone][index]))
                    record("hsr", "hsr.hitL.framesValues", max_f <= 1e-6,
                           "hitL 采样帧号最大差 %.2e" % max_f)
                    record("hsr", "hsr.hitL.quat", max_q <= 1.0,
                           "hitL 旋转相对 extract-hsr-anims.py 最大差 %.4f°（期望 ≤1°）" % max_q)
                    record("hsr", "hsr.hitL.head", max_h <= 5e-4,
                           "hitL 头部位置最大差 %.2e m（期望 ≤5e-4；链接骨归一化若与 HSR 导入不同会在此暴露）" % max_h)
                else:
                    record("hsr", "hsr.hitL.present", False, "hitL clip 缺失（本机或对照 samples 缺）")

    return finish(timings, artifacts)


def finish(timings, artifacts):
    total = len(CHECKS)
    failed = [check for check in CHECKS if not check["ok"]]
    groups = {}
    for check in CHECKS:
        group = groups.setdefault(check["group"], {"total": 0, "failed": 0})
        group["total"] += 1
        if not check["ok"]:
            group["failed"] += 1
    summary = {
        "ok": not failed,
        "total": total,
        "passed": total - len(failed),
        "failed": len(failed),
        "groups": groups,
        "timings": timings,
        "artifacts": artifacts,
        "failedChecks": [check["id"] + ": " + check["detail"] for check in failed[:40]],
    }
    report = {"schemaVersion": 1, "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
              "summary": summary, "checks": CHECKS}
    os.makedirs(VERIFY_DIR, exist_ok=True)
    report_path = os.path.join(VERIFY_DIR, "VERIFY-REPORT.json")
    with open(report_path, "w", encoding="utf-8") as handle:
        json.dump(report, handle, ensure_ascii=False, indent=1)
    print("")
    print("=" * 78)
    for group, stats in groups.items():
        print("  %-10s %3d/%3d passed" % (group, stats["total"] - stats["failed"], stats["total"]))
    print("=" * 78)
    print("VERIFY %s  passed=%d failed=%d total=%d" % (
        "PASS" if summary["ok"] else "FAIL", summary["passed"], summary["failed"], total))
    print("REPORT %s" % report_path)
    for failed_check in summary["failedChecks"][:20]:
        print("  FAIL ", failed_check)
    return 0 if summary["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
