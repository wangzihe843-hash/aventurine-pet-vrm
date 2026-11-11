# Asset pipeline pitfalls (with a “hand it to an AI” template)

> Part of the “Not a modeler? Start here” series in the [English README](../README.en.md).
> Upstream: [where to find assets](guide-asset-sourcing.en.md), [model → VRM](guide-model-conversion.en.md),
> [motion pipelines](guide-motion-conversion.en.md)

[中文版](guide-asset-pitfalls.md)

This page covers only **weird behaviour after conversion**. Every item has been reproduced in this repo
and traced to a specific script or parameter, so the fix is deterministic: **you don't need bone math —
hand the symptom, the error text and the file names to an AI and let it reproduce from the docs linked
here.**

## Quick table

| # | Symptom | Root cause | Fix | Evidence |
|---|---|---|---|---|
| 1 | Converted model stays **A-pose-ish** (arms down ~40°) | The conversion never lifted the rest pose into a spec T-pose | Re-convert with VRMify (it lifts by default), or correct the T-pose manually in Blender | [`vrm-tpose-repair.md`](vrm-tpose-repair.md) §1.1 |
| 2 | An **A-pose model with T-pose motions** clips and hyperextends | Normalized animation is a rotation *relative to the T-pose rest*; an A-pose rest adds a constant offset | **The model format must be re-converted** — editing motion data cannot save it | [`vrm-tpose-repair.md`](vrm-tpose-repair.md) §1; [`research/wave1-15-pitfalls.md`](research/wave1-15-pitfalls.md) §0-2 |
| 3 | **Female motion on a male body** collapses the shoulders: drooping shoulders, sunken deltoid, arms that look stretched | Three stacked causes (next section): dropped `upperChest` tracks, female clavicle styling, proportion mismatch | Already built in: `upperChest` α-fold + proportion-aware shoulder/arm retarget | [`research/mate-female-to-male-joint-plan-2026-11-11.md`](research/mate-female-to-male-joint-plan-2026-11-11.md) |
| 4 | Arms **mirrored / raised overhead** | Handedness or orientation is wrong (Unity left-handed vs VRM1 left hand +X) | Pick the right `--axis x` (VRM1) or `--axis z` (old VRM0 / facing -Z) when retargeting | [`vrm-tpose-repair.md`](vrm-tpose-repair.md) §1.2 |
| 5 | Walking **slides / feet sink / jitter** | In-place convention disagrees with foot IK; three ignores VMD's IK on/off frames | Use a pipeline with foot IK for walk/sit; for legacy VMD playback call `helper.enable('ik', false)` | [`foot-slide-fix-report.md`](foot-slide-fix-report.md), [`research/mocap-options.md`](research/mocap-options.md) §4 |
| 6 | Clip count looks right but it **only ever plays idle** | Manifest not finalized, wrong `mood`, mismatched `motionSet` | Run `build-app-manifest.mjs --check`, then verify the `PET_MOODS` slot names | [`guide-motion-conversion.en.md`](guide-motion-conversion.en.md), [`../scripts/vrm/motion/README.md`](../scripts/vrm/motion/README.md) |
| 7 | Blender **crashes importing the official FBX** | Maya-style in-between shape keys | Use the monkey-patch in `extract-hsr-anims.py` that filters `len(entry[3]) > 1` | [`research/wave1-15-pitfalls.md`](research/wave1-15-pitfalls.md) §0-7 |

All linked documents are Chinese-only.

## Three that need detail

### 1) “It comes out A-pose-ish” and “an A-pose model with T-pose motions”

These are two faces of one root cause: **VRM animation is a rotation delta relative to the T-pose rest**.
If the model's rest pose is an A-pose, the whole arm carries a constant offset during playback. The old
asset in this project measured **39.6°**, with a textbook symptom pattern:

- arm-extended motions (drag) look fine;
- motions that bring the arm close to the body (idle crossed arms, walking arm swing) push the arm into
  the torso/sleeve → clipping;
- legs look fine (the A/T difference lives in the shoulder and arm; legs are vertical either way).

