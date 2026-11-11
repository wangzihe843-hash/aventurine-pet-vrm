#!/usr/bin/env python3
"""Verify an incoming pilot FBX drop against the G1-G6 gates.

See docs/adv-pilot-ingest-runbook.md for the gate definitions. This script reads
the reports produced by `scripts/vrm/motion/run-adv-pipeline.sh --mode pilot`
(plus the raw FBX folder for a file-pairing check) and writes a PASS/FAIL summary
so the pilot validation is reproducible instead of manual.

Usage:
  python3 scripts/vrm/motion/verify-pilot.py --dir tests/tmp/adv-pilot
  python3 scripts/vrm/motion/verify-pilot.py --dir tests/tmp/adv-pilot --expect idle,walk,talk01,skill01,stun

Expected layout (created by the runbook):
  <dir>/fbx/                       # Tpose.fbx + 5 animation scenes (+ *_skel.fbx)
  <dir>/pipeline/samples.json
  <dir>/pipeline/samples-report.json
  <dir>/pipeline/retarget-report.json
  <dir>/pipeline/validation-report.json

Outputs: <dir>/PILOT-VERIFY.md and <dir>/PILOT-VERIFY.json.
Exit code: 0 all gates PASS/WARN; 1 any gate FAIL.
"""
import argparse
import json
import os
import re
import sys

DEFAULT_EXPECT = ["idle", "walk", "talk01", "skill01", "stun"]
BIPED_MARKERS = ("pelvis", "spine", "neck", "head")
LIMB_MARKERS = ("upperarm", "clavicle", "thigh", "calf", "hand", "foot")


def read_json(path):
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except Exception:
        return None


