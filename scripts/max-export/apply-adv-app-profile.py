#!/usr/bin/env python3
"""Derive an app-binding profile of the adv clip registry (A / B / C).

The full registry `clips.adv-all.json` binds 11 idle-slot and 2 walk-slot clips,
which grows the pet's idle pool from 15 to 26. This script rewrites a copy where
only the clips of the chosen profile keep an app `slot`; everything else becomes
catalog-only (`slot: null`). See docs/adv-app-manifest-proposal.md.

Usage:
  python3 scripts/max-export/apply-adv-app-profile.py --profile B \
      --in scripts/vrm/motion/clips.adv-all.json \
      --out scripts/vrm/motion/clips.adv-all.b.json

Profiles (idle pool sizes assume the current 15-clip app-manifest idle pool):
  A  conservative : idle + think01 + worry01                              -> +3  (18)
  B  balanced (rec): A + scratchHead01                                     -> +4  (19)
  (run demoted to catalog-only 2026-11-09: source root yaw not closed per loop -> loopSeam 19.19 FAIL)

  B 2026-11-10 用户要求：commonIdle 与现役 hsr-commonIdle 是同一条动画（帧数/时长一致，
  逐帧姿态平均差 0.48°），按「一模一样不添加」已从 idle 槽位移除（保留 catalog-only，可按 id 回放）；
  `idle` 的 priority 由 9 改为 10，与 hsr-idle 同级（app 播放器同分随机二选一）。
  2026-11-10 追加（用户反馈「女体待机不要自动进轮换」）：adv 的 3 条 NPC 社交待机
  think01/worry01/scratchHead01（托腮/捂胸口/挠头，观感偏女性化）也移出 idle 槽
  （slot:null，catalog 保留），当前 B 的 idle 槽只剩 `idle`。
  **2026-11-10 用户改口（明确否掉上一条）：「不要把 adv 移出 idle 轮换」→ 已把
  think01/worry01/scratchHead01 三条重新放回 idle 槽（优先级恢复 -7/-8/-8），
  B 的 idle 池恢复为 idle + 这 3 条稀有变体。**

NOTE 2026-11-09 full-v3: Idle_Show_01/02 demoted to catalog-only (loop=false) because the
source Biped segment is a one-shot showcase whose root object ends rotated 65.5 deg / moved
0.372 m (loop seam FAIL, not a loop). They are intentionally NOT part of the app idle pool.

  C  full showcase : keep the registry as-is                               -> +11 (26)

After writing the profile file, rebuild manifests:
  node scripts/vrm/motion/build-adv-manifest.mjs --dir assets/motions/adv \
      --config <profile.json>
  node scripts/vrm/motion/build-app-manifest.mjs
  node scripts/vrm/motion/build-manifest --check ... (use --check flags to verify)
"""
import argparse
import json
import sys

# id -> (slot, priority) kept by each profile. Everything not listed is set slot=null.
PROFILES = {
    "A": {
        "idle": ("idle", 9),
        "think01": ("idle", -7),
        "worry01": ("idle", -8),
        "walk": ("walk", 5),
    },
    "B": {
        "idle": ("idle", 10),
        "think01": ("idle", -7),
        "worry01": ("idle", -8),
        "scratchHead01": ("idle", -8),
        "walk": ("walk", 5),
    },
    "C": None,  # keep registry as-is (all 11 idle + 2 walk)
}

APP_SLOTS = {"idle", "walk", "climb", "sit", "sleep", "drag", "fall", "pat",
             "grabWindow", "dshBusy", "dshDone", "dshError", "salute"}


def main() -> int:
    parser = argparse.ArgumentParser(description="Derive an app-binding profile of clips.adv-all.json")
    parser.add_argument("--profile", required=True, choices=sorted(PROFILES))
    parser.add_argument("--in", dest="src", default="scripts/vrm/motion/clips.adv-all.json")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    with open(args.src, encoding="utf-8") as handle:
        registry = json.load(handle)

    mapping = PROFILES[args.profile]
    if mapping is None:
        out = registry
    else:
        out = json.loads(json.dumps(registry))
        kept = []
        dropped = []
        for clip in out["clips"]:
            binding = mapping.get(clip["id"])
            if binding is None:
                if clip.get("slot") is not None:
                    dropped.append(clip["id"])
                clip["slot"] = None
                continue
            slot, priority = binding
            if slot not in APP_SLOTS:
                raise SystemExit(f"invalid app slot {slot} for {clip['id']}")
            clip["slot"] = slot
            clip["priority"] = priority
            kept.append(clip["id"])
        missing = sorted(set(mapping) - set(kept))
        if missing:
            raise SystemExit(f"profile {args.profile}: clip ids not found in registry: {missing}")
        out.setdefault("notes", []).append(
            f"app binding profile {args.profile}: kept {sorted(kept)}; catalog-only {sorted(dropped)}"
        )

    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(out, handle, ensure_ascii=False, indent=1)
        handle.write("\n")

    idle = sum(1 for c in out["clips"] if c.get("slot") == "idle")
    walk = sum(1 for c in out["clips"] if c.get("slot") == "walk")
    if mapping is not None:
        print(f"profile {args.profile}: kept={len(mapping)} clips; app idles from adv={idle}, walks={walk}; "
              f"catalog-only dropped slots={len(dropped)}; wrote {args.out}")
    else:
        print(f"profile C (as-is): app idles from adv={idle}, walks={walk}; wrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
