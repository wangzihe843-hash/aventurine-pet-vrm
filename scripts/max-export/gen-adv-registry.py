#!/usr/bin/env python3
"""Generate the full adv clip registry (all 138 .max → 135 catalog clips).

The pilot/first-batch registry `scripts/vrm/motion/clips.adv.json` only contains 25
representative clips (used for the pilot validation and the first acceptance round).
This script expands it to EVERY animation take of the pack so the whole set can be
converted into catalog clips (`assets/motions/adv/**`) once the real FBX are exported.

Rules (keep in sync with docs/adv-clip-selection.md):
- Exclude `Tpose` (rest/bind reference, not a clip).
- Exclude the two download duplicates `StandBy (2)` / `Skill04 (2)`; keep the primary
  take. (Which one is primary must be confirmed on real FBX data -- see the note field.)
- Keep every other take, including Ready-loop / transition / Hand variants: they are
  catalog-only until the acceptance round decides otherwise.
- Existing 25 clips keep their ids/slot/grounding/priority/tags EXACTLY as defined in
  `clips.adv.json` (pilot and full runs share the same clip ids).
- Derive ids for the remaining takes from the file stem (lowercase, separators → `-`).

Usage:
  python3 scripts/max-export/gen-adv-registry.py \
      --zip "/Volumes/4TB外置盘/百度网盘/砂金戏浪.zip" \
      --base scripts/vrm/motion/clips.adv.json \
      --out scripts/vrm/motion/clips.adv-all.json
  # or --dir <folder with the .max files>
"""
import argparse
import json
import os
import re
import sys
import zipfile

EXCLUDED_TAKES = {
    "Tpose": "绑定/rest 参考姿势，不是动作；采样器从 FBX bind/rest 读 rest，不进 clips。",
    "StandBy (2)": "与 StandBy 重复（下载复本，修改时间不同）；真实 FBX 回传后比较曲线/时长二选一，禁止盲选。",
    "Skill04 (2)": "与 Skill04 重复（下载复本）；同上。",
}

SOCIAL_PREFIXES = (
    "Akimbo", "Alert", "BackWard", "Build", "Bye", "CoverMouth", "Forerake", "HoldArm",
    "HoldHead", "Injured", "LookAtPhone", "PutHand", "ScratchHead", "Shrug", "Snap",
    "StrikeChest", "Talk", "Think", "UseHeadPhone", "UseProp", "WatchPhone", "Worry",
)
SOCIAL_NON_STANDING = ("Injured", "Build", "Forerake")  # kneeling / prop work: keep off-foot grounding

ALLOWED_SLOTS = {None, "idle", "walk", "climb", "sit", "sleep", "drag", "fall", "pat",
                 "grabWindow", "dshBusy", "dshDone", "dshError", "salute"}
ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


def list_stems(args):
    if args.zip:
        with zipfile.ZipFile(args.zip) as archive:
            names = [info.filename for info in archive.infolist() if info.filename.lower().endswith(".max")]
        origin = args.zip
    else:
        names = [name for name in os.listdir(args.dir) if name.lower().endswith(".max")]
        origin = args.dir
    return sorted(os.path.splitext(os.path.basename(name))[0] for name in names), origin


def make_id(stem):
    text = stem.strip().lower()
    text = re.sub(r"[\s_]+", "-", text)
    text = re.sub(r"[^A-Za-z0-9.\-]", "", text)
    text = re.sub(r"-{2,}", "-", text).strip("-")
    if not text:
        return None
    return text[0].lower() + text[1:]


def classify(stem):
    if stem == "Walk":
        return ("locomotion", ["walk"])
    if stem.startswith(("Run", "FastRun", "Turn_", "WalkStop", "RunStop")):
        return ("locomotion", ["locomotion"])
    if stem.startswith(("StandBy", "TeamStandBy", "AttackStandBy", "Idle_Show", "Common_IdleShow")):
        return ("idle", ["idle"])
    if stem.startswith(("Skill", "MazeSkill", "MazeAttack")):
        return ("combat-skill", ["skill"])
    if stem.startswith(("BeHit", "Hit_", "State_Stun", "Die", "Revive")):
        return ("combat-react", ["react"])
    for prefix in SOCIAL_PREFIXES:
        if stem.startswith(prefix):
            return ("social", ["social"])
    return ("other", [])


