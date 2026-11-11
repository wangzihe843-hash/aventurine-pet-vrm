#!/usr/bin/env python3
"""Inventory helper for the Aventurine "Waveflair" .max animation pack.

Usage:
  # 1) From the downloaded zip (no extraction needed; reads the zip central directory)
  python3 scripts/max-export/inventory.py --zip "/Volumes/4TB外置盘/百度网盘/砂金戏浪.zip" \
      --out work/max-inventory.md

  # 2) From a folder on the Windows machine / after extraction
  python3 scripts/max-export/inventory.py --dir "D:\\sjxl\\max" --out work/max-inventory.md

Output: markdown table (name, size MB, category guess) + summary counts.
This script is read-only and does not touch assets/.
"""
import argparse
import os
import re
import sys
import zipfile

CATEGORY_RULES = [
    ("bind", re.compile(r"^Tpose$", re.I)),
    ("combat-idle", re.compile(r"^(StandBy( \(2\))?|TeamStandBy|AttackStandBy)$", re.I)),
    ("idle-show", re.compile(r"^(Idle_Show_0[12]|Common_IdleShow)$", re.I)),
    ("locomotion", re.compile(r"^(Walk|Run|FastRun|WalkStop|RunStop|Run_BS|Run_Turn|Turn_|FastRunStop|FastRun_Turn)", re.I)),
    ("combat-skill", re.compile(r"^(Skill\d+|MazeSkill|MazeAttack|Skill\d+_Ready|Skill\d+Ready|Skill\d+toSkill\d+)", re.I)),
    ("combat-react", re.compile(r"^(BeHit|Hit_|State_Stun|Die|Revive)", re.I)),
    ("social", re.compile(r"^(Akimbo|Alert|BackWard|Build|Bye|CoverMouth|Forerake|HoldArm|HoldHead|Injured|LookAtPhone|PutHand|ScratchHead|Shrug|Snap|StrikeChest|Talk|Think|UseHeadPhone|UseProp|WatchPhone|Worry)", re.I)),
]


def categorize(name: str) -> str:
    base = os.path.splitext(os.path.basename(name))[0]
    for label, pattern in CATEGORY_RULES:
        if pattern.search(base):
            return label
    return "other"


def iter_zip(path: str):
    with zipfile.ZipFile(path) as archive:
        for info in archive.infolist():
            if info.filename.lower().endswith(".max"):
                yield info.filename, info.file_size
            elif info.filename.lower().endswith(".png"):
                yield info.filename, info.file_size


def iter_dir(path: str):
    for name in sorted(os.listdir(path)):
        full = os.path.join(path, name)
        if os.path.isfile(full) and name.lower().endswith((".max", ".png")):
            yield name, os.path.getsize(full)


def main() -> int:
    parser = argparse.ArgumentParser(description="Inventory the Waveflair .max animation pack")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--zip", help="path to the downloaded zip")
    source.add_argument("--dir", help="folder containing *.max files")
    parser.add_argument("--out", default="work/max-inventory.md", help="markdown output path")
    args = parser.parse_args()

    if args.zip:
        if not os.path.isfile(args.zip):
            print(f"zip not found: {args.zip}", file=sys.stderr)
            return 1
        entries = list(iter_zip(args.zip))
        origin = args.zip
    else:
        if not os.path.isdir(args.dir):
            print(f"dir not found: {args.dir}", file=sys.stderr)
            return 1
        entries = list(iter_dir(args.dir))
        origin = args.dir

    maxes = [(n, s) for n, s in entries if n.lower().endswith(".max")]
    others = [(n, s) for n, s in entries if not n.lower().endswith(".max")]
    maxes.sort(key=lambda item: os.path.basename(item[0]).lower())

    by_cat = {}
    rows = []
    for name, size in maxes:
        base = os.path.splitext(os.path.basename(name))[0]
        cat = categorize(name)
        by_cat.setdefault(cat, []).append(base)
        rows.append((base, cat, size))

    lines = []
    lines.append("# Waveflair .max animation pack inventory")
    lines.append("")
    lines.append(f"- source: `{origin}`")
    lines.append(f"- `.max` files: **{len(maxes)}** ({sum(s for _, s in maxes) / 1024 ** 3:.2f} GiB uncompressed)")
    lines.append(f"- other files: {len(others)} (textures/materials)")
    lines.append("")
    lines.append("## Categories")
    lines.append("")
    lines.append("| category | count | files |")
    lines.append("|---|---|---|")
    for cat in [c for c, _ in CATEGORY_RULES] + ["other"]:
        if cat not in by_cat:
            continue
        files = sorted(by_cat[cat])
        lines.append(f"| {cat} | {len(files)} | {', '.join(f'`{f}`' for f in files)} |")
    lines.append("")
    lines.append("## All .max files")
    lines.append("")
    lines.append("| # | file | category | MB |")
    lines.append("|---|---|---|---|")
    for index, (base, cat, size) in enumerate(rows, 1):
        lines.append(f"| {index} | `{base}.max` | {cat} | {size / 1e6:.1f} |")
    lines.append("")

    out_dir = os.path.dirname(os.path.abspath(args.out))
    os.makedirs(out_dir, exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines))
    print(f"wrote {args.out}: {len(maxes)} max files, categories: " + ", ".join(f"{c}={len(v)}" for c, v in sorted(by_cat.items())))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