Conclusion: **re-convert the model first (VRMify lifts arms by default), then re-bake the motions.**
Fixing only one side leaves the constant error in place.

### 2) Female motion on a male body: why the shoulder collapses

Three independent causes stack up (all measured):

1. **The target model has no `upperChest`**: the player drops the entire `UpperChest` track, so neck /
   shoulders / head rotate **backwards relative to the source** (error angle = the original track angle).
   10 of 30 mate clips hit this, |U| = 4–10°, shoulder socket sinks 4.3–6.0 cm. HSR/adv male motions have
   `UpperChest` at identity, so they don't collapse — that's not merely a “male source / body type” win.
2. **Female rigs treat the clavicle as a styling bone** (drop + retract): local `Shoulder` rotation
   17–38° versus 2.1–7.0° in male references; the clavicle is 12.34 cm long and every extra degree sinks
   the socket ≈2.2 mm.
3. **Proportion mismatch**: upper arm + forearm 0.443 m (male) vs 0.530 m (female source) = 84%; upperArm
   joint height 0.126 m vs 0.220 m = 57%. With arms hanging the two nearly cancel, but **when the hand
   comes forward and up the hand position differs by 10–18 cm** — which is why “standing looks fine,
   sitting / lying / hiding looks broken”.

Fixes already implemented in this repo (not suggestions):

- **`upperChest` α-fold**: folds the dropped track into `chest`; after folding it differs from Unity's
  official retarget by only 1–3.3°;
- **proportion-aware shoulder/arm retargeting**: `scripts/unity-bake/proportion-retarget.mjs` / `-v2` /
  `-v3`, which lifts the clavicle to match the source's visual pose plus a constrained hand IK; the
  recommended parameter table is in
  [`research/proportion-retarget-prototype-2026-11-11.md`](research/proportion-retarget-prototype-2026-11-11.md);
- the project produced **22 tuned clips** in `assets/motions/mate-tuned/` (private, not in git).
  A clean clone must re-run the scripts above; don't expect them to be shipped.

> Boundary of what this fixes: proportions, contacts and shoulder line — real distortion. **Motion
> vocabulary** (hands clasped at the chest, covering the mouth, pigeon toes) is the source's performance
> intent; only a male motion source fixes that, no global parameter will. See
> [`research/wave15-male-motion-tune.md`](research/wave15-male-motion-tune.md).

### 3) Without a mocap rig, don't let an AI invent motion

This is a lesson this project paid for: Wave 2 tried the procedural-pose route and it was **rejected after
measurement** — no reference, no visual review loop, so writing pure numbers only yields hyperextended
joints, foot sliding and bizarre hand placement (root cause in [`anim-strategy.md`](anim-strategy.md) C4).

There are only three reliable motion sources: captured data, motion already authored by someone, or
manual keyframing with screenshot review. AI should do **retargeting, offset correction, contact fixing
and batch validation** — not generate keyframes from nothing.

## Template to hand to an AI

```text
I'm stuck at "<which step>". Symptom: <screenshot / exact error text>.
Files: model <path>, motion <path>, manifest <path>, target <which clip / which slot>.
Expected: <stands / walks / shoulders don't collapse / no clipping / not mirrored>.
Read docs/guide-asset-pitfalls.en.md and <the specific entry linked from this page> first,
then reproduce using the repo's scripts. Give me options first (with cost and rollback point),
and don't touch anything until I confirm.
After the change run pnpm typecheck + pnpm test and attach preview/screenshot evidence.
```

Constraints to include in the request (they save a lot of back-and-forth):

- **Read the docs before changing anything** — this page and its links already record the root cause;
  don't let the AI guess from scratch;
- **Change one variable at a time** (`--axis`, `liftFraction`, `timeScale` separately), otherwise you
  can't attribute the result;
- **Evidence is mandatory**: `pnpm typecheck` + `pnpm test` + viewer/three-view screenshots; anything
  missing means it isn't done;
- **Always provide a rollback point**: never overwrite private assets in place — back them up or use
  `assets/motions/*.before-*.json`;
- **No motion authoring**: when there is no captured data, refuse requests like “have the AI generate a
  set of idle motions”.