def default_entry(stem):
    """Heuristic entry for a take that is not in the 25-clip base registry."""
    category, tags = classify(stem)
    loop = bool(re.search(r"(?i)(?:loop)$", stem))
    if stem.lower().startswith(("die_loop", "state_stun_loop")):
        loop = True
    grounding = "none" if category == "combat-skill" or category == "combat-react" else "feet"
    if category == "social" and any(stem.startswith(p) for p in SOCIAL_NON_STANDING):
        grounding = "none"
    note_bits = []
    if stem.startswith(("Skill", "Maze")):
        note_bits.append("技能/战斗表演：catalog-only（app 绑定待验收后定）")
    elif category == "social":
        note_bits.append("NPC 社交：catalog-only；AS/BS/Loop 语义待真实数据验证")
    elif category == "locomotion":
        note_bits.append("移动：catalog-only 过渡/转向段")
    elif category == "combat-react":
        note_bits.append("受击/异常：catalog-only，grounding=none")
    if stem.startswith(("Skill", "Maze")) and loop:
        note_bits.append("技能 Ready 循环：语义待确认")
    if " (2)" in stem:
        note_bits.append("复本：需与主文件比对")
    return {
        "id": make_id(stem),
        "takeMatch": stem,
        "file": f"{stem}.fbx",
        "fps": 30,
        "loop": loop,
        "slot": None,
        "grounding": grounding,
        "priority": 0,
        "tags": tags,
        "note": "；".join(note_bits) if note_bits else "",
    }


def main():
    parser = argparse.ArgumentParser(description="Generate clips.adv-all.json from the .max pack")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--zip", help="砂金戏浪.zip path")
    source.add_argument("--dir", help="folder containing *.max")
    parser.add_argument("--base", default="scripts/vrm/motion/clips.adv.json",
                        help="25-clip pilot registry to keep ids/fields in sync")
    parser.add_argument("--out", default="scripts/vrm/motion/clips.adv-all.json")
    args = parser.parse_args()

    stems, origin = list_stems(args)
    base = json.load(open(args.base, encoding="utf-8"))
    base_by_take = {c["takeMatch"]: c for c in base.get("clips", [])}

    clips = []
    report = []
    for stem in stems:
        if stem in EXCLUDED_TAKES:
            report.append({"take": stem, "status": "excluded", "reason": EXCLUDED_TAKES[stem]})
            continue
        existing = base_by_take.get(stem)
        if existing:
            entry = dict(existing)
            entry.setdefault("file", f"{stem}.fbx")
            entry.setdefault("fps", 30)
            source_label = "base(25)"
        else:
            entry = default_entry(stem)
            source_label = "heuristic"
        # normalize / validate
        if not entry["id"] or not ID_PATTERN.match(entry["id"]):
            raise SystemExit(f"bad id for {stem}: {entry.get('id')!r}")
        if entry.get("slot") not in ALLOWED_SLOTS:
            raise SystemExit(f"bad slot for {stem}: {entry.get('slot')!r}")
        clips.append(entry)
        report.append({"take": stem, "status": source_label, "id": entry["id"]})

    ids = [c["id"] for c in clips]
    dupes = sorted({i for i in ids if ids.count(i) > 1})
    if dupes:
        raise SystemExit(f"duplicate clip ids: {dupes}")

    registry = {
        "schemaVersion": 1,
        "source": base.get("source", {}),
        "fps": 30,
        "sourceFps": base.get("sourceFps", 30),
        "matchMode": "file",
        "notes": [
            "全量 catalog registry：138 个 .max 中排除 Tpose + 2 个下载复本 = 135 条。",
            "基础 25 条沿用 clips.adv.json 的 id/字段（pilot 与全量共享 id）；其余为启发式（slot=null 只进 catalog）。",
            "真实 FBX 回传后需按 export_log.txt 的 fps 列复核 sourceFps；按 samples-report 复核 rest/单位。",
            "Ready/transition/Hand 变体与社交 AS/BS 段均为 catalog-only，app 绑定在验收轮另行决定（docs/adv-clip-selection.md）。",
        ],
        "excluded": [
            {"take": take, "reason": reason} for take, reason in sorted(EXCLUDED_TAKES.items())
        ],
        "requirements": {"idle": 5, "walk": 2, "social": 20, "skill": 5, "react": 5, "locomotion": 10},
        "clips": clips,
    }

    out_dir = os.path.dirname(os.path.abspath(args.out))
    os.makedirs(out_dir, exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(registry, handle, ensure_ascii=False, indent=1)
        handle.write("\n")

    from_base = sum(1 for item in report if item["status"] == "base(25)")
    heuristic = sum(1 for item in report if item["status"] == "heuristic")
    categories = {}
    for clip in clips:
        category = classify(clip["takeMatch"])[0]
        categories[category] = categories.get(category, 0) + 1
    print(f"origin: {origin}")
    print(f"max files: {len(stems)}  clips: {len(clips)}  base(25): {from_base}  heuristic: {heuristic}  excluded: {len(EXCLUDED_TAKES)}")
    print("categories:", json.dumps(categories, ensure_ascii=False, sort_keys=True))
    print("slots:", json.dumps({k: sum(1 for c in clips if c.get('slot') == k) for k in ['idle', 'walk', None]}, ensure_ascii=False))
    print("grounding:", json.dumps({k: sum(1 for c in clips if c.get('grounding') == k) for k in ['feet', 'none']}))
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