def norm(name):
    return re.sub(r"[^a-z0-9]", "", str(name).lower())


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify incoming pilot FBX drop (G1-G6)")
    parser.add_argument("--dir", required=True, help="pilot drop dir (contains fbx/ and pipeline/)")
    parser.add_argument("--expect", default="", help="comma separated clip ids expected from the pilot")
    args = parser.parse_args()

    root = os.path.abspath(args.dir)
    fbx_dir = os.path.join(root, "fbx")
    pipe = os.path.join(root, "pipeline")
    expect = [x for x in (args.expect.split(",") if args.expect else DEFAULT_EXPECT) if x]

    samples = read_json(os.path.join(pipe, "samples.json"))
    samples_report = read_json(os.path.join(pipe, "samples-report.json"))
    retarget_report = read_json(os.path.join(pipe, "retarget-report.json"))
    validation = read_json(os.path.join(pipe, "validation-report.json"))

    results = []

    def gate(gid, title, status, detail, hard_fail=True):
        results.append({"gate": gid, "title": title, "status": status, "detail": detail, "hardFail": hard_fail})

    # ---------- G0: incoming files ----------
    fbx_files = []
    if os.path.isdir(fbx_dir):
        fbx_files = sorted(f for f in os.listdir(fbx_dir) if f.lower().endswith(".fbx"))
    skel = [f for f in fbx_files if re.search(r"_skel\.fbx$", f, re.I)]
    full = [f for f in fbx_files if f not in skel]
    pairs = []
    for f in full:
        if re.search(r"tpose", f, re.I):
            continue  # Tpose.fbx has no *_skel pair (bind/rest only)
        stem = f[:-4]
        pairs.append((f, stem + "_skel.fbx" in skel))
    detail = f"fbx 文件 {len(fbx_files)} 个（full {len(full)} / _skel {len(skel)}）；成对 {sum(1 for _, ok in pairs if ok)}/{len(pairs)}"
    has_tpose = any(re.search(r"tpose", f, re.I) for f in fbx_files)
    if not fbx_files:
        gate("G0", "回传文件存在", "FAIL", "fbx/ 目录缺失或没有 .fbx 文件")
    elif not has_tpose:
        gate("G0", "回传文件存在", "FAIL", f"{detail}；缺少 Tpose.fbx")
    else:
        status = "PASS" if all(ok for _, ok in pairs) else "WARN"
        gate("G0", "回传文件存在", status, detail + "；Tpose.fbx 存在", hard_fail=False)

    # ---------- G1: skeleton ----------
    g1_ok = True
    g1_detail = []
    if samples_report and samples_report.get("files"):
        for item in samples_report["files"]:
            rest = item.get("rest") or {}
            names = [norm(k) for k in rest.keys()]
            bone_count = item.get("boneCount") or len(rest)
            has_core = all(any(m in n for n in names) for m in BIPED_MARKERS)
            has_limb = any(any(m in n for n in names) for m in LIMB_MARKERS)
            ok = bone_count >= 60 and has_core and has_limb
            g1_ok = g1_ok and ok
            g1_detail.append(
                f"{item.get('file')}: bones={bone_count} core={has_core} limbs={has_limb}"
            )
    elif samples:
        rest = samples.get("rest") or {}
        names = [norm(k) for k in rest.keys()]
        bone_count = len(rest)
        ok = bone_count >= 60 and all(any(m in n for n in names) for m in BIPED_MARKERS)
        g1_ok = ok
        g1_detail = [f"samples.rest bones={bone_count}"]
    else:
        g1_ok = False
        g1_detail = ["缺少 samples/samples-report，无法检查骨架"]
    gate("G1", "骨架识别（Biped 骨名/骨数）", "PASS" if g1_ok else "FAIL", "; ".join(g1_detail))

    # ---------- G2: animation clips ----------
    got = sorted((samples or {}).get("clips", {}).keys())
    missing = [cid for cid in expect if cid not in got]
    g2_ok = bool(got) and not missing
    g2_detail = f"samples.clips={len(got)} 个；期望 {expect}；缺失 {missing or 'none'}"
    if samples_report:
        no_anim = [w for w in (samples_report.get("warnings") or []) if "没有匹配本文件" in str(w)]
        if no_anim:
            g2_detail += f"；警告 {len(no_anim)} 条（可能有文件未匹配到 clip）"
    gate("G2", "动画存在且覆盖 pilot 动作", "PASS" if g2_ok else "FAIL", g2_detail)

    # ---------- G3: units / scale ----------
    if samples:
        hips = float(samples.get("sourceHipsHeightMeters") or 0)
        height = float(samples.get("sourceHeightMeters") or 0)
        g3_ok = 0.80 <= hips <= 1.20 and 1.40 <= height <= 2.10
        detail = f"sourceHipsHeight={hips:.4f}m（期望 0.80–1.20）；sourceHeight={height:.4f}m（期望 1.40–2.10）"
    else:
        g3_ok = False
        detail = "缺少 samples.json"
    gate("G3", "单位/比例", "PASS" if g3_ok else "FAIL", detail)

    # ---------- G4: fps ----------
    g4_fail = []
    fps_by_file = (samples_report or {}).get("sourceFpsByFile") or {}
    for name, fps in fps_by_file.items():
        if float(fps) not in (24.0, 25.0, 30.0, 48.0, 50.0, 60.0):
            g4_fail.append(f"{name}={fps}")
    clip_fps_missing = []
    durations = []
    for cid, clip in ((samples or {}).get("clips") or {}).items():
        fps = clip.get("sourceFps") or (samples or {}).get("sourceFps")
        if not fps:
            clip_fps_missing.append(cid)
            continue
        start, end = (clip.get("srcFrames") or [0, 0])[:2]
        durations.append((cid, (float(end) - float(start)) / float(fps)))
    g4_ok = not g4_fail and not clip_fps_missing and all(0.1 <= d <= 40.0 for _, d in durations)
    detail = f"fpsByFile={fps_by_file or 'missing'}；per-clip sourceFps 缺失={clip_fps_missing or 'none'}；时长={[(c, round(d, 2)) for c, d in durations]}"
    gate("G4", "fps/时长", "PASS" if g4_ok else "FAIL", detail)

    # ---------- G5: Tpose rest ----------
    rest_source = (samples_report or {}).get("restSource") or {}
    reason = rest_source.get("reason")
    if reason == "tpose-prefer":
        gate("G5", "Tpose 作 rest 基准", "PASS", f"restSource={rest_source}")
    elif reason:
        gate("G5", "Tpose 作 rest 基准", "FAIL", f"restSource={rest_source}（期望 tpose-prefer；Tpose.fbx 是否在目录里？）")
    else:
        gate("G5", "Tpose 作 rest 基准", "FAIL", "缺少 samples-report.restSource")

    # ---------- G6: retarget gate ----------
    counts = ((retarget_report or {}).get("grades") or {}).get("counts") or {}
    grade_items = ((retarget_report or {}).get("grades") or {}).get("items") or []
    grade_ids = {item.get("clip") for item in grade_items}
    missing_grade = [cid for cid in expect if cid not in grade_ids]
    v_summary = (validation or {}).get("summary") or {}
    g6_ok = (
        counts.get("FAIL", 1) == 0
        and counts.get("PASS", 0) == len(expect)
        and not missing_grade
        and v_summary.get("fail", 1) == 0
    )
    detail = (
        f"retarget PASS/WARN/FAIL={counts.get('PASS', '?')}/{counts.get('WARN', '?')}/{counts.get('FAIL', '?')}"
        f"（期望 PASS={len(expect)} FAIL=0）；缺失 grade={missing_grade or 'none'}；"
        f"validate pass/warn/fail={v_summary.get('pass', '?')}/{v_summary.get('warn', '?')}/{v_summary.get('fail', '?')}"
    )
    gate("G6", "重定向/校验门禁", "PASS" if g6_ok else "FAIL", detail)

    # ---------- summary ----------
    fails = [r for r in results if r["status"] == "FAIL"]
    warns = [r for r in results if r["status"] == "WARN"]
    ok = not fails

    lines = []
    lines.append("# Pilot 验证结果（G0–G6）")
    lines.append("")
    lines.append(f"- pilot dir: `{root}`")
    lines.append(f"- 期望 clip: `{', '.join(expect)}`")
    lines.append(f"- 结论: **{'PASS' if ok else 'FAIL'}**（FAIL {len(fails)} / WARN {len(warns)}）")
    lines.append("")
    lines.append("| gate | 检查 | 状态 | 详情 |")
    lines.append("|---|---|---|---|")
    for item in results:
        lines.append(f"| {item['gate']} | {item['title']} | **{item['status']}** | {item['detail']} |")
    lines.append("")
    if fails:
        lines.append("## FAIL 需要处理")
        for item in fails:
            lines.append(f"- {item['gate']} {item['title']}: {item['detail']}")
        lines.append("")
    py_out = {"root": root, "expect": expect, "pass": ok, "gates": results}
    with open(os.path.join(root, "PILOT-VERIFY.json"), "w", encoding="utf-8") as handle:
        json.dump(py_out, handle, ensure_ascii=False, indent=1)
        handle.write("\n")
    with open(os.path.join(root, "PILOT-VERIFY.md"), "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")

    print("\n".join(lines))
    print(f"wrote {os.path.join(root, 'PILOT-VERIFY.md')}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
