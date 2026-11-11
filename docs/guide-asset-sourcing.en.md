# Where to find assets: models and motions

> Part of the “Not a modeler? Start here” series in the [English README](../README.en.md).

[中文版](guide-asset-sourcing.md)

The project consumes exactly two asset types. Get the shape right before you download anything —
it saves half of the rework:

| Asset | Shape the project needs | Where it lives |
|---|---|---|
| Model | **VRM 1.0 with a spec-compliant T-pose** (facing +Z, left hand +X) | `assets/vrm/*.vrm` + an entry in `src/shared/vrm-manifest.json` |
| Motion | **VRM humanoid normalized JSON clip** (per-frame quaternions + Hips translation + grounding metadata) | `assets/motions/*.json` + `app-manifest.json` / `app-catalog.json` |

Minimum playable set: 1 VRM plus `idle` / `walk` / `sit`. The full set is 40 clips today
(`app-manifest.json`); a missing mood slot falls back to idle instead of crashing.

## 1. Where to find models

| Source | What you get | Caveats |
|---|---|---|
| **模之屋 / aplaybox** <https://www.aplaybox.com/> | Main Chinese MMD hub; mostly PMX, some already-converted VRM 1.0 | Login required; in-site search is a SPA, so browsing in a browser beats scraping. This project's Aventurine model came from there (model edit: 流云景, © miHoYo) |
| **BowlRoll** <https://bowlroll.net/> | PMX / VMD distributions | Most need a download key (`download_control: permission`) |
| **Niconi Commons** <https://3d.nicovideo.jp/> | 3D models and motions | Requires a niconico account |
| **BOOTH** <https://booth.pm/> | Models and motion packs (see below) | Requires a pixiv account; free items too |
| **Official game models** | FBX/PMX from games such as HSR | Requires Windows plus the game itself to extract. **This repo ships neither the tools nor the assets**, and this cannot be done on macOS alone |
| **Build your own** | Anything | Model in Blender, then export a VRM following route 2 in the [model conversion guide](guide-model-conversion.en.md) |

Three recurring realities:

1. **Model sites publish models, not motions.** Don't expect a single download to contain both —
   in this project they are two separate supply chains.
2. **Model packs usually exclude props.** Our water gun was found/made outside the model pack; the
   investigation is in [`research/watergun-asset-sourcing.md`](research/watergun-asset-sourcing.md) (Chinese).
3. **The license is the `使用规则.txt` inside the pack**, not the platform. This project's red line:
   **no redistribution, no commercial use** (see [red lines](../README.en.md#red-lines-read-first)).

## 2. Where to find motions (priority order, don't invert it)

1. **Same game, same character**, extracted from the game — the best match, first choice. The HSR
   official motions in this project came from there.
2. **Same body type** — similar height and limb proportions, smallest retarget error.
3. **Same gender** — female motions on a male body cause shoulder collapse, and the motion vocabulary
   is still wrong (see pitfall #3 in [common pitfalls](guide-asset-pitfalls.en.md)).
4. **Public motion libraries** (table below).
5. **Record your own** — Reze MiPo (browser camera or phone video → motion, no account, video never
   leaves your machine); with a mocap rig, use your own data.

| Motion source | Format | Quality / fit | License (local personal use) | Barrier |
|---|---|---|---|---|
| HSR / official game motions | FBX | Best character match (idle/walk/stand) | Game asset copyright, local research only | Windows + game extraction |
| Mate-Engine `.anim` | Unity Humanoid muscle | 109 pet-specific clips (ledge sit/hide/drag/head-pat) | Personal non-commercial + attribution, no redistribution (including converted output) | Unity baking |
| Mixamo <https://www.mixamo.com/> | FBX | Professional generic motion; best for walk/sit | Adobe terms: free to use, no redistribution of raw animation | Free account |
| BOOTH “モーションパッケージ” | FBX | 20 male idle motions per pack, very fitting | Modification + local personal use + personal commercial (attribution) allowed; no extractable redistribution | ¥2,000/pack + account |
| 名もなきモーション (zukun-lab) | FBX + BIP | VICON-captured, clean loops | Free samples, read the terms manually | BOOTH login |
| CMU MoCap / AMASS | BVH / SMPL | Real human quality, style needs work | Academic license | Convert to FBX then retarget |
| Reze MiPo <https://mipo.reze.one> | Motion directly | Custom idle/sit/reactions; walking needs another route | Code GPL-3.0; output is yours | None |

> Measured findings, license text and traps per source:
> [`research/motion-assets.md`](research/motion-assets.md) and
> [`research/mocap-options.md`](research/mocap-options.md) (both Chinese).

## 3. One hard rule: without a mocap rig, never ask an AI to author motion

This is not caution — it is a lesson this project paid for:

- Wave 2 tried the “procedural pose” route and it was **rejected after measurement**: no reference, no
  visual feedback loop, so pure numbers produced hyperextended joints, foot sliding and bizarre hand
  placement. Root-cause analysis: [`anim-strategy.md`](anim-strategy.md) C4 (Chinese).
- There are only three reliable motion sources: **captured data, motion already authored by someone,
  or manual keyframing with screenshot review**. AI is good at *retargeting, offset correction, contact
  fixing and batch validation* — not at inventing keyframes from nothing.

So the correct order is: **find existing motion → convert to project format → let AI fix proportions,
contacts and orientation**. Once assets exist, see the [motion pipelines](guide-motion-conversion.en.md).

## 4. Licensing, one page

| Asset | Local personal use | Modify / convert | Redistribute / bundle | Commercial |
|---|---|---|---|---|
| This project's model (miHoYo / 流云景) | ✅ | ✅ | ❌ | ❌ |
| Official game motions (HSR etc.) | ✅ | ✅ | ❌ | ❌ |
| Mate-Engine motions | ✅ (attribute Shiny) | ✅ | ❌ (including baked JSON) | Written permission required |
| Mixamo | ✅ | ✅ | ❌ (raw animation) | ✅ (Adobe terms) |
| BOOTH motion packs | ✅ | ✅ | ❌ (extractable form) | Per-pack terms |
| Repo code (this project) | ✅ | ✅ | No LICENSE file: all rights reserved by default — pick a license before publishing | Same |

No public repo, shared build or PR may contain `assets/{model,vrm,motions,expressions,props}/`.
`.gitignore` already covers them, but don't bypass it with `git add -f`.
